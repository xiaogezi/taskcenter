import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAutomaticObserver, requestAutomaticWork } from "../scripts/ai-observer.mjs";

const profile = { model: "deepseek-test", effort: "low" };
const task = { id: "current", workspace: "/project", title: "修复导出", goal: "导出全部记录", status: "blocked", blocker: "导出缺行", evidence: ["两条而非三条"], currentStep: "检查缺行" };
const result = { decision: "evidence", reason: "期望与结果有差异", summary: "缺少完整导出证据", findings: [{ severity: "medium", basis: "observed", message: "导出数量不同", evidence_refs: ["evidence:1"] }], next_steps: ["复核数量"] };

test("正常计划和执行进度仅本地观察，不调用任何模型", async t => {
  const f = await fixture(t, { judge: async () => assert.fail("正常进度无需Jev") });
  for (const status of ["planned", "in_progress"]) {
    for (let i = 0; i < 3; i++) {
      f.advance(60_001);
      await f.observer.tick([{ ...task, status, blocker: "", currentStep: `步骤${i}`, currentSubject: { type: "git_commit", value: String(i) } }], profile);
    }
  }
  assert.equal(f.calls(), 0);
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].model, "rules");
});

test("同一阻塞不因进度Subject和证据更新反复分析，真实新阻塞仍参与", async t => {
  const f = await fixture(t);
  await f.observer.tick([task], profile);
  const restarted = await createAutomaticObserver(f.options);
  for (let i = 0; i < 3; i++) {
    f.advance(300_001);
    await restarted.tick([{ ...task, currentStep: `步骤${i}`, evidence: [`证据${i}`], currentSubject: { type: "git_commit", value: String(i) } }], profile);
  }
  assert.equal(f.calls(), 1);
  f.advance(60_001);
  await restarted.tick([{ ...task, blocker: "新阻塞：权限缺失" }], profile);
  assert.equal(f.calls(), 2);
});

test("回合结束和恢复记录反复变化不把正常长测变成模型任务", async t => {
  const f = await fixture(t, { judge: async () => assert.fail("生命周期对账无需Jev") });
  for (let i = 0; i < 47; i++) {
    f.advance(60_001);
    const observer = i % 2 ? await createAutomaticObserver(f.options) : f.observer;
    await observer.tick([{ ...task, status: "in_progress", blocker: "", currentStep: `长测进度${i}`,
      executionReconciliation: i % 3 ? { state: "execution_unconfirmed", basis: `turn:completed-${i}` } : undefined,
      currentSubject: { type: "git_commit", value: String(i) } }], profile);
  }
  assert.equal(f.calls(), 0);
});

test("异常解除再恢复、其他异常插入及进程重启均不重开已处理信号", async t => {
  const f = await fixture(t);
  for (const blocker of [task.blocker, "", task.blocker, "权限错误", task.blocker]) {
    f.advance(60_001);
    const observer = await createAutomaticObserver(f.options);
    await observer.tick([{ ...task, status: blocker ? "blocked" : "in_progress", blocker }], profile);
  }
  assert.equal(f.calls(), 2);
});

test("真正的验证失败按失败诊断去重，新失败事实可重新分析", async t => {
  const f = await fixture(t);
  const subject = { type: "git_commit", value: "a".repeat(40) };
  const failed = { ...task, status: "in_progress", blocker: "", currentSubject: subject,
    verificationPlan: [{ id: "test", kind: "test", required: true }],
    verificationClaims: [{ id: "claim", requirement_id: "test", kind: "test", subject_ref: subject, status: "failed", summary: "导出缺行" }] };
  await f.observer.tick([failed], profile);
  f.advance(60_001);
  await f.observer.tick([{ ...failed, currentStep: "继续定位", evidence: ["新进度"] }], profile);
  assert.equal(f.calls(), 1);
  f.advance(60_001);
  await f.observer.tick([{ ...failed, verificationClaims: [{ ...failed.verificationClaims[0], summary: "新事实：连接被拒绝" }] }], profile);
  assert.equal(f.calls(), 2);
});

test("主动目标只关联明确名称，无匹配和正常空白巡检均给本地回执", async t => {
  let calls = 0;
  const f = await fixture(t, { infer: async () => { calls++; return { text: JSON.stringify({ ...result, intent_understanding: "处理修复导出任务" }), model: profile.model }; } });
  const rows = [], runtime = join(f.options.statePath, "..");
  const tasks = [task, { ...task, id: "other", title: "整理磁盘" }].map(item => ({ ...item, status: "in_progress", blocker: "" }));
  const args = { tasks, runtime, workspace: "/project", profile, record: async row => rows.push(row) };
  const unknown = await requestAutomaticWork({ ...args, intent: "三个新建任务为什么一直没处理" });
  assert.deepEqual(unknown.task_ids, []);
  assert.match(rows.at(-1).summary, /未找到.*未调用模型/);
  const empty = await requestAutomaticWork(args);
  assert.deepEqual(empty.task_ids, []);
  const work = await requestAutomaticWork({ ...args, intent: "优先修复导出，核对缺行" });
  assert.deepEqual(work.task_ids, [task.id]);
  await f.observer.tick(tasks, profile, work);
  assert.equal(calls, 1);
  assert.equal(f.rows.at(-1).task_id, task.id);
});

test("升级前已排入的广泛意图队列也不能继续遍历无关任务", async t => {
  const f = await fixture(t, { judge: async () => assert.fail("无关目标不判断") });
  const tasks = [task, { ...task, id: "other", title: "整理磁盘" }].map(item => ({ ...item, status: "in_progress", blocker: "" }));
  const request = { id: "legacy-broad-request", task_ids: tasks.map(item => item.id), intent: "三个新建任务为什么一直没处理" };
  await f.observer.tick(tasks, profile, request);
  const restarted = await createAutomaticObserver(f.options);
  await restarted.tick(tasks, profile, request);
  assert.equal(f.calls(), 0);
  assert.equal(f.jev.length, 0);
  const saved = JSON.parse(await readFile(f.options.statePath, "utf8"));
  for (const item of tasks) {
    assert.equal(saved.tasks[item.id].request_id, request.id);
    assert.equal(saved.tasks[item.id].work_result.status, "skipped");
  }
});

test("自动分析失败不对相同异常无限重试，主动请求仍可明确重试", async t => {
  let calls = 0;
  const f = await fixture(t, { infer: async () => { calls++; throw new Error("failed"); } });
  await f.observer.tick([task], profile);
  const restarted = await createAutomaticObserver(f.options);
  for (let i = 0; i < 3; i++) {
    f.advance(300_001); await restarted.tick([task], profile);
  }
  assert.equal(calls, 1);
  await restarted.tick([task], profile, { id: "explicit-retry", task_ids: [task.id], intent: "重试修复导出" });
  assert.equal(calls, 2);
});

test("缺少完成登记与Subject变化由本地处理，不自动调用模型", async t => {
  const f = await fixture(t);
  const done = { ...task, status: "done_claimed", blocker: "", currentSubject: { type: "git_commit", value: "commit-1", observed_at: "2026-10-15T00:00:00Z" } };
  await f.observer.tick([task], profile);
  f.advance(60_001); await f.observer.tick([done], profile);
  assert.equal(f.calls(), 1);
  f.advance(60_001);
  await f.observer.tick([{ ...done, currentSubject: { ...done.currentSubject, observed_at: "2026-10-15T01:00:00Z" } }], profile);
  assert.equal(f.calls(), 1);
});

test("确认会话缺失由本地对账归档，不调用模型或进入接续队列", async t => {
  let queued;
  const f = await fixture(t, { infer: async () => assert.fail("确定性归档无需模型"), enqueue: async (...args) => { queued = args; } });
  for (const basis of ["session_missing", "owner_inactive"]) {
    const orphan = { ...task, executionReconciliation: { basis, state: "recovery_pending" } };
    await f.observer.tick([orphan], profile);
    assert.equal(queued, undefined);
    const work = await requestAutomaticWork({ tasks: [orphan], workspace: "/project", profile, runtime: join(f.options.statePath, "..") });
    assert.deepEqual(work.task_ids, []);
  }
});

test("CLI失败后重启和冷却结束不重复推理，新明确请求才能重试", async t => {
  let calls = 0;
  const f = await fixture(t, { infer: async () => {
    if (++calls === 1) throw new Error("temporary failure");
    return { text: JSON.stringify({ ...result, intent_understanding: "继续原目标" }), model: profile.model };
  } });
  const request = { id: "retry-intent", task_ids: [task.id], intent: "核对修复导出" };
  await f.observer.tick([task], profile, request);
  assert.equal(f.rows.at(-1).status, "degraded");
  const restarted = await createAutomaticObserver(f.options);
  f.advance(299_999);
  await restarted.tick([task], profile, request);
  assert.equal(calls, 1);
  f.advance(1);
  await restarted.tick([task], profile, request);
  assert.equal(calls, 1);
  await restarted.tick([task], profile, { ...request, id: "explicit-new-retry" });
  assert.equal(calls, 2);
  assert.equal(f.rows.at(-1).status, "succeeded");
  assert.equal(f.rows.at(-1).intent, request.intent);
  await restarted.tick([task], profile, { ...request, id: "explicit-new-retry" });
  assert.equal(calls, 2);
  assert.equal(JSON.parse(await readFile(f.options.statePath, "utf8")).tasks[task.id].retry_at, undefined);
});

test("意图持久化、同目标复用，未完成时不同目标明确拒绝，敏感输入不落盘", async t => {
  const f = await fixture(t);
  const args = { tasks: [task], workspace: "/project", profile, runtime: join(f.options.statePath, ".."), intent: " 优先修复导出 " };
  const first = await requestAutomaticWork(args);
  assert.equal(first.intent, "优先修复导出");
  assert.equal((await requestAutomaticWork(args)).id, first.id);
  await assert.rejects(requestAutomaticWork({ ...args, intent: "处理其他任务" }), { statusCode: 409 });
  await assert.rejects(requestAutomaticWork({ ...args, intent: "api_key=abcdefghijklmnop" }), { code: "AI_SUSPECTED_SECRET" });
  await assert.rejects(requestAutomaticWork({ ...args, intent: "x".repeat(2001) }), { statusCode: 400 });
  await assert.rejects(requestAutomaticWork({ ...args, intent: { text: "目标" } }), { statusCode: 400 });
  assert.equal(JSON.parse(await readFile(join(args.runtime, "ai-work-request.json"), "utf8")).intent, first.intent);
});

test("用户意图传入分析及维护，不被 Jev observe 忽略，保存模型理解与结果", async t => {
  let prompt, queued;
  const f = await fixture(t, { judge: async () => ({ status: "succeeded", answers: { participation: { choice: "observe" } } }), infer: async args => { prompt = args.prompt; return { text: `\`\`\`json\n${JSON.stringify({ ...result, intent_understanding: "你希望修复导出缺行，我会核对完整性" })}\n\`\`\``, model: profile.model }; }, enqueue: async (...args) => { queued = args; } });
  const work = { id: "intent-round", task_ids: [task.id], intent: "优先修复导出" };
  await f.observer.tick([{ ...task, status: "in_progress", blocker: "" }], profile, work);
  assert.ok(prompt.includes(work.intent));
  assert.equal(queued[3].intent, work.intent);
  assert.equal(queued[3].request_id, work.id);
  const saved = JSON.parse(await readFile(f.options.statePath, "utf8")).tasks[task.id];
  assert.match(saved.work_result.understanding, /修复导出/);
  assert.equal(saved.work_result.status, "succeeded");
  assert.notEqual(f.rows[0].input_hash, f.rows[0].snapshot.input_hash);
});

test("模型理解含凭据时拒绝保存，规则降级仍保留用户目标", async t => {
  let queued;
  const f = await fixture(t, { infer: async () => ({ text: JSON.stringify({ ...result, intent_understanding: "api_key=abcdefghijklmnop" }) }), enqueue: async (...args) => { queued = args; } });
  await f.observer.tick([task], profile, { id: "intent-round", task_ids: [task.id], intent: "修复导出" });
  assert.equal(f.rows.at(-1).status, "degraded");
  assert.equal(queued[3].intent, "修复导出");
  assert.ok(!JSON.stringify(f.rows).includes("abcdefghijklmnop"));
});
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
  assert.deepEqual(next.task_ids, [], "空白按钮不重开相同异常");
  await restarted.tick(args.tasks, profile, next);
  assert.equal(f.calls(), 1);
});

test("执行待确认不覆盖Jev观察判断，也不优先启动推理", async t => {
  const f = await fixture(t, { judge: async () => ({ status: "succeeded", model: "jev", answers: { participation: { choice: "observe" } } }) });
  const foreign = { ...task, id: "foreign", workspace: "/other", executionReconciliation: { state: "execution_unconfirmed", basis: "run:completed" } };
  const all = { ...profile, automatic: { scope: "all_projects" } };
  await f.observer.tick([task, foreign], all);
  assert.equal(f.calls(), 0);
  assert.equal(f.rows.at(-1).decision, "observe");
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
  assert.equal(task.status, "blocked");
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
  await observer.tick([{ ...past, blocker: "新增实际失败，需要复核", evidence: ["新增实际证据"] }], profile);
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
