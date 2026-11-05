import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("switch-history memo advances only for own appends and invalidates on external changes", async t => {
  const root = mkdtempSync(join(tmpdir(), "task-history-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [key, name] of Object.entries({ TASKCENTER_TASK_LEDGER_PATH: "ledger.json", TASKCENTER_TASK_EVENTS_PATH: "events.jsonl",
    TASKCENTER_TASK_EVENT_IDS_PATH: "ids.json", TASKCENTER_SESSION_REGISTRY_PATH: "registry.json", TASKCENTER_SESSION_MERGES_PATH: "merges.json" })) process.env[key] = join(root, name);
  const path = process.env.TASKCENTER_TASK_EVENTS_PATH;
  const filler = (JSON.stringify({ type: "tool.call", padding: "x".repeat(16384) }) + "\n").repeat(128);
  const seal = id => JSON.stringify({ type: "task.create", previous_task_id: id, session_switch_id: "switch" }) + "\n";
  writeFileSync(path, filler);
  writeFileSync(process.env.TASKCENTER_SESSION_REGISTRY_PATH, JSON.stringify({ owner: { sessionId: "owner", agent: "codex", workspace: "/test" } }));
  writeFileSync(process.env.TASKCENTER_TASK_LEDGER_PATH, JSON.stringify([{ id: "closed", sessionId: "owner", status: "done_claimed",
    createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", goal: "test" }]));
  const { recordTaskEvent } = await import("../scripts/task-ledger.mjs");
  let calls = 0;
  const scans = [], stderr = console.error;
  console.error = line => { const event = JSON.parse(line); if (event.event === "task_history_scan") scans.push(event); };
  t.after(() => { console.error = stderr; });
  const record = () => recordTaskEvent({ type: "tool.call", event_id: `history-${++calls}`, task_id: "closed", session_id: "owner", tool_name: "Read" });
  record();
  record();
  assert.equal(scans.length, 1, "own append must not force another full scan");
  appendFileSync(path, seal("closed"));
  assert.throws(record, /SWITCH_PREDECESSOR_SEALED/);
  assert.equal(scans.length, 2);
  const old = statSync(path);
  writeFileSync(path, filler + seal("otherX"));
  utimesSync(path, old.atime, old.mtime);
  record();
  assert.equal(scans.length, 3, "in-place rewrite must invalidate, even with restored mtime");
  writeFileSync(path + ".replacement", filler + seal("closed"));
  renameSync(path + ".replacement", path);
  assert.throws(record, /SWITCH_PREDECESSOR_SEALED/);
  assert.equal(scans.length, 4);
  writeFileSync(path, "");
  record();
  record();
  assert.equal(scans.length, 4, "truncation clears the old seal; small rebuild need not emit a slow-scan log");
  t.diagnostic(JSON.stringify({ event: "history_cache_verified", scans: scans.length, sealed_predecessor_rejections: 2 }));
});
