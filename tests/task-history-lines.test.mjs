import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("authoritative history lookup filters bytes but preserves exact replay and cross-chunk UTF-8", async t => {
  const root = mkdtempSync(join(tmpdir(), "task-history-lines-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [key, name] of Object.entries({ TASKCENTER_TASK_LEDGER_PATH: "ledger.json", TASKCENTER_TASK_EVENTS_PATH: "events.jsonl",
    TASKCENTER_TASK_EVENT_IDS_PATH: "ids.json", TASKCENTER_SESSION_REGISTRY_PATH: "registry.json", TASKCENTER_SESSION_MERGES_PATH: "merges.json" })) process.env[key] = join(root, name);
  const path = process.env.TASKCENTER_TASK_EVENTS_PATH;
  const owner = { owner: { sessionId: "owner", agent: "codex", workspace: "/test" } };
  writeFileSync(process.env.TASKCENTER_SESSION_REGISTRY_PATH, JSON.stringify(owner));
  const { recordTaskEvent, loadSessionRegistry } = await import("../scripts/task-ledger.mjs");
  const input = { type: "task.create", event_id: "创建-精确事件", task_id: "target", session_id: "owner", title: "fixture", goal: "fixture" };
  const original = recordTaskEvent(input).event;
  const line = JSON.stringify(original);
  const filler = JSON.stringify({ type: "ignore", padding: "x".repeat(4096) }) + "\n";
  const scans = [], stderr = console.error;
  console.error = message => scans.push(JSON.parse(message));
  t.after(() => { console.error = stderr; });

  // Place the multibyte ID across both forward and reverse 64 KiB boundaries.
  const idAt = Buffer.byteLength(line.slice(0, line.indexOf(input.event_id)));
  const padding = size => JSON.stringify({ padding: "x".repeat(size - 15) }) + "\n";
  for (const direction of ["forward", "backward"]) {
    for (const split of [1, 2]) {
      const prefixSize = direction === "forward" ? 65536 - idAt - split : 15;
      const suffixSize = direction === "backward" ? 65536 - Buffer.byteLength(line) + idAt + split : 1;
      writeFileSync(path, padding(prefixSize) + line + "\n" + (suffixSize > 1 ? padding(suffixSize - 1) : ""));
      const replay = recordTaskEvent(input);
      assert.equal(replay.idempotent, true);
      assert.deepEqual(replay.event, JSON.parse(line));
    }
  }
  const huge = JSON.stringify({ ...original, padding: "汉字".repeat(200000) });
  writeFileSync(path, filler.repeat(300) + huge + "\r\n" + JSON.stringify({ event_id: "other", note: input.event_id }) + "\n" + input.event_id);
  assert.equal(recordTaskEvent(input).idempotent, true, "ignore malformed and misleading candidates, preserve a line larger than a chunk");
  assert.equal(scans.at(-1).found, true);
  assert.ok(scans.at(-1).decoded_lines <= 3, "unrelated lines must not be decoded");
  writeFileSync(path, filler.repeat(300) + line); // Valid final record without newline.
  assert.equal(recordTaskEvent(input).idempotent, true);
  assert.throws(() => recordTaskEvent({ ...input, goal: "changed" }), /不同事件/);

  // After processed IDs expire, a missing projection must not resurrect a historical task.
  writeFileSync(process.env.TASKCENTER_TASK_EVENT_IDS_PATH, "[]");
  writeFileSync(process.env.TASKCENTER_TASK_LEDGER_PATH, "[]");
  assert.throws(() => recordTaskEvent({ ...input, event_id: "new-create-id" }), /TASK_LEDGER_RECOVERY_REQUIRED/);
  writeFileSync(path, filler.repeat(300));
  const fresh = recordTaskEvent({ ...input, event_id: "fresh", task_id: "fresh" });
  assert.equal(fresh.task.id, "fresh");
  const absent = scans.findLast(e => e.kind === "event_lookup" && e.found === false);
  assert.ok(absent.bytes >= 1024 * 1024);
  assert.equal(absent.decoded_lines, 0);
  assert.ok(!JSON.stringify(scans).includes(input.event_id));

  // The unfiltered forward iterator still reconstructs legacy registration with split UTF-8.
  writeFileSync(process.env.TASKCENTER_SESSION_REGISTRY_PATH, "{}");
  writeFileSync(path, filler.repeat(17) + JSON.stringify({ type: "session.register", session_id: "legacy", workspace: "/汉字", padding: "汉".repeat(45000) }));
  assert.equal(loadSessionRegistry().legacy.workspace, "/汉字");

  writeFileSync(process.env.TASKCENTER_SESSION_REGISTRY_PATH, JSON.stringify(owner));
  writeFileSync(process.env.TASKCENTER_TASK_LEDGER_PATH, JSON.stringify([{ ...fresh.task, status: "done_claimed" }]));
  writeFileSync(path, filler.repeat(300) + JSON.stringify({ previous_task_id: "fresh", session_switch_id: "switch", padding: "汉".repeat(45000) }));
  assert.throws(() => recordTaskEvent({ type: "task.update", task_id: "fresh", session_id: "owner", current_step: "forbidden" }), /SWITCH_PREDECESSOR_SEALED/);
  assert.equal(JSON.parse(readFileSync(process.env.TASKCENTER_TASK_LEDGER_PATH))[0].status, "done_claimed");
  t.diagnostic(JSON.stringify({ event: "history_line_checks", lookup_scans: scans.filter(e => e.kind === "event_lookup").length,
    absent_decoded_lines: absent.decoded_lines, predecessor_rejected: true }));
});
