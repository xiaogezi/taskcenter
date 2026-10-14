import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { terminateProcessTree } from "../scripts/process-tree.mjs";

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
const { recordTaskEvent, loadTasks } = await import("../scripts/task-ledger.mjs");

test("确认会话清除先登记，静默后归档保留原状态与证据，重复对账幂等且可恢复", async () => {
  await resetLedger();
  recordTaskEvent({ type: "session.register", session_id: "cleared-session", agent: "codex" });
  recordTaskEvent({ type: "task.create", task_id: "cleared", session_id: "cleared-session", agent: "codex", status: "in_progress", goal: "保留原目标", title: "会话清除", evidence: ["原产物"], acceptance_criteria: ["原标准"] });
  const inspectSession = async () => { throw Object.assign(new Error("cleared"), { code: "CODEX_SESSION_NOT_FOUND" }); };
  await runReconciliation({ availableSessionIds: [], inspectSession });
  const task = loadTasks().find(task => task.id === "cleared");
  assert.equal(task.executionReconciliation.basis, "session_missing");
  assert.equal(task.executionReconciliation.state, "recovery_pending");
  assert.equal(task.goal, "保留原目标");
  assert.equal(task.sessionId, "cleared-session");
  assert.ok(!task.archivedAt);
  assert.equal((await runReconciliation({ availableSessionIds: [], inspectSession })).actions.length, 0);
  const old = new Date(Date.now() - 600_000).toISOString();
  await writeFile(envPaths.TASKCENTER_TASK_LEDGER_PATH, JSON.stringify([{ ...task, updatedAt: old, activeStartedAt: old }]));
  const archived = await runReconciliation({ availableSessionIds: [], inspectSession });
  const saved = loadTasks()[0];
  assert.equal(archived.actions[0].action, "orphan_archived");
  assert.ok(saved.archivedAt); assert.equal(saved.status, "in_progress");
  assert.deepEqual(saved.evidence, task.evidence); assert.deepEqual(saved.acceptanceCriteria, task.acceptanceCriteria);
  assert.equal(saved.goal, task.goal); assert.equal(saved.acceptanceStatus, task.acceptanceStatus);
  assert.equal(saved.runs.at(-1).ended_reason, "session_detached"); assert.equal(saved.activeStartedAt, "");
  assert.equal(saved.lastEventId, archived.actions[0].event_id);
  assert.equal((await runReconciliation({ availableSessionIds: [], inspectSession })).actions.length, 0);
  recordTaskEvent({ type: "task.create", task_id: "new-task", session_id: "cleared-session", agent: "codex", goal: "新目标" });
  assert.throws(() => recordTaskEvent({ type: "task.review", task_id: "cleared", session_id: "cleared-session", archived_at: "__UNARCHIVE__" }), /ACTIVE_TASK_CONFLICT/);
  recordTaskEvent({ type: "task.update", task_id: "new-task", session_id: "cleared-session", status: "cancelled" });
  recordTaskEvent({ type: "task.review", task_id: "cleared", session_id: "cleared-session", archived_at: "__UNARCHIVE__" });
  const restored = loadTasks().find(t => t.id === "cleared");
  assert.ok(!restored.archivedAt); assert.ok(restored.activeStartedAt); assert.equal(restored.status, "in_progress");
});

test("读取失败、状态未确认、活跃CLI、非Codex和忙碌会话不被归档，外部不能伪造内部归档", async () => {
  for (const scenario of ["unreadable", "unconfirmed", "cli", "claude", "busy", "recent"]) {
    await resetLedger();
    recordTaskEvent({ type: "session.register", session_id: "protected", agent: "codex" });
    recordTaskEvent({ type: "task.create", task_id: "protected", session_id: "protected", agent: "codex", status: "in_progress", title: "保护", goal: "保留" });
    const task = loadTasks()[0], old = new Date(Date.now() - 600_000).toISOString();
    await writeFile(envPaths.TASKCENTER_TASK_LEDGER_PATH, JSON.stringify([{ ...task, updatedAt: scenario === "recent" ? new Date().toISOString() : old, executionReconciliation: scenario === "unconfirmed" ? null : { basis: "session_missing", state: "recovery_pending" }, ...(scenario === "cli" ? { cliRuns: [{ status: "active" }] } : scenario === "claude" ? { agent: "claude" } : {}) }]));
    await runReconciliation({ availableSessionIds: [task.sessionId], inspectSession: async () => {
      if (scenario === "busy") return { busy: true };
      throw Object.assign(new Error("read"), { code: scenario === "unreadable" ? "EACCES" : "CODEX_SESSION_NOT_FOUND" });
    } });
    assert.ok(!loadTasks()[0].archivedAt, scenario);
  }
  const input = { type: "task.execution_reconciled", task_id: "protected", session_id: "protected", archived_at: new Date().toISOString(), execution_observation: { basis: "session_missing", state: "recovery_pending", next_action: "归档" } };
  assert.throws(() => recordTaskEvent(input), /内部/);
  assert.throws(() => recordTaskEvent(input, { internalReconciliation: true }), /孤儿归档/);
});

test("缺失会话的待验收和已结束任务也归档，完成与验收状态保持原样", async () => {
  for (const status of ["planned", "blocked", "done_claimed", "verified", "cancelled"]) {
    await resetLedger();
    recordTaskEvent({ type: "session.register", session_id: "owner", agent: "codex" });
    recordTaskEvent({ type: "task.create", task_id: "original", session_id: "owner", agent: "codex", goal: "原目标" });
    const old = new Date(Date.now() - 600_000).toISOString();
    await writeFile(envPaths.TASKCENTER_TASK_LEDGER_PATH, JSON.stringify([{ ...loadTasks()[0], status, updatedAt: old, executionReconciliation: { basis: "session_missing", state: "recovery_pending" } }]));
    const before = loadTasks()[0];
    await runReconciliation({ availableSessionIds: ["owner"], inspectSession: async (_id, _root, options) => {
      assert.equal(options.presenceOnly, ["done_claimed", "verified", "cancelled"].includes(status));
      throw Object.assign(new Error("cleared"), { code: "CODEX_SESSION_NOT_FOUND" });
    } });
    const after = loadTasks()[0];
    assert.ok(after.archivedAt, status); assert.equal(after.status, status);
    assert.equal(after.acceptanceStatus, before.acceptanceStatus); assert.equal(after.verificationStatus, before.verificationStatus);
  }
});

test("最近对账从尾部跨块读取，跳过损坏与超大行并保留UTF-8", async () => {
  const record = { type: "reconciliation.run", observedAt: "latest", text: "中文".repeat(40_000) };
  const path = envPaths.TASKCENTER_TASK_RECONCILE_PATH;
  await writeFile(path, `${JSON.stringify(record)}\n${"x".repeat(2 * 1024 * 1024 + 100)}\n{broken\n${JSON.stringify({ type: "other" })}\n`);
  assert.deepEqual(lastReconciliation(), record);
  await writeFile(path, JSON.stringify(record));
  assert.deepEqual(lastReconciliation(), record);
  await writeFile(path, "{broken\n");
  assert.equal(lastReconciliation(), null);
  await rm(path);
  assert.equal(lastReconciliation(), null);
});

async function resetLedger() {
  for (const path of Object.values(envPaths)) {
    await rm(path, { force: true });
  }
}

test("运行中的真实维护宿主不被本地对账误记为中断", async t => {
  await resetLedger();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: process.platform !== "win32", stdio: "ignore" });
  await new Promise((accept, reject) => { child.once("spawn", accept); child.once("error", reject); });
  t.after(() => terminateProcessTree(child.pid, { force: true }));
  const path = join(tempDir, "maintenance.json");
  recordTaskEvent({ type: "task.create", task_id: "maintenance-active", session_id: "maint-session", title: "维护运行", goal: "目标", status: "in_progress" });
  await writeFile(path, JSON.stringify({ actions: { "maintenance-active": { status: "running", pid: child.pid } } }));
  const result = await runReconciliation({ availableSessionIds: ["maint-session"], maintenancePath: path, inspectSession: () => { assert.fail("不能检查并收口活跃维护宿主"); } });
  assert.equal(result.actions.length, 0);
  assert.equal(loadTasks()[0].executionReconciliation, null);
});

test("对账器：不调用 task_close 的任务在会话脱离后被收口并生成待确认缺项，不伪造完成", async () => {
  await resetLedger();
  recordTaskEvent({ type: "task.create", session_id: "sess-orphan", task_id: "rec-orphan", title: "孤儿任务", goal: "目标" });
  // 触发执行中状态（模拟真实运行）
  recordTaskEvent({ type: "task.resume", task_id: "rec-orphan", session_id: "sess-orphan", agent: "a1" }, { authorizedResume: true });

  const result = await runReconciliation({ availableSessionIds: ["other-session"] });
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
  await runReconciliation({ availableSessionIds: [] });
  const first = loadTasks()[0].runs.at(-1).ended_at;
  assert.ok(first, "首次对账已收口");
  await runReconciliation({ availableSessionIds: [] });
  await runReconciliation({ availableSessionIds: [] });
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
  const result = await runReconciliation({ availableSessionIds: [] });
  assert.equal(result.reconciled.length, 1);
  const task = loadTasks()[0];
  assert.equal(task.runs.at(-1).ended_reason, "session_detached", "重启后的首次对账收口脱离运行");
  assert.equal(lastReconciliation().observedAt, result.observedAt, "对账审计记录可查询");
});


test("主动处置依据明确回合结束收口 Run，保持契约与归属并幂等登记恢复动作", async () => {
  await resetLedger();
  recordTaskEvent({ type: "task.create", task_id: "auto-ended", session_id: "auto-session", title: "待恢复", goal: "保留目标", status: "in_progress" });
  const terminal = { type: "task_complete", turn_id: "turn-1", at: new Date(Date.now() + 1000).toISOString() };
  const options = { availableSessionIds: ["auto-session"], inspectSession: () => ({ busy: false, lastTerminal: terminal }) };
  const first = await runReconciliation(options);
  const task = loadTasks()[0];
  assert.equal(first.actions.length, 1);
  assert.equal(task.runs.at(-1).ended_at, terminal.at);
  assert.equal(task.status, "in_progress");
  assert.equal(task.sessionId, "auto-session");
  assert.equal(task.goal, "保留目标");
  assert.equal(task.executionReconciliation.state, "execution_unconfirmed");
  assert.match(task.executionReconciliation.next_action, /原契约/);
  const before = await readFile(envPaths.TASKCENTER_TASK_EVENTS_PATH, "utf8");
  assert.deepEqual((await runReconciliation(options)).actions, []);
  assert.equal(await readFile(envPaths.TASKCENTER_TASK_EVENTS_PATH, "utf8"), before);
  recordTaskEvent({ type: "task.resume", task_id: task.id, session_id: task.sessionId }, { authorizedResume: true });
  assert.equal(loadTasks()[0].executionReconciliation, null);
  assert.equal(loadTasks()[0].runs.at(-1).ended_at, "");
});

test("异步核对期间任务更新时不写入过期运行事实", async () => {
  await resetLedger();
  recordTaskEvent({ type: "task.create", task_id: "async-inspect", session_id: "async-session", title: "异步核实", goal: "目标", status: "in_progress" });
  const result = await runReconciliation({ availableSessionIds: ["async-session"], inspectSession: async () => {
    await new Promise(setImmediate);
    recordTaskEvent({ type: "task.update", event_id: "concurrent-update", task_id: "async-inspect", session_id: "async-session", current_step: "并发新进展" });
    return { busy: false, lastTerminal: { type: "task_complete", at: new Date(Date.now() + 1000).toISOString(), turn_id: "old-turn" } };
  } });
  assert.deepEqual(result.actions, []);
  const task = loadTasks()[0];
  assert.equal(task.currentStep, "并发新进展");
  assert.equal(task.runs.at(-1).ended_at, "");
});

test("当前忙碌、旧结束事件、缺失会话和CLI活跃不会被错误收口或取消", async () => {
  await resetLedger();
  recordTaskEvent({ type: "task.create", task_id: "auto-busy", session_id: "busy-session", status: "in_progress" });
  assert.deepEqual((await runReconciliation({ availableSessionIds: ["busy-session"], inspectSession: () => ({ busy: true }) })).actions, []);
  const task = loadTasks()[0];
  await runReconciliation({ availableSessionIds: ["busy-session"], inspectSession: () => ({ busy: false, lastTerminal: { type: "task_complete", at: "2000-01-01T00:00:00Z", turn_id: "old" } }) });
  assert.equal(loadTasks()[0].runs.at(-1).ended_at, "");
  assert.equal(loadTasks()[0].executionReconciliation.state, "recovery_pending");
  assert.equal(loadTasks()[0].status, task.status);
  assert.throws(() => recordTaskEvent({ type: "task.execution_reconciled", task_id: task.id }), /内部/);
  await writeFile(envPaths.TASKCENTER_TASK_LEDGER_PATH, JSON.stringify([{ ...task, cliRuns: [{ status: "active" }] }]));
  assert.deepEqual((await runReconciliation({ availableSessionIds: [task.sessionId], inspectSession: () => { assert.fail("活跃CLI不能被扫描收口"); } })).actions, []);
});

test("只有当前Run的完整版本证据才补齐完成声明，失败与旧证据保持待确认", async () => {
  await resetLedger();
  const started = "2026-10-12T00:00:00Z", observed = "2026-10-12T00:01:00Z";
  const subject = { type: "git_commit", value: "abc123", observed_at: observed };
  const base = { id: "auto-delivery", sessionId: "delivery-session", status: "in_progress", contractVersion: "v2", goal: "交付", scope: ["本任务"], nonGoals: [], workflowProfile: "standard", reviewPolicy: "recommended", acceptanceRequirements: [{ id: "done", description: "交付", required: true }], verificationPlan: [{ id: "test", kind: "test", title: "验证", required: true }], currentSubject: subject, evidence: ["artifact:report"], tests: ["测试通过"], requirementResults: [{ requirement_id: "done", status: "passed", evidence_refs: ["artifact:report"], checked_at: observed, checked_by: { type: "agent", id: "owner" }, subject_ref: subject }], verificationClaims: [{ id: "claim", requirement_id: "test", kind: "test", status: "passed", evidence_ref: "artifact:report", observed_at: observed, producer: { type: "agent", id: "owner" }, subject_ref: subject }], runs: [{ run_id: "delivery-run", session_id: "delivery-session", started_at: started, ended_at: observed, ended_reason: "completed" }] };
  await writeFile(envPaths.TASKCENTER_TASK_LEDGER_PATH, JSON.stringify([base]));
  const options = { availableSessionIds: [base.sessionId], inspectSession: () => ({ busy: false }) };
  assert.equal((await runReconciliation(options)).actions[0].action, "delivery_reconciled");
  assert.equal(loadTasks()[0].status, "done_claimed");
  assert.notEqual(loadTasks()[0].acceptanceStatus, "accepted");
  assert.deepEqual((await runReconciliation(options)).actions, []);
  await resetLedger();
  await writeFile(envPaths.TASKCENTER_TASK_LEDGER_PATH, JSON.stringify([{ ...base, requirementResults: [{ ...base.requirementResults[0], checked_at: "2000-01-01T00:00:00Z" }] }]));
  await runReconciliation(options);
  assert.equal(loadTasks()[0].status, "in_progress");
});
