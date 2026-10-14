import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createMaintenanceWorker, maintenanceOperation, currentMaintenanceAction } from "../scripts/ai-maintenance.mjs";

test("操作摘要白名单保留对象，隐藏敏感参数且不包含写入正文", () => {
  assert.equal(maintenanceOperation("Bash", { command: "npm test" }), "运行命令：npm test");
  assert.equal(maintenanceOperation("Write", { file_path: "health.txt", content: "private data" }), "写入文件：health.txt");
  assert.equal(maintenanceOperation("Read", { file_path: "/Users/gezi/private.txt" }), "读取文件：[local-path]");
  assert.match(maintenanceOperation("Bash", { command: "echo token=abc" }), /敏感参数已隐藏/);
  assert.match(maintenanceOperation("Bash", { command: "x".repeat(600) + " Bearer abcdefghijklmnop" }), /敏感参数已隐藏/);
});

test("当前行动来自账本阶段，过期心跳不宣称正在执行", () => {
  const actions = { task: { task_id: "task", status: "running", analysis: { summary: "发现异常" }, latest_operation: { summary: "运行命令：npm test" } } };
  const tasks = [{ id: "task", title: "修复服务", currentStep: "验证修复", nextAction: "提交证据" }];
  assert.equal(currentMaintenanceAction(actions, tasks, {}, false).title, "修复服务");
  assert.equal(currentMaintenanceAction(actions, tasks, {}, false).step, "验证修复");
  assert.equal(currentMaintenanceAction(actions, tasks, {}, true).phase, "stale");
  assert.equal(currentMaintenanceAction({}, tasks, {}, false), null);
});

test("工具进展实时持久化并可跨请求展示", async t => {
  const f = await fixture(t, { execute: async ({ record }) => { await record({ status: "tool_started", summary: "运行命令：npm test" }); assert.equal((await f.state()).actions.task.latest_operation.summary, "运行命令：npm test"); return { tool_calls: 1 }; } });
  await f.worker.enqueue(task, analysis, profile); await f.worker.tick(profile);
  assert.equal(f.rows.find(row => row.status === "tool_started").title, "维护");
});

const profile = { model: "test", effort: "low", automatic: { actions: true } };
const task = { id: "task", sessionId: "original", lastEventId: "event-1", workspace: "/project", title: "维护", goal: "修复异常", status: "in_progress" };
const analysis = { summary: "核对异常", next_steps: ["检查现场"] };

test("确认缺失的会话不再默认接续，归档也不会进入维护队列", async t => {
  const orphan = { ...task, agent: "codex", updatedAt: new Date(0).toISOString(), executionReconciliation: { basis: "session_missing" } };
  const f = await fixture(t, { tasks: () => [orphan, { ...orphan, id: "other", sessionId: "other" }], inspect: async () => { throw Object.assign(new Error("cleared"), { code: "CODEX_SESSION_NOT_FOUND" }); } });
  await f.worker.enqueue(orphan, analysis, profile); await f.worker.tick(profile);
  assert.equal(f.calls(), 0);
  assert.equal(f.rows.length, 0);
  await f.worker.enqueue({ ...task, archivedAt: new Date().toISOString() }, analysis, profile);
  assert.equal(f.rows.length, 0);
});

test("旧队列即使处于冷却或attention也撤销缺失会话动作，已归档孤儿不挡其他任务", async t => {
  for (const status of ["queued", "retry_wait", "attention"]) {
    const f = await fixture(t);
    await f.worker.enqueue(task, analysis, profile);
    const state = await f.state(); state.actions.task.status = status; state.actions.task.retry_at = 9_000_000;
    await writeFile(f.options.statePath, JSON.stringify(state));
    f.update({ executionReconciliation: { basis: "session_missing" } });
    const restarted = await createMaintenanceWorker(f.options);
    await restarted.tick(profile);
    assert.equal((await f.state()).actions.task.status, "cancelled"); assert.equal(f.calls(), 0);
  }
  const f = await fixture(t, { tasks: () => [task, { ...task, id: "archived", archivedAt: "past" }], inspect: async id => { assert.equal(id, task.sessionId); return { busy: false, lastTerminal: { type: "turn_aborted" } }; } });
  await f.worker.enqueue(task, analysis, profile); await f.worker.tick(profile);
  assert.equal(f.calls(), 1);
});

test("源不可读、未确认、近期变化、非Codex及其他活跃执行者都不允许孤儿接管", async t => {
  const orphan = { ...task, agent: "codex", updatedAt: new Date(0).toISOString(), executionReconciliation: { basis: "session_missing" } };
  for (const scenario of ["unreadable", "unconfirmed", "recent", "claude", "busy", "cli"]) {
    const current = { ...orphan, ...(scenario === "recent" ? { updatedAt: new Date(999_999).toISOString() } : scenario === "claude" ? { agent: "claude" } : scenario === "unconfirmed" ? { executionReconciliation: undefined } : {}) };
    const other = { ...orphan, id: "other", sessionId: "other", ...(scenario === "cli" ? { cliRuns: [{ status: "active" }] } : {}) };
    const f = await fixture(t, { tasks: () => [current, other], inspect: async id => {
      if (scenario === "busy" && id === "other") return { busy: true };
      throw Object.assign(new Error("read"), { code: scenario === "unreadable" ? "EACCES" : "CODEX_SESSION_NOT_FOUND" });
    } });
    await f.worker.enqueue(current, analysis, profile); await f.worker.tick(profile);
    assert.equal(f.calls(), 0, scenario);
  }
});

test("待执行的旧分析被新快照替换，不因旧事件变化取消唯一恢复机会", async t => {
  const f = await fixture(t);
  await f.worker.enqueue(task, analysis, profile);
  const changed = { ...task, lastEventId: "reconciled", executionReconciliation: { basis: "session_end_unconfirmed" } };
  f.update(changed);
  await f.worker.enqueue(changed, analysis, profile);
  await f.worker.tick(profile);
  assert.equal(f.calls(), 1);
});

test("维护队列持久保存本轮目标，CLI 执行器收到同一目标", async t => {
  let received;
  const f = await fixture(t, { execute: async ({ action }) => { received = action; return { tool_calls: 1 }; } });
  await f.worker.enqueue(task, analysis, profile, { request_id: "round", intent: "修复异常" });
  await f.worker.tick(profile);
  assert.equal(received.intent, "修复异常"); assert.equal(received.request_id, "round");
});

test("运行中的维护保留新目标，完成后核对接续且不抢占当前执行", async t => {
  let f, calls = 0;
  f = await fixture(t, { execute: async ({ action }) => { calls++; if (calls === 1) await f.worker.enqueue(task, analysis, profile, { request_id: "new", intent: "检查缺项" }); else assert.equal(action.intent, "检查缺项"); return { tool_calls: 1 }; } });
  await f.worker.enqueue(task, analysis, profile); await f.worker.tick(profile);
  assert.equal(calls, 1);
  assert.equal((await f.state()).actions.task.pending_work.work.intent, "检查缺项");
  await f.worker.tick(profile); await f.worker.tick(profile);
  assert.equal(calls, 2);
});
async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ai-maintenance-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const rows = []; let current = { ...task }, time = 1_000_000, calls = 0;
  const options = { statePath: join(dir, "actions.json"), record: async row => rows.push(row), tasks: () => [current], now: () => time,
    inspect: async () => ({ busy: false, lastTerminal: { type: "turn_aborted" } }),
    execute: async () => { calls++; return { tool_calls: 1 }; }, ...overrides };
  return { options, worker: await createMaintenanceWorker(options), rows, calls: () => calls, update: value => { current = { ...current, ...value }; }, advance: ms => { time += ms; }, state: async () => JSON.parse(await readFile(options.statePath, "utf8")) };
}

test("分析进入持久队列，真实执行后核对账本，CLI 成功不冒充任务闭环", async t => {
  const f = await fixture(t);
  await f.worker.enqueue(task, analysis, profile); await f.worker.enqueue(task, analysis, profile);
  assert.equal(f.rows.length, 1);
  const restarted = await createMaintenanceWorker(f.options);
  await restarted.tick(profile);
  assert.equal(f.calls(), 1);
  assert.equal(f.rows.at(-1).status, "attention");
  assert.equal(f.rows.at(-1).result.task_status, "in_progress");
  assert.equal((await f.state()).actions.task.status, "attention");
  await restarted.tick(profile); assert.equal(f.calls(), 1);
});

test("CLI 不可用持久保留，冷却后重试，主线无需等待模型", async t => {
  let calls = 0;
  const f = await fixture(t, { execute: async () => { calls++; throw Object.assign(new Error("missing"), { code: "ENOENT" }); } });
  await f.worker.enqueue(task, analysis, profile); await f.worker.tick(profile);
  assert.equal(f.rows.at(-1).status, "retry_wait"); assert.equal(f.rows.at(-1).error, "AI_CLI_UNAVAILABLE");
  await f.worker.tick(profile); assert.equal(calls, 1);
  f.advance(300_001); await f.worker.tick(profile); assert.equal(calls, 2);
  f.advance(300_001); await f.worker.tick(profile);
  assert.equal(calls, 3); assert.equal(f.rows.at(-1).status, "attention");
});

test("不抢占运行中的宿主；任务变化撤销旧行动", async t => {
  const f = await fixture(t, { inspect: async () => ({ busy: true }) });
  await f.worker.enqueue(task, analysis, profile); await f.worker.tick(profile);
  assert.equal(f.calls(), 0); assert.equal(f.rows.at(-1).status, "waiting_owner");
  f.update({ lastEventId: "event-2" }); f.advance(60_001); await f.worker.tick(profile);
  assert.equal(f.calls(), 0); assert.equal(f.rows.at(-1).status, "cancelled");
});

test("重启遇到运行中未知结果不盲目重放，保留恢复记录", async t => {
  const f = await fixture(t);
  await writeFile(f.options.statePath, JSON.stringify({ actions: { task: { id: "action-1", task_id: task.id, status: "running", model: "test", pid: 99999999 } } }));
  const restarted = await createMaintenanceWorker(f.options);
  await restarted.tick(profile);
  assert.equal(f.calls(), 0); assert.equal(f.rows.at(-1).status, "attention");
});

test("部分工具已执行后报错必须核对，不自动重复副作用", async t => {
  const f = await fixture(t, { execute: async () => { throw Object.assign(new Error("failed"), { performed_tools: 1 }); } });
  await f.worker.enqueue(task, analysis, profile); await f.worker.tick(profile);
  assert.equal(f.rows.at(-1).status, "attention");
  f.advance(300_001); await f.worker.tick(profile);
  assert.equal(f.rows.filter(row => row.status === "started").length, 1);
});

test("新范围需显式启用，关闭行动时仅分析", async t => {
  const f = await fixture(t);
  await f.worker.enqueue(task, analysis, { ...profile, automatic: {} });
  await f.worker.tick({ ...profile, automatic: {} });
  assert.equal(f.rows.length, 0); assert.equal(f.calls(), 0);
});

test("只有当前契约证据已通过才显示已闭环，独立验收状态不改写", async t => {
  let f;
  f = await fixture(t, { execute: async () => { f.update({ status: "done_claimed", contractVersion: "v2", workflowProfile: "fast", blocker: "", lastEventId: "closed", acceptanceRequirements: [{ id: "repair", required: true }], requirementResults: [{ requirement_id: "repair", status: "passed" }], acceptanceStatus: "pending" }); return { tool_calls: 3 }; } });
  await f.worker.enqueue(task, analysis, profile); await f.worker.tick(profile);
  assert.equal(f.rows.at(-1).status, "completed");
  assert.equal(f.rows.at(-1).result.acceptance_status, "pending");
});
