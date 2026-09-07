import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateUsageIndex } from "../scripts/usage-index.mjs";
import { collectUsage } from "../scripts/usage-report.mjs";

const threadId = "019f0000-0000-7000-8000-000000000123";
const rootId = "019f0000-0000-7000-8000-000000000999";
const continuationId = "019f0000-0000-7000-8000-000000000456";

function records() {
  return [
    { type: "session_meta", payload: { id: threadId, session_id: rootId, cwd: "/repo" } },
    { type: "turn_context", payload: { model: "gpt-test" } },
    { type: "event_msg", timestamp: "2026-08-20T01:00:00Z", payload: { info: { last_token_usage: { input_tokens: 100, output_tokens: 10 } } } },
  ];
}

test("usage report prefers metadata thread id over filename and root session id", () => {
  const report = collectUsage({
    sessions: [{ sessionId: "wrong-filename-id", records: records() }],
    ledger: [{ id: "task", sessionId: threadId }],
    rates: { "gpt-test": { input: 1, output: 2 } },
    now: "2026-08-20T02:00:00Z",
  });
  assert.equal(report.windows["24h"].bySession[0].sessionId, threadId);
  assert.equal(report.windows["24h"].byTask[0].id, "task");
  assert.equal(report.windows["24h"].bySession.some((row) => row.sessionId === rootId), false);
});

test("usage index repairs a persisted filename identity once without double counting", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "taskcenter-usage-identity-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, `rollout-2026-08-20T09-00-00-${rootId}_${threadId}_${continuationId}.jsonl`);
  const indexPath = join(root, "usage-index.json");
  await writeFile(file, records().map((record) => JSON.stringify(record)).join("\n") + "\n");
  const options = { sessionsRoot: root, indexPath, ledger: [], rates: {}, now: Date.parse("2026-08-20T02:00:00Z") };

  const initial = await updateUsageIndex(options);
  const stale = initial.index;
  stale.files[file].sessionId = continuationId;
  stale.files[file].lifetimeTotal = { input: 7, cachedInput: 0, output: 0, reasoning: 0, total: 7, count: 1 };
  stale.files[file].lifetimeByTask = { stale: { input: 7, cachedInput: 0, output: 0, reasoning: 0, total: 7, count: 1 } };
  await writeFile(indexPath, JSON.stringify(stale));
  const repaired = await updateUsageIndex(options);
  assert.equal(repaired.index.files[file].sessionId, threadId);
  assert.equal(repaired.index.files[file].lifetimeTotal.input, 100);
  assert.equal(repaired.index.files[file].lifetimeTotal.count, 1);
  const second = await updateUsageIndex(options);
  assert.equal(second.index.files[file].sessionId, threadId);
  assert.equal(second.index.files[file].lifetimeTotal.input, 100);
  assert.equal(second.index.files[file].lifetimeTotal.count, 1);
});

test("usage index reads valid metadata lines larger than 64KiB without replaying them", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "taskcenter-usage-identity-large-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, `rollout-${continuationId}.jsonl`);
  const indexPath = join(root, "usage-index.json");
  const largeMeta = { type: "session_meta", payload: { id: threadId, session_id: rootId, cwd: "/repo", padding: "x".repeat(70 * 1024) } };
  await writeFile(file, [largeMeta, ...records().slice(1)].map((record) => JSON.stringify(record)).join("\n") + "\n");
  const options = { sessionsRoot: root, indexPath, ledger: [], rates: {}, now: Date.parse("2026-08-20T02:00:00Z") };
  const first = await updateUsageIndex(options);
  const sentinel = JSON.parse(await readFile(indexPath, "utf8"));
  sentinel.files[file].sentinel = "reused";
  await writeFile(indexPath, JSON.stringify(sentinel));
  const second = await updateUsageIndex(options);
  assert.equal(first.index.files[file].sessionId, threadId);
  assert.equal(second.index.files[file].sessionId, threadId);
  assert.equal(second.index.files[file].lifetimeTotal.count, 1);
  assert.equal(second.index.files[file].offset, first.index.files[file].offset);
  assert.equal(second.index.files[file].sentinel, "reused");
});
