import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createMaintenanceWorker } from "../scripts/ai-maintenance.mjs";

const profile = { model: "test", effort: "low", automatic: { actions: true } };
const task = { id: "task", sessionId: "original", lastEventId: "event-1", workspace: "/project", title: "维护", goal: "修复异常", status: "in_progress" };
const analysis = { summary: "核对异常", next_steps: ["检查现场"] };
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
