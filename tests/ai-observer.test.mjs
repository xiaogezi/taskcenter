import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAutomaticObserver, requestAutomaticWork } from "../scripts/ai-observer.mjs";

const profile = { model: "deepseek-test", effort: "low" };
const task = { id: "current", workspace: "/project", title: "修复导出", goal: "导出全部记录", status: "in_progress", evidence: ["两条而非三条"], currentStep: "检查缺行" };
const result = { decision: "evidence", reason: "期望与结果有差异", summary: "缺少完整导出证据", findings: [{ severity: "medium", basis: "observed", message: "导出数量不同", evidence_refs: ["evidence:1"] }], next_steps: ["复核数量"] };
async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ai-observer-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const rows = [], jev = []; let time = 1_000_000, calls = 0;
  const options = { workspace: "/project", statePath: join(dir, "ai-observer-state.json"), record: async row => rows.push(row), recordJev: async row => jev.push(row), now: () => time, infer: async () => { calls++; return { text: JSON.stringify(result), model: profile.model }; }, ...overrides };
  const observer = await createAutomaticObserver(options);
  return { observer, rows, jev, options, advance: ms => { time += ms; }, calls: () => calls };
}

test("自动关联活跃任务与新变化，排除其他项目/已结束历史，持久去重", async t => {
  const f = await fixture(t);
  const tasks = [{ ...task, id: "foreign", workspace: "/other" }, { ...task, id: "past", status: "done_claimed" }, task];
  await f.observer.tick(tasks, profile);
  assert.equal(f.calls(), 1); assert.equal(f.rows.at(-1).task_id, task.id); assert.equal(f.rows.at(-1).decision, "evidence");
  assert.equal(f.jev[0].reason, "JEV_NOT_CONFIGURED");
  await f.observer.tick(tasks, profile); assert.equal(f.calls(), 1);
  const restarted = await createAutomaticObserver(f.options);
  await restarted.tick(tasks, profile); assert.equal(f.calls(), 1);
  f.advance(60_001);
  await restarted.tick(tasks.map(item => item.id === task.id ? { ...item, status: "blocked", blocker: "缺行根因未知" } : item), profile);
  assert.equal(f.calls(), 2); assert.equal(f.rows.at(-1).trigger, "task_changed");
  assert.deepEqual(tasks.at(-1), task);
});
test("Jev 自主选择继续观察时不调用 CLI，保留原始判断", async t => {
  const judgement = { status: "succeeded", model: "jev-1.13.0", answers: { participation: { choice: "observe" } }, usage: { input_tokens: 10, output_tokens: 5 } };
  const f = await fixture(t, { judge: async () => judgement });
  await f.observer.tick([task], profile);
  assert.equal(f.calls(), 0); assert.equal(f.rows.at(-1).decision, "observe"); assert.equal(f.rows.at(-1).status, "skipped"); assert.equal(f.jev[0].usage.input_tokens, 10);
});

test("自主分析与模型降级都连接行动队列，observe 不触发行动", async t => {
  const queued = [];
  const f = await fixture(t, { enqueue: async (...args) => queued.push(args) });
  await f.observer.tick([task], profile);
  assert.equal(queued.length, 1); assert.equal(queued[0][0].id, task.id);
  const degraded = await fixture(t, { enqueue: async (...args) => queued.push(args), infer: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } });
  await degraded.observer.tick([task], profile); assert.equal(queued.length, 2);
  const observe = await fixture(t, { enqueue: async (...args) => queued.push(args), judge: async () => ({ status: "succeeded", model: "jev", answers: { participation: { choice: "observe" } } }) });
  await observe.observer.tick([task], profile); assert.equal(queued.length, 2);
});

test("主动处理持久排队，重复请求复用，重启后每项仅处理一次", async t => {
  const f = await fixture(t);
  const runtime = join(f.options.statePath, "..");
  const args = { tasks: [task, { ...task, id: "foreign", workspace: "/other" }], workspace: "/project", profile, runtime };
  const first = await requestAutomaticWork(args);
  assert.deepEqual(first.task_ids, [task.id]);
  assert.equal((await requestAutomaticWork(args)).id, first.id);
  await f.observer.tick(args.tasks, profile, first);
  assert.equal(f.rows.at(-1).trigger, "manual_work");
  const restarted = await createAutomaticObserver(f.options);
  await restarted.tick(args.tasks, profile, first);
  assert.equal(f.calls(), 1);
  const next = await requestAutomaticWork(args);
  assert.notEqual(next.id, first.id);
  await restarted.tick(args.tasks, profile, next);
  assert.equal(f.calls(), 2);
});

test("全项目范围显式启用且待确认任务优先，不被 Jev observe 忽略", async t => {
  const f = await fixture(t, { judge: async () => ({ status: "succeeded", model: "jev", answers: { participation: { choice: "observe" } } }) });
  const foreign = { ...task, id: "foreign", workspace: "/other", executionReconciliation: { state: "execution_unconfirmed", basis: "run:completed" } };
  const all = { ...profile, automatic: { scope: "all_projects" } };
  await f.observer.tick([task, foreign], all);
  assert.equal(f.calls(), 1);
  assert.equal(f.rows.at(-1).task_id, foreign.id);
  assert.equal(f.rows.at(-1).decision, "evidence");
});

test("慢对账不阻塞受理，后台成功和失败分别留回执", async t => {
  const f = await fixture(t);
  const rows = []; let finish;
  const work = await requestAutomaticWork({ tasks: [task], workspace: "/project", profile, runtime: join(f.options.statePath, ".."), record: async row => rows.push(row), reconcile: () => new Promise(resolve => { finish = resolve; }) });
  assert.equal(rows[0].status, "started");
  assert.equal(JSON.parse(await readFile(join(f.options.statePath, "..", "ai-work-request.json"), "utf8")).id, work.id);
  await new Promise(setImmediate);
  assert.equal(typeof finish, "function");
  assert.equal(rows.length, 1, "对账仍未完成时请求已经返回且持久化");
  finish({ actions: [{ task_id: task.id, action: "recovery_pending" }], findings: [] });
  await new Promise(setImmediate);
  assert.equal(rows.at(-1).status, "succeeded");
  assert.equal(rows.at(-1).result.actions.length, 1);
  const failed = await fixture(t);
  await requestAutomaticWork({ tasks: [task], workspace: "/project", profile, runtime: join(failed.options.statePath, ".."), record: async row => rows.push(row), reconcile: async () => { throw new Error("probe"); } });
  await new Promise(setImmediate); await new Promise(setImmediate);
  assert.equal(rows.at(-1).status, "failed");
  assert.equal(rows.at(-1).error, "RECONCILIATION_FAILED");
});

test("主动处理 CLI 失败仍消化队列并记录降级，不改变任务", async t => {
  const f = await fixture(t, { infer: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } });
  const tasks = [task, { ...task, id: "second" }];
  const request = { id: "request-test", task_ids: tasks.map(item => item.id) };
  await f.observer.tick(tasks, profile, request);
  await f.observer.tick(tasks, profile, request);
  assert.equal(f.rows.filter(row => row.status === "degraded").length, 2);
  await f.observer.tick(tasks, profile, request);
  assert.equal(f.rows.filter(row => row.status === "degraded").length, 2);
  assert.equal(task.status, "in_progress");
});
test("快照版本升级仅重建已结束历史的基线，之后真实变化仍参与", async t => {
  const f = await fixture(t);
  await writeFile(f.options.statePath, JSON.stringify({ tasks: { past: { hash: "legacy-snapshot", handled_at: 1 } }, cooldown_until: 0 }));
  const observer = await createAutomaticObserver(f.options);
  const past = { ...task, id: "past", status: "done_claimed" };
  await observer.tick([past], profile);
  assert.equal(f.calls(), 0); assert.equal(f.rows.length, 0);
  assert.equal(JSON.parse(await readFile(f.options.statePath, "utf8")).tasks.past.snapshot_version, "collaboration-v1");
  f.advance(60_001);
  await observer.tick([{ ...past, evidence: ["新增实际证据"] }], profile);
  assert.equal(f.calls(), 1);
});
test("CLI 缺失只失败一次，其他快照规则降级，冷却不阻塞或改写任务", async t => {
  let calls = 0;
  const f = await fixture(t, { infer: async () => { calls++; throw Object.assign(new Error("missing"), { code: "ENOENT" }); } });
  await f.observer.tick([task], profile);
  assert.equal(f.rows.at(-1).fallback_reason, "AI_CLI_UNAVAILABLE");
  await f.observer.tick([{ ...task, id: "second" }], profile);
  assert.equal(calls, 1); assert.equal(f.rows.at(-1).fallback_reason, "AI_COOLDOWN");
  assert.equal(f.observer.health.status, "watching");
  f.advance(300_001);
  await f.observer.tick([{ ...task, id: "third" }], profile); assert.equal(calls, 2);
});
test("重复 tick 不产生并发推理；任务新的完成声明仍自动分析", async t => {
  let release, calls = 0;
  const f = await fixture(t, { infer: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const pending = f.observer.tick([task], profile);
  for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 2));
  await f.observer.tick([task], profile); assert.equal(calls, 1); assert.equal(f.observer.health.current_task_id, task.id);
  release({ text: JSON.stringify(result), model: profile.model }); await pending;
  const next = f.observer.tick([{ ...task, id: "new-completion", status: "done_claimed" }], profile);
  for (let i = 0; i < 100 && calls < 2; i++) await new Promise(resolve => setTimeout(resolve, 2));
  release({ text: JSON.stringify(result), model: profile.model }); await next;
  assert.equal(calls, 2);
});
test("快照或判断理由疑似秘密时不发送或保存该秘密", async t => {
  const f = await fixture(t);
  await f.observer.tick([{ ...task, goal: "api_key=abcdefghijklmnop" }], profile);
  assert.equal(f.calls(), 0); assert.equal(f.rows.at(-1).error, "AI_SUSPECTED_SECRET");
  assert.ok(!JSON.stringify(f.rows).includes("abcdefghijklmnop"));
  const invalid = await fixture(t, { infer: async () => ({ text: JSON.stringify({ ...result, reason: "api_key=abcdefghijklmnop" }) }) });
  await invalid.observer.tick([task], profile);
  assert.equal(invalid.rows.at(-1).status, "degraded"); assert.ok(!JSON.stringify(invalid.rows).includes("abcdefghijklmnop"));
});

test("测试和候选进程即使配置启用也不启动模型或写行为日志", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ai-disabled-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, "config.json"), audit = join(dir, "audit.jsonl");
  await writeFile(config, JSON.stringify({ harness: "claude", model: "deepseek-test", effort: "low", automatic: { enabled: true } }));
  for (const flag of ["TASKCENTER_AI_OBSERVER_DISABLED", "TASKCENTER_DISPATCH_DRY_RUN"]) {
    await promisify(execFile)(process.execPath, ["scripts/ai-observer.mjs"], { timeout: 5000, env: { ...process.env, TASKCENTER_AI_CONFIG_PATH: config, TASKCENTER_RUNTIME_DIR: dir, TASKCENTER_AI_ACTIVITY_PATH: audit, TASKCENTER_AI_OBSERVER_DISABLED: "0", TASKCENTER_DISPATCH_DRY_RUN: "0", [flag]: "1" } });
    assert.equal(JSON.parse(await readFile(join(dir, "ai-observer-health.json"), "utf8")).status, "disabled");
    await assert.rejects(readFile(audit), { code: "ENOENT" });
  }
});
