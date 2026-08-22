import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = new URL("../", import.meta.url);
const tempDir = await mkdtemp(join(tmpdir(), "taskcenter-ledger-"));
process.env.TASKCENTER_DISABLE_LIVE_SESSION_RECONCILIATION = "1";

const envPaths = {
  TASKCENTER_TASK_EVENTS_PATH: join(tempDir, "task-events.jsonl"),
  TASKCENTER_TASK_LEDGER_PATH: join(tempDir, "task-ledger.json"),
  TASKCENTER_TASK_EVENT_IDS_PATH: join(tempDir, "task-event-ids.json"),
  TASKCENTER_TASK_RECONCILE_PATH: join(tempDir, "task-reconcile.jsonl"),
  TASKCENTER_SESSION_REGISTRY_PATH: join(tempDir, "session-registry.json"),
  TASKCENTER_CONTEXT_TASK_MAP_PATH: join(tempDir, "context-task-map.json"),
  TASKCENTER_CONTEXT_AUDIT_PATH: join(tempDir, "context-sync-events.jsonl"),
  TASKCENTER_DELEGATIONS_PATH: join(tempDir, "delegations.json"),
  TASKCENTER_ROUTING_CONTROL_PATH: join(tempDir, "routing-control.json"),
  TASKCENTER_GATE_SESSION_ALLOWLIST_PATH: join(tempDir, "gate-session-allowlist.json"),
  TASKCENTER_MCP_TOKEN_PATH: join(tempDir, "mcp-token"),
};
for (const [key, value] of Object.entries(envPaths)) {
  process.env[key] = value;
}

const {
  completeContextTasks,
  ensureContextTask,
  getSessionStatuses,
  isContextShadowTask,
  loadTasks,
  loadVisibleTasks,
  reconcileContextShadowTasks,
  reconcileTasks,
  recordTaskEvent,
  recordSessionL0Audit,
  setSessionScheduledReadonlyProfile,
  setSessionScheduledReadonlyScanExemption,
  supersedeContextShadowTask,
  taskCompletionPacket,
  taskCompletionReadiness,
  TaskLedgerError,
  taskTimeState,
} = await import("../scripts/task-ledger.mjs");

async function resetLedger() {
  for (const path of Object.values(envPaths)) {
    await rm(path, { force: true });
  }
}

async function startControlServer(options = {}) {
  const port = 38_000 + (process.pid % 1_000);
  const child = spawn(process.execPath, ["scripts/control-server.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      TASKCENTER_CONTROL_PORT: String(port),
      TASKCENTER_SESSIONS_ROOT: join(tempDir, "sessions"),
      TASKCENTER_MODEL_RATES_PATH: join(tempDir, "model-rates.json"),
      ...envPaths,
      ...options,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForReady(child);
  return { port, child, base: `http://127.0.0.1:${port}` };
}

function taskHeaders() {
  return {
    "Content-Type": "application/json",
    "X-TaskCenter-Task": "mcp",
  };
}

async function runTaskcenterHook(base, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/taskcenter-hook.mjs", "pre-tool-use", "--agent", "codex"], {
      cwd: root,
      env: { ...process.env, TASKCENTER_CONTROL_URL: base, ...envPaths },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function registerHttpSession(base, session_id, identity = {}) {
  const response = await fetch(`${base}/task-events`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({
      type: "session.register",
      session_id,
      workspace: "/work",
      agent: identity.agent || "codex",
      provider: identity.provider || "openai",
      model: identity.model || "gpt-test",
    }),
  });
  assert.equal(response.status, 200);
}

async function writeTransientContextServer(path) {
  const mcpUrl = new URL("node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js", root).href;
  const stdioUrl = new URL("node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js", root).href;
  const zodUrl = new URL("node_modules/zod/index.js", root).href;
  await writeFile(path, `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { McpServer } from ${JSON.stringify(mcpUrl)};
import { StdioServerTransport } from ${JSON.stringify(stdioUrl)};
import { z } from ${JSON.stringify(zodUrl)};

const statePath = process.env.FAKE_CONTEXT_STATE_PATH;
const load = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { observationAttempts: 0, calls: [] };
const save = (state) => writeFileSync(statePath, JSON.stringify(state));
const result = (payload, isError = false) => ({ isError, content: [{ type: "text", text: JSON.stringify(payload) }] });
const schema = z.object({}).passthrough();
const server = new McpServer({ name: "transient-context-test", version: "0.0.0" });

server.registerTool("context.start_task", { inputSchema: schema }, async (input) => result({ task_id: input.task_id || "context-created" }));
server.registerTool("context.report_observation", { inputSchema: schema }, async (input) => {
  const state = load();
  state.observationAttempts += 1;
  state.calls.push({ name: "context.report_observation", eventId: input.event_id });
  save(state);
  return state.observationAttempts === 1 ? result({ error: "TEMPORARY", message: "temporary timeout" }, true) : result({ accepted: true });
});
server.registerTool("context.complete_task", { inputSchema: schema }, async (input) => {
  const state = load();
  state.calls.push({ name: "context.complete_task", eventId: input.event_id });
  save(state);
  return result({ accepted: true });
});

await server.connect(new StdioServerTransport());
`);
}

test("session.register 不误创建任务", async () => {
  await resetLedger();
  const result = recordTaskEvent({ type: "session.register", session_id: "sess-1", workspace: "/work" });
  assert.equal(result.task, null);
  assert.equal(result.idempotent, undefined);
  assert.equal(loadTasks().length, 0);
});

test("scheduled_readonly Profile 绑定已登记 Session 且不创建任务", async () => {
  await resetLedger();
  recordTaskEvent({ type: "session.register", event_id: "sess-scheduled-register", session_id: "sess-scheduled", workspace: "/work" });
  const profile = setSessionScheduledReadonlyProfile("sess-scheduled", {
    profile: "scheduled_readonly",
    automation_id: "cyberrole-agent-context",
    project_id: "cyberrole",
    workspace_root: "/work",
    report_path: "/work/report.md",
    report_mutation: true,
  });
  assert.equal(profile.reportMutation, true);
  assert.equal(setSessionScheduledReadonlyScanExemption("sess-scheduled", true).scanExempt, true);
  assert.equal(setSessionScheduledReadonlyScanExemption("sess-scheduled", false).scanExempt, false);
  assert.equal(getSessionStatuses([], [])[0].scheduledReadonly.automationId, "cyberrole-agent-context");
  assert.equal(loadTasks().length, 0);
  assert.throws(() => setSessionScheduledReadonlyProfile("missing", profile), /尚未登记/);
  recordTaskEvent({ type: "session.register", session_id: "sess-normal", workspace: "/work" });
  assert.throws(() => setSessionScheduledReadonlyScanExemption("sess-normal", true), /未绑定 scheduled_readonly/);
});

test("L0 仅聚合 Session 审计且不创建任务或事件历史", async () => {
  await resetLedger();
  recordTaskEvent({ type: "session.register", session_id: "sess-l0", workspace: "/work" });
  const audit = recordSessionL0Audit("sess-l0", "/work");
  assert.equal(audit.count, 1);
  assert.equal(loadTasks().length, 0);
  assert.equal(getSessionStatuses().find((item) => item.sessionId === "sess-l0").l0Audit.count, 1);
  assert.throws(() => recordSessionL0Audit("not-registered"), /尚未登记/);
});

test("任务 session_id 不在当前会话源时拒绝创建并可清理旧记录", async () => {
  await resetLedger();
  recordTaskEvent({ type: "task.create", session_id: "sess-stale", task_id: "task-stale", title: "旧任务", goal: "旧目标" });
  recordTaskEvent({ type: "task.create", session_id: "sess-current", task_id: "task-current", title: "当前任务", goal: "当前目标" });

  const removed = reconcileTasks(["sess-current"]);
  assert.deepEqual(removed.map((task) => task.id), ["task-stale"]);
  assert.deepEqual(loadTasks().map((task) => task.id), ["task-current"]);
  assert.throws(
    () => recordTaskEvent({ type: "task.create", session_id: "sess-missing", task_id: "task-missing", title: "失配任务", goal: "失配目标" }, { availableSessionIds: ["sess-current"] }),
    (error) => error instanceof TaskLedgerError && error.statusCode === 409,
  );
});

test("任务聚合真实时间和工具调用次数", async () => {
  await resetLedger();
  recordTaskEvent({ type: "task.create", session_id: "sess-metrics", task_id: "task-metrics", event_id: "m-create" });
  recordTaskEvent({ type: "tool.call", session_id: "sess-metrics", task_id: "task-metrics", event_id: "m-tool-1", tool_name: "exec_command" });
  recordTaskEvent({ type: "tool.call", session_id: "sess-metrics", task_id: "task-metrics", event_id: "m-tool-2", tool_name: "exec_command" });
  const task = loadTasks()[0];
  assert.ok(task.startedAt);
  assert.equal(task.toolCalls.exec_command, 2);
  assert.equal(task.actualAt, "");
});

test("估时提醒事件幂等记录且不改变任务运行态", async () => {
  await resetLedger();
  recordTaskEvent({ type: "task.create", session_id: "sess-reminder", task_id: "task-reminder", event_id: "reminder-create", expected_at: "2026-08-16T00:00:00.000Z" });
  const before = loadTasks()[0];
  const input = {
    type: "task.reminder",
    session_id: "sess-reminder",
    task_id: "task-reminder",
    event_id: "reminder-once",
    expected_at: before.expectedAt,
    next_action: "复盘估时偏差并更新时间或拆分任务。",
  };
  const first = recordTaskEvent(input);
  const replay = recordTaskEvent(input);
  assert.equal(first.idempotent, undefined);
  assert.equal(replay.idempotent, true);
  assert.deepEqual(loadTasks()[0], before);
});

test("模型路由决定只追加审计记录，不改变任务状态", async () => {
  await resetLedger();
  recordTaskEvent({
    type: "session.register",
    session_id: "sess-routing",
    event_id: "routing-register",
    agent: "codex",
    provider: "openai",
    model: "gpt-5.6-sol",
    workspace: "/work",
  });
  recordTaskEvent({
    type: "task.create",
    session_id: "sess-routing",
    task_id: "task-routing",
    event_id: "routing-create",
    status: "blocked",
    blocker: "等待外部依赖。",
  });
  const executionState = loadTasks()[0];
  const firstInput = {
    type: "routing.decision",
    session_id: "sess-routing",
    task_id: "task-routing",
    event_id: "routing-native",
    routing_action: "delegate_native",
    orchestrator_model: "gpt-5.6-sol",
    preferred_executor_model: "gpt-5.3-codex-spark",
    selected_executor_model: "gpt-5.3-codex-spark",
    dispatch_channel: "native",
    routing_reason: "任务边界清晰，可独立验证。",
  };
  const first = recordTaskEvent(firstInput);
  assert.equal(first.task.status, "blocked");
  assert.equal(first.task.blocker, "等待外部依赖。");
  assert.equal(first.task.updatedAt, executionState.updatedAt);
  assert.equal(first.task.lastEventId, executionState.lastEventId);
  assert.equal(first.task.routing.action, "delegate_native");
  assert.equal(first.task.routing.outcome, "selected");
  assert.equal(first.task.routing.policyVersion, "soft-routing-v1");
  assert.equal(first.task.routingHistory.length, 1);
  assert.ok(first.task.routingRecordedAt);
  const session = getSessionStatuses().find((item) => item.sessionId === "sess-routing");
  assert.equal(session.agent, "codex");
  assert.equal(session.provider, "openai");
  assert.equal(session.model, "gpt-5.6-sol");

  const replay = recordTaskEvent(firstInput);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.task.routingHistory.length, 1);
  assert.throws(
    () => recordTaskEvent({ ...firstInput, routing_reason: "尝试篡改既有路由原因。" }),
    (error) => error instanceof TaskLedgerError && error.statusCode === 409,
  );

  const fallback = recordTaskEvent({
    ...firstInput,
    event_id: "routing-cli",
    routing_action: "fallback_cli",
    dispatch_channel: "cli",
    routing_reason: "原生派发不可用，改用 CLI 兜底。",
    routing_outcome: "started",
  });
  assert.equal(fallback.task.status, "blocked");
  assert.equal(fallback.task.blocker, "等待外部依赖。");
  assert.equal(fallback.task.updatedAt, executionState.updatedAt);
  assert.equal(fallback.task.routing.action, "fallback_cli");
  assert.equal(fallback.task.routingHistory.length, 2);
  assert.throws(
    () => recordTaskEvent({ ...firstInput, event_id: "routing-invalid", dispatch_channel: "cli" }),
    (error) => error instanceof TaskLedgerError && error.statusCode === 400,
  );
});

test("已登记的外部 Session 不被 Codex 会话清理误删", async () => {
  await resetLedger();
  recordTaskEvent({
    type: "session.register",
    session_id: "external-session",
    workspace: "/work/Atlas",
    agent: "claude",
    provider: "anthropic",
    model: "claude-test",
  });
  recordTaskEvent({
    type: "task.create",
    session_id: "external-session",
    task_id: "external-task",
    title: "外部任务",
    goal: "验证外部 Session 任务闭环",
  });

  const removed = reconcileTasks(["codex-session"]);
  assert.deepEqual(removed, []);
  assert.equal(loadTasks()[0].id, "external-task");

  recordTaskEvent({ type: "task.update", session_id: "external-session", task_id: "external-task", current_step: "已保留" });
  recordTaskEvent({ type: "task.report", session_id: "external-session", task_id: "external-task", status: "done_claimed", tests: ["人工验证清理后结果"] });
  assert.equal(loadTasks()[0].status, "done_claimed");
});

test("task.create 返回 accepted 与 task_id 并持久化", async () => {
  await resetLedger();
  const result = recordTaskEvent({
    type: "task.create",
    session_id: "sess-1",
    task_id: "task-1",
    title: "实现闸门",
    goal: "完成会话任务闸门",
    acceptance_criteria: ["可创建任务"],
    plan: ["登记 session", "创建任务"],
  });
  assert.equal(result.task.id, "task-1");
  assert.equal(result.task.status, "planned");
  assert.equal(result.task.title, "实现闸门");
  assert.equal(result.task.goal, "完成会话任务闸门");
  assert.equal(loadTasks().length, 1);
});

test("Context semantic task 跨 Turn 复用同一执行任务，只有 complete 才结束", async () => {
  await resetLedger();
  const first = ensureContextTask({
    context_task_id: "context-semantic-1",
    session_id: "context-session-1",
    workspace: "/work",
    semantic_label: "多环境数据生命周期设计",
    agent: "codex",
  });
  const second = ensureContextTask({
    context_task_id: "context-semantic-1",
    session_id: "context-session-1",
    workspace: "/work",
    semantic_label: "多环境数据生命周期设计",
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.task.id, first.task.id);
  assert.equal(second.task.contextTaskId, "context-semantic-1");
  assert.equal(second.task.status, "in_progress");

  const completed = completeContextTasks({ context_task_id: "context-semantic-1", summary: "设计完成" });
  assert.equal(completed.completed.length, 1);
  assert.equal(completed.completed[0].status, "done_claimed");

  const resumed = ensureContextTask({
    context_task_id: "context-semantic-1",
    session_id: "context-session-1",
    workspace: "/work",
  });
  assert.equal(resumed.reactivated, true);
  assert.equal(resumed.task.id, first.task.id);
  assert.equal(resumed.task.status, "in_progress");
  assert.equal(resumed.task.actualAt, "");

  const completedAgain = completeContextTasks({ context_task_id: "context-semantic-1", summary: "补充工作完成" });
  assert.equal(completedAgain.completed.length, 1);
  assert.equal(completedAgain.completed[0].status, "done_claimed");
});

test("正式任务原子接管同 Session、同 Context 的内部影子且不会被重新激活", async () => {
  await resetLedger();
  const shadow = ensureContextTask({
    context_task_id: "context-semantic-adopt",
    session_id: "session-adopt",
    workspace: "/work",
    semantic_label: "内部占位",
  }).task;
  assert.equal(isContextShadowTask(shadow), true);

  const created = recordTaskEvent({
    type: "task.create",
    event_id: "formal-create",
    task_id: "task-formal",
    context_task_id: "context-semantic-adopt",
    session_id: "session-adopt",
    title: "正式业务任务",
    goal: "完成业务目标",
    status: "in_progress",
  });
  assert.deepEqual(created.supersededTaskIds, [shadow.id]);
  assert.deepEqual(created.task.adoptedTaskIds, [shadow.id]);

  const shadowAfterAdoption = loadTasks().find((task) => task.id === shadow.id);
  assert.equal(shadowAfterAdoption.status, "cancelled");
  assert.equal(shadowAfterAdoption.supersededBy, "task-formal");
  assert.ok(shadowAfterAdoption.archivedAt);
  assert.deepEqual(loadVisibleTasks().map((task) => task.id), ["task-formal"]);

  const ensured = ensureContextTask({
    context_task_id: "context-semantic-adopt",
    session_id: "session-adopt",
    workspace: "/work",
  });
  assert.equal(ensured.task.id, "task-formal");
  assert.equal(ensured.created, false);

  recordTaskEvent({
    type: "task.report",
    event_id: "formal-done",
    task_id: "task-formal",
    context_task_id: "context-semantic-adopt",
    session_id: "session-adopt",
    status: "done_claimed",
    tests: ["npm test"],
  });
  const nextTurn = ensureContextTask({
    context_task_id: "context-semantic-adopt",
    session_id: "session-adopt",
    workspace: "/work",
  });
  assert.equal(isContextShadowTask(nextTurn.task), true);
  assert.notEqual(nextTurn.task.id, shadow.id);
  assert.equal(loadTasks().find((task) => task.id === "task-formal").status, "done_claimed");

  const beforeRestartReconciliation = reconcileContextShadowTasks();
  assert.deepEqual(beforeRestartReconciliation.reconciled, []);
  assert.equal(loadTasks().find((task) => task.id === nextTurn.task.id).status, "in_progress");

  const followUp = recordTaskEvent({
    type: "task.create",
    event_id: "formal-follow-up-create",
    task_id: "task-formal-follow-up",
    context_task_id: "context-semantic-adopt",
    session_id: "session-adopt",
    title: "正式后续任务",
    goal: "完成后续业务目标",
    status: "in_progress",
  });
  assert.deepEqual(followUp.supersededTaskIds, [nextTurn.task.id]);
  assert.equal(loadTasks().find((task) => task.id === "task-formal").status, "done_claimed");
  assert.equal(loadTasks().find((task) => nextTurn.task.id === task.id).supersededBy, "task-formal-follow-up");
  assert.deepEqual(loadVisibleTasks().map((task) => [task.id, task.status]), [
    ["task-formal", "done_claimed"],
    ["task-formal-follow-up", "in_progress"],
  ]);
  const ensuredFollowUp = ensureContextTask({
    context_task_id: "context-semantic-adopt",
    session_id: "session-adopt",
    workspace: "/work",
  });
  assert.equal(ensuredFollowUp.task.id, "task-formal-follow-up");
});

test("影子接管严格校验生成 ID、Session 和人工指定的正式替代任务", async () => {
  await resetLedger();
  const shadow = ensureContextTask({
    context_task_id: "context-legacy-link",
    session_id: "session-legacy",
    workspace: "/work",
  }).task;
  recordTaskEvent({
    type: "task.create",
    task_id: "context-not-a-generated-shadow",
    session_id: "session-legacy",
    title: "历史正式任务",
    goal: "历史目标",
    status: "done_claimed",
    tests: ["历史任务完成"],
  });
  assert.equal(isContextShadowTask("context-not-a-generated-shadow"), false);

  const reconciled = supersedeContextShadowTask(shadow.id, "context-not-a-generated-shadow", "人工确认历史映射");
  assert.equal(reconciled.task.status, "cancelled");
  assert.equal(reconciled.task.supersededBy, "context-not-a-generated-shadow");
  assert.throws(
    () => supersedeContextShadowTask(shadow.id, "missing-task"),
    (error) => error instanceof TaskLedgerError && error.statusCode === 404,
  );

  const mismatchedShadow = ensureContextTask({
    context_task_id: "context-mismatch-a",
    session_id: "session-mismatch",
    workspace: "/work",
  }).task;
  recordTaskEvent({
    type: "task.create",
    task_id: "task-mismatch-b",
    context_task_id: "context-mismatch-b",
    session_id: "session-mismatch",
    title: "不同 semantic task",
    goal: "验证误链防护",
  });
  assert.throws(
    () => supersedeContextShadowTask(mismatchedShadow.id, "task-mismatch-b"),
    (error) => error instanceof TaskLedgerError && error.statusCode === 409,
  );
});

test("未创建任务就 update/report 返回 404", async () => {
  await resetLedger();
  assert.throws(
    () => recordTaskEvent({ type: "task.update", session_id: "sess-1", task_id: "ghost", current_step: "x" }),
    (error) => error instanceof TaskLedgerError && error.statusCode === 404,
  );
  assert.throws(
    () => recordTaskEvent({ type: "task.report", session_id: "sess-1", task_id: "ghost", status: "done_claimed" }),
    (error) => error instanceof TaskLedgerError && error.statusCode === 404,
  );
});

test("session 归属不匹配时返回 403", async () => {
  await resetLedger();
  recordTaskEvent({
    type: "task.create",
    session_id: "sess-1",
    task_id: "task-1",
    title: "t",
    goal: "g",
    acceptance_criteria: ["a"],
    plan: ["p"],
  });
  assert.throws(
    () => recordTaskEvent({ type: "task.update", session_id: "sess-OTHER", task_id: "task-1", current_step: "x" }),
    (error) => error instanceof TaskLedgerError && error.statusCode === 403,
  );
});

test("不同 session 对同一 task_id 的 task.create 返回 403 而非幂等", async () => {
  await resetLedger();
  const first = recordTaskEvent({
    type: "task.create",
    session_id: "sess-1",
    task_id: "task-1",
    title: "t",
    goal: "g",
    acceptance_criteria: ["a"],
    plan: ["p"],
  });
  assert.equal(first.task.id, "task-1");
  assert.equal(first.idempotent, undefined);

  // 同一 session 重复创建应幂等返回
  const sameSession = recordTaskEvent({
    type: "task.create",
    session_id: "sess-1",
    task_id: "task-1",
    title: "t2",
    goal: "g2",
    acceptance_criteria: ["a2"],
    plan: ["p2"],
  });
  assert.equal(sameSession.idempotent, true);
  assert.equal(sameSession.task.title, "t"); // 标题保持原值，不更新

  // 不同 session 尝试复用同一 task_id 必须返回 403
  assert.throws(
    () => recordTaskEvent({
      type: "task.create",
      session_id: "sess-OTHER",
      task_id: "task-1",
      title: "hijack",
      goal: "hijack",
      acceptance_criteria: ["hijack"],
      plan: ["hijack"],
    }),
    (error) => error instanceof TaskLedgerError && error.statusCode === 403,
  );

  // 任务列表仍然只有一条，未被篡改
  const tasks = loadTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].sessionId, "sess-1");
});

test("事件幂等：重复 event_id 不重放副作用", async () => {
  await resetLedger();
  const create = { type: "task.create", session_id: "sess-1", task_id: "task-1", event_id: "evt-create", title: "t", goal: "g", acceptance_criteria: ["a"], plan: ["p"] };
  const first = recordTaskEvent(create);
  assert.equal(first.idempotent, undefined);
  const second = recordTaskEvent(create);
  assert.equal(second.idempotent, true);
  assert.equal(loadTasks().length, 1);
  assert.equal(second.task.updatedAt, first.task.updatedAt);

  const update = { type: "task.update", session_id: "sess-1", task_id: "task-1", event_id: "evt-update", current_step: "doing" };
  recordTaskEvent(update);
  const dupUpdate = recordTaskEvent(update);
  assert.equal(dupUpdate.idempotent, true);
  const task = loadTasks()[0];
  assert.equal(task.currentStep, "doing");
  assert.equal(task.updatedAt, dupUpdate.task.updatedAt);
});

test("done_claimed 不会自动变 verified，会话也不能直接 set verified", async () => {
  await resetLedger();
  recordTaskEvent({
    type: "task.create",
    session_id: "sess-1",
    task_id: "task-1",
    title: "t",
    goal: "g",
    acceptance_criteria: ["a"],
    plan: ["p"],
  });
  recordTaskEvent({
    type: "task.report",
    session_id: "sess-1",
    task_id: "task-1",
    status: "done_claimed",
    changed_files: ["x.ts"],
    tests: ["npm test"],
  });
  assert.equal(loadTasks()[0].status, "done_claimed");

  assert.throws(
    () => recordTaskEvent({ type: "task.update", session_id: "sess-1", task_id: "task-1", status: "verified" }),
    (error) => error instanceof TaskLedgerError && error.statusCode === 400,
  );
  // 状态仍然停留在 done_claimed，没有升级为 verified
  assert.equal(loadTasks()[0].status, "done_claimed");
});

test("done_claimed 未附 tests 或 evidence 时拒绝", async () => {
  await resetLedger();
  recordTaskEvent({
    type: "task.create",
    session_id: "sess-1",
    task_id: "task-claim",
    title: "无证据完成声明",
    goal: "验证边界",
    acceptance_criteria: ["a"],
    plan: ["p"],
  });
  assert.throws(
    () => recordTaskEvent({ type: "task.report", session_id: "sess-1", task_id: "task-claim", status: "done_claimed" }),
    (error) => error instanceof TaskLedgerError && error.statusCode === 400,
  );
  recordTaskEvent({
    type: "task.report",
    session_id: "sess-1",
    task_id: "task-claim",
    status: "done_claimed",
    tests: ["npm test"],
  });
  assert.equal(loadTasks()[0].status, "done_claimed");
});

test("v2 完成证据追加幂等、就绪度与 Completion Packet 闭环", async () => {
  await resetLedger();
  recordTaskEvent({
    type: "task.create", event_id: "completion-create", session_id: "completion-session", task_id: "completion-task",
    title: "完成闭环", goal: "验证完成闭环", acceptance_criteria: ["功能通过"], plan: ["实现"],
    contract_version: "v2", scope: ["scripts/"], non_goals: [], workflow_profile: "standard",
    review_policy: "not_required", execution_environment: "local",
    verification_plan: [{ id: "tests", title: "单元测试", kind: "test", required: true }],
  });
  assert.throws(
    () => recordTaskEvent({ type: "task.report", event_id: "completion-forged-accepted", session_id: "completion-session", task_id: "completion-task", status: "accepted" }),
    (error) => error instanceof TaskLedgerError && error.statusCode === 400,
  );
  recordTaskEvent({
    type: "task.report", event_id: "completion-done", session_id: "completion-session", task_id: "completion-task",
    status: "done_claimed", tests: ["node --test"], revision: "revision-a",
  });
  recordTaskEvent({
    type: "requirement.reported", event_id: "completion-requirement", session_id: "completion-session", task_id: "completion-task",
    requirement_result: { requirement_id: "acceptance-1", status: "passed", evidence_refs: ["claim-tests"], checked_by: "codex", revision: "revision-a" },
  });
  const claim = {
    type: "verification.reported", event_id: "completion-verification", session_id: "completion-session", task_id: "completion-task", revision: "revision-a",
    verification_claim: {
      id: "claim-tests", requirement_id: "tests", kind: "test", command_or_probe: "node --test", status: "passed", exit_code: 0,
      revision: "revision-a", observed_at: "2026-08-17T00:00:00.000Z", producer: "codex", producer_session_id: "completion-session",
      evidence_ref: "summary:passed", artifact_refs: [], summary: "通过",
    },
  };
  const first = recordTaskEvent(claim);
  const replay = recordTaskEvent(claim);
  assert.equal(first.task.verificationClaims.length, 1);
  assert.equal(replay.idempotent, true);
  assert.equal(loadTasks()[0].verificationClaims.length, 1);
  assert.equal(taskCompletionReadiness("completion-task").ready, true);
  assert.equal(taskCompletionPacket("completion-task").acceptanceStatus, "ready");
  recordTaskEvent({ type: "task.update", event_id: "completion-revision-change", session_id: "completion-session", task_id: "completion-task", revision: "revision-b" });
  const auditTypes = (await readFile(envPaths.TASKCENTER_TASK_EVENTS_PATH, "utf8")).trim().split("\n").map((line) => JSON.parse(line).type);
  assert.ok(auditTypes.includes("acceptance.ready"));
  assert.ok(auditTypes.includes("verification.staled"));
  assert.equal(taskCompletionReadiness("completion-task").ready, false);
});

test("普通任务事件不能验收，可信 Context 同步才可 accepted", async (context) => {
  await resetLedger();
  const { base, child } = await startControlServer({ TASKCENTER_CONTEXT_ACCEPTANCE_TOKEN: "context-test-token" });
  context.after(() => child.kill("SIGTERM"));
  await registerHttpSession(base, "acceptance-session");
  const createBody = {
    type: "task.create", event_id: "acceptance-create", session_id: "acceptance-session", task_id: "acceptance-task",
    context_task_id: "context-acceptance", title: "可信验收", goal: "验证可信验收", acceptance_criteria: ["功能通过"], plan: ["实现"],
    contract_version: "v2", scope: ["scripts/"], non_goals: [], workflow_profile: "standard", review_policy: "not_required",
    execution_environment: "local", verification_plan: [{ id: "tests", title: "测试", kind: "test", required: true }],
  };
  assert.equal((await fetch(`${base}/task-events`, { method: "POST", headers: taskHeaders(), body: JSON.stringify(createBody) })).status, 201);
  const events = [
    { type: "task.report", event_id: "acceptance-done", session_id: "acceptance-session", task_id: "acceptance-task", status: "done_claimed", tests: ["passed"], revision: "revision-a" },
    { type: "requirement.reported", event_id: "acceptance-requirement", session_id: "acceptance-session", task_id: "acceptance-task", requirement_result: { requirement_id: "acceptance-1", status: "passed", evidence_refs: ["claim-tests"] } },
    { type: "verification.reported", event_id: "acceptance-verification", session_id: "acceptance-session", task_id: "acceptance-task", revision: "revision-a", verification_claim: { id: "claim-tests", requirement_id: "tests", kind: "test", status: "passed", exit_code: 0, revision: "revision-a", observed_at: "2026-08-17T00:00:00.000Z", producer: "codex", producer_session_id: "acceptance-session", evidence_ref: "summary:passed" } },
  ];
  for (const event of events) assert.equal((await fetch(`${base}/task-events`, { method: "POST", headers: taskHeaders(), body: JSON.stringify(event) })).status, 200);

  const forged = await fetch(`${base}/task-events`, {
    method: "POST", headers: taskHeaders(),
    body: JSON.stringify({ type: "acceptance.accepted", event_id: "forged-acceptance", session_id: "acceptance-session", task_id: "acceptance-task" }),
  });
  assert.equal(forged.status, 403);
  const denied = await fetch(`${base}/task-acceptance-sync`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-TaskCenter-Context-Token": "wrong" }, body: JSON.stringify({ task_id: "acceptance-task" }),
  });
  assert.equal(denied.status, 403);
  const accepted = await fetch(`${base}/task-acceptance-sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-TaskCenter-Context-Token": "context-test-token" },
    body: JSON.stringify({
      event_id: "trusted-acceptance", task_id: "acceptance-task", context_task_id: "context-acceptance",
      context_completion_id: "completion-1", authorization_id: "authorization-1", revision: "revision-a", outcome: "accepted",
    }),
  });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).task.acceptanceStatus, "accepted");
});

test("需求 ID持久化且人工审核保留理由和时间", async () => {
  await resetLedger();
  recordTaskEvent({ type: "task.create", session_id: "sess-review", task_id: "task-review", requirement_id: "req-stable-1" });
  recordTaskEvent({ type: "task.report", session_id: "sess-review", task_id: "task-review", status: "done_claimed", evidence: ["人工评审材料已归档"] });
  const result = recordTaskEvent({ type: "task.review", session_id: "sess-review", task_id: "task-review", event_id: "manual-review-1", status: "verified", review_reason: "人工检查证据", reviewed_at: "2026-08-09T00:00:00.000Z" });
  assert.equal(result.task.requirementId, "req-stable-1");
  assert.equal(result.task.reviewReason, "人工检查证据");
  assert.equal(result.task.reviewedAt, "2026-08-09T00:00:00.000Z");
});

test("非人工 task.review 不能伪造 verified", async () => {
  await resetLedger();
  recordTaskEvent({ type: "task.create", session_id: "sess-security", task_id: "task-security" });
  recordTaskEvent({
    type: "task.report",
    session_id: "sess-security",
    task_id: "task-security",
    status: "done_claimed",
    tests: ["安全校验"],
  });
  assert.throws(
    () => recordTaskEvent({ type: "task.review", session_id: "sess-security", task_id: "task-security", status: "verified", event_id: "evt-forged" }),
    (error) => error instanceof TaskLedgerError && error.statusCode === 400,
  );
});

test("任务时间判断覆盖 active 与终态旧数据", () => {
  const now = Date.parse("2026-08-10T12:00:00.000Z");
  const active = taskTimeState({ status: "in_progress", startedAt: "2026-08-08T12:00:00.000Z", updatedAt: "2026-08-09T10:00:00.000Z", expectedAt: "2026-08-09T12:00:00.000Z" }, now);
  assert.equal(active.stale, true);
  assert.equal(active.overdue, false);
  assert.equal(active.elapsedMs, 172800000);
  assert.equal(active.activeElapsedKnown, false);
  assert.equal(active.activeElapsedMs, null);
  const terminal = taskTimeState({ status: "cancelled", startedAt: "2026-08-08T12:00:00.000Z", updatedAt: "2026-08-09T12:00:00.000Z", expectedAt: "2026-08-09T10:00:00.000Z" }, now);
  assert.equal(terminal.elapsedMs, 86400000);
  assert.equal(terminal.overdue, false);
});

test("归档状态、预计时间校验和旧字段兼容", async () => {
  await resetLedger();
  recordTaskEvent({ type: "task.create", session_id: "sess-time", task_id: "task-time", title: "t" });
  assert.equal(loadTasks()[0].archivedAt, "");
  assert.throws(() => recordTaskEvent({ type: "task.review", session_id: "sess-time", task_id: "task-time", event_id: "manual-archive-bad", status: "verified", archived_at: new Date().toISOString() }), (error) => error instanceof TaskLedgerError && error.statusCode === 409);
  recordTaskEvent({ type: "task.update", session_id: "sess-time", task_id: "task-time", event_id: "manual-schedule", expected_at: "2026-08-11T12:00:00.000Z" });
  assert.equal(loadTasks()[0].expectedAt, "2026-08-11T12:00:00.000Z");
  assert.equal(loadTasks()[0].dueAt, "");
  assert.equal(taskTimeState(loadTasks()[0], Date.parse("2026-08-12T12:00:00.000Z")).overdue, false);
  recordTaskEvent({ type: "task.done_claimed", session_id: "sess-time", task_id: "task-time", event_id: "done-time", status: "done_claimed", evidence: ["时间归档"] });
  recordTaskEvent({ type: "task.review", session_id: "sess-time", task_id: "task-time", event_id: "manual-archive-ok", status: "done_claimed", archived_at: new Date().toISOString() });
  assert.ok(loadTasks()[0].archivedAt);
  recordTaskEvent({ type: "task.review", session_id: "sess-time", task_id: "task-time", event_id: "manual-unarchive", archived_at: "__UNARCHIVE__" });
  assert.equal(loadTasks()[0].archivedAt, "");
});

test("估时校准应记录交付截止、有效工时与状态分段", async () => {
  await resetLedger();
  recordTaskEvent({
    type: "task.create",
    session_id: "sess-calibration",
    task_id: "task-calibration",
    event_id: "calibration-create",
    title: "校准任务",
    due_at: "2026-08-18T12:00:00.000Z",
    estimated_effort_ms: 7_200_000,
    estimate_reason: "初始拆解",
  });
  let task = loadTasks()[0];
  assert.equal(task.dueAt, "2026-08-18T12:00:00.000Z");
  assert.equal(task.dueAtExplicit, true);
  assert.equal(task.expectedAt, "");
  assert.equal(task.estimatedEffortMs, 7_200_000);
  assert.equal(task.estimateHistory.length, 1);

  recordTaskEvent({ type: "task.update", session_id: "sess-calibration", task_id: task.id, event_id: "calibration-start", status: "in_progress" });
  task = loadTasks()[0];
  assert.ok(task.firstStartedAt);
  assert.ok(task.activeStartedAt);

  recordTaskEvent({ type: "task.update", session_id: "sess-calibration", task_id: task.id, event_id: "calibration-block", status: "blocked", blocked_by: "等待外部依赖" });
  task = loadTasks()[0];
  assert.equal(task.activeStartedAt, "");
  assert.ok(task.blockedStartedAt);

  recordTaskEvent({
    type: "task.update",
    session_id: "sess-calibration",
    task_id: task.id,
    event_id: "calibration-reestimate",
    due_at: "2026-08-19T12:00:00.000Z",
    estimated_effort_ms: 10_800_000,
    estimate_reason: "发现额外兼容范围",
  });
  task = loadTasks()[0];
  assert.equal(task.estimateHistory.length, 2);
  assert.equal(task.estimateHistory.at(-1).previousEstimatedEffortMs, 7_200_000);
  assert.equal(task.estimateHistory.at(-1).reason, "发现额外兼容范围");
});

test("控制服务任务闸门 HTTP 协议：register→create→update→report 并展示", async (context) => {
  await resetLedger();
  const { base, child } = await startControlServer();
  context.after(() => child.kill("SIGTERM"));
  assert.equal((await stat(envPaths.TASKCENTER_MCP_TOKEN_PATH)).mode & 0o077, 0);
  const headers = taskHeaders();

  const register = await fetch(`${base}/task-events`, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "session.register", session_id: "sess-http", workspace: "/work" }),
  });
  assert.equal(register.status, 200);
  assert.equal((await register.json()).task, null);

  const create = await fetch(`${base}/task-events`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "task.create",
      session_id: "sess-http",
      task_id: "task-http",
      title: "HTTP 闸门",
      goal: "验证协议",
      acceptance_criteria: ["a"],
      plan: ["p"],
      assumptions: ["假设A"],
      risks: ["风险B"],
      retrospective: "复盘C",
      expected_at: "2026-08-10T12:00:00.000Z",
    }),
  });
  assert.equal(create.status, 201);
  const created = (await create.json()).task;
  assert.equal(created.id, "task-http");
  assert.equal(created.status, "planned");
  assert.equal(created.expectedAt, "2026-08-10T12:00:00.000Z");

  const update = await fetch(`${base}/task-events`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "task.update",
      session_id: "sess-http",
      task_id: "task-http",
      current_step: "实现中",
      next_action: "写测试",
      assumptions: ["假设A"],
      risks: ["风险B"],
      retrospective: "复盘C",
    }),
  });
  assert.equal(update.status, 200);

  // 幂等重投递同一 create
  const dupCreate = await fetch(`${base}/task-events`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "task.create",
      session_id: "sess-http",
      task_id: "task-http",
      event_id: "dup-create-1",
      title: "HTTP 闸门",
      goal: "验证协议",
      acceptance_criteria: ["a"],
      plan: ["p"],
    }),
  });
  const dupPayload = await dupCreate.json();
  assert.equal(dupCreate.status, 200);
  assert.equal(dupPayload.idempotent, true);

  // 错误 session 归属
  const bad = await fetch(`${base}/task-events`, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "task.update", session_id: "other", task_id: "task-http", current_step: "x" }),
  });
  assert.equal(bad.status, 403);

  // 未创建任务 update
  const missing = await fetch(`${base}/task-events`, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "task.update", session_id: "x", task_id: "ghost", current_step: "x" }),
  });
  assert.equal(missing.status, 404);

  // report done_claimed
  const report = await fetch(`${base}/task-events`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "task.report",
      session_id: "sess-http",
      task_id: "task-http",
      status: "done_claimed",
      changed_files: ["x.ts"],
      tests: ["npm test"],
      evidence: ["本地验证"],
      assumptions: ["假设A"],
      risks: ["风险B"],
      retrospective: "复盘C",
    }),
  });
  assert.equal(report.status, 200);
  assert.equal((await report.json()).task.status, "done_claimed");

  // GET /tasks 展示关键信息
  const tasksPayload = await (await fetch(`${base}/tasks`)).json();
  const task = tasksPayload.tasks.find((item) => item.id === "task-http");
  assert.ok(task, "任务应出现在看板数据源");
  assert.equal(task.title, "HTTP 闸门");
  assert.equal(task.goal, "验证协议");
  assert.equal(task.status, "done_claimed");
  assert.equal(task.currentStep, "实现中");
  assert.equal(task.nextAction, "写测试");
  assert.equal(task.sessionId, "sess-http");
  assert.equal(task.assumptions.length, 1);
  assert.equal(task.risks.length, 1);
  assert.ok(task.updatedAt);
  const paged = await (await fetch(`${base}/tasks?view=summary&page=1&page_size=1`)).json();
  assert.equal(paged.page, 1);
  assert.equal(paged.pageSize, 1);
  assert.ok(paged.total >= 1);
  assert.equal(paged.tasks.length, 1);
  assert.equal("verificationClaims" in paged.tasks[0], false, "摘要列表不应携带完整验证历史");
});

test("CLI delegation 附着单个正式主任务并独立记录 Run", async (context) => {
  await resetLedger();
  const { base, child } = await startControlServer();
  context.after(() => child.kill("SIGTERM"));
  await registerHttpSession(base, "session-main");
  await registerHttpSession(base, "session-cli", { model: "gpt-5.3-codex-spark" });

  const created = await fetch(`${base}/task-events`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({
      type: "task.create",
      event_id: "delegation-http-task-create",
      session_id: "session-main",
      task_id: "task-delegation-http",
      title: "单正式任务",
      goal: "让 CLI 附着主任务",
      workspace: "/work",
    }),
  });
  assert.equal(created.status, 201);
  const grant = await fetch(`${base}/delegations/grant`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({
      parent_session_id: "session-main",
      task_id: "task-delegation-http",
      event_id: "delegation-http-grant",
      workspace: "/work",
      scope: ["."],
      allowed_tools: ["exec_command"],
      executor_model: "gpt-5.3-codex-spark",
      channel: "cli",
      ttl_seconds: 600,
    }),
  });
  assert.equal(grant.status, 201);
  const grantPayload = await grant.json();
  assert.ok(grantPayload.claimToken);

  const claim = await fetch(`${base}/delegations/claim`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({ delegation_id: grantPayload.delegation.id, claim_token: grantPayload.claimToken, session_id: "session-cli", workspace: "/work" }),
  });
  const claimPayload = await claim.json();
  assert.equal(claim.status, 200, claimPayload.error);
  const resolved = await (await fetch(`${base}/delegations/resolve?session_id=session-cli&workspace=${encodeURIComponent("/work")}`)).json();
  assert.equal(resolved.task.id, "task-delegation-http");

  const forbiddenParentUpdate = await fetch(`${base}/task-events`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({ type: "task.update", event_id: "delegation-forged-parent-update", session_id: "session-cli", task_id: "task-delegation-http", status: "done_claimed" }),
  });
  assert.equal(forbiddenParentUpdate.status, 403);
  const run = await fetch(`${base}/delegations/report`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({ delegation_id: grantPayload.delegation.id, session_id: "session-cli", workspace: "/work", event_id: "delegation-http-run", status: "succeeded", summary: "只上报运行结果", tests: ["node --test"] }),
  });
  assert.equal(run.status, 200);
  const tasks = (await (await fetch(`${base}/tasks`)).json()).tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, "task-delegation-http");
  assert.equal(tasks[0].status, "planned");
  assert.equal(tasks[0].cliRuns.length, 1);
  assert.equal(tasks[0].cliRuns[0].status, "succeeded");
  const summaryTasks = (await (await fetch(`${base}/tasks?view=summary&page=1&page_size=40`)).json()).tasks;
  assert.equal(summaryTasks[0].cliRuns[0].status, "succeeded");
  assert.equal("events" in summaryTasks[0].cliRuns[0], false, "摘要列表不携带 delegation 完整事件历史");
  const sessions = (await (await fetch(`${base}/session-status`)).json()).sessions;
  assert.equal(sessions.find((session) => session.sessionId === "session-cli").taskCount, 0);
});

test("路由控制 HTTP 原子发放租约、上报结果并写入任务审计", async (context) => {
  await resetLedger();
  const { base, child } = await startControlServer({ TASKCENTER_ROUTING_CONCURRENCY_GPT_5_3_CODEX_SPARK: "1" });
  context.after(() => child.kill("SIGTERM"));
  await registerHttpSession(base, "session-routing-control", { model: "gpt-5.6-sol" });
  const created = await fetch(`${base}/task-events`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({ type: "task.create", event_id: "routing-control-task-create", session_id: "session-routing-control", task_id: "task-routing-control", title: "路由控制", goal: "验证路由控制面", workspace: "/work" }),
  });
  assert.equal(created.status, 201);

  const selectedResponse = await fetch(`${base}/routing/select`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({ task_id: "task-routing-control", preferred_model: "gpt-5.3-codex-spark", task_class: "implementation", channel: "cli", event_id: "routing-control-select" }),
  });
  const selected = await selectedResponse.json();
  assert.equal(selectedResponse.status, 201, selected.error);
  assert.equal(selected.route.selected_model, "gpt-5.3-codex-spark");
  assert.equal(selected.route.available, true);

  const resultResponse = await fetch(`${base}/routing/result`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({ route_id: selected.route.route_id, outcome: "succeeded", event_id: "routing-control-result", request_id: "request-routing-control" }),
  });
  const result = await resultResponse.json();
  assert.equal(resultResponse.status, 200, result.error);
  assert.equal(result.route.status, "succeeded");
  assert.equal(result.health.find((item) => item.model === "gpt-5.3-codex-spark").active_executors, 0);

  const task = (await (await fetch(`${base}/tasks`)).json()).tasks.find((item) => item.id === "task-routing-control");
  assert.equal(task.routing.routeId, selected.route.route_id);
  assert.equal(task.routingHistory.length, 1);
  assert.equal(task.routingResultHistory.length, 1);
  assert.equal(task.routingHealth.state, "closed");
  assert.equal(task.routingHealthHistory.length, 2);
  assert.equal(task.status, "planned");
});

test("路由状态已持久化但审计首次失败时，同 event_id 可补偿重放且不重复", async (context) => {
  await resetLedger();
  const { base, child } = await startControlServer({ TASKCENTER_ROUTING_CONCURRENCY_GPT_5_3_CODEX_SPARK: "1" });
  context.after(async () => {
    await chmod(envPaths.TASKCENTER_TASK_EVENTS_PATH, 0o600).catch(() => {});
    child.kill("SIGTERM");
  });
  await registerHttpSession(base, "session-routing-audit-retry", { model: "gpt-5.6-sol" });
  const created = await fetch(`${base}/task-events`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({ type: "task.create", event_id: "routing-audit-task-create", session_id: "session-routing-audit-retry", task_id: "task-routing-audit-retry", title: "路由审计补偿", goal: "验证审计补偿重放", workspace: "/work" }),
  });
  assert.equal(created.status, 201);

  const selectBody = { task_id: "task-routing-audit-retry", preferred_model: "gpt-5.3-codex-spark", task_class: "implementation", channel: "cli", event_id: "routing-audit-select", route_id: "route-audit-retry" };
  await chmod(envPaths.TASKCENTER_TASK_EVENTS_PATH, 0o400);
  const failedSelect = await fetch(`${base}/routing/select`, { method: "POST", headers: taskHeaders(), body: JSON.stringify(selectBody) });
  assert.equal(failedSelect.status, 500);
  await chmod(envPaths.TASKCENTER_TASK_EVENTS_PATH, 0o600);
  const replayedSelect = await fetch(`${base}/routing/select`, { method: "POST", headers: taskHeaders(), body: JSON.stringify(selectBody) });
  assert.equal(replayedSelect.status, 200);
  assert.equal((await replayedSelect.json()).idempotent, true);
  assert.equal((await fetch(`${base}/routing/select`, { method: "POST", headers: taskHeaders(), body: JSON.stringify(selectBody) })).status, 200);

  const resultBody = { route_id: "route-audit-retry", outcome: "succeeded", event_id: "routing-audit-result", request_id: "request-audit-retry" };
  await chmod(envPaths.TASKCENTER_TASK_EVENTS_PATH, 0o400);
  const failedResult = await fetch(`${base}/routing/result`, { method: "POST", headers: taskHeaders(), body: JSON.stringify(resultBody) });
  assert.equal(failedResult.status, 500);
  await chmod(envPaths.TASKCENTER_TASK_EVENTS_PATH, 0o600);
  const replayedResult = await fetch(`${base}/routing/result`, { method: "POST", headers: taskHeaders(), body: JSON.stringify(resultBody) });
  assert.equal(replayedResult.status, 200);
  assert.equal((await replayedResult.json()).idempotent, true);
  assert.equal((await fetch(`${base}/routing/result`, { method: "POST", headers: taskHeaders(), body: JSON.stringify(resultBody) })).status, 200);

  const auditEvents = (await readFile(envPaths.TASKCENTER_TASK_EVENTS_PATH, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((event) => event.route_id === "route-audit-retry");
  assert.deepEqual(auditEvents.map((event) => event.event_id).sort(), [
    "routing-decision-route-audit-retry-leased",
    "routing-health-route-audit-retry-leased",
    "routing-health-route-audit-retry-succeeded",
    "routing-result-route-audit-retry-succeeded",
  ]);
});

test("控制服务只允许相同 event_id 的同事件补偿重放", async (context) => {
  await resetLedger();
  const fakeServerPath = join(tempDir, "transient-context-server.mjs");
  const fakeStatePath = join(tempDir, "transient-context-state.json");
  await rm(fakeStatePath, { force: true });
  await writeTransientContextServer(fakeServerPath);
  const { base, child } = await startControlServer({
    TASKCENTER_CONTEXT_ROOT: tempDir,
    TASKCENTER_CONTEXT_SERVER: fakeServerPath,
    TASKCENTER_CONTEXT_NODE: process.execPath,
    TASKCENTER_CONTEXT_TIMEOUT_MS: "2000",
    FAKE_CONTEXT_STATE_PATH: fakeStatePath,
  });
  context.after(() => child.kill("SIGTERM"));
  await registerHttpSession(base, "session-retry");

  const createResponse = await fetch(`${base}/task-events`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({
      type: "task.create",
      event_id: "retry-create",
      task_id: "task-retry",
      context_task_id: "context-retry",
      session_id: "session-retry",
      workspace: "/work",
      title: "验证补偿重放",
      goal: "Context 首次失败后可安全重试",
      status: "in_progress",
    }),
  });
  assert.equal(createResponse.status, 201);

  const reportBody = {
    type: "task.report",
    event_id: "retry-report",
    task_id: "task-retry",
    context_task_id: "context-retry",
    session_id: "session-retry",
    status: "done_claimed",
    changed_files: ["a.mjs"],
    tests: ["node --test"],
  };
  const firstReport = await fetch(`${base}/task-events`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify(reportBody),
  });
  const firstPayload = await firstReport.json();
  assert.equal(firstReport.status, 200);
  assert.equal(firstPayload.contextSync.status, "failed");
  assert.equal(firstPayload.task.status, "done_claimed");
  assert.deepEqual(firstPayload.warnings.map((warning) => warning.code), ["SESSION_NOTIFICATION_FAILED"]);

  const retryReport = await fetch(`${base}/task-events`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify(reportBody),
  });
  const retryPayload = await retryReport.json();
  assert.equal(retryReport.status, 200);
  assert.equal(retryPayload.idempotent, true);
  assert.equal(retryPayload.contextSync.status, "synced");
  assert.deepEqual(retryPayload.warnings, []);
  assert.equal(retryPayload.event.type, "task.report");
  assert.equal(retryPayload.event.status, "done_claimed");

  const stateAfterRetry = JSON.parse(await readFile(fakeStatePath, "utf8"));
  assert.deepEqual(stateAfterRetry.calls, [
    { name: "context.report_observation", eventId: "reqradar-context-observation-retry-report" },
    { name: "context.report_observation", eventId: "reqradar-context-observation-retry-report" },
    { name: "context.complete_task", eventId: "reqradar-context-complete-retry-report" },
  ]);

  const mutations = [
    { type: "task.update" },
    { status: "in_progress" },
    { task_id: "other-task" },
    { session_id: "other-session" },
    { context_task_id: "other-context" },
  ];
  for (const mutation of mutations) {
    const response = await fetch(`${base}/task-events`, {
      method: "POST",
      headers: taskHeaders(),
      body: JSON.stringify({ ...reportBody, ...mutation }),
    });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /event_id 已被不同事件使用/);
  }
  const stateAfterTampering = JSON.parse(await readFile(fakeStatePath, "utf8"));
  assert.equal(stateAfterTampering.calls.length, stateAfterRetry.calls.length);
  assert.equal(loadTasks().find((task) => task.id === "task-retry").status, "done_claimed");
});

test("Context 生命周期维护端点显式接管影子并补齐完成状态", async (context) => {
  await resetLedger();
  const { base, child } = await startControlServer();
  context.after(() => child.kill("SIGTERM"));
  const taskHeaders = { "Content-Type": "application/json", "X-TaskCenter-Task": "hook" };
  const manualHeaders = { "Content-Type": "application/json", Origin: "http://localhost:3000", "X-TaskCenter-Action": "delegate" };

  const shadowResponse = await fetch(`${base}/context-tasks/ensure`, {
    method: "POST",
    headers: taskHeaders,
    body: JSON.stringify({
      context_task_id: "context-maintenance",
      session_id: "session-maintenance",
      workspace: "/work",
    }),
  });
  const shadow = (await shadowResponse.json()).task;
  await fetch(`${base}/task-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "mcp" },
    body: JSON.stringify({
      type: "task.create",
      task_id: "formal-maintenance",
      session_id: "session-maintenance",
      title: "历史正式任务",
      goal: "验证安全清理",
      status: "in_progress",
    }),
  });

  const missingConfirmation = await fetch(`${base}/maintenance/context-tasks/reconcile`, {
    method: "POST",
    headers: manualHeaders,
    body: "{}",
  });
  assert.equal(missingConfirmation.status, 400);

  const reconciledResponse = await fetch(`${base}/maintenance/context-tasks/reconcile`, {
    method: "POST",
    headers: manualHeaders,
    body: JSON.stringify({
      confirm: true,
      shadowReplacements: [{ shadowTaskId: shadow.id, replacementTaskId: "formal-maintenance" }],
      completeTaskIds: ["formal-maintenance"],
      completionEvidence: "测试中的 final_answer 与 task_complete 已核对。",
    }),
  });
  assert.equal(reconciledResponse.status, 200);
  const payload = await reconciledResponse.json();
  assert.equal(payload.superseded[0].supersededBy, "formal-maintenance");
  assert.equal(payload.completed[0].status, "done_claimed");
  const visible = await (await fetch(`${base}/tasks`)).json();
  assert.deepEqual(visible.tasks.map((task) => [task.id, task.status]), [["formal-maintenance", "done_claimed"]]);
});

test("MCP verification report 在 Session 通知失败后保留账本并返回 warning", async (context) => {
  await resetLedger();
  const fakeServerPath = join(tempDir, "verification-warning-context-server.mjs");
  const fakeStatePath = join(tempDir, "verification-warning-context-state.json");
  await rm(fakeStatePath, { force: true });
  await writeTransientContextServer(fakeServerPath);
  const { base, child } = await startControlServer({
    TASKCENTER_CONTEXT_ROOT: tempDir,
    TASKCENTER_CONTEXT_SERVER: fakeServerPath,
    TASKCENTER_CONTEXT_NODE: process.execPath,
    TASKCENTER_CONTEXT_TIMEOUT_MS: "2000",
    FAKE_CONTEXT_STATE_PATH: fakeStatePath,
  });
  context.after(() => child.kill("SIGTERM"));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["scripts/taskcenter-mcp.mjs"],
    env: { ...process.env, TASKCENTER_CONTROL_URL: base },
    cwd: root,
  });
  const client = new Client({ name: "taskcenter-verification-warning", version: "0.0.0" });
  await client.connect(transport);
  context.after(async () => { await client.close().catch(() => {}); });

  await client.callTool({ name: "taskcenter_session_register", arguments: {
    session_id: "verification-warning-session", agent: "codex", provider: "openai", model: "gpt-test", workspace: "/work",
  } });
  await client.callTool({ name: "taskcenter_task_create", arguments: {
    session_id: "verification-warning-session", task_id: "verification-warning-task", context_task_id: "verification-warning-context",
    title: "验证通知降级", goal: "验证事件应先落盘", acceptance_criteria: ["账本可用"], plan: ["报告验证"],
  } });
  const verification = {
    session_id: "verification-warning-session", task_id: "verification-warning-task", event_id: "verification-warning-event",
    id: "verification-warning-claim", kind: "test", status: "passed", observed_at: "2026-08-20T08:00:00.000Z",
    producer: "codex", evidence_ref: "summary:passed",
  };
  const first = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_verification_report", arguments: verification })));
  assert.equal(first.accepted, true);
  assert.deepEqual(first.warnings.map((warning) => warning.code), ["SESSION_NOTIFICATION_FAILED"]);
  assert.equal(loadTasks().find((task) => task.id === "verification-warning-task").verificationClaims.length, 1);

  const replay = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_verification_report", arguments: verification })));
  assert.equal(replay.accepted, true);
  assert.equal(replay.warnings, undefined);
  assert.equal(loadTasks().find((task) => task.id === "verification-warning-task").verificationClaims.length, 1);
});

test("MCP stdio 真实协议：session_register 与 task_create 取得 task_id", async (context) => {
  await resetLedger();
  const { base, child } = await startControlServer();
  context.after(() => child.kill("SIGTERM"));

  const gateSessionId = "019f0000-0000-7000-8000-000000000112";

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["scripts/taskcenter-mcp.mjs"],
    env: { ...process.env, TASKCENTER_CONTROL_URL: base, TASKCENTER_CALLER_SESSION_ID: gateSessionId },
    cwd: root,
  });
  const client = new Client({ name: "taskcenter-test", version: "0.0.0" });
  await client.connect(transport);
  context.after(async () => { await client.close().catch(() => {}); });

  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  for (const expected of [
    "taskcenter_session_register", "taskcenter_task_create", "taskcenter_task_update", "taskcenter_task_report",
    "taskcenter_task_close",
    "taskcenter_task_requirement_report", "taskcenter_task_verification_report", "taskcenter_task_review_report",
    "taskcenter_task_completion_readiness", "taskcenter_task_completion_packet", "taskcenter_routing_record", "taskcenter_routing_select", "taskcenter_routing_result",
    "taskcenter_delegation_grant", "taskcenter_delegation_claim", "taskcenter_cli_run_report", "taskcenter_delegation_revoke",
    "taskcenter_task_query", "taskcenter_session_status", "taskcenter_session_gate_exemption_status", "taskcenter_session_gate_exemption_set",
    "taskcenter_scheduled_readonly_scan_exemption_status", "taskcenter_scheduled_readonly_scan_exemption_set",
    "taskcenter_usage_report", "taskcenter_session_lifecycle", "taskcenter_governance_metrics",
  ]) {
    assert.ok(toolNames.includes(expected), `MCP 应暴露 ${expected}`);
  }

  const register = await client.callTool({ name: "taskcenter_session_register", arguments: { session_id: "sess-mcp", agent: "codex", provider: "openai", model: "gpt-test", workspace: "/work", response_mode: "full" } });
  const registerPayload = JSON.parse(textOf(register));
  assert.equal(registerPayload.accepted, true);
  assert.equal(registerPayload.task, null);

  const gateStatusBefore = JSON.parse(textOf(await client.callTool({
    name: "taskcenter_session_gate_exemption_status",
    arguments: {},
  })));
  assert.equal(gateStatusBefore.session.registered, false);
  assert.equal(gateStatusBefore.session.gateExempt, false);
  const unregisteredGateSet = JSON.parse(textOf(await client.callTool({
    name: "taskcenter_session_gate_exemption_set",
    arguments: { enabled: true },
  })));
  assert.equal(unregisteredGateSet.error, "TASKCENTER_REQUEST_FAILED");
  assert.match(unregisteredGateSet.message, /尚未登记/);

  const gateRegister = await client.callTool({
    name: "taskcenter_session_register",
    arguments: { session_id: gateSessionId, agent: "codex", provider: "openai", model: "gpt-test", workspace: "/work" },
  });
  assert.equal(JSON.parse(textOf(gateRegister)).accepted, true);
  const gateJoin = JSON.parse(textOf(await client.callTool({
    name: "taskcenter_session_gate_exemption_set",
    arguments: { enabled: true },
  })));
  assert.equal(gateJoin.session.gateExempt, true);
  const gateHookAllowed = await runTaskcenterHook(base, {
    session_id: gateSessionId,
    cwd: "/work",
    tool_name: "Bash",
    tool_input: { command: "true" },
  });
  assert.equal(gateHookAllowed.code, 0);
  assert.match(gateHookAllowed.stdout, /门禁豁免白名单放行/);
  const gateInteractiveBlocked = await runTaskcenterHook(base, {
    session_id: gateSessionId,
    cwd: "/work",
    tool_name: "Bash",
    tool_input: { command: "zsh" },
  });
  assert.equal(gateInteractiveBlocked.code, 2);
  assert.match(gateInteractiveBlocked.stderr, /交互式命令/);
  const gateStatusJoined = JSON.parse(textOf(await client.callTool({
    name: "taskcenter_session_gate_exemption_status",
    arguments: {},
  })));
  assert.equal(gateStatusJoined.session.gateExempt, true);
  const gateLeave = JSON.parse(textOf(await client.callTool({
    name: "taskcenter_session_gate_exemption_set",
    arguments: { enabled: false },
  })));
  assert.equal(gateLeave.session.gateExempt, false);
  const gateHookBlocked = await runTaskcenterHook(base, {
    session_id: gateSessionId,
    cwd: "/work",
    tool_name: "Bash",
    tool_input: { command: "true" },
  });
  assert.equal(gateHookBlocked.code, 2);
  assert.match(gateHookBlocked.stderr, /无活跃任务/);

  const scheduledReportPath = join(tempDir, "scheduled-report.md");
  await writeFile(scheduledReportPath, "report\n");
  setSessionScheduledReadonlyProfile(gateSessionId, {
    profile: "scheduled_readonly",
    automation_id: "cyberrole-agent-context",
    project_id: "cyberrole",
    workspace_root: tempDir,
    report_path: scheduledReportPath,
    report_mutation: true,
  });
  const scanStatusBefore = JSON.parse(textOf(await client.callTool({
    name: "taskcenter_scheduled_readonly_scan_exemption_status",
    arguments: { session_id: gateSessionId },
  })));
  assert.equal(scanStatusBefore.session.scheduledReadonly, true);
  assert.equal(scanStatusBefore.session.scanExempt, false);
  const scanJoin = JSON.parse(textOf(await client.callTool({
    name: "taskcenter_scheduled_readonly_scan_exemption_set",
    arguments: { session_id: gateSessionId, enabled: true },
  })));
  assert.equal(scanJoin.session.scanExempt, true);
  setSessionScheduledReadonlyProfile(gateSessionId, {
    profile: "scheduled_readonly",
    automation_id: "cyberrole-agent-context",
    project_id: "cyberrole",
    workspace_root: tempDir,
    report_path: scheduledReportPath,
    report_mutation: true,
  });
  const scanStatusAfterDetect = JSON.parse(textOf(await client.callTool({
    name: "taskcenter_scheduled_readonly_scan_exemption_status",
    arguments: { session_id: gateSessionId },
  })));
  assert.equal(scanStatusAfterDetect.session.scanExempt, true);
  const scheduledIdentity = {
    profile: "scheduled_readonly",
    automation_id: "cyberrole-agent-context",
    project_id: "cyberrole",
    workspace_root: tempDir,
    report_path: scheduledReportPath,
    task_mutation: false,
    pca_mutation: false,
    report_mutation: true,
    network: false,
  };
  const scanHookAllowed = await runTaskcenterHook(base, {
    session_id: gateSessionId,
    cwd: tempDir,
    ...scheduledIdentity,
    tool_name: "exec_command",
    tool_input: { cmd: "rtk git ls-files README.md" },
  });
  assert.equal(scanHookAllowed.code, 0);
  assert.match(scanHookAllowed.stdout, /扫描豁免放行/);
  for (const command of [
    "rtk git ls-files --exclude-from=/tmp/patterns",
    "git check-ignore --exclude-from=/tmp/patterns /tmp/other",
    "git check-ignore ../outside",
  ]) {
    const boundaryBlocked = await runTaskcenterHook(base, {
      session_id: gateSessionId,
      cwd: tempDir,
      ...scheduledIdentity,
      tool_name: "exec_command",
      tool_input: { cmd: command },
    });
    assert.equal(boundaryBlocked.code, 2, command);
  }
  const scanPipelineBlocked = await runTaskcenterHook(base, {
    session_id: gateSessionId,
    cwd: tempDir,
    ...scheduledIdentity,
    tool_name: "exec_command",
    tool_input: { cmd: "rtk git ls-files | cat" },
  });
  assert.equal(scanPipelineBlocked.code, 2);
  const scanLeave = JSON.parse(textOf(await client.callTool({
    name: "taskcenter_scheduled_readonly_scan_exemption_set",
    arguments: { session_id: gateSessionId, enabled: false },
  })));
  assert.equal(scanLeave.session.scanExempt, false);
  const scanHookBlocked = await runTaskcenterHook(base, {
    session_id: gateSessionId,
    cwd: tempDir,
    ...scheduledIdentity,
    tool_name: "exec_command",
    tool_input: { cmd: "rtk git ls-files README.md" },
  });
  assert.equal(scanHookBlocked.code, 2);

  const create = await client.callTool({
    name: "taskcenter_task_create",
    arguments: {
      session_id: "sess-mcp",
      agent: "codex",
      provider: "openai",
      model: "gpt-test",
      task_id: "task-mcp",
      title: "MCP 闸门",
      goal: "验证 MCP 通道",
      acceptance_criteria: ["a"],
      plan: ["p"],
      assumptions: ["假设A"],
      risks: ["风险B"],
      retrospective: "复盘C",
      expected_at: "2026-08-10T12:00:00.000Z",
      response_mode: "full",
    },
  });
  const createPayload = JSON.parse(textOf(create));
  assert.equal(createPayload.accepted, true);
  assert.equal(createPayload.task.id, "task-mcp");
  assert.equal(createPayload.task.status, "planned");
  assert.equal(createPayload.task.expectedAt, "2026-08-10T12:00:00.000Z");

  const compact = await client.callTool({
    name: "taskcenter_task_create",
    arguments: { session_id: "sess-mcp", task_id: "task-mcp-summary", title: "紧凑回包", goal: "验证默认摘要", acceptance_criteria: ["a"], plan: ["p"] },
  });
  const compactText = textOf(compact);
  const compactPayload = JSON.parse(compactText);
  assert.deepEqual(Object.keys(compactPayload).sort(), ["accepted", "missing_count", "review_status", "status", "task_id", "verification_status"]);
  assert.equal(compactPayload.task_id, "task-mcp-summary");
  assert.ok(compactText.length < textOf(create).length / 2, "默认摘要应显著小于 full 回包");

  await client.callTool({
    name: "taskcenter_task_create",
    arguments: {
      session_id: "sess-mcp", task_id: "task-mcp-close", contract_version: "v2", title: "原子关闭",
      goal: "一次上报闭环证据", scope: ["close"], non_goals: [], workflow_profile: "fast", review_policy: "not_required",
      acceptance_criteria: [{ id: "close-criterion", description: "证据完整", required: true }], plan: ["close"], response_mode: "full",
    },
  });
  const closeArguments = {
    session_id: "sess-mcp", task_id: "task-mcp-close", event_id: "mcp-close-once",
    tests: ["node --test"], evidence: ["summary:passed"], changed_files: ["scripts/example.mjs"],
    close_requirements: [{ requirement_id: "close-criterion", status: "passed", evidence_refs: ["summary:passed"] }],
    close_verifications: [{ id: "close-test", kind: "test", status: "passed", observed_at: "2026-08-20T08:30:00.000Z", producer: "codex", evidence_ref: "summary:passed" }],
    response_mode: "full",
  };
  const closed = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_close", arguments: closeArguments })));
  assert.equal(closed.accepted, true);
  assert.equal(closed.event.type, "task.close");
  assert.equal(closed.task.status, "done_claimed");
  assert.equal(closed.task.requirementResults.length, 1);
  assert.equal(closed.task.verificationClaims.length, 1);
  assert.equal(closed.task.completionReadiness.ready, true);
  await rm(envPaths.TASKCENTER_TASK_EVENT_IDS_PATH, { force: true });
  const closeReplay = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_close", arguments: closeArguments })));
  assert.equal(closeReplay.idempotent, true);
  assert.equal(closeReplay.task.requirementResults.length, 1);
  assert.equal(closeReplay.task.verificationClaims.length, 1);
  assert.ok(1 <= 4 * 0.6, "原子 close 将四次闭环上报缩减为一次，下降至少 40%");

  const usageReport = JSON.parse(textOf(await client.callTool({ name: "taskcenter_usage_report", arguments: {} })));
  assert.deepEqual(Object.keys(usageReport.windows), ["5h", "24h", "7d"]);
  const lifecycle = JSON.parse(textOf(await client.callTool({ name: "taskcenter_session_lifecycle", arguments: { session_id: "sess-mcp" } })));
  assert.ok(["continue_current_session", "recommend_new_codex_session", "require_handoff_before_continue"].includes(lifecycle.action));
  assert.match(lifecycle.taskSemantics, /新建 Codex Session 不等于新建 TaskCenter task/);
  const governance = JSON.parse(textOf(await client.callTool({ name: "taskcenter_governance_metrics", arguments: {} })));
  assert.equal(governance.schemaVersion, "taskcenter-governance-metrics-v1");

  const routing = await client.callTool({
    name: "taskcenter_routing_record",
    arguments: {
      session_id: "sess-mcp",
      task_id: "task-mcp",
      event_id: "mcp-routing-native",
      routing_action: "delegate_native",
      orchestrator_model: "gpt-5.6-sol",
      preferred_executor_model: "gpt-5.3-codex-spark",
      selected_executor_model: "gpt-5.3-codex-spark",
      dispatch_channel: "native",
      routing_reason: "边界清晰，优先原生派发。",
      response_mode: "full",
    },
  });
  const routingPayload = JSON.parse(textOf(routing));
  assert.equal(routingPayload.accepted, true);
  assert.equal(routingPayload.task.status, "planned");
  assert.equal(routingPayload.task.routing.selectedExecutorModel, "gpt-5.3-codex-spark");

  const selectedRoute = JSON.parse(textOf(await client.callTool({
    name: "taskcenter_routing_select",
    arguments: { task_id: "task-mcp", preferred_model: "gpt-5.3-codex-spark", task_class: "test", channel: "cli", route_id: "route-mcp-compat" },
  })));
  assert.equal(selectedRoute.route.route_id, "route-mcp-compat", "旧客户端不传 response_mode 时仍需取得路由租约");
  assert.ok(selectedRoute.route.selected_model);
  await client.callTool({ name: "taskcenter_routing_result", arguments: { route_id: selectedRoute.route.route_id, outcome: "succeeded" } });

  const query = await client.callTool({ name: "taskcenter_task_query", arguments: { session_id: "sess-mcp" } });
  const queryPayload = JSON.parse(textOf(query));
  assert.equal(queryPayload.tasks.find((task) => task.id === "task-mcp").routing.dispatchChannel, "cli");

  const update = await client.callTool({ name: "taskcenter_task_update", arguments: { session_id: "sess-mcp", task_id: "task-mcp", current_step: "已更新" } });
  assert.equal(JSON.parse(textOf(update)).accepted, true);
  const report = await client.callTool({ name: "taskcenter_task_report", arguments: { session_id: "sess-mcp", task_id: "task-mcp", status: "done_claimed", tests: ["MCP 闭环"] } });
  assert.equal(JSON.parse(textOf(report)).accepted, true);
  const finalQuery = await client.callTool({ name: "taskcenter_task_query", arguments: { session_id: "sess-mcp", task_id: "task-mcp" } });
  assert.equal(JSON.parse(textOf(finalQuery)).tasks[0].status, "done_claimed");

  await client.callTool({ name: "taskcenter_session_register", arguments: { session_id: "sess-reviewer", agent: "codex", provider: "openai", model: "gpt-review", workspace: "/review" } });
  const v2Create = await client.callTool({
    name: "taskcenter_task_create",
    arguments: {
      session_id: "sess-mcp", task_id: "task-mcp-v2", title: "MCP v2 闭环", goal: "验证新 MCP 能力",
      acceptance_criteria: ["功能通过"], plan: ["实现"], contract_version: "v2", scope: ["scripts/"], non_goals: [],
      workflow_profile: "standard", review_policy: "required", execution_environment: "local", response_mode: "full",
      verification_plan: [{ id: "tests", title: "测试", kind: "test", required: true }],
    },
  });
  assert.equal(JSON.parse(textOf(v2Create)).task.contractVersion, "v2");
  await client.callTool({ name: "taskcenter_task_report", arguments: { session_id: "sess-mcp", task_id: "task-mcp-v2", status: "done_claimed", tests: ["passed"], revision: "revision-mcp" } });
  await client.callTool({
    name: "taskcenter_task_requirement_report",
    arguments: { session_id: "sess-mcp", task_id: "task-mcp-v2", event_id: "mcp-requirement", requirement_id: "acceptance-1", status: "passed", evidence_refs: ["claim-mcp"], checked_by: "codex", revision: "revision-mcp" },
  });
  await client.callTool({
    name: "taskcenter_task_verification_report",
    arguments: {
      session_id: "sess-mcp", task_id: "task-mcp-v2", event_id: "mcp-verification", id: "claim-mcp", requirement_id: "tests",
      kind: "test", command_or_probe: "node --test", status: "passed", exit_code: 0, revision: "revision-mcp",
      observed_at: "2026-08-17T00:00:00.000Z", producer: "codex", producer_session_id: "sess-mcp", evidence_ref: "summary:passed",
    },
  });
  const beforeReview = await client.callTool({ name: "taskcenter_task_completion_readiness", arguments: { task_id: "task-mcp-v2" } });
  assert.equal(JSON.parse(textOf(beforeReview)).completionReadiness.ready, false);
  await client.callTool({
    name: "taskcenter_task_review_report",
    arguments: {
      session_id: "sess-reviewer", task_id: "task-mcp-v2", event_id: "mcp-review", id: "review-mcp", reviewer: "ocr",
      reviewer_session_id: "sess-reviewer", revision: "revision-mcp", scope: "scripts/", verdict: "approved", unresolved_findings: 0,
      observed_at: "2026-08-17T00:05:00.000Z", summary: "approved",
    },
  });
  const readiness = await client.callTool({ name: "taskcenter_task_completion_readiness", arguments: { task_id: "task-mcp-v2" } });
  assert.equal(JSON.parse(textOf(readiness)).completionReadiness.ready, true);
  const packet = await client.callTool({ name: "taskcenter_task_completion_packet", arguments: { task_id: "task-mcp-v2" } });
  assert.equal(JSON.parse(textOf(packet)).completionPacket.reviewStatus, "passed");

  const structuredSubject = { type: "git_worktree_snapshot", value: "snapshot-mcp-structured", repository: "/work", branch: "feature/readiness", observed_at: "2026-08-17T01:00:00.000Z" };
  await client.callTool({
    name: "taskcenter_task_create",
    arguments: {
      session_id: "sess-mcp", task_id: "task-mcp-structured", title: "结构化 Subject 就绪度", goal: "验证专用 readiness 与 task_query 一致",
      acceptance_criteria: ["功能通过"], plan: ["实现"], contract_version: "v2", scope: ["scripts/"], non_goals: [],
      workflow_profile: "standard", review_policy: "not_required", execution_environment: "local",
      verification_plan: [{ id: "tests", title: "测试", kind: "test", required: true }],
    },
  });
  await client.callTool({ name: "taskcenter_task_report", arguments: { session_id: "sess-mcp", task_id: "task-mcp-structured", status: "done_claimed", tests: ["passed"], subject_ref: structuredSubject } });
  await client.callTool({
    name: "taskcenter_task_requirement_report",
    arguments: { session_id: "sess-mcp", task_id: "task-mcp-structured", event_id: "mcp-structured-requirement", requirement_id: "acceptance-1", status: "passed", evidence_refs: ["structured-claim"], checked_by: "codex", subject_ref: structuredSubject },
  });
  await client.callTool({
    name: "taskcenter_task_verification_report",
    arguments: {
      session_id: "sess-mcp", task_id: "task-mcp-structured", event_id: "mcp-structured-verification", id: "structured-claim", requirement_id: "tests",
      kind: "test", command_or_probe: "node --test", status: "passed", exit_code: 0, subject_ref: structuredSubject,
      observed_at: "2026-08-17T01:05:00.000Z", producer: "codex", producer_session_id: "sess-mcp", evidence_ref: "summary:passed",
    },
  });
  const structuredQuery = await client.callTool({ name: "taskcenter_task_query", arguments: { task_id: "task-mcp-structured" } });
  const structuredReadiness = await client.callTool({ name: "taskcenter_task_completion_readiness", arguments: { task_id: "task-mcp-structured" } });
  assert.equal(JSON.parse(textOf(structuredQuery)).tasks[0].completionReadiness.ready, true);
  assert.equal(JSON.parse(textOf(structuredReadiness)).completionReadiness.ready, true);
  assert.deepEqual(JSON.parse(textOf(structuredReadiness)).completionReadiness.currentSubject, structuredSubject);
});

test("V2 通用核心 API：无 Session 创建、离线导入、独立验收与双格式导出", async (context) => {
  await resetLedger();
  const { base, child } = await startControlServer({ TASKCENTER_ACCEPTANCE_TOKEN: "acceptance-v2-token" });
  context.after(() => child.kill("SIGTERM"));
  const coreHeaders = { "Content-Type": "application/json", "X-TaskCenter-Task": "core" };
  const subject = { type: "artifact", value: "artifact://taskcenter/v2", observed_at: "2026-08-16T00:00:00.000Z" };
  const created = await fetch(`${base}/core/task-events`, {
    method: "POST", headers: coreHeaders,
    body: JSON.stringify({ type: "task.create", event_id: "core-v2-create", task_id: "core-v2-task", title: "Core V2", goal: "无平台依赖完成", plan: ["run"], acceptance_criteria: [{ id: "ac", description: "works", required: true }], contract_version: "v2", scope: ["core"], non_goals: [], workflow_profile: "standard", review_policy: "not_required", verification_plan: [{ id: "test", title: "test", kind: "test", required: true }], actor: { type: "human", id: "author" } }),
  });
  assert.equal(created.status, 201);
  const done = await fetch(`${base}/core/task-events`, { method: "POST", headers: coreHeaders, body: JSON.stringify({ type: "task.report", event_id: "core-v2-done", task_id: "core-v2-task", status: "done_claimed", tests: ["external CI"], subject_ref: subject, actor: { type: "ci", id: "build" } }) });
  assert.equal(done.status, 200);
  const imported = await fetch(`${base}/tasks/import-evidence`, {
    method: "POST", headers: coreHeaders,
    body: JSON.stringify({ task_id: "core-v2-task", events: [
      { type: "requirement.reported", event_id: "core-v2-ac", occurred_at: "2026-08-16T00:01:00.000Z", requirement_result: { requirement_id: "ac", status: "passed", evidence_refs: ["ci://run/42"], checked_at: "2026-08-16T00:01:00.000Z", checked_by: { type: "ci", id: "ci" }, subject_ref: subject } },
      { type: "verification.reported", event_id: "core-v2-test", occurred_at: "2026-08-16T00:02:00.000Z", verification_claim: { id: "claim", requirement_id: "test", kind: "test", status: "passed", observed_at: "2026-08-16T00:02:00.000Z", producer: { type: "ci", id: "ci" }, subject_ref: subject, evidence_ref: "ci://run/42" } },
    ] }),
  });
  assert.equal(imported.status, 200);
  const recorded = JSON.parse((await readFile(envPaths.TASKCENTER_TASK_EVENTS_PATH, "utf8")).trim().split("\n").find((line) => line.includes("core-v2-test")));
  assert.equal(recorded.occurred_at, "2026-08-16T00:02:00.000Z");
  assert.notEqual(recorded.recorded_at, recorded.occurred_at);
  const accepted = await fetch(`${base}/task-acceptance-report`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-TaskCenter-Acceptance-Token": "acceptance-v2-token" },
    body: JSON.stringify({ task_id: "core-v2-task", event_id: "core-v2-accept", outcome: "accepted", acceptance_record: { id: "accept-1", source: "human", actor: { type: "human", id: "owner" }, subject_ref: subject, observed_at: "2026-08-16T00:03:00.000Z" } }),
  });
  assert.equal(accepted.status, 200);
  const exportedJson = await (await fetch(`${base}/tasks/core-v2-task/export?format=json`)).json();
  assert.equal(exportedJson.completionPacket.acceptanceRecords[0].outcome, "accepted");
  const exportedMarkdown = await (await fetch(`${base}/tasks/core-v2-task/export?format=markdown`)).text();
  assert.match(exportedMarkdown, /accept-1: accepted via human/);
});

function textOf(result) {
  if (!result.content || !result.content.length) return "";
  return result.content.map((part) => part.text ?? "").join("");
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("控制服务启动超时")), 5_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`控制服务提前退出：${code}`));
    });
    child.stdout.on("data", (chunk) => {
      if (!String(chunk).includes("TaskCenter control server is listening")) return;
      clearTimeout(timer);
      resolve();
    });
  });
}

test("人工操作端点：合法 UI 操作可变更任务状态", async (context) => {
  await resetLedger();
  const { base, child } = await startControlServer();
  context.after(() => child.kill("SIGTERM"));
  await registerHttpSession(base, "sess-manual");

  // 先通过 MCP 创建任务
  const create = await fetch(`${base}/task-events`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({
      type: "task.create",
      session_id: "sess-manual",
      task_id: "task-manual-1",
      title: "人工操作测试",
      goal: "验证 UI 操作",
      acceptance_criteria: ["a"],
      plan: ["p"],
    }),
  });
  assert.equal(create.status, 201);
  const created = (await create.json()).task;
  assert.equal(created.id, "task-manual-1");
  assert.equal(created.status, "planned");

  // 合法人工操作：开始任务
  const start = await fetch(`${base}/tasks/task-manual-1/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "http://localhost:3000",
      "X-TaskCenter-Action": "delegate",
    },
    body: JSON.stringify({ action: "start" }),
  });
  assert.equal(start.status, 200);
  const started = (await start.json()).task;
  assert.equal(started.status, "in_progress");

  // 合法人工操作：声明完成
  const done = await fetch(`${base}/tasks/task-manual-1/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "http://localhost:3000",
      "X-TaskCenter-Action": "delegate",
    },
    body: JSON.stringify({ action: "done" }),
  });
  assert.equal(done.status, 200);
  const doneTask = (await done.json()).task;
  assert.equal(doneTask.status, "done_claimed");

  // 合法人工操作：取消任务
  const cancel = await fetch(`${base}/tasks/task-manual-1/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "http://localhost:3000",
      "X-TaskCenter-Action": "delegate",
    },
    body: JSON.stringify({ action: "cancel" }),
  });
  assert.equal(cancel.status, 200);
  const cancelled = (await cancel.json()).task;
  assert.equal(cancelled.status, "cancelled");
});

test("门禁豁免支持单个 Session 幂等加入与退出且不覆盖其他 Session", async (context) => {
  await resetLedger();
  const { base, child } = await startControlServer();
  context.after(() => child.kill("SIGTERM"));
  const headers = {
    "Content-Type": "application/json",
    "Origin": "http://localhost:3000",
    "X-TaskCenter-Action": "delegate",
  };
  const firstId = "019f0000-0000-7000-8000-000000000101";
  const secondId = "019f0000-0000-7000-8000-000000000102";

  const forgedMcp = await fetch(`${base}/gate-session-exemption/status`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({ session_id: firstId }),
  });
  assert.equal(forgedMcp.status, 403);

  const seed = await fetch(`${base}/gate-session-allowlist`, {
    method: "POST",
    headers,
    body: JSON.stringify({ threadIds: [firstId] }),
  });
  assert.equal(seed.status, 200);

  for (const enabled of [true, true]) {
    const joined = await fetch(`${base}/gate-session-allowlist/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ session_id: secondId, enabled }),
    });
    assert.equal(joined.status, 200);
    const payload = await joined.json();
    assert.deepEqual(payload.selection.threadIds, [firstId, secondId]);
    assert.equal(payload.session.gateExempt, true);
  }

  const left = await fetch(`${base}/gate-session-allowlist/session`, {
    method: "POST",
    headers,
    body: JSON.stringify({ session_id: firstId, enabled: false }),
  });
  assert.equal(left.status, 200);
  assert.deepEqual((await left.json()).selection.threadIds, [secondId]);

  const invalid = await fetch(`${base}/gate-session-allowlist/session`, {
    method: "POST",
    headers,
    body: JSON.stringify({ session_id: "not-a-session", enabled: true }),
  });
  assert.equal(invalid.status, 400);
});

test("人工操作端点：缺少 UI 来源标记返回 403", async (context) => {
  await resetLedger();
  const { base, child } = await startControlServer();
  context.after(() => child.kill("SIGTERM"));

  // 先创建任务
  await fetch(`${base}/task-events`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({
      type: "task.create",
      session_id: "sess-protect",
      task_id: "task-protect",
      title: "保护测试",
      goal: "验证权限",
      acceptance_criteria: ["a"],
      plan: ["p"],
    }),
  });

  // 缺少 Origin
  const noOrigin = await fetch(`${base}/tasks/task-protect/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-TaskCenter-Action": "delegate" },
    body: JSON.stringify({ action: "start" }),
  });
  assert.equal(noOrigin.status, 403);

  // 缺少 X-TaskCenter-Action
  const noMark = await fetch(`${base}/tasks/task-protect/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "http://localhost:3000" },
    body: JSON.stringify({ action: "start" }),
  });
  assert.equal(noMark.status, 403);

  // 非 allowedOrigins
  const badOrigin = await fetch(`${base}/tasks/task-protect/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "http://evil.com",
      "X-TaskCenter-Action": "delegate",
    },
    body: JSON.stringify({ action: "start" }),
  });
  assert.equal(badOrigin.status, 403);
});

test("任务创建闸门：未登记 Session 被拒绝，登记后返回执行器身份", async (context) => {
  await resetLedger();
  const { base, child } = await startControlServer();
  context.after(() => child.kill("SIGTERM"));

  const rejected = await fetch(`${base}/task-events`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({
      type: "task.create",
      session_id: "sess-unregistered",
      task_id: "task-gated",
      title: "未登记任务",
      goal: "验证闸门",
      acceptance_criteria: ["a"],
      plan: ["p"],
    }),
  });
  assert.equal(rejected.status, 409);
  assert.match((await rejected.json()).error, /先调用 taskcenter_session_register/);

  await registerHttpSession(base, "sess-claude", { agent: "claude", provider: "anthropic", model: "glm-5" });
  const created = await fetch(`${base}/task-events`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({
      type: "task.create",
      session_id: "sess-claude",
      agent: "claude",
      provider: "anthropic",
      model: "glm-5",
      task_id: "task-gated-claude",
      title: "已登记任务",
      goal: "验证执行器身份",
      acceptance_criteria: ["a"],
      plan: ["p"],
    }),
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).task.agent, "claude");

  const status = await fetch(`${base}/session-status`);
  assert.equal(status.status, 200);
  const session = (await status.json()).sessions.find((item) => item.sessionId === "sess-claude");
  assert.deepEqual({ agent: session.agent, provider: session.provider, model: session.model, status: session.status, taskCount: session.taskCount }, {
    agent: "claude",
    provider: "anthropic",
    model: "glm-5",
    status: "registered",
    taskCount: 1,
  });
});

test("人工操作端点：演示任务可移除，真实任务取消", async (context) => {
  await resetLedger();
  const { base, child } = await startControlServer();
  context.after(() => child.kill("SIGTERM"));
  await registerHttpSession(base, "sess-demo");
  await registerHttpSession(base, "sess-real");

  // 创建演示任务
  await fetch(`${base}/task-events`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({
      type: "task.create",
      session_id: "sess-demo",
      task_id: "ui-demo-123",
      title: "演示任务",
      goal: "演示",
      acceptance_criteria: ["a"],
      plan: ["p"],
    }),
  });

  // 创建真实任务
  await fetch(`${base}/task-events`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({
      type: "task.create",
      session_id: "sess-real",
      task_id: "task-real-456",
      title: "真实任务",
      goal: "真实",
      acceptance_criteria: ["a"],
      plan: ["p"],
    }),
  });

  // 演示任务可移除
  const removeDemo = await fetch(`${base}/tasks/ui-demo-123/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "http://localhost:3000",
      "X-TaskCenter-Action": "delegate",
    },
    body: JSON.stringify({ action: "remove" }),
  });
  assert.equal(removeDemo.status, 200);
  const removed = (await removeDemo.json()).task;
  assert.equal(removed.status, "removed");

  // 真实任务移除 -> 变成 cancelled
  const removeReal = await fetch(`${base}/tasks/task-real-456/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "http://localhost:3000",
      "X-TaskCenter-Action": "delegate",
    },
    body: JSON.stringify({ action: "remove" }),
  });
  assert.equal(removeReal.status, 200);
  const cancelled = (await removeReal.json()).task;
  assert.equal(cancelled.status, "cancelled");
});

test("人工操作事件绕过 session 归属校验", async (context) => {
  await resetLedger();
  const { base, child } = await startControlServer();
  context.after(() => child.kill("SIGTERM"));
  await registerHttpSession(base, "sess-owner");

  // 任务属于 sess-owner
  await fetch(`${base}/task-events`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({
      type: "task.create",
      session_id: "sess-owner",
      task_id: "task-owner",
      title: "归属测试",
      goal: "验证人工操作绕过归属",
      acceptance_criteria: ["a"],
      plan: ["p"],
    }),
  });

  // 人工操作端点不需要 session_id，直接操作
  const action = await fetch(`${base}/tasks/task-owner/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "http://localhost:3000",
      "X-TaskCenter-Action": "delegate",
    },
    body: JSON.stringify({ action: "start" }),
  });
  assert.equal(action.status, 200);
  const started = (await action.json()).task;
  assert.equal(started.status, "in_progress");
  // 任务仍属于原 session
  assert.equal(started.sessionId, "sess-owner");
});

test("控制服务 verify/reject 校验状态并写入审核结果", async (context) => {
  await resetLedger();
  const dashboardPath = join(tempDir, "review-dashboard.json");
  const overridesPath = join(tempDir, "review-overrides.json");
  await writeFile(dashboardPath, JSON.stringify({ requirements: [{ id: "req-http-review", title: "真实需求" }] }));
  await writeFile(overridesPath, "{}\n");
  const { base, child } = await startControlServer({ TASKCENTER_DASHBOARD_PATH: dashboardPath, TASKCENTER_OVERRIDES_PATH: overridesPath });
  context.after(() => child.kill("SIGTERM"));
  await registerHttpSession(base, "sess-http-review");
  const create = await fetch(`${base}/task-events`, { method: "POST", headers: taskHeaders(), body: JSON.stringify({ type: "task.create", session_id: "sess-http-review", task_id: "task-http-review", requirement_id: "req-http-review" }) });
  assert.equal(create.status, 201);
  const externalReview = await fetch(`${base}/task-events`, { method: "POST", headers: taskHeaders(), body: JSON.stringify({ type: "task.review", session_id: "sess-http-review", task_id: "task-http-review", event_id: "manual-forged", status: "verified" }) });
  assert.equal(externalReview.status, 403);
  const headers = { "Content-Type": "application/json", Origin: "http://localhost:3000", "X-TaskCenter-Action": "delegate" };
  const invalid = await fetch(`${base}/tasks/task-http-review/actions`, { method: "POST", headers, body: JSON.stringify({ action: "verify" }) });
  assert.equal(invalid.status, 409);
  await fetch(`${base}/task-events`, { method: "POST", headers: taskHeaders(), body: JSON.stringify({ type: "task.report", session_id: "sess-http-review", task_id: "task-http-review", status: "done_claimed", tests: ["手工验收"] }) });
  const verified = await fetch(`${base}/tasks/task-http-review/actions`, { method: "POST", headers, body: JSON.stringify({ action: "verify" }) });
  assert.equal(verified.status, 200);
  assert.equal((await verified.json()).task.status, "verified");
  let overrides = JSON.parse(await (await fetch(`${base}/requirement-overrides`)).text()).overrides;
  assert.equal(overrides["req-http-review"].status, "verified");
  const rejected = await fetch(`${base}/tasks/task-http-review/actions`, { method: "POST", headers, body: JSON.stringify({ action: "reject", reason: "证据不足" }) });
  assert.equal(rejected.status, 200);
  const rejectedTask = (await rejected.json()).task;
  assert.equal(rejectedTask.status, "in_progress");
  assert.equal(rejectedTask.reviewReason, "证据不足");
  overrides = JSON.parse(await (await fetch(`${base}/requirement-overrides`)).text()).overrides;
  assert.equal(overrides["req-http-review"].status, "needs_validation");
  assert.equal(overrides["req-http-review"].hidden, false);
});

test("控制服务 schedule/archive/unarchive HTTP 闭环", async (context) => {
  await resetLedger();
  const { base, child } = await startControlServer();
  context.after(() => child.kill("SIGTERM"));
  await registerHttpSession(base, "sess-http-governance");
  await fetch(`${base}/task-events`, { method: "POST", headers: taskHeaders(), body: JSON.stringify({ type: "task.create", session_id: "sess-http-governance", task_id: "task-http-governance" }) });
  const headers = { "Content-Type": "application/json", Origin: "http://localhost:3000", "X-TaskCenter-Action": "delegate" };
  const invalidSchedule = await fetch(`${base}/tasks/task-http-governance/actions`, { method: "POST", headers, body: JSON.stringify({ action: "schedule", expectedAt: "bad" }) });
  assert.equal(invalidSchedule.status, 400);
  const schedule = await fetch(`${base}/tasks/task-http-governance/actions`, { method: "POST", headers, body: JSON.stringify({ action: "schedule", expectedAt: "2026-08-11T12:00:00.000Z" }) });
  assert.equal(schedule.status, 200);
  const scheduledTask = (await schedule.json()).task;
  assert.equal(scheduledTask.dueAt, "2026-08-11T12:00:00.000Z");
  assert.equal(scheduledTask.expectedAt, "");
  const activeArchive = await fetch(`${base}/tasks/task-http-governance/actions`, { method: "POST", headers, body: JSON.stringify({ action: "archive" }) });
  assert.equal(activeArchive.status, 409);
  await fetch(`${base}/tasks/task-http-governance/actions`, { method: "POST", headers, body: JSON.stringify({ action: "done" }) });
  const archive = await fetch(`${base}/tasks/task-http-governance/actions`, { method: "POST", headers, body: JSON.stringify({ action: "archive" }) });
  assert.equal(archive.status, 200);
  assert.ok((await archive.json()).task.archivedAt);
  const unarchive = await fetch(`${base}/tasks/task-http-governance/actions`, { method: "POST", headers, body: JSON.stringify({ action: "unarchive" }) });
  assert.equal(unarchive.status, 200);
  assert.equal((await unarchive.json()).task.archivedAt, "");
});

test("Session 生命周期端点会从相邻任务目标变化自动要求交接", async (context) => {
  await resetLedger();
  const { base, child } = await startControlServer();
  context.after(() => child.kill("SIGTERM"));
  await registerHttpSession(base, "sess-lifecycle-goal");
  for (const [taskId, goal] of [["task-lifecycle-one", "完成用量报告"], ["task-lifecycle-two", "实现登录页面"]]) {
    const response = await fetch(`${base}/task-events`, {
      method: "POST",
      headers: taskHeaders(),
      body: JSON.stringify({
        type: "task.create",
        session_id: "sess-lifecycle-goal",
        task_id: taskId,
        title: goal,
        goal,
      }),
    });
    assert.equal(response.status, 201);
  }
  const lifecycle = await fetch(`${base}/session-lifecycle?session_id=sess-lifecycle-goal`);
  assert.equal(lifecycle.status, 200);
  const result = await lifecycle.json();
  assert.equal(result.action, "require_handoff_before_continue");
  assert.ok(result.reasons.includes("project_or_primary_goal_changed"));
});
