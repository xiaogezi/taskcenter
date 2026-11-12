import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createMaintenanceWorker, runClaudeMaintenance, maintenanceOperation, currentMaintenanceAction } from "../scripts/ai-maintenance.mjs";
import { governanceSnapshot } from "../scripts/ai-governance.mjs";

test("操作摘要白名单保留对象，隐藏敏感参数且不包含写入正文", () => {
  assert.equal(maintenanceOperation("Bash", { command: "npm test" }), "运行命令：npm test");
  assert.equal(maintenanceOperation("Write", { file_path: "health.txt", content: "private data" }), "写入文件：health.txt");
  assert.equal(maintenanceOperation("Read", { file_path: "/Users/gezi/private.txt" }), "读取文件：[local-path]");
  assert.match(maintenanceOperation("Bash", { command: "echo token=abc" }), /敏感参数已隐藏/);
  assert.match(maintenanceOperation("Bash", { command: "x".repeat(600) + " Bearer abcdefghijklmnop" }), /敏感参数已隐藏/);
});

test("Claude 维护保留Hook与MCP，沿用指定模型、推理等级和连接", async t => {
  const dir = await mkdtemp(join(tmpdir(), "maintenance-cli-"));
  const previous = process.env.PATH, capture = join(dir, "capture.json");
  t.after(async () => { process.env.PATH = previous; await rm(dir, { recursive: true, force: true }); });
  await writeFile(join(dir, "fixture.mjs"), `import fs from 'node:fs'; for await(const chunk of process.stdin){} fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2)})); console.log(JSON.stringify({type:'result',subtype:'success',modelUsage:{fixture:{}}}));`);
  if (process.platform === "win32") await writeFile(join(dir, "claude.cmd"), '@echo off\n"%dp0%/node.exe" "%dp0%/fixture.mjs" %*');
  else await writeFile(join(dir, "claude"), `#!${process.execPath}\nimport './fixture.mjs';`, { mode: 0o700 });
  process.env.PATH = dir;
  {
    await runClaudeMaintenance({ task: { ...task, workspace: dir }, action: { session_id: "fixture" }, profile: { model: "fixture", effort: "low" }, record: async () => {}, onSpawn: async () => {} });
    const { args } = JSON.parse(await readFile(capture, "utf8"));
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
    assert.ok(settings.hooks.SessionStart); assert.ok(settings.hooks.PreToolUse);
    assert.ok(args.includes("--strict-mcp-config")); assert.equal(args[args.indexOf("--model") + 1], "fixture");
    assert.equal(args[args.indexOf("--effort") + 1], "low");
    assert.equal(settings.env?.ANTHROPIC_BASE_URL, undefined);
  }
  const rows = [];
  const providerMessage = "Function tools with reasoning_effort are not supported; token=never-persist-this";
  await writeFile(join(dir, "fixture.mjs"), `for await(const chunk of process.stdin){} console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,errors:[${JSON.stringify(providerMessage)}]})); process.exitCode=1;`);
  await assert.rejects(runClaudeMaintenance({ task: { ...task, workspace: dir }, action: { session_id: "fixture" }, profile: { model: "fixture", effort: "low" }, record: async row => rows.push(row), onSpawn: async () => {} }), error => error.code === "AI_ACTION_PROTOCOL_UNSUPPORTED" && error.performed_tools === 0);
  assert.equal(rows.at(-1).result.cause, "tools_reasoning_unsupported");
  assert.equal(rows.at(-1).result.exit_code, 1);
  assert.doesNotMatch(JSON.stringify(rows), /never-persist-this/);
  for (const [source, message] of [["assistant", "Responses upstream too_many_requests: token rate limit exceeded"], ["stderr", "HTTP 429"], ["result", "rate_limit_error"]]) {
    rows.length = 0;
    const text = `${message}; token=never-persist-this; private conversation`;
    const emitted = source === "assistant" ? [{ type: "assistant", error: "rate_limit", message: { content: [{ type: "text", text }] } }] : [];
    emitted.push({ type: "result", subtype: "success", ...(source === "result" ? { errors: [text] } : {}) });
    await writeFile(join(dir, "fixture.mjs"), `for await(const chunk of process.stdin){} ${source === "stderr" ? `console.error(${JSON.stringify(text)});` : ""} for(const row of ${JSON.stringify(emitted)}) console.log(JSON.stringify(row)); process.exitCode=1;`);
    await assert.rejects(runClaudeMaintenance({ task: { ...task, workspace: dir }, action: { session_id: "fixture" }, profile: { model: "fixture", effort: "low" }, record: async row => rows.push(row), onSpawn: async () => {} }), error => error.code === "AI_ACTION_RATE_LIMITED" && error.performed_tools === 0);
    assert.deepEqual(rows.at(-1).result, { exit_code: 1, subtype: "success", permission_denials: 0, cause: "rate_limited", tool_calls: 0 });
    assert.doesNotMatch(JSON.stringify(rows), /never-persist-this|private conversation|Responses upstream/);
    t.diagnostic(JSON.stringify({ source, ...rows.at(-1) }));
  }
  rows.length = 0;
  await writeFile(join(dir, "fixture.mjs"), `for await(const chunk of process.stdin){} console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Discuss too_many_requests here'}]}})); console.log(JSON.stringify({type:'result',subtype:'private conversation token=never-persist-this'})); process.exitCode=1;`);
  await assert.rejects(runClaudeMaintenance({ task: { ...task, workspace: dir }, action: { session_id: "fixture" }, profile: { model: "fixture", effort: "low" }, record: async row => rows.push(row), onSpawn: async () => {} }), error => !error.code);
  assert.equal(rows.at(-1).result.cause, "unknown");
  assert.equal(rows.at(-1).result.subtype, "unknown");
  assert.doesNotMatch(JSON.stringify(rows), /private conversation|never-persist-this/);
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

test("普通会话一轮结束、终止或空闲都不授权自动转移任务归属", async t => {
  for (const type of ["task_complete", "turn_aborted"]) {
    const f = await fixture(t, { maintenanceOwned: false, inspect: async () => ({ busy: false, lastTerminal: { type } }) });
    await f.worker.enqueue(task, analysis, profile, { request_id: "manual-work", intent: "检查缺项" });
    await f.worker.tick(profile);
    assert.equal(f.calls(), 0, type);
    assert.equal(f.rows.at(-1).status, "waiting_owner");
    assert.match(f.rows.at(-1).summary, /归属|移交/);
    f.advance(300_001); await f.worker.tick(profile);
    assert.equal(f.calls(), 0);
  }
});

test("旧失败行动的stopped_session_id不能授权接走原会话任务", async t => {
  const f = await fixture(t);
  await writeFile(f.options.statePath, JSON.stringify({ actions: { task: {
    id: "old-action", task_id: task.id, status: "retry_wait", attempts: 1,
    session_id: "failed-maintenance", stopped_session_id: task.sessionId,
  } } }));
  const restarted = await createMaintenanceWorker(f.options);
  await restarted.tick(profile);
  assert.equal(f.calls(), 0);
  assert.equal(f.rows.at(-1).status, "waiting_owner");
});

test("维护自身恢复可跨重启，但归属回到普通会话后停止重试", async t => {
  let calls = 0;
  const f = await fixture(t, { execute: async ({ action }) => {
    calls++; f.update({ sessionId: action.session_id });
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  } });
  await f.worker.enqueue(task, analysis, profile); await f.worker.tick(profile);
  assert.equal(calls, 1);
  f.advance(300_001);
  const restarted = await createMaintenanceWorker(f.options);
  await restarted.tick(profile);
  assert.equal(calls, 2);
  f.update({ sessionId: "user-returned", lastEventId: "user-resumed" });
  f.advance(300_001); await restarted.tick(profile);
  assert.equal(calls, 2);
  assert.equal(f.rows.at(-1).status, "waiting_owner");
});

test("维护自身恢复也保护同工作区活跃宿主", async t => {
  const f = await fixture(t, { tasks: () => [task, { ...task, id: "other", sessionId: "busy-owner" }], inspect: async () => ({ busy: true }) });
  await f.worker.enqueue(task, analysis, profile); await f.worker.tick(profile);
  assert.equal(f.calls(), 0);
  assert.equal(f.rows.at(-1).status, "waiting_owner");
});

test("确认缺失的会话不再默认接续，归档也不会进入维护队列", async t => {
  const orphan = { ...task, agent: "codex", updatedAt: new Date(0).toISOString(), executionReconciliation: { basis: "session_missing" } };
  const f = await fixture(t, { maintenanceOwned: false, tasks: () => [orphan, { ...orphan, id: "other", sessionId: "other" }], inspect: async () => { throw Object.assign(new Error("cleared"), { code: "CODEX_SESSION_NOT_FOUND" }); } });
  for (const basis of ["session_missing", "owner_inactive"]) {
    await f.worker.enqueue({ ...orphan, executionReconciliation: { basis } }, analysis, profile); await f.worker.tick(profile);
  }
  assert.equal(f.calls(), 0);
  assert.equal(f.rows.length, 0);
  await f.worker.enqueue({ ...task, archivedAt: new Date().toISOString() }, analysis, profile);
  assert.equal(f.rows.length, 0);
});

test("旧队列即使处于冷却或attention也撤销缺失会话动作，已归档孤儿不挡其他任务", async t => {
  for (const [status, basis] of ["session_missing", "owner_inactive"].flatMap(basis => ["queued", "retry_wait", "attention"].map(status => [status, basis]))) {
    const f = await fixture(t);
    await f.worker.enqueue(task, analysis, profile);
    const state = await f.state(); state.actions.task.status = status; state.actions.task.retry_at = 9_000_000;
    await writeFile(f.options.statePath, JSON.stringify(state));
    f.update({ executionReconciliation: { basis } });
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
  f = await fixture(t, { execute: async ({ action, onSpawn }) => { calls++; f.update({ sessionId: action.session_id }); await onSpawn(99999999); if (calls === 1) await f.worker.enqueue(task, analysis, profile, { request_id: "new", intent: "检查缺项" }); else assert.equal(action.intent, "检查缺项"); return { tool_calls: 1 }; } });
  await f.worker.enqueue(task, analysis, profile); await f.worker.tick(profile);
  assert.equal(calls, 1);
  assert.equal((await f.state()).actions.task.pending_work.work.intent, "检查缺项");
  await f.worker.tick(profile); await f.worker.tick(profile);
  assert.equal(calls, 2);
});
async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ai-maintenance-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const rows = []; let current = { ...task }, time = 1_000_000, calls = 0;
  const { maintenanceOwned = true, ...workerOverrides } = overrides;
  const options = { statePath: join(dir, "actions.json"), record: async row => rows.push(row), tasks: () => [current], now: () => time,
    inspect: async () => ({ busy: false, lastTerminal: { type: "turn_aborted" } }),
    execute: async () => { calls++; return { tool_calls: 1 }; }, ...workerOverrides };
  // Execution tests recover a task already owned by a prior maintenance host.
  if (maintenanceOwned) await writeFile(options.statePath, JSON.stringify({ actions: { task: {
    id: "prior-maintenance", task_id: task.id, session_id: task.sessionId,
    attempts: 1, status: "attention", pid: 99999999,
  } } }));
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

test("已确认协议不兼容不定时重试，重启后保留原因，显式新授权才重试", async t => {
  let calls = 0;
  const f = await fixture(t, { execute: async ({ onSpawn }) => {
    calls++; await onSpawn(99999999);
    throw Object.assign(new Error("AI_ACTION_CLI_FAILED"), { code: "AI_ACTION_PROTOCOL_UNSUPPORTED", performed_tools: 0 });
  } });
  await f.worker.enqueue(task, analysis, profile); await f.worker.tick(profile);
  assert.equal(f.rows.at(-1).status, "attention");
  assert.equal(f.rows.at(-1).error, "AI_ACTION_PROTOCOL_UNSUPPORTED");
  assert.match(f.rows.at(-1).summary, /停止自动重试/);
  f.advance(300_001);
  const restarted = await createMaintenanceWorker(f.options);
  await restarted.tick(profile); assert.equal(calls, 1);
  await restarted.enqueue(task, analysis, profile, { request_id: "new-authorization", handoff: { task_id: task.id, expected_session_id: task.sessionId, workspace: task.workspace, input_hash: governanceSnapshot(task, "evidence").input_hash } });
  await restarted.tick(profile); assert.equal(calls, 2);
});

test("限流退避跨重启增长、到期仍核对占用，三次后不被自动分析重置", async t => {
  let calls = 0, busy = false;
  const f = await fixture(t, { maintenanceOwned: false, inspect: async () => ({ busy }), execute: async ({ action, onSpawn }) => {
    calls++; f.update({ sessionId: action.session_id }); await onSpawn(99999999);
    throw Object.assign(new Error("AI_ACTION_CLI_FAILED"), { code: "AI_ACTION_RATE_LIMITED", performed_tools: 0 });
  } });
  const current = { ...task, agent: "codex" }; f.update(current);
  await f.worker.enqueue(current, analysis, profile, { request_id: "grant", handoff: { task_id: task.id, expected_session_id: task.sessionId, workspace: task.workspace, input_hash: governanceSnapshot(current, "evidence").input_hash } });
  await f.worker.tick(profile);
  let action = (await f.state()).actions.task;
  assert.equal(action.status, "retry_wait"); assert.equal(action.retry_at, 1_300_000);
  f.advance(299_999);
  const restarted = await createMaintenanceWorker(f.options);
  await restarted.tick(profile); assert.equal(calls, 1);
  f.advance(1); busy = true;
  const withOther = await createMaintenanceWorker({ ...f.options, tasks: () => [{ ...task, sessionId: action.session_id }, { ...task, id: "other", sessionId: "other" }] });
  await withOther.tick(profile); assert.equal(calls, 1);
  busy = false; f.advance(60_001);
  const recovered = await createMaintenanceWorker(f.options);
  await recovered.tick(profile); assert.equal(calls, 2);
  action = (await f.state()).actions.task;
  assert.equal(action.retry_at, 1_960_001);
  await recovered.enqueue({ ...task, lastEventId: "observer-update" }, analysis, profile);
  assert.equal((await f.state()).actions.task.attempts, 2);
  f.advance(599_999); await recovered.tick(profile); assert.equal(calls, 2);
  f.advance(1); await recovered.tick(profile); assert.equal(calls, 3);
  action = (await f.state()).actions.task;
  assert.equal(action.status, "attention"); assert.equal(action.retry_at, null); assert.equal(action.retry_blocked, true);
  assert.equal(f.rows.at(-1).result.retry_reason, "attempts_exhausted");
  t.diagnostic(JSON.stringify(f.rows.at(-1)));
  f.advance(9_000_000);
  const stopped = await createMaintenanceWorker(f.options);
  await stopped.enqueue(task, analysis, profile); await stopped.tick(profile); assert.equal(calls, 3);
});

test("限流前已有工具执行即保留现场，真实PID退出后也不自动重放", async t => {
  let calls = 0, owner;
  const f = await fixture(t, { execute: async ({ action, onSpawn }) => {
    calls++; owner = action.session_id; f.update({ sessionId: owner }); await onSpawn(99999999);
    throw Object.assign(new Error("AI_ACTION_CLI_FAILED"), { code: "AI_ACTION_RATE_LIMITED", performed_tools: 1 });
  } });
  await f.worker.enqueue(task, analysis, profile); await f.worker.tick(profile);
  assert.equal((await f.state()).actions.task.retry_blocked, true);
  assert.equal(f.rows.at(-1).result.retry_reason, "tool_results_require_check");
  f.advance(9_000_000);
  const restarted = await createMaintenanceWorker(f.options);
  await restarted.tick(profile); assert.equal(calls, 1);
  await restarted.enqueue({ ...task, sessionId: owner }, analysis, profile, { request_id: "explicit-recovery" });
  await restarted.tick(profile); assert.equal(calls, 2);
});

test("不抢占运行中的宿主；普通事件变化不丢弃恢复行动", async t => {
  const f = await fixture(t, { maintenanceOwned: false, inspect: async () => ({ busy: true }) });
  await f.worker.enqueue(task, analysis, profile); await f.worker.tick(profile);
  assert.equal(f.calls(), 0); assert.equal(f.rows.at(-1).status, "waiting_owner");
  f.update({ lastEventId: "event-2" }); f.advance(60_001); await f.worker.tick(profile);
  assert.equal(f.calls(), 0); assert.equal((await f.state()).actions.task.status, "queued");
  assert.equal((await f.state()).actions.task.expected_event_id, "event-2");
});

test("首次显式移交跨重启可执行，普通事件不撤销授权", async t => {
  const current = { ...task, agent: "codex" };
  const f = await fixture(t, { maintenanceOwned: false }); f.update(current);
  const handoff = { task_id: task.id, expected_session_id: task.sessionId, workspace: task.workspace, input_hash: governanceSnapshot(current, "evidence").input_hash };
  await f.worker.enqueue(current, analysis, profile, { request_id: "handoff", handoff });
  f.update({ lastEventId: "audit-only" });
  await (await createMaintenanceWorker(f.options)).tick(profile);
  assert.equal(f.calls(), 1);
});

test("显式移交保护原宿主、同工作区宿主及不可读现场", async t => {
  for (const scenario of ["owner_busy", "other_busy", "unknown", "unreadable", "cli"]) {
    const current = { ...task, agent: "codex", ...(scenario === "cli" ? { cliRuns: [{ status: "active" }] } : {}) };
    const f = await fixture(t, { maintenanceOwned: false, tasks: () => [current, { ...task, id: "other", sessionId: "other" }], inspect: async id => {
      if (scenario === "unreadable") throw new Error("read failed");
      return { busy: scenario === "unknown" ? undefined : scenario === "owner_busy" && id === task.sessionId || scenario === "other_busy" && id === "other" };
    } });
    await f.worker.enqueue(current, analysis, profile, { handoff: { task_id: task.id, expected_session_id: task.sessionId, workspace: task.workspace, input_hash: governanceSnapshot(current, "evidence").input_hash } });
    await f.worker.tick(profile); assert.equal(f.calls(), 0, scenario);
  }
});

test("内容变化保留行动但撤销移交，归属变化取消旧授权", async t => {
  for (const update of [{ goal: "另一个目标" }, { sessionId: "new-owner" }, { workspace: "/other" }]) {
    const current = { ...task, agent: "codex" };
    const f = await fixture(t, { maintenanceOwned: false }); f.update(current);
    await f.worker.enqueue(current, analysis, profile, { handoff: { task_id: task.id, expected_session_id: task.sessionId, workspace: task.workspace, input_hash: governanceSnapshot(current, "evidence").input_hash } });
    f.update({ ...update, lastEventId: "changed" }); await f.worker.tick(profile);
    assert.equal(f.calls(), 0);
    const action = (await f.state()).actions.task;
    assert.equal(action.status, update.goal ? "queued" : "cancelled");
    if (update.goal) { assert.equal(action.handoff, undefined); assert.notDeepEqual(action.analysis, analysis); }
  }
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
