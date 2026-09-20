import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { previewTaskRecovery } from "../scripts/task-recovery-preview.mjs";

test("恢复预览只读，区分缺失、移除、未知状态和活跃冲突", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "task-recovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.json");
  const eventsPath = join(dir, "events.jsonl");
  const ledger = JSON.stringify([{ id: "current", sessionId: "owner", status: "planned" }, { id: "removed", status: "removed" }]);
  const events = [
    { type: "task.create", event_id: "create-missing", task_id: "missing", session_id: "owner", title: "历史任务", new_state: { execution_status: "in_progress" } },
    { type: "review.reported", event_id: "review", task_id: "missing", session_id: "reviewer", new_state: { execution_status: "in_progress" } },
    { type: "task.update", event_id: "legacy", task_id: "unknown" },
    { type: "task.create", event_id: "create-current", task_id: "current" },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
  await writeFile(ledgerPath, ledger);
  await writeFile(eventsPath, events);
  const preview = await previewTaskRecovery({ ledgerPath, eventsPath });
  assert.equal(preview.mode, "preview_only");
  assert.equal(preview.complete, true);
  assert.equal(preview.tasks.length, 3);
  const missing = preview.tasks.find((task) => task.id === "missing");
  assert.equal(missing.sessionId, "owner");
  assert.deepEqual(missing.conflictingTaskIds, ["current"]);
  assert.ok(missing.issues.includes("active_session_conflict"));
  assert.equal(missing.creationEventId, "create-missing");
  const removed = preview.tasks.find((task) => task.id === "removed");
  assert.equal(removed.lastKnownStatus, null);
  assert.ok(removed.issues.includes("missing_creation_event"));
  assert.equal(await readFile(ledgerPath, "utf8"), ledger);
  assert.equal(await readFile(eventsPath, "utf8"), events);

  await writeFile(eventsPath, events + "invalid\n" + '{"partial":');
  const incomplete = await previewTaskRecovery({ ledgerPath, eventsPath });
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.malformedLines, 1);
  assert.ok(incomplete.trailingBytes > 0);
  assert.ok(incomplete.tasks.every((task) => task.issues.includes("incomplete_or_changing_source")));
});
