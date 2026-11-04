import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("current-session selection matches full projection and sees updates immediately", async t => {
  const root = await mkdtemp(join(tmpdir(), "session-task-selection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  process.env.TASKCENTER_TASK_LEDGER_PATH = join(root, "ledger.json");
  process.env.TASKCENTER_SESSION_MERGES_PATH = join(root, "merges.json");
  const { loadVisibleTasks, loadVisibleSessionTasks } = await import("../scripts/task-ledger.mjs");
  const seed = (id, sessionId, extra = {}) => ({ id, sessionId, status: "done_claimed", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", acceptanceCriteria: ["one"], ...extra });
  const rows = [seed("current", "session-a"), seed("archived", "session-a", { archivedAt: "2026-10-02" }), seed("removed", "session-a", { status: "removed" }), seed("context-" + "a".repeat(24), "session-a"),
    ...Array.from({ length: 500 }, (_, i) => seed(`other-${i}`, "session-b"))];
  await writeFile(process.env.TASKCENTER_TASK_LEDGER_PATH, JSON.stringify(rows));
  const comparable = values => values.map(task => { const copy = { ...task }; delete copy.phaseTiming; return copy; });
  assert.deepEqual(comparable(loadVisibleSessionTasks("session-a")), comparable(loadVisibleTasks().filter(task => task.sessionId === "session-a")));
  assert.equal(loadVisibleSessionTasks("session-a").length, 1);
  rows[0].status = "blocked";
  rows[0].goal = "updated-goal";
  await writeFile(process.env.TASKCENTER_TASK_LEDGER_PATH, JSON.stringify(rows));
  assert.equal(loadVisibleSessionTasks("session-a")[0].status, "blocked");
  assert.equal(loadVisibleSessionTasks("session-a")[0].goal, "updated-goal");
  rows[0].sessionId = "session-b";
  await writeFile(process.env.TASKCENTER_TASK_LEDGER_PATH, JSON.stringify(rows));
  assert.deepEqual(loadVisibleSessionTasks("session-a"), []);
});
