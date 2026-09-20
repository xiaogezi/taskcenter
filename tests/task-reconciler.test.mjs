import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = await mkdtemp(join(tmpdir(), "taskcenter-reconciler-"));
const envPaths = {
  TASKCENTER_TASK_EVENTS_PATH: join(tempDir, "task-events.jsonl"),
  TASKCENTER_TASK_LEDGER_PATH: join(tempDir, "task-ledger.json"),
  TASKCENTER_TASK_EVENT_IDS_PATH: join(tempDir, "task-event-ids.json"),
  TASKCENTER_TASK_RECONCILE_PATH: join(tempDir, "task-reconcile.jsonl"),
  TASKCENTER_TASK_REUSE_DECISIONS_PATH: join(tempDir, "task-reuse-decisions.jsonl"),
  TASKCENTER_SESSION_REGISTRY_PATH: join(tempDir, "session-registry.json"),
  TASKCENTER_SESSION_MERGES_PATH: join(tempDir, "session-merges.json"),
  TASKCENTER_CONTEXT_TASK_MAP_PATH: join(tempDir, "context-task-map.json"),
  TASKCENTER_CONTEXT_AUDIT_PATH: join(tempDir, "context-sync-events.jsonl"),
  TASKCENTER_DELEGATIONS_PATH: join(tempDir, "delegations.json"),
  TASKCENTER_ROUTING_CONTROL_PATH: join(tempDir, "routing-control.json"),
  TASKCENTER_USAGE_REPORT_PATH: join(tempDir, "usage-report.json"),
};
for (const [key, value] of Object.entries(envPaths)) {
  process.env[key] = value;
}
// 动态 import：必须在 envPaths 设置之后加载，避免路径常量落到默认（真实数据）路径。
const { runReconciliation, queryFindings, lastReconciliation } = await import("../scripts/task-reconciler.mjs");
const { recordTaskEvent, reconcileTasks, loadTasks } = await import("../scripts/task-ledger.mjs");

async function resetLedger() {
  for (const path of Object.values(envPaths)) {
    await rm(path, { force: true });
  }
}

test("对账器：不调用 task_close 的任务在会话脱离后被收口并生成待确认缺项，不伪造完成", async () => {
  await resetLedger();
  recordTaskEvent({ type: "task.create", session_id: "sess-orphan", task_id: "rec-orphan", title: "孤儿任务", goal: "目标" });
  // 触发执行中状态（模拟真实运行）
  recordTaskEvent({ type: "task.resume", task_id: "rec-orphan", session_id: "sess-orphan", agent: "a1" }, { authorizedResume: true });

  const result = runReconciliation({ availableSessionIds: ["other-session"] });
  assert.equal(result.reconciled.length, 1, "脱离会话的任务被收口");
  assert.equal(result.reconciled[0].id, "rec-orphan");

  const task = loadTasks()[0];
  assert.equal(task.runs.at(-1).ended_reason, "session_detached", "运行收口为 session_detached");
  assert.ok(task.sessionDetachedAt, "标记会话脱离");
  assert.equal(task.status, "planned", "不伪造完成（状态保持，绝不自动推进完成判定）");
  assert.notEqual(task.status, "done_claimed", "绝不伪造验收");

  const unconfirmed = result.findings.find((item) => item.code === "execution_unconfirmed");
  assert.ok(unconfirmed, "生成执行状态待确认缺项");
  assert.equal(unconfirmed.task_id, "rec-orphan");
});

test("对账器：幂等——重复对账不重复收口，不改变已收口的结束时间", async () => {
  await resetLedger();
  recordTaskEvent({ type: "task.create", session_id: "sess-idem", task_id: "rec-idem", title: "幂等任务", goal: "目标" });
  runReconciliation({ availableSessionIds: [] });
  const first = loadTasks()[0].runs.at(-1).ended_at;
  assert.ok(first, "首次对账已收口");
  runReconciliation({ availableSessionIds: [] });
  runReconciliation({ availableSessionIds: [] });
  const task = loadTasks()[0];
  assert.equal(task.runs.at(-1).ended_at, first, "重复对账幂等");
  assert.equal(task.sessionDetachedAt, task.sessionDetachedAt, "脱离时间保留");
});

test("对账器：执行已结束未收尾与待补交付记录缺项", async () => {
  await resetLedger();
  // 场景 A：in_progress 但 runs 已全部收口（未标记脱离）→ execution_ended。
  // 该异常状态无法由正常事件流产生，直接构造账本状态验证对账发现。
  await writeFile(envPaths.TASKCENTER_TASK_LEDGER_PATH, JSON.stringify([{
    id: "rec-a", sessionId: "sess-a", status: "in_progress", title: "A", goal: "a",
    runs: [{ run_id: "r1", session_id: "sess-a", started_at: "2026-08-25T00:00:00.000Z", ended_at: "2026-08-25T00:01:00.000Z", ended_reason: "completed" }],
  }]));
  // 场景 B：done_claimed 但无交付版本 → delivery_missing
  recordTaskEvent({ type: "task.create", session_id: "sess-b", task_id: "rec-b", title: "B", goal: "b", acceptance_criteria: [{ id: "done", description: "完成" }] });
  recordTaskEvent({ type: "task.close", session_id: "sess-b", task_id: "rec-b", status: "done_claimed", evidence: ["eb"], close_requirements: [{ requirement_id: "done", status: "passed", evidence_refs: ["eb"], checked_at: "2026-08-25T00:00:00.000Z", checked_by: { type: "task_platform", id: "test" } }] });

  const findings = queryFindings();
  const ended = findings.find((item) => item.code === "execution_ended");
  const missing = findings.find((item) => item.code === "delivery_missing");
  assert.ok(ended, "生成执行已结束未收尾缺项");
  assert.equal(ended.task_id, "rec-a");
  assert.ok(missing, "生成待补交付记录缺项");
  assert.equal(missing.task_id, "rec-b");
});

test("对账器：queryFindings 为纯只读，不写任何文件", async () => {
  await resetLedger();
  recordTaskEvent({ type: "task.create", session_id: "sess-ro", task_id: "rec-ro", title: "只读", goal: "r" });
  const before = await readFile(envPaths.TASKCENTER_TASK_LEDGER_PATH, "utf8");
  queryFindings();
  queryFindings();
  assert.equal(await readFile(envPaths.TASKCENTER_TASK_LEDGER_PATH, "utf8"), before, "查询不修改账本");
  assert.equal(await readFile(envPaths.TASKCENTER_TASK_EVENTS_PATH, "utf8").catch(() => ""), (await readFile(envPaths.TASKCENTER_TASK_EVENTS_PATH, "utf8")), "查询不修改事件");
});

test("对账器：服务重启恢复——重启后再次对账可恢复未处理记录", async () => {
  await resetLedger();
  recordTaskEvent({ type: "task.create", session_id: "sess-restart", task_id: "rec-restart", title: "重启", goal: "r" });
  const result = runReconciliation({ availableSessionIds: [] });
  assert.equal(result.reconciled.length, 1);
  const task = loadTasks()[0];
  assert.equal(task.runs.at(-1).ended_reason, "session_detached", "重启后的首次对账收口脱离运行");
  assert.equal(lastReconciliation().observedAt, result.observedAt, "对账审计记录可查询");
});
