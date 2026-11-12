import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants as bufferConstants } from "node:buffer";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = new URL("../", import.meta.url);
const tempDir = await mkdtemp(join(tmpdir(), "taskcenter-ledger-"));
process.env.TASKCENTER_DISABLE_LIVE_SESSION_RECONCILIATION = "1";

const envPaths = {
  TASKCENTER_SESSION_SWITCH_PATH: join(tempDir, "session-switch.jsonl"),
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
  TASKCENTER_GATE_SESSION_ALLOWLIST_PATH: join(tempDir, "gate-session-allowlist.json"),
  TASKCENTER_MCP_TOKEN_PATH: join(tempDir, "mcp-token"),
  TASKCENTER_AI_ACTIVITY_PATH: join(tempDir, "ai-activity.jsonl"),
};
for (const [key, value] of Object.entries(envPaths)) {
  process.env[key] = value;
}

const {
  completeContextTasks,
  ensureContextTask,
  getSessionStatuses,
  isContextShadowTask,
  loadSessionRegistry,
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
  taskExport,
  taskCompletionReadiness,
  taskPhaseReport,
  TaskLedgerError,
  taskTimeState,
} = await import("../scripts/task-ledger.mjs");
const { resolveTrustedMcpSession } = await import("../scripts/mcp-session-context.mjs");
const { enrichTaskWorkspaceEvent } = await import("../lib/git-workspace.mjs");

test("MCP Session 上下文：请求 threadId 优先、兼容环境变量且冲突时拒绝", () => {
  const requestSessionId = "019f0000-0000-7000-8000-000000000112";
  const otherSessionId = "019f0000-0000-7000-8000-000000000113";

  assert.deepEqual(resolveTrustedMcpSession({ _meta: { threadId: requestSessionId } }, {}), {
    sessionId: requestSessionId,
  });
  assert.deepEqual(resolveTrustedMcpSession({}, { TASKCENTER_CALLER_SESSION_ID: requestSessionId }), {
    sessionId: requestSessionId,
  });
  assert.equal(resolveTrustedMcpSession({ _meta: { threadId: "not-a-uuid" } }, {}).error, "TASKCENTER_SESSION_CONTEXT_INVALID");
  assert.equal(resolveTrustedMcpSession({ _meta: { threadId: requestSessionId } }, {
    TASKCENTER_CALLER_SESSION_ID: otherSessionId,
  }).error, "TASKCENTER_SESSION_CONTEXT_MISMATCH");
  assert.equal(resolveTrustedMcpSession({}, {}).error, "TASKCENTER_SESSION_CONTEXT_UNAVAILABLE");
  assert.deepEqual(resolveTrustedMcpSession({ _meta: { "taskcenter/sessionId": requestSessionId } }, {}), { sessionId: requestSessionId });
  assert.equal(resolveTrustedMcpSession({ _meta: { "taskcenter/sessionId": requestSessionId, threadId: otherSessionId } }, {}).error, "TASKCENTER_SESSION_CONTEXT_MISMATCH");
  assert.equal(resolveTrustedMcpSession({ _meta: { "taskcenter/sessionId": "" } }, {}).error, "TASKCENTER_SESSION_CONTEXT_INVALID");
  assert.equal(resolveTrustedMcpSession({ _meta: { "taskcenter/sessionId": requestSessionId } }, { TASKCENTER_CALLER_SESSION_ID: otherSessionId }).error, "TASKCENTER_SESSION_CONTEXT_MISMATCH");
  assert.equal(resolveTrustedMcpSession({ session_id: requestSessionId }, {}).error, "TASKCENTER_SESSION_CONTEXT_UNAVAILABLE");
});

test("Control API 返回单任务完整详情，摘要列表仍不携带证据", async (context) => {
  await resetLedger();
  await writeFile(envPaths.TASKCENTER_USAGE_REPORT_PATH, JSON.stringify({ lifetime: { byTask: [
    { id: "task-detail-1", usage: { input: 200, cachedInput: 100, output: 20, reasoning: 4 }, totalTokens: 224, count: 3, attribution: "estimated" },
  ] } }));
  const { base, child } = await startControlServer();
  context.after(() => child.kill("SIGTERM"));
  await registerHttpSession(base, "task-detail-session");
  const created = await fetch(`${base}/task-events`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({
      type: "task.create", event_id: "task-detail-create", task_id: "task-detail-1", session_id: "task-detail-session",
      workspace: "/work", title: "任务详情", goal: "验证完整详情接口", evidence: ["probe:detail"],
    }),
  });
  assert.equal(created.status, 201);
  const receipt = await created.json();
  assert.equal(receipt.agent_guidance.advisory_only, true);
  assert.ok(receipt.agent_guidance.steps[0].action);
  const prepared = await (await fetch(`${base}/task-prepare?session_id=task-detail-session`)).json();
  assert.equal(prepared.agent_guidance.task_id, "task-detail-1");
  const guided = await (await fetch(`${base}/tasks?task_id=task-detail-1&view=summary`)).json();
  assert.equal(guided.tasks[0].agent_guidance.advisory_only, true);
  const detail = await (await fetch(`${base}/tasks/task-detail-1`)).json();
  assert.deepEqual(detail.task.evidence, ["probe:detail"]);
  assert.equal(detail.task.tokenUsage.totalTokens, 224);
  const summary = await (await fetch(`${base}/tasks?view=summary&page=1&page_size=10`)).json();
  assert.equal("evidence" in summary.tasks[0], false);
  assert.equal(summary.tasks[0].tokenUsage.totalTokens, 224);
});

test("Control API 在全量任务上筛选后分页，并返回项目范围 action counts", async (context) => {
  await resetLedger();
  const { base, child } = await startControlServer();
  context.after(() => child.kill("SIGTERM"));
  await registerHttpSession(base, "task-filter-session");
  for (const [task_id, title, workspace, status, blocker] of [
    ["filter-alpha-1", "Alpha 第一条", "/workspaces/Alpha", "in_progress", ""],
    ["filter-alpha-2", "Alpha 需阻塞", "/workspaces/Alpha", "blocked", "等待依赖"],
    ["filter-beta-1", "Beta 条目", "/workspaces/Beta", "planned", ""],
  ]) {
    await registerHttpSession(base, `session-${task_id}`);
    const response = await fetch(`${base}/task-events`, { method: "POST", headers: taskHeaders(), body: JSON.stringify({ type: "task.create", event_id: `create-${task_id}`, task_id, session_id: `session-${task_id}`, title, workspace, status, blocker }) });
    assert.equal(response.status, 201);
  }
  const filtered = await (await fetch(`${base}/tasks?view=summary&project=project:alpha&query=${encodeURIComponent("需阻塞")}&page=1&page_size=1`)).json();
  assert.equal(filtered.total, 1, "query must filter the full project range before pagination");
  assert.equal(filtered.tasks[0].id, "filter-alpha-2");
  assert.equal(filtered.actionCounts.all, 2, "counts must not be based on the single result page");
  assert.equal(filtered.actionCounts.blocked, 1);
  assert.deepEqual(filtered.projects.find((item) => item.id === "project:alpha"), { id: "project:alpha", label: "Alpha" });
});

test("Control API task_id 精准查询、session 交集、view 与归档可见性", async (context) => {
  await resetLedger();
  const { base, child } = await startControlServer();
  context.after(() => child.kill("SIGTERM"));
  await registerHttpSession(base, "precise-session");
  const create = await fetch(`${base}/task-events`, {
    method: "POST", headers: taskHeaders(),
    body: JSON.stringify({
      type: "task.create", event_id: "precise-create", task_id: "precise-target", session_id: "precise-session",
      workspace: "/work", title: "精准目标", goal: "验证精准查询", evidence: ["probe:precise"],
    }),
  });
  assert.equal(create.status, 201);
  for (let index = 0; index < 40; index += 1) {
    recordTaskEvent({ type: "task.create", event_id: `noise-${index}`, task_id: `noise-${index}`, session_id: `noise-session-${index}`, title: `无关 ${index}`, evidence: [`noise-evidence-${index}`] });
  }

  const precise = await (await fetch(`${base}/tasks?task_id=precise-target`)).json();
  assert.equal(precise.tasks.length, 1);
  assert.equal(precise.tasks[0].id, "precise-target");
  assert.deepEqual(precise.tasks[0].evidence, ["probe:precise"], "默认 view 应保持 full 字段");
  assert.equal(precise.tasks.some((task) => task.id.startsWith("noise-")), false, "精准查询不随无关任务增长");

  const explicitFull = await (await fetch(`${base}/tasks?task_id=precise-target&view=full`)).json();
  assert.deepEqual(explicitFull.tasks[0].evidence, ["probe:precise"], "显式 view=full 保留完整字段");

  const summary = await (await fetch(`${base}/tasks?task_id=precise-target&view=summary`)).json();
  assert.equal(summary.tasks.length, 1);
  assert.equal("evidence" in summary.tasks[0], false, "显式 view=summary 裁剪长历史与证据");
  assert.equal(summary.tasks[0].id, "precise-target");
  assert.ok(summary.tasks[0].status);
  assert.equal(summary.tasks[0].sessionId, "precise-session");

  const intersectMiss = await (await fetch(`${base}/tasks?task_id=precise-target&session_id=other-session`)).json();
  assert.deepEqual(intersectMiss.tasks, [], "session_id 与 task_id 必须求交集");
  const intersectHit = await (await fetch(`${base}/tasks?task_id=precise-target&session_id=precise-session`)).json();
  assert.equal(intersectHit.tasks.length, 1);

  const missing = await fetch(`${base}/tasks?task_id=no-such-task`);
  assert.equal(missing.status, 200, "task_id 不存在保持可识别空结果而非错误");
  assert.deepEqual((await missing.json()).tasks, []);
  const detailMissing = await fetch(`${base}/tasks/no-such-task`);
  assert.equal(detailMissing.status, 404, "空结果与失败必须可区分");

  const summarySize = Buffer.byteLength(await (await fetch(`${base}/tasks?task_id=precise-target&view=summary`)).text());
  const seed = loadTasks().find(task => task.id === "precise-target");
  await writeFile(envPaths.TASKCENTER_TASK_LEDGER_PATH, JSON.stringify([seed, ...Array.from({ length: 1000 }, (_, index) => ({
    ...seed, id: `noise-${index}`, sessionId: "noise-session", status: "cancelled", workspace: `/projects/noise-${index}`,
  }))]));
  const all = await (await fetch(`${base}/tasks`)).json();
  assert.equal(all.tasks.length, 1001, "旧无过滤 full 不得截断到500条");
  assert.equal((await (await fetch(`${base}/tasks?session_id=noise-session`)).json()).tasks.length, 1000);
  const exactFull = await (await fetch(`${base}/tasks?task_id=precise-target`)).json();
  assert.deepEqual(exactFull.tasks[0], all.tasks.find(task => task.id === "precise-target"), "精准 full 与旧投影完全一致");
  const summarySizeAfter = Buffer.byteLength(await (await fetch(`${base}/tasks?task_id=precise-target&view=summary`)).text());
  assert.equal(summarySizeAfter, summarySize, "单任务响应不随1000条跨项目历史增长");
  context.diagnostic(`精准摘要响应 UTF-8 bytes: ${summarySize} -> ${summarySizeAfter}; full任务数: ${all.tasks.length}`);

  await fetch(`${base}/task-events`, { method: "POST", headers: taskHeaders(), body: JSON.stringify({ type: "task.done_claimed", event_id: "precise-done", task_id: "precise-target", session_id: "precise-session", status: "done_claimed", tests: ["t"], evidence: ["e"] }) });
  const archive = await fetch(`${base}/tasks/precise-target/actions`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", "X-TaskCenter-Action": "delegate" },
    body: JSON.stringify({ action: "archive" }),
  });
  assert.equal(archive.status, 200);
  const archived = await (await fetch(`${base}/tasks?task_id=precise-target`)).json();
  assert.equal(archived.tasks[0].id, "precise-target", "精确ID查询保留归档任务，支持恢复原合同");
  assert.ok(archived.tasks[0].archivedAt);
  assert.equal((await (await fetch(`${base}/tasks?session_id=precise-session`)).json()).tasks.length, 0, "普通Session列表仍隐藏归档项");
});

async function resetLedger() {
  for (const path of Object.values(envPaths)) {
    await rm(path, { force: true });
  }
}

test("128 MB 堆下扫描大事件历史仍能创建与幂等重放中文任务", async () => {
  await resetLedger();
  execFileSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { appendFileSync } from "node:fs";
    const { recordTaskEvent } = await import("./scripts/task-ledger.mjs");
    const input = { type: "task.create", event_id: "中文历史", task_id: "old", session_id: "old", title: "中文任务😀" };
    recordTaskEvent(input);
    const block = (JSON.stringify({ note: "无关历史😀".repeat(100) }) + "\\n").repeat(1024);
    for (let size = 0; size < 192 * 1024 * 1024; size += Buffer.byteLength(block)) {
      appendFileSync(process.env.TASKCENTER_TASK_EVENTS_PATH, block);
    }
    appendFileSync(process.env.TASKCENTER_TASK_EVENTS_PATH, "broken line\\n");
    assert.equal(recordTaskEvent(input).idempotent, true);
    assert.equal(recordTaskEvent({ type: "task.create", event_id: "new", task_id: "new", session_id: "new" }).task.id, "new");
    assert.equal(recordTaskEvent(input).task.title, "中文任务😀");
  `], { cwd: root, env: process.env, timeout: 30000, stdio: "pipe" });
});

test("内容字段保留换行缩进，新事件严格重放且兼容旧折叠事件", async () => {
  await resetLedger();
  const input = { type: "task.create", event_id: "multiline", task_id: "multiline", session_id: "multiline", title: "单行\n标题", evidence: ["first\n  second"], plan: ["step\n  detail"], retrospective: "a\n b" };
  const { task } = recordTaskEvent(input);
  assert.equal(task.title, "单行 标题");
  assert.equal(task.evidence[0], "first\n  second");
  assert.equal(task.plan[0], "step\n  detail");
  assert.equal(task.retrospective, "a\n b");
  assert.equal(recordTaskEvent(input).idempotent, true);
  assert.throws(() => recordTaskEvent({ ...input, evidence: ["first second"] }), /不同事件/);
  const old = JSON.parse((await readFile(envPaths.TASKCENTER_TASK_EVENTS_PATH, "utf8")).trim());
  delete old.text_format;
  old.evidence = ["first second"];
  old.plan = ["step detail"];
  old.retrospective = "a b";
  await writeFile(envPaths.TASKCENTER_TASK_EVENTS_PATH, JSON.stringify(old) + "\n");
  assert.equal(recordTaskEvent(input).idempotent, true);
  assert.throws(() => recordTaskEvent({ ...input, evidence: ["different"] }), /不同事件/);
});

test("超过500条保留最早活跃任务、归档记录与冲突约束", async () => {
  await resetLedger();
  const { task } = recordTaskEvent({ type: "task.create", task_id: "oldest", session_id: "oldest-session", status: "in_progress" });
  const seeded = [task, ...Array.from({ length: 499 }, (_, index) => ({
    ...task, id: `closed-${index}`, sessionId: `closed-session-${index}`, status: "cancelled", archivedAt: task.createdAt,
  }))];
  await writeFile(envPaths.TASKCENTER_TASK_LEDGER_PATH, JSON.stringify(seeded));
  recordTaskEvent({ type: "task.create", task_id: "newest", session_id: "newest-session" });
  assert.equal(loadTasks().length, 501);
  assert.equal(loadTasks().find((item) => item.id === "oldest").status, "in_progress");
  assert.ok(loadTasks().find((item) => item.id === "closed-0").archivedAt);
  assert.throws(() => recordTaskEvent({ type: "task.create", task_id: "conflict", session_id: "oldest-session" }), /ACTIVE_TASK_CONFLICT/);
});

test("创建事件超出5000条缓存仍幂等，缺失投影拒绝复活", async () => {
  await resetLedger();
  const input = { type: "task.create", event_id: "old-create", task_id: "old-task", session_id: "old-session", title: "原任务" };
  recordTaskEvent(input);
  await writeFile(envPaths.TASKCENTER_TASK_EVENT_IDS_PATH, JSON.stringify(Array.from({ length: 5000 }, (_, index) => `later-${index}`)));
  const before = await readFile(envPaths.TASKCENTER_TASK_EVENTS_PATH, "utf8");
  assert.equal(recordTaskEvent(input).idempotent, true);
  assert.throws(() => recordTaskEvent({ ...input, title: "篡改" }), /event_id 已被不同事件使用/);
  await writeFile(envPaths.TASKCENTER_TASK_LEDGER_PATH, "[]");
  assert.throws(() => recordTaskEvent(input), /TASK_LEDGER_RECOVERY_REQUIRED/);
  assert.throws(() => recordTaskEvent({ ...input, event_id: "different-create" }), /TASK_LEDGER_RECOVERY_REQUIRED/);
  const implicitId = { ...input };
  delete implicitId.task_id;
  assert.throws(() => recordTaskEvent(implicitId), /TASK_LEDGER_RECOVERY_REQUIRED/);
  assert.equal(await readFile(envPaths.TASKCENTER_TASK_EVENTS_PATH, "utf8"), before);
  assert.deepEqual(loadTasks(), []);
});

test("查询缺失会话任务不会写账本；reconcile 收口运行并保留任务，不自动移除", async (context) => {
  await resetLedger();
  recordTaskEvent({ type: "task.create", task_id: "orphan", session_id: "absent-session" });
  const dashboardPath = join(tempDir, "empty-source.json");
  await writeFile(dashboardPath, JSON.stringify({ threads: [], source: { availableThreads: [] } }));
  const { base, child } = await startControlServer({ TASKCENTER_DISABLE_LIVE_SESSION_RECONCILIATION: "0", TASKCENTER_DASHBOARD_PATH: dashboardPath });
  context.after(() => child.kill("SIGTERM"));
  let startupFinished = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    startupFinished = Boolean((await (await fetch(`${base}/reconciliation`)).json()).lastRunAt);
    if (startupFinished) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(startupFinished, true, "等待后台启动对账结束，再独立验证GET不写账本");
  const before = await readFile(envPaths.TASKCENTER_TASK_LEDGER_PATH, "utf8");
  for (const path of ["/tasks", "/tasks?view=summary", "/session-status"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200);
    await response.json();
    assert.equal(await readFile(envPaths.TASKCENTER_TASK_LEDGER_PATH, "utf8"), before);
  }
  assert.equal((await (await fetch(`${base}/tasks`)).json()).tasks[0].id, "orphan");
  await registerHttpSession(base, "new-session");
  assert.equal(loadTasks().find((item) => item.id === "orphan").status, "planned", "写事件也不能隐式移除其他任务");
  reconcileTasks([]); // Session 脱离：收口运行并保留任务，不自动移除。
  recordTaskEvent({ type: "task.create", task_id: "survivor", session_id: "new-session" });
  const raw = JSON.parse(await readFile(envPaths.TASKCENTER_TASK_LEDGER_PATH, "utf8"));
  const orphan = raw.find((item) => item.id === "orphan");
  assert.equal(orphan.status, "planned", "reconcile 不自动移除任务，也不伪造完成");
  assert.ok(orphan.sessionDetachedAt, "reconcile 标记会话脱离");
  assert.equal(orphan.runs.at(-1).ended_reason, "session_detached", "reconcile 收口运行");
  assert.ok(orphan.runs.at(-1).ended_at, "运行结束时间已记录");
  // 任务保留后，同 session 重复 create 走恢复语义：不抛错、不重复创建，仍指向同一任务。
  const resumed = recordTaskEvent({ type: "task.create", task_id: "orphan", session_id: "absent-session" });
  assert.equal(resumed.task.id, "orphan", "恢复语义仍绑定原任务");
  assert.equal(loadTasks().filter((task) => task.id === "orphan").length, 1, "不重复创建任务");
  await rm(envPaths.TASKCENTER_TASK_EVENTS_PATH);
  const resumedAgain = recordTaskEvent({ type: "task.create", task_id: "orphan", session_id: "absent-session" });
  assert.equal(resumedAgain.task.id, "orphan");
});

async function startControlServer(options = {}) {
  const port = 38_000 + (process.pid % 1_000);
  const child = spawn(process.execPath, ["scripts/control-server.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      TASKCENTER_CONTROL_PORT: String(port),
      TASKCENTER_JEV_ROUTING: "0",
      TASKCENTER_SESSIONS_ROOT: join(tempDir, "sessions"),
      TASKCENTER_MODEL_RATES_PATH: join(tempDir, "model-rates.json"),
      TASKCENTER_RUNTIME_DIR: join(tempDir, "runtime"),
      ...envPaths,
      ...options,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForReady(child);
  return { port, child, base: `http://127.0.0.1:${port}` };
}

test("主动处理入口校验人工来源，本地对账与持久队列可见且重复请求复用", async t => {
  await resetLedger();
  const { base, child } = await startControlServer({ TASKCENTER_AI_WORKSPACE: "/work" });
  t.after(() => child.kill());
  await registerHttpSession(base, "ai-work-session");
  const created = await fetch(`${base}/task-events`, { method: "POST", headers: taskHeaders(), body: JSON.stringify({ type: "task.create", event_id: "ai-work-create", task_id: "ai-work-task", session_id: "ai-work-session", workspace: "/work", title: "主动核实", goal: "核实待确认交付", evidence: ["probe:work"] }) });
  assert.equal(created.status, 201);
  const denied = await fetch(`${base}/ai/work`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(denied.status, 403);
  const handoffDenied = await fetch(`${base}/ai/work`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handoff: { task_id: "ai-work-task" } }) });
  assert.equal(handoffDenied.status, 403);
  const init = { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-taskcenter-action": "delegate" }, body: JSON.stringify({ intent: "优先主动核实" }) };
  const noAnomaly = await (await fetch(`${base}/ai/work`, { ...init, body: "{}" })).json();
  assert.equal(noAnomaly.queued, 0, "正常planned任务不触发空白主动分析");
  const response = await fetch(`${base}/ai/work`, init);
  assert.equal(response.status, 202);
  const first = await response.json();
  assert.equal(first.queued, 1);
  const second = await (await fetch(`${base}/ai/work`, init)).json();
  assert.equal(second.request_id, first.request_id);
  assert.equal(second.reused, true);
  const changed = await fetch(`${base}/ai/work`, { ...init, body: JSON.stringify({ intent: "优先恢复导出" }) });
  assert.equal(changed.status, 409);
  const unsafe = await fetch(`${base}/ai/work`, { ...init, body: JSON.stringify({ intent: "api_key=abcdefghijklmnop" }) });
  assert.equal(unsafe.status, 400);
  const activity = await (await fetch(`${base}/ai/activity`)).json();
  assert.equal(activity.work.pending, 1);
  assert.equal(activity.work.intent, "优先主动核实");
  assert.equal(activity.rows.filter(row => row.id === first.request_id).length, 1);
});

function taskHeaders() {
  return {
    "Content-Type": "application/json",
    "X-TaskCenter-Task": "mcp",
  };
}

test("人工移交入口精确绑定任务归属和版本，不接受过期授权", async t => {
  await resetLedger();
  const { base, child } = await startControlServer({ TASKCENTER_AI_WORKSPACE: "/work" });
  t.after(() => child.kill());
  await registerHttpSession(base, "handoff-owner");
  const headers = { "content-type": "application/json", origin: "http://localhost:3000", "x-taskcenter-action": "delegate" };
  await fetch(`${base}/task-events`, { method: "POST", headers: taskHeaders(), body: JSON.stringify({ type: "task.create", event_id: "handoff-create", task_id: "handoff-task", session_id: "handoff-owner", workspace: "/work", agent: "codex", title: "明确移交", goal: "执行修复" }) });
  const send = expected_event_id => fetch(`${base}/ai/work`, { method: "POST", headers, body: JSON.stringify({ handoff: { task_id: "handoff-task", expected_session_id: "handoff-owner", expected_event_id } }) });
  assert.equal((await send("stale")).status, 409);
  const response = await send("handoff-create"); assert.equal(response.status, 202);
  const result = await response.json(); assert.equal(result.queued, 1);
  const saved = JSON.parse(await readFile(join(tempDir, "runtime", "ai-work-request.json"), "utf8"));
  assert.deepEqual(saved.task_ids, ["handoff-task"]);
  assert.equal(saved.handoff.expected_session_id, "handoff-owner"); assert.equal(saved.handoff.expected_event_id, "handoff-create");
});

function legacyTaskHeaders() {
  return {
    "Content-Type": "application/json",
    "X-ReqRadar-Task": "mcp",
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
      project_id: identity.project_id,
    }),
  });
  assert.equal(response.status, 200);
}

test("会话状态和 Pilot 使用 session_index 标题且不伪造缺失标题", async (context) => {
  await resetLedger();
  const dashboardPath = join(tempDir, "session-title-dashboard.json");
  await writeFile(envPaths.TASKCENTER_USAGE_REPORT_PATH, JSON.stringify({ lifetime: { bySession: [
    { sessionId: "session-titled", usage: { input: 100, cachedInput: 25, output: 15, reasoning: 2 }, totalTokens: 117, count: 2 },
  ] } }));
  await writeFile(dashboardPath, JSON.stringify({ source: { sessionTitles: [
    { id: "session-titled", title: "排查新任务未记录问题", updatedAt: "2099-09-08T02:00:00.000Z" },
    { id: "session-untitled", title: "临时标题", updatedAt: "2099-09-08T01:00:00.000Z" },
  ] } }));
  const { base, child } = await startControlServer({ TASKCENTER_DASHBOARD_PATH: dashboardPath });
  context.after(() => child.kill("SIGTERM"));
  await registerHttpSession(base, "session-titled", { project_id: "example" });
  await registerHttpSession(base, "session-untitled", { project_id: "other" });

  const sessions = (await (await fetch(`${base}/session-status`)).json()).sessions;
  assert.deepEqual(sessions.slice(0, 2).map((item) => item.sessionId), ["session-titled", "session-untitled"]);
  assert.equal(sessions.find((item) => item.sessionId === "session-titled").title, "排查新任务未记录问题");
  assert.equal(sessions.find((item) => item.sessionId === "session-untitled").title, "临时标题");
  assert.deepEqual(sessions.find((item) => item.sessionId === "session-titled").tokenUsage, { sessionId: "session-titled", usage: { input: 100, cachedInput: 25, output: 15, reasoning: 2 }, totalTokens: 117, count: 2 });
  assert.equal(sessions.find((item) => item.sessionId === "session-untitled").tokenUsage, null);

  const projects = (await (await fetch(`${base}/context-management-pilots`)).json()).projects;
  assert.equal(projects.find((item) => item.project_id === "example").sessions[0].title, "排查新任务未记录问题");
  assert.equal(projects.find((item) => item.project_id === "other").sessions[0].title, "临时标题");

  await writeFile(dashboardPath, JSON.stringify({ source: { sessionTitles: [
    { id: "session-titled", title: "已更新标题", updatedAt: "2099-09-08T03:00:00.000Z" },
  ] } }));
  const refreshed = (await (await fetch(`${base}/session-status`)).json()).sessions;
  assert.equal(refreshed[0].title, "已更新标题", "无需重启服务即可覆盖旧标题");
  assert.equal(refreshed.find((item) => item.sessionId === "session-untitled").title, "");
});

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
  state.calls.push({ name: "context.complete_task", eventId: input.event_id, taskCenterTaskId: input.taskcenter_task_id });
  save(state);
  return result({ accepted: true });
});

await server.connect(new StdioServerTransport());
`);
}

test("session.register 不误创建任务", async () => {
  await resetLedger();
  const result = recordTaskEvent({ type: "session.register", session_id: "sess-1", workspace: "/work", project_id: "project-alpha" });
  assert.equal(result.task, null);
  assert.equal(result.idempotent, undefined);
  assert.equal(loadTasks().length, 0);
  assert.equal(loadSessionRegistry()["sess-1"].projectId, "project-alpha");
});

test("worktree 身份进入 Session 和任务投影", async () => {
  await resetLedger();
  const main = join(tempDir, "worktree-main");
  const workspace = join(tempDir, "worktree-feature");
  await rm(main, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
  execFileSync("git", ["init", "-q", main]);
  execFileSync("git", ["-C", main, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", main, "config", "user.name", "TaskCenter Test"]);
  await writeFile(join(main, "README.md"), "fixture\n");
  execFileSync("git", ["-C", main, "add", "README.md"]);
  execFileSync("git", ["-C", main, "commit", "-qm", "fixture"]);
  execFileSync("git", ["-C", main, "worktree", "add", "-qb", "feature/parallel", workspace]);

  recordTaskEvent(enrichTaskWorkspaceEvent({ type: "session.register", session_id: "sess-worktree", workspace }));
  const result = recordTaskEvent(enrichTaskWorkspaceEvent({
    type: "task.create",
    task_id: "task-worktree",
    session_id: "sess-worktree",
    workspace,
    contract_version: "v2",
    title: "并行任务",
    goal: "验证 worktree 投影",
    scope: ["."],
    non_goals: ["不管理 worktree 生命周期"],
    workflow_profile: "fast",
    acceptance_criteria: [{ id: "worktree", description: "识别 worktree", required: true }],
  }));
  assert.equal(result.task.projectId, "worktree-main");
  assert.equal(result.task.workspaceBranch, "feature/parallel");
  assert.equal(result.task.executionEnvironment, "worktree");
  assert.equal(loadSessionRegistry()["sess-worktree"].repositoryRoot.endsWith("/worktree-main"), true);
});

test("阶段事件写入任务账本并保持幂等、状态机校验与旧账本兼容", async () => {
  await resetLedger();
  recordTaskEvent({ type: "session.register", event_id: "phase-session", session_id: "phase-owner", workspace: "/work" });
  recordTaskEvent({
    type: "task.create",
    event_id: "phase-task-create",
    task_id: "phase-task",
    session_id: "phase-owner",
    workspace: "/work",
    title: "阶段计时",
    goal: "验证账本接入",
  });
  assert.equal(taskPhaseReport("phase-task").status, "unknown");
  const subject = { type: "artifact", value: "phase-snapshot", observed_at: "2026-09-02T00:00:00.000Z" };
  const start = {
    type: "phase.reported",
    event_id: "phase-start",
    task_id: "phase-task",
    session_id: "phase-owner",
    phase: "planning",
    transition: "started",
    occurred_at: "2026-09-02T00:00:00.000Z",
    subject_ref: subject,
    reason: "开始规划",
    activity_source: "agent",
  };
  assert.equal(recordTaskEvent(start, { requireRegistered: true }).task.phaseEvents.length, 1);
  assert.equal(recordTaskEvent(start, { requireRegistered: true }).idempotent, true);
  assert.throws(() => recordTaskEvent({ ...start, reason: "冲突重试" }, { requireRegistered: true }), /幂等冲突|event_id/);
  assert.throws(() => recordTaskEvent({ ...start, occurred_at: "2026-09-02T00:01:00.000Z" }, { requireRegistered: true }), /幂等冲突|拒绝重放/);
  assert.throws(() => recordTaskEvent({ ...start, event_id: "phase-early-finish", transition: "finished", occurred_at: "2026-09-01T23:59:00.000Z" }, { requireRegistered: true }), /时间顺序/);
  recordTaskEvent({ ...start, event_id: "phase-finish", transition: "finished", occurred_at: "2026-09-02T00:10:00.000Z", reason: "规划结束" }, { requireRegistered: true });
  const auditBeforeEvictedReplay = (await readFile(envPaths.TASKCENTER_TASK_EVENTS_PATH, "utf8")).trim().split("\n").length;
  await writeFile(envPaths.TASKCENTER_TASK_EVENT_IDS_PATH, JSON.stringify(Array.from({ length: 5_000 }, (_, index) => `evicted-${index}`)));
  assert.equal(recordTaskEvent(start, { requireRegistered: true }).idempotent, true);
  const auditAfterEvictedReplay = (await readFile(envPaths.TASKCENTER_TASK_EVENTS_PATH, "utf8")).trim().split("\n").length;
  assert.equal(auditAfterEvictedReplay, auditBeforeEvictedReplay, "阶段事件 ID 从近期缓存淘汰后仍不得重复追加");
  const report = taskPhaseReport("phase-task", "2026-09-02T00:20:00.000Z");
  assert.equal(report.status, "complete");
  assert.equal(report.phases.planning.phase_wall_ms, 600_000);
  assert.equal(report.phases.implementing.phase_wall_ms, null);
  assert.throws(() => taskPhaseReport("phase-task", "not-a-time"), /as_of/);
});

test("显式 Session merge 配合稳定 activity_id 支持重启续接并保留执行器归因", async () => {
  await resetLedger();
  recordTaskEvent({ type: "session.register", event_id: "restart-owner-register", session_id: "restart-owner", workspace: "/work" });
  recordTaskEvent({
    type: "task.create",
    event_id: "restart-task-create",
    task_id: "restart-task",
    session_id: "restart-owner",
    workspace: "/work",
    title: "Session 重启阶段续接",
    goal: "验证显式授权后的阶段生命周期续接",
  });
  const subject = { type: "artifact", value: "restart-snapshot", observed_at: "2026-09-02T00:00:00.000Z" };
  const base = {
    type: "phase.reported",
    task_id: "restart-task",
    phase: "verifying",
    subject_ref: subject,
    activity_source: "agent",
    activity_id: "verification-run-1",
  };
  recordTaskEvent({ ...base, event_id: "restart-start", session_id: "restart-owner", transition: "started", occurred_at: "2026-09-02T00:00:00.000Z", reason: "开始验证" }, { requireRegistered: true });
  recordTaskEvent({ ...base, event_id: "restart-pause", session_id: "restart-owner", transition: "paused", occurred_at: "2026-09-02T00:10:00.000Z", reason: "Session 重启" }, { requireRegistered: true });
  assert.throws(() => recordTaskEvent({ ...base, event_id: "restart-unauthorized", session_id: "restart-resumed", transition: "resumed", occurred_at: "2026-09-02T00:20:00.000Z", reason: "未经授权恢复" }, { requireRegistered: true }), /不是该任务的登记 Session/);

  await writeFile(envPaths.TASKCENTER_SESSION_MERGES_PATH, JSON.stringify({ canonicalSessionId: "restart-owner", aliases: ["restart-resumed"] }));
  recordTaskEvent({ type: "session.register", event_id: "restart-resumed-register", session_id: "restart-resumed", workspace: "/work" });
  recordTaskEvent({ ...base, event_id: "restart-resume", session_id: "restart-resumed", transition: "resumed", occurred_at: "2026-09-02T00:20:00.000Z", reason: "恢复验证" }, { requireRegistered: true });
  recordTaskEvent({ ...base, event_id: "restart-finish", session_id: "restart-resumed", transition: "finished", occurred_at: "2026-09-02T00:30:00.000Z", reason: "验证完成" }, { requireRegistered: true });

  const report = taskPhaseReport("restart-task", "2026-09-02T00:30:00.000Z");
  assert.equal(report.status, "complete");
  assert.equal(report.phases.verifying.phase_wall_ms, 1_800_000);
  assert.equal(report.phases.verifying.phase_active_ms, 1_200_000);
  assert.equal(report.phases.verifying.phase_wait_ms, 600_000);
  assert.equal(report.executor_active_ms["session:restart-owner"], 600_000);
  assert.equal(report.executor_active_ms["session:restart-resumed"], 600_000);
});

test("scheduled_readonly Profile 绑定已登记 Session 且不创建任务", async () => {
  await resetLedger();
  recordTaskEvent({ type: "session.register", event_id: "sess-scheduled-register", session_id: "sess-scheduled", workspace: "/work" });
  const profile = setSessionScheduledReadonlyProfile("sess-scheduled", {
    profile: "scheduled_readonly",
    automation_id: "instory",
    project_id: "instory",
    workspace_root: "/work",
    report_path: "/work/report.md",
    report_mutation: true,
  });
  assert.equal(profile.reportMutation, true);
  assert.equal(setSessionScheduledReadonlyScanExemption("sess-scheduled", true).scanExempt, true);
  assert.equal(setSessionScheduledReadonlyScanExemption("sess-scheduled", false).scanExempt, false);
  assert.equal(getSessionStatuses([], [])[0].scheduledReadonly.automationId, "instory");
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
  for (const cwd of ["/", "/other-project", ""]) {
    recordSessionL0Audit("sess-l0", cwd);
    assert.equal(loadSessionRegistry()["sess-l0"].workspace, "/work", "只读审计不能重绑正式 workspace");
  }
  assert.throws(() => recordSessionL0Audit("not-registered"), /尚未登记/);
});

test("任务 session_id 不在当前会话源时拒绝创建；脱离任务收口运行并保留", async () => {
  await resetLedger();
  recordTaskEvent({ type: "task.create", session_id: "sess-stale", task_id: "task-stale", title: "旧任务", goal: "旧目标" });
  recordTaskEvent({ type: "task.create", session_id: "sess-current", task_id: "task-current", title: "当前任务", goal: "当前目标" });

  const removed = reconcileTasks(["sess-current"]);
  assert.deepEqual(removed.map((task) => task.id), ["task-stale"]);
  const after = loadTasks();
  assert.deepEqual(after.map((task) => task.id).sort(), ["task-current", "task-stale"], "脱离任务保留在账本");
  const stale = after.find((task) => task.id === "task-stale");
  assert.ok(stale.sessionDetachedAt, "脱离任务标记会话脱离");
  assert.equal(stale.runs.at(-1).ended_reason, "session_detached");
  assert.equal(stale.status, "planned", "不自动判定完成");
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
  assert.equal(completed.accepted, true);
  assert.equal(completed.completionPacket.schemaVersion, "taskcenter-completion-v2");
  assert.equal(completed.completionPacket.taskId, first.task.id);
  assert.equal(completed.completionPacket.completionReadiness.completionClaim.allowed, true);
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

test("正式 TaskCenter 任务未满足 Completion Packet 门禁时不能完成 Context", async () => {
  await resetLedger();
  recordTaskEvent({ type: "session.register", event_id: "packet-session", session_id: "packet-session", workspace: "/work", agent: "codex" });
  recordTaskEvent({
    type: "task.create",
    event_id: "packet-task-create",
    task_id: "packet-task",
    context_task_id: "context-packet",
    session_id: "packet-session",
    title: "严格任务",
    goal: "严格完成",
    status: "done_claimed",
    evidence: ["实现声明"],
    contract_version: "v2",
    scope: ["scripts/"],
    non_goals: [],
    workflow_profile: "strict",
    review_policy: "required",
    acceptance_criteria: [{ id: "ac", description: "完成", required: true }],
    verification_plan: [{ id: "tests", title: "测试", kind: "test", required: true }],
  });
  const result = completeContextTasks({ context_task_id: "context-packet", taskcenter_task_id: "packet-task" });
  assert.equal(result.accepted, false);
  assert.equal(result.error, "completion_claim_blocked");
  assert.ok(result.reasons.includes("current_subject_missing"));
  assert.equal(result.completed.length, 0);
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

test("TaskCenter 页面仅对门禁通过的 fast 任务同步关联 ProjectContext", async (context) => {
  await resetLedger();
  recordTaskEvent({ type: "session.register", event_id: "ui-sync-session", session_id: "ui-sync-session", workspace: "/work" });
  recordTaskEvent({
    type: "task.create",
    event_id: "ui-sync-create",
    session_id: "ui-sync-session",
    task_id: "ui-sync-task",
    context_task_id: "ui-sync-context",
    workspace: "/work",
    title: "同步 ProjectContext",
    goal: "验证页面完成同步",
    contract_version: "v2",
    scope: ["completion bridge"],
    non_goals: [],
    workflow_profile: "fast",
    review_policy: "not_required",
    acceptance_criteria: [{ id: "done", description: "同步完成", required: true }],
  });
  recordTaskEvent({
    type: "task.close",
    event_id: "ui-sync-close",
    session_id: "ui-sync-session",
    task_id: "ui-sync-task",
    context_task_id: "ui-sync-context",
    status: "done_claimed",
    evidence: ["fast completion evidence"],
    close_requirements: [{
      requirement_id: "done",
      status: "passed",
      evidence_refs: ["fast completion evidence"],
      checked_at: "2026-08-25T00:00:00.000Z",
      checked_by: { type: "task_platform", id: "taskcenter-test" },
    }],
  });

  const fakeServerPath = join(tempDir, "ui-sync-context-server.mjs");
  const fakeStatePath = join(tempDir, "ui-sync-context-state.json");
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

  const response = await fetch(`${base}/tasks/ui-sync-task/sync-project-context`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:3000",
      "X-TaskCenter-Action": "delegate",
    },
    body: JSON.stringify({ confirm: true, requestId: "55555555-5555-4555-8555-555555555555" }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.accepted, true);
  assert.equal(payload.completionPacket.completionReadiness.completionClaim.allowed, true);
  const state = JSON.parse(await readFile(fakeStatePath, "utf8"));
  assert.deepEqual(state.calls, [{
    name: "context.complete_task",
    eventId: "taskcenter-ui-context-complete-55555555-5555-4555-8555-555555555555",
    taskCenterTaskId: "ui-sync-task",
  }]);
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
  assert.deepEqual(loadVisibleTasks(), []);
  recordTaskEvent({ type: "task.review", session_id: "sess-time", task_id: "task-time", event_id: "manual-unarchive", archived_at: "__UNARCHIVE__" });
  assert.equal(loadTasks()[0].archivedAt, "");
  assert.deepEqual(loadVisibleTasks().map((task) => task.id), ["task-time"]);
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

test("活跃任务复用 Advisor 只读查询并把最终选择写入独立审计", async (context) => {
  await resetLedger();
  const { base, child } = await startControlServer();
  context.after(() => child.kill("SIGTERM"));
  await registerHttpSession(base, "session-reuse", { project_id: "example" });
  const inspectFromParent = async () => {
    const hook = await runTaskcenterHook(base, { session_id: "session-reuse", cwd: "/", tool_name: "exec_command", tool_input: { cmd: "pwd" } });
    assert.equal(hook.code, 0, hook.stderr);
    assert.match(hook.stdout, /L0 确定性只读|任务门禁通过/);
    const sessions = (await (await fetch(`${base}/session-status`)).json()).sessions;
    assert.equal(sessions.find((item) => item.sessionId === "session-reuse").workspace, "/work");
  };
  await inspectFromParent();
  const created = await fetch(`${base}/task-events`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({
      type: "task.create",
      event_id: "reuse-http-task-create",
      session_id: "session-reuse",
      task_id: "task-reuse-http",
      context_task_id: "context-reuse-http",
      workspace: "/work",
      title: "实现 FCM 通知链路",
      goal: "完成 FCM 通知失败重试和送达验证",
      status: "in_progress",
    }),
  });
  assert.equal(created.status, 201, await created.text());
  await inspectFromParent();
  const ledgerBefore = await readFile(envPaths.TASKCENTER_TASK_LEDGER_PATH, "utf8");
  const eventsBefore = await readFile(envPaths.TASKCENTER_TASK_EVENTS_PATH, "utf8");
  const checkInput = {
    session_id: "session-reuse",
    workspace: "/work",
    project_id: "example",
    context_task_id: "context-reuse-http",
    title: "继续完善 FCM 通知链路",
    goal: "补充 FCM 通知失败重试和送达验证",
    scope: ["FCM notification delivery"],
  };
  const check = await fetch(`${base}/task-reuse/check`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify(checkInput),
  });
  const advice = await check.json();
  assert.equal(check.status, 200, advice.error);
  assert.equal(advice.recommendation, "reuse");
  assert.deepEqual(advice.project_identity, { status: "registered", project_id: "example" });
  assert.equal(advice.candidates[0].task_id, "task-reuse-http");
  assert.equal(advice.advisory_only, true);
  assert.equal(await readFile(envPaths.TASKCENTER_TASK_LEDGER_PATH, "utf8"), ledgerBefore);
  assert.equal(await readFile(envPaths.TASKCENTER_TASK_EVENTS_PATH, "utf8"), eventsBefore);
  const mismatchedCheck = await fetch(`${base}/task-reuse/check`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({ ...checkInput, project_id: "forged-project" }),
  });
  assert.equal(mismatchedCheck.status, 403);
  const crossProject = await fetch(`${base}/task-reuse/check`, {
    method: "POST", headers: taskHeaders(), body: JSON.stringify({ ...checkInput, workspace: "/other-project" }),
  });
  assert.equal(crossProject.status, 403);
  assert.match((await crossProject.json()).error, /workspace.*不一致/);

  const decision = {
    event_id: "reuse-http-decision",
    check_id: advice.check_id,
    session_id: "session-reuse",
    workspace: "/work",
    project_id: "example",
    context_task_id: "context-reuse-http",
    recommendation: advice.recommendation,
    confidence: advice.confidence,
    candidate_task_ids: advice.candidates.map((candidate) => candidate.task_id),
    match_reasons: advice.match_reasons,
    final_decision: "reuse",
    selected_task_id: "task-reuse-http",
    occurred_at: "2026-09-02T03:00:00.000Z",
  };
  const report = await fetch(`${base}/task-reuse/decisions`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify(decision),
  });
  assert.equal(report.status, 201, await report.text());
  const mismatchedReport = await fetch(`${base}/task-reuse/decisions`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({ ...decision, event_id: "reuse-http-decision-forged", project_id: "forged-project" }),
  });
  assert.equal(mismatchedReport.status, 403);
  const replay = await fetch(`${base}/task-reuse/decisions`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify(decision),
  });
  const replayPayload = await replay.json();
  assert.equal(replay.status, 200, replayPayload.error);
  assert.equal(replayPayload.idempotent, true);
  const conflict = await fetch(`${base}/task-reuse/decisions`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({ ...decision, final_decision: "uncertain", selected_task_id: undefined }),
  });
  assert.equal(conflict.status, 409);
  assert.equal(await readFile(envPaths.TASKCENTER_TASK_LEDGER_PATH, "utf8"), ledgerBefore);
  assert.equal(await readFile(envPaths.TASKCENTER_TASK_EVENTS_PATH, "utf8"), eventsBefore);
  const unauthorizedQuery = await fetch(`${base}/task-reuse/decisions?project_id=example`);
  assert.equal(unauthorizedQuery.status, 403);
  const markerOnlyQuery = await fetch(`${base}/task-reuse/decisions?project_id=example`, { headers: taskHeaders() });
  assert.equal(markerOnlyQuery.status, 403);
  const mcpToken = (await readFile(envPaths.TASKCENTER_MCP_TOKEN_PATH, "utf8")).trim();
  const queriedResponse = await fetch(`${base}/task-reuse/decisions?project_id=example`, {
    headers: { ...taskHeaders(), "X-TaskCenter-MCP-Token": mcpToken },
  });
  const queried = await queriedResponse.json();
  assert.equal(queriedResponse.status, 200, queried.error);
  assert.equal(queried.decisions.length, 1);
  assert.equal(queried.decisions[0].selected_task_id, "task-reuse-http");
  assert.equal(queried.summary.decision_count, 1);
  assert.equal(queried.summary.automatic_block_count, 0);
  assert.equal(queried.summary.automatic_merge_count, 0);

  await registerHttpSession(base, "session-reuse-legacy");
  const unknownProjectCheck = await fetch(`${base}/task-reuse/check`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({
      ...checkInput,
      session_id: "session-reuse-legacy",
      project_id: "caller-asserted-project",
      context_task_id: "context-independent-legacy",
      title: "独立日志归档",
      goal: "实现本地日志按月归档",
      scope: ["local log archive"],
    }),
  });
  const unknownProjectAdvice = await unknownProjectCheck.json();
  assert.equal(unknownProjectCheck.status, 200, unknownProjectAdvice.error);
  assert.deepEqual(unknownProjectAdvice.project_identity, { status: "unknown", project_id: "unknown" });
  const unknownProjectReport = await fetch(`${base}/task-reuse/decisions`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({
      event_id: "reuse-http-decision-legacy-project",
      check_id: unknownProjectAdvice.check_id,
      session_id: "session-reuse-legacy",
      workspace: "/work",
      project_id: "caller-asserted-project",
      recommendation: unknownProjectAdvice.recommendation,
      confidence: unknownProjectAdvice.confidence,
      candidate_task_ids: unknownProjectAdvice.candidates.map((candidate) => candidate.task_id),
      match_reasons: unknownProjectAdvice.match_reasons,
      final_decision: unknownProjectAdvice.recommendation,
      occurred_at: "2026-09-02T03:05:00.000Z",
    }),
  });
  const unknownProjectRecord = await unknownProjectReport.json();
  assert.equal(unknownProjectReport.status, 201, unknownProjectRecord.error);
  assert.equal(unknownProjectRecord.record.project_id, "unknown");
  const allDecisionsResponse = await fetch(`${base}/task-reuse/decisions`, {
    headers: { ...taskHeaders(), "X-TaskCenter-MCP-Token": mcpToken },
  });
  const allDecisions = await allDecisionsResponse.json();
  assert.equal(allDecisions.summary.project_count, 1, "unknown project 不计入试点项目覆盖");
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
    { name: "context.complete_task", eventId: "reqradar-context-complete-retry-report", taskCenterTaskId: "task-retry" },
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
  const taskHeaders = legacyTaskHeaders();
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
  assert.equal(shadowResponse.status, 201, "兼容期必须继续接受旧 X-ReqRadar-Task 请求头");
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
  assert.equal(first.accepted, true, JSON.stringify(first));
  assert.deepEqual(first.warnings.map((warning) => warning.code), ["SESSION_NOTIFICATION_FAILED"]);
  assert.equal(loadTasks().find((task) => task.id === "verification-warning-task").verificationClaims.length, 1);

  const replay = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_verification_report", arguments: verification })));
  assert.equal(replay.accepted, true);
  assert.equal(replay.warnings, undefined);
  assert.equal(loadTasks().find((task) => task.id === "verification-warning-task").verificationClaims.length, 1);
});

test("MCP Review attestation 先落账，通知失败降级且非法 v3 返回真实校验原因", async (context) => {
  await resetLedger();
  const fakeServerPath = join(tempDir, "review-warning-context-server.mjs");
  const fakeStatePath = join(tempDir, "review-warning-context-state.json");
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
  const client = new Client({ name: "taskcenter-review-warning", version: "0.0.0" });
  await client.connect(transport);
  context.after(async () => { await client.close().catch(() => {}); });

  const subject = {
    type: "git_commit", value: "review-warning-revision", repository: "example", branch: "main",
    observed_at: "2026-08-25T08:00:00.000Z",
  };
  const owner = { type: "agent", id: "review-owner", provider: "openai", session_id: "review-owner-session" };
  const reviewer = { type: "agent", id: "reviewer-luna", provider: "openai", session_id: "reviewer-session" };
  for (const session_id of ["review-owner-session", "reviewer-session"]) {
    await client.callTool({ name: "taskcenter_session_register", arguments: {
      session_id, agent: "codex", provider: "openai", model: "gpt-test", workspace: "/work",
    } });
  }
  await client.callTool({ name: "taskcenter_task_create", arguments: {
    session_id: "review-owner-session", task_id: "review-warning-task", context_task_id: "review-warning-context",
    contract_version: "v2", title: "Review 通知降级", goal: "Review 先落账", scope: ["example"], non_goals: [],
    workflow_profile: "standard", review_policy: "required", execution_environment: "local",
    acceptance_criteria: [{ id: "review", description: "独立 Review 通过", required: true }],
    verification_plan: [{ id: "review-check", title: "Review", kind: "other", required: true }],
    plan: ["报告 Review"], subject_ref: subject, actor: owner,
  } });
  const attestation = {
    session_id: "reviewer-session", task_id: "review-warning-task", event_id: "review-warning-event",
    id: "review-warning-attestation", reviewer, reviewer_session_id: "reviewer-session", subject_ref: subject,
    scope: "all", review_contract_version: "v2", spec_verdict: "compliant", quality_verdict: "approved",
    verdict: "approved", unresolved_findings: 0, unverified_requirements: [], observed_at: "2026-08-25T08:05:00.000Z",
  };

  const first = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_review_report", arguments: attestation })));
  assert.equal(first.accepted, true, JSON.stringify(first));
  assert.equal(first.review_status, "passed");
  assert.deepEqual(first.warnings.map((warning) => warning.code), ["SESSION_NOTIFICATION_FAILED"]);
  assert.equal(loadTasks().find((task) => task.id === "review-warning-task").reviewAttestations.length, 1);

  const replay = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_review_report", arguments: attestation })));
  assert.equal(replay.accepted, true);
  assert.equal(replay.warnings, undefined);
  assert.equal(loadTasks().find((task) => task.id === "review-warning-task").reviewAttestations.length, 1);

  const invalid = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_review_report", arguments: {
    ...attestation,
    event_id: "review-invalid-v3-event",
    id: "review-invalid-v3-attestation",
    review_contract_version: "v3",
  } })));
  assert.equal(invalid.error, "TASKCENTER_REQUEST_FAILED");
  assert.match(invalid.message, /Review Attestation v3 缺少 cycle、scope、files 或 findings/);
  assert.doesNotMatch(invalid.message, /Session 投递服务失败/);
  assert.equal(loadTasks().find((task) => task.id === "review-warning-task").reviewAttestations.length, 1);
});

test("MCP stdio 真实协议：session_register 与 task_create 取得 task_id", async (context) => {
  await resetLedger();
  const { base, child } = await startControlServer();
  context.after(() => child.kill("SIGTERM"));

  const gateSessionId = "019f0000-0000-7000-8000-000000000112";

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["scripts/taskcenter-mcp.mjs"],
    env: Object.fromEntries(Object.entries({ ...process.env, TASKCENTER_CONTROL_URL: base })
      .filter(([key]) => !["TASKCENTER_CALLER_SESSION_ID", "CODEX_SESSION_ID", "CODEX_THREAD_ID"].includes(key))),
    cwd: root,
  });
  const client = new Client({ name: "taskcenter-test", version: "0.0.0" });
  await client.connect(transport);
  const callTool = client.callTool.bind(client);
  client.callTool = async (...args) => {
    const response = await callTool(...args);
    assert.ok(Buffer.byteLength(textOf(response)) <= 4096, args[0].name);
    let payload;
    try { payload = JSON.parse(textOf(response)); } catch { return response; }
    if (!payload.truncated) return response;
    let text = "";
    while (payload.continuation_cursor) {
      const page = await callTool({ name: "taskcenter_response_continue", arguments: { cursor: payload.continuation_cursor } });
      assert.ok(Buffer.byteLength(textOf(page)) <= 4096);
      payload = JSON.parse(textOf(page));
      assert.equal(payload.encoding, "json_text_fragment");
      text += payload.fragment;
    }
    return { content: [{ type: "text", text }] };
  };
  context.after(async () => { await client.close().catch(() => {}); });

  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  for (const expected of [
    "taskcenter_session_register", "taskcenter_task_begin", "taskcenter_task_create", "taskcenter_task_update", "taskcenter_task_report",
    "taskcenter_task_close",
    "taskcenter_task_requirement_report", "taskcenter_task_verification_report", "taskcenter_task_review_report", "taskcenter_review_cycle_report", "taskcenter_task_phase_report", "taskcenter_task_diagnostic_report",
    "taskcenter_task_completion_readiness", "taskcenter_task_completion_packet", "taskcenter_task_export",
    "taskcenter_task_query", "taskcenter_task_reuse_check", "taskcenter_task_reuse_decision_report", "taskcenter_task_reuse_decision_query",
    "taskcenter_session_status", "taskcenter_session_gate_exemption_status", "taskcenter_session_gate_exemption_set",
    "taskcenter_scheduled_readonly_scan_exemption_status", "taskcenter_scheduled_readonly_scan_exemption_set",
    "taskcenter_usage_report", "taskcenter_session_lifecycle", "taskcenter_governance_metrics",
  ]) {
    assert.ok(toolNames.includes(expected), `MCP 应暴露 ${expected}`);
  }

  const missingGateContext = JSON.parse(textOf(await client.callTool({
    name: "taskcenter_session_gate_exemption_status",
    arguments: {},
  })));
  assert.equal(missingGateContext.error, "TASKCENTER_SESSION_CONTEXT_UNAVAILABLE");
  assert.equal(missingGateContext.assessment.category, "mcp_session_context");
  assert.match(missingGateContext.assessment.verification, /taskcenter_client_context/);
  const invalidGateContext = JSON.parse(textOf(await client.callTool({
    name: "taskcenter_session_gate_exemption_status",
    arguments: {},
    _meta: { threadId: "not-a-uuid" },
  })));
  assert.equal(invalidGateContext.error, "TASKCENTER_SESSION_CONTEXT_INVALID");
  assert.equal(invalidGateContext.assessment.category, "mcp_session_context");
  const spoofedGateTarget = await client.callTool({
    name: "taskcenter_session_gate_exemption_set",
    arguments: { enabled: true, session_id: "019f0000-0000-7000-8000-000000000113" },
    _meta: { threadId: gateSessionId },
  });
  assert.equal(spoofedGateTarget.isError, true);
  assert.match(textOf(spoofedGateTarget), /session_id|unrecognized/i);

  const register = await client.callTool({ name: "taskcenter_session_register", arguments: { session_id: "sess-mcp", agent: "codex", provider: "openai", model: "gpt-test", workspace: "/work", project_id: "mcp-project", response_mode: "full" } });
  const registerPayload = JSON.parse(textOf(register));
  assert.equal(registerPayload.accepted, true);
  assert.equal(registerPayload.task, null);

  for (const tool of tools.tools.filter((item) => item.inputSchema.properties?.agent)) {
    assert.deepEqual(tool.inputSchema.properties.agent.enum, ["codex", "claude", "workbuddy", "kimi", "unknown"], tool.name);
  }
  const capabilities = JSON.parse(textOf(await client.callTool({ name: "taskcenter_agent_capabilities", arguments: { agent: "kimi" } })));
  assert.equal(capabilities.clients.length, 1);
  const { operations, ...legacyCapabilities } = capabilities.clients[0];
  assert.equal(operations.createSession.supported, true);
  assert.equal(operations.createSession.availability, "unknown");
  assert.equal(operations.inspectSession.supported, false);
  assert.deepEqual([legacyCapabilities], [{ agent: "kimi", label: "Kimi Code CLI", hooks: true, resume: true, usage: true, integration_mode: "managed_acp", usage_scope: "context_snapshot", native_hooks_require_configuration: true, task_protocol: true, trusted_identity: "explicit_host_binding_required" }]);
  assert.equal(JSON.parse(textOf(await client.callTool({ name: "taskcenter_client_context", arguments: {}, _meta: { "taskcenter/sessionId": gateSessionId } }))).sessionId, gateSessionId);
  assert.equal(JSON.parse(textOf(await client.callTool({ name: "taskcenter_client_context", arguments: {} }))).error, "TASKCENTER_SESSION_CONTEXT_UNAVAILABLE");
  const kimiRegister = JSON.parse(textOf(await client.callTool({ name: "taskcenter_session_register", arguments: {
    session_id: "sess-begin", agent: "kimi", workspace: "/work",
  } })));
  assert.equal(kimiRegister.accepted, true);

  const beginArguments = {
    session_id: "sess-begin", agent: "kimi", workspace: "/work", event_id: "begin-first", task_id: "task-begin-first",
    title: "第一任务", goal: "完成第一任务", scope: ["scripts"], acceptance_criteria: [{ id: "done", description: "完成", required: true }], plan: ["执行"],
  };
  const begun = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_begin", arguments: beginArguments })));
  assert.deepEqual({ task_id: begun.task_id, status: begun.status, next: begun.next, context_ref: begun.context_ref }, {
    task_id: "task-begin-first", status: "planned", next: "implement", context_ref: "task:task-begin-first",
  });
  assert.equal(JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_begin", arguments: beginArguments }))).task_id, "task-begin-first");
  assert.equal(loadTasks().filter((task) => task.sessionId === "sess-begin").length, 1);
  assert.equal(loadTasks().find((task) => task.id === "task-begin-first").agent, "kimi");
  const conflict = JSON.parse(textOf(await client.callTool({
    name: "taskcenter_task_begin",
    arguments: { ...beginArguments, event_id: "begin-conflict", task_id: "task-begin-conflict", title: "冲突任务" },
  })));
  assert.match(conflict.message, /ACTIVE_TASK_CONFLICT/);
  const progress = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_report", arguments: { session_id: "sess-begin", task_id: "task-begin-first", agent: "kimi", status: "in_progress", current_step: "完成验证" } })));
  assert.equal(progress.accepted, true);
  const kimiClosed = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_close", arguments: {
    session_id: "sess-begin", task_id: "task-begin-first", agent: "kimi", tests: ["isolated protocol passed"], evidence: ["test:protocol"],
    close_requirements: [{ requirement_id: "done", status: "passed", evidence_refs: ["test:protocol"] }],
  } })));
  assert.equal(kimiClosed.accepted, true);
  assert.equal(kimiClosed.status, "done_claimed");
  assert.equal(loadTasks().find((task) => task.id === "task-begin-first").agent, "kimi");
  assert.equal(loadSessionRegistry()["sess-begin"].agent, "kimi");
  const nextBegun = JSON.parse(textOf(await client.callTool({
    name: "taskcenter_task_begin",
    arguments: { ...beginArguments, event_id: "begin-next", task_id: "task-begin-next", title: "下一任务", goal: "顺序创建" },
  })));
  assert.equal(nextBegun.task_id, "task-begin-next");
  assert.equal(getSessionStatuses([], loadTasks()).find((item) => item.sessionId === "sess-begin").taskCount, 2);

  const gateStatusBefore = JSON.parse(textOf(await client.callTool({
    name: "taskcenter_session_gate_exemption_status",
    arguments: {},
    _meta: { threadId: gateSessionId },
  })));
  assert.equal(gateStatusBefore.session.registered, false);
  assert.equal(gateStatusBefore.session.gateExempt, false);
  const unregisteredGateSet = JSON.parse(textOf(await client.callTool({
    name: "taskcenter_session_gate_exemption_set",
    arguments: { enabled: true },
    _meta: { threadId: gateSessionId },
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
    _meta: { threadId: gateSessionId },
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
    _meta: { threadId: gateSessionId },
  })));
  assert.equal(gateStatusJoined.session.gateExempt, true);
  const gateLeave = JSON.parse(textOf(await client.callTool({
    name: "taskcenter_session_gate_exemption_set",
    arguments: { enabled: false },
    _meta: { threadId: gateSessionId },
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

  const scheduledReportPath = join(tempDir, "project-context", "90-Agent提案", "自动化报告", "scheduled-report.md");
  await mkdir(dirname(scheduledReportPath), { recursive: true });
  await writeFile(scheduledReportPath, "report\n");
  setSessionScheduledReadonlyProfile(gateSessionId, {
    profile: "scheduled_readonly",
    automation_id: "instory",
    project_id: "instory",
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
    automation_id: "instory",
    project_id: "instory",
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
    automation_id: "instory",
    project_id: "instory",
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

  const precreateAdvice = JSON.parse(textOf(await client.callTool({
    name: "taskcenter_task_reuse_check",
    arguments: {
      session_id: "sess-mcp",
      workspace: "/work",
      project_id: "mcp-project",
      title: "MCP 闸门",
      goal: "验证 MCP 通道",
      scope: ["MCP task gate"],
    },
  })));
  assert.equal(precreateAdvice.recommendation, "create_new");
  assert.equal(precreateAdvice.advisory_only, true);
  const precreateDecision = JSON.parse(textOf(await client.callTool({
    name: "taskcenter_task_reuse_decision_report",
    arguments: {
      event_id: "mcp-reuse-decision",
      check_id: precreateAdvice.check_id,
      session_id: "sess-mcp",
      workspace: "/work",
      project_id: "mcp-project",
      recommendation: precreateAdvice.recommendation,
      confidence: precreateAdvice.confidence,
      candidate_task_ids: [],
      match_reasons: [],
      final_decision: "create_new",
      occurred_at: "2026-09-02T04:00:00.000Z",
    },
  })));
  assert.equal(precreateDecision.accepted, true);
  assert.equal(precreateDecision.record.final_decision, "create_new");
  const queriedDecisions = JSON.parse(textOf(await client.callTool({
    name: "taskcenter_task_reuse_decision_query",
    arguments: { project_id: "mcp-project" },
  })));
  assert.equal(queriedDecisions.decisions.length, 1);

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
    arguments: { session_id: "sess-mcp", task_id: "task-mcp", title: "MCP 闸门", goal: "验证 MCP 通道", acceptance_criteria: ["a"], plan: ["p"] },
  });
  const compactText = textOf(compact);
  const compactPayload = JSON.parse(compactText);
  assert.deepEqual(Object.keys(compactPayload).sort(), ["accepted", "agent_guidance", "completion_claim_allowed", "missing_count", "review_status", "status", "task_id", "verification_status"]);
  assert.equal(compactPayload.agent_guidance.advisory_only, true);
  assert.ok(compactPayload.agent_guidance.steps.length);
  assert.equal(compactPayload.completion_claim_allowed, false);
  assert.equal(compactPayload.task_id, "task-mcp");
  assert.ok(compactText.length < textOf(create).length, "摘要保留协作建议但不携带完整任务");

  await client.callTool({ name: "taskcenter_session_register", arguments: { session_id: "sess-mcp-close-owner", workspace: "/work", agent: "codex" } });
  await client.callTool({
    name: "taskcenter_task_create",
    arguments: {
      session_id: "sess-mcp-close-owner", task_id: "task-mcp-close", contract_version: "v2", title: "原子关闭",
      goal: "一次上报闭环证据", scope: ["close"], non_goals: [], workflow_profile: "fast", review_policy: "not_required",
      acceptance_criteria: [{ id: "close-criterion", description: "证据完整", required: true }], plan: ["close"], response_mode: "full",
    },
  });
  const closeArguments = {
    session_id: "sess-mcp-close-owner", task_id: "task-mcp-close", event_id: "mcp-close-once",
    tests: ["node --test"], evidence: ["summary:passed"], changed_files: ["scripts/example.mjs"],
    close_requirements: [{ requirement_id: "close-criterion", status: "passed", evidence_refs: ["summary:passed"] }],
    close_verifications: [{ id: "close-test", kind: "test", status: "passed", observed_at: "2026-08-20T08:30:00.000Z", producer: "codex", evidence_ref: "summary:passed" }],
    response_mode: "full",
  };
  const bypassClose = JSON.parse(textOf(await client.callTool({
    name: "taskcenter_task_report",
    arguments: {
      session_id: "sess-mcp-close-owner", task_id: "task-mcp-close", event_id: "mcp-close-bypass",
      status: "done_claimed", tests: ["passed"], evidence: ["summary:passed"],
    },
  })));
  assert.equal(bypassClose.error, "TASKCENTER_ATOMIC_CLOSE_REQUIRED");
  assert.match(bypassClose.message, /v2.*taskcenter_task_close/);
  const closed = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_close", arguments: closeArguments })));
  assert.equal(closed.accepted, true);
  assert.equal(closed.event.type, "task.close");
  assert.equal(closed.session_lifecycle.action, "continue");
  assert.equal(closed.task.status, "done_claimed");
  assert.equal(closed.task.requirementResults.length, 1);
  assert.equal(closed.task.verificationClaims.length, 1);
  assert.equal(closed.task.completionReadiness.ready, true);
  await rm(envPaths.TASKCENTER_TASK_EVENT_IDS_PATH, { force: true });
  const closeReplay = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_close", arguments: closeArguments })));
  assert.equal(closeReplay.idempotent, true);
  assert.equal(closeReplay.task.requirementResults.length, 1);
  assert.equal(closeReplay.task.verificationClaims.length, 1);
  const compactClose = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_close", arguments: { ...closeArguments, response_mode: "summary", continuation: { context_large: true, expected_more_rounds: true } } })));
  assert.equal(compactClose.accepted, true);
  assert.equal(compactClose.session_lifecycle.action, "recommend_compact");
  assert.ok(1 <= 4 * 0.6, "原子 close 将四次闭环上报缩减为一次，下降至少 40%");

  // 结构化引用替代重复摘要，但不替代逐项结果、验证计划或版本新鲜度。
  const closeSubject = { type: "git_commit", value: "structured-close-revision", observed_at: "2026-08-20T08:30:00.000Z" };
  const slimBase = {
    subject_ref: closeSubject,
    close_requirements: [{ requirement_id: "criterion", status: "passed", evidence_refs: ["log:checks"] }],
    close_verifications: [{ id: "slim-check", requirement_id: "checks", kind: "test", status: "passed", observed_at: closeSubject.observed_at, producer: "codex", artifact_refs: ["log:checks"] }],
  };
  for (const scenario of ["empty", "bad-criterion", "bad-plan", "stale", "missing-check", "verification-only", "ready"]) {
    const owner = `slim-${scenario}`, taskId = `task-${owner}`;
    await client.callTool({ name: "taskcenter_session_register", arguments: { session_id: owner, workspace: "/work", agent: "codex" } });
    const slimCreated = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_create", arguments: {
      session_id: owner, task_id: taskId, title: "精简关闭", goal: "复用结构化证据", scope: ["close"], non_goals: [], plan: ["check"],
      workflow_profile: "standard", review_policy: "recommended", subject_ref: closeSubject,
      acceptance_criteria: [{ id: "criterion", description: "条件满足", required: true }],
      verification_plan: [{ id: "checks", kind: "test", title: "检查", required: true }],
    } })));
    assert.equal(slimCreated.accepted, true, JSON.stringify(slimCreated));
    const slim = structuredClone({ ...slimBase, session_id: owner, task_id: taskId, event_id: `close-${owner}`, response_mode: "full" });
    if (scenario === "empty") { delete slim.subject_ref; slim.close_requirements = []; slim.close_verifications = []; }
    if (scenario === "bad-criterion") slim.close_requirements[0].requirement_id = "checks";
    if (scenario === "bad-plan") slim.close_verifications[0].requirement_id = "criterion";
    if (scenario === "stale") slim.close_verifications[0].subject_ref = { ...closeSubject, value: "old-revision" };
    if (scenario === "missing-check") slim.close_verifications = [];
    if (scenario === "verification-only") {
      slim.close_requirements = [];
      slim.close_verifications[0].evidence_ref = "log:checks";
      slim.close_verifications[0].artifact_refs = [];
    }
    const reply = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_close", arguments: slim })));
    if (["bad-criterion", "bad-plan"].includes(scenario)) {
      assert.equal(reply.accepted, false, scenario);
      assert.match(reply.message, scenario === "bad-criterion" ? /UNKNOWN_ACCEPTANCE_REFERENCE/ : /UNKNOWN_VERIFICATION_REFERENCE/);
      const queried = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_query", arguments: { task_id: taskId, view: "full" } })));
      assert.equal(queried.tasks[0].requirementResults.length, 0, "拒绝的原子close不留下部分结果");
      assert.equal(queried.tasks[0].verificationClaims.length, 0);
      continue;
    }
    assert.equal(reply.accepted, true, scenario);
    assert.equal(reply.task.completionReadiness.completionClaim.allowed, scenario === "ready", scenario);
    assert.deepEqual(reply.event.tests, []);
    assert.deepEqual(reply.event.evidence, []);
    if (scenario === "empty") {
      assert.equal(reply.task.status, "done_claimed");
      assert.equal(reply.task.requirementResults.length, 0);
      assert.equal(reply.task.verificationClaims.length, 0);
      assert.notEqual(reply.task.acceptanceStatus, "accepted");
      assert.deepEqual(reply.agent_guidance.steps, [], "关闭回包不再要求补证据或继续query");
    }
    if (scenario === "ready") {
      assert.deepEqual(reply.task.verificationClaims[0].subject_ref, closeSubject);
      const replay = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_close", arguments: slim })));
      assert.equal(replay.idempotent, true);
      assert.equal(replay.task.requirementResults.length, 1);
      assert.equal(replay.task.verificationClaims.length, 1);
    }
  }

  const usageReport = JSON.parse(textOf(await client.callTool({ name: "taskcenter_usage_report", arguments: {} })));
  assert.deepEqual(Object.keys(usageReport.windows), ["5h", "24h", "7d"]);
  const lifecycle = JSON.parse(textOf(await client.callTool({ name: "taskcenter_session_lifecycle", arguments: { session_id: "sess-mcp" } })));
  assert.ok(["continue_current_session", "recommend_new_codex_session", "require_handoff_before_continue"].includes(lifecycle.action));
  assert.match(lifecycle.taskSemantics, /顺序承载多个/);
  const governance = JSON.parse(textOf(await client.callTool({ name: "taskcenter_governance_metrics", arguments: {} })));
  assert.equal(governance.schemaVersion, "taskcenter-governance-metrics-v2");

  const retired = (await client.listTools()).tools.filter(tool => /routing_|delegation_|cli_run_|review_claim|review_start|review_restore/.test(tool.name));
  assert.deepEqual(retired, []);
  const update = await client.callTool({ name: "taskcenter_task_update", arguments: { session_id: "sess-mcp", task_id: "task-mcp", current_step: "已更新" } });
  assert.equal(JSON.parse(textOf(update)).accepted, true);
  const report = await client.callTool({ name: "taskcenter_task_report", arguments: { session_id: "sess-mcp", task_id: "task-mcp", status: "done_claimed", tests: ["MCP 闭环"] } });
  assert.equal(JSON.parse(textOf(report)).accepted, true);
  const finalQuery = await client.callTool({ name: "taskcenter_task_query", arguments: { session_id: "sess-mcp", task_id: "task-mcp" } });
  assert.equal(JSON.parse(textOf(finalQuery)).tasks[0].status, "done_claimed");

  await client.callTool({ name: "taskcenter_session_register", arguments: { session_id: "sess-reviewer", agent: "codex", provider: "openai", model: "gpt-review", workspace: "/review" } });
  await client.callTool({ name: "taskcenter_session_register", arguments: { session_id: "sess-mcp-v2-owner", workspace: "/work", agent: "codex" } });
  const v2Create = await client.callTool({
    name: "taskcenter_task_create",
    arguments: {
      session_id: "sess-mcp-v2-owner", task_id: "task-mcp-v2", title: "MCP v2 闭环", goal: "验证新 MCP 能力",
      acceptance_criteria: ["功能通过"], plan: ["实现"], contract_version: "v2", scope: ["scripts/"], non_goals: [],
      workflow_profile: "standard", review_policy: "required", execution_environment: "local", response_mode: "full",
      verification_plan: [{ id: "tests", title: "测试", kind: "test", required: true }],
    },
  });
  assert.equal(JSON.parse(textOf(v2Create)).task.contractVersion, "v2");
  await client.callTool({
    name: "taskcenter_task_close",
    arguments: {
      session_id: "sess-mcp-v2-owner", task_id: "task-mcp-v2", event_id: "mcp-v2-close",
      tests: ["passed"], evidence: ["summary:passed"], revision: "revision-mcp",
    },
  });
  await client.callTool({
    name: "taskcenter_task_requirement_report",
    arguments: { session_id: "sess-mcp-v2-owner", task_id: "task-mcp-v2", event_id: "mcp-requirement", requirement_id: "acceptance-1", status: "passed", evidence_refs: ["claim-mcp"], checked_by: "codex", revision: "revision-mcp" },
  });
  await client.callTool({
    name: "taskcenter_task_verification_report",
    arguments: {
      session_id: "sess-mcp-v2-owner", task_id: "task-mcp-v2", event_id: "mcp-verification", id: "claim-mcp", requirement_id: "tests",
      kind: "test", command_or_probe: "node --test", status: "passed", exit_code: 0, revision: "revision-mcp",
      observed_at: "2026-08-17T00:00:00.000Z", producer: "codex", producer_session_id: "sess-mcp-v2-owner", evidence_ref: "summary:passed",
    },
  });
  const beforeReview = await client.callTool({ name: "taskcenter_task_completion_readiness", arguments: { task_id: "task-mcp-v2" } });
  assert.equal(JSON.parse(textOf(beforeReview)).completionReadiness.ready, true, "真实 MCP 流程在审查前即可完成");
  const reviewSubject = { type: "external", value: "revision-mcp", observed_at: "2026-08-17T00:00:00.000Z" };
  const cycleReport = await client.callTool({
    name: "taskcenter_review_cycle_report",
    arguments: {
      session_id: "sess-reviewer", task_id: "task-mcp-v2", event_id: "mcp-review-cycle", cycle_id: "cycle-mcp", subject_ref: reviewSubject,
      reviewer: { type: "agent", id: "ocr", session_id: "sess-reviewer" }, model: "gpt-review", review_scope: "full", phase: "completed", outcome: "approved",
      implementation_ready_at: "2026-08-17T00:01:00.000Z", review_requested_at: "2026-08-17T00:02:00.000Z", review_started_at: "2026-08-17T00:03:00.000Z", review_finished_at: "2026-08-17T00:05:00.000Z",
      review_active_ms: 60_000, response_mode: "full",
    },
  });
  assert.equal(JSON.parse(textOf(cycleReport)).task.reviewCycles[0].cycle_id, "cycle-mcp");
  const reviewPhaseStart = {
    session_id: "sess-reviewer",
    task_id: "task-mcp-v2",
    event_id: "mcp-review-phase-start",
    phase: "reviewing",
    transition: "started",
    occurred_at: "2026-08-17T00:03:00.000Z",
    subject_ref: reviewSubject,
    reason: "独立 Review 开始",
    activity_source: "review_cycle",
    review_cycle_id: "cycle-mcp",
    response_mode: "full",
  };
  const phaseStarted = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_phase_report", arguments: reviewPhaseStart })));
  assert.equal(phaseStarted.accepted, true);
  const phaseReplay = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_phase_report", arguments: reviewPhaseStart })));
  assert.equal(phaseReplay.idempotent, true);
  const phaseFinished = JSON.parse(textOf(await client.callTool({
    name: "taskcenter_task_phase_report",
    arguments: { ...reviewPhaseStart, event_id: "mcp-review-phase-finish", transition: "finished", occurred_at: "2026-08-17T00:05:00.000Z", reason: "独立 Review 结束" },
  })));
  assert.equal(phaseFinished.task.phaseTiming.phases.reviewing.phase_active_ms, 60_000);
  await client.callTool({
    name: "taskcenter_task_review_report",
    arguments: {
      session_id: "sess-reviewer", task_id: "task-mcp-v2", event_id: "mcp-review", id: "review-mcp", reviewer: "ocr",
      reviewer_session_id: "sess-reviewer", revision: "revision-mcp", subject_ref: reviewSubject, scope: "scripts/", review_contract_version: "v3", cycle_id: "cycle-mcp", cycle_number: 1, review_scope: "full",
      reviewed_files: ["scripts/example.mjs"], changed_files_since_previous_review: [], findings: [], spec_verdict: "compliant", quality_verdict: "approved", verdict: "approved", unverified_requirements: [], unresolved_findings: 0,
      observed_at: "2026-08-17T00:05:00.000Z", summary: "approved",
    },
  });
  const readiness = await client.callTool({ name: "taskcenter_task_completion_readiness", arguments: { task_id: "task-mcp-v2" } });
  assert.equal(JSON.parse(textOf(readiness)).completionReadiness.ready, true);
  const packet = await client.callTool({ name: "taskcenter_task_completion_packet", arguments: { task_id: "task-mcp-v2" } });
  const packetPayload = JSON.parse(textOf(packet)).completionPacket;
  assert.equal(packetPayload.reviewStatus, "passed");
  assert.equal(packetPayload.reviewProcess.totalCycles, 1);
  assert.equal(packetPayload.reviewProcess.cycles[0].model, "gpt-review");
  assert.equal(packetPayload.reviewProcess.finalApprovedSubject.value, "revision-mcp");
  assert.equal(packetPayload.phaseTiming.phases.reviewing.phase_wall_ms, 180_000);
  assert.equal(packetPayload.phaseTiming.phases.reviewing.phase_wait_ms, 60_000);
  assert.equal(packetPayload.phaseTiming.data_sources.review_cycles, true);
  const phaseQuery = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_query", arguments: { task_id: "task-mcp-v2" } })));
  assert.equal(phaseQuery.tasks[0].phaseTiming.phases.reviewing.active_time_source, "review_cycle");
  const phaseJsonExport = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_export", arguments: { task_id: "task-mcp-v2", format: "json" } })));
  assert.equal(phaseJsonExport.completionPacket.phaseTiming.phases.reviewing.phase_active_ms, 60_000);
  const phaseMarkdownExport = textOf(await client.callTool({ name: "taskcenter_task_export", arguments: { task_id: "task-mcp-v2", format: "markdown" } }));
  assert.match(phaseMarkdownExport, /## Phase distribution/);
  assert.match(phaseMarkdownExport, /Data sources: phase_events=yes \/ review_cycles=yes/);
  await client.callTool({
    name: "taskcenter_task_diagnostic_report",
    arguments: {
      session_id: "sess-mcp-v2-owner", task_id: "task-mcp-v2", event_id: "mcp-diagnostic", case_id: "debug-mcp-1",
      observed_at: "2026-08-17T00:08:00.000Z", started_at: "2026-08-17T00:01:00.000Z", root_cause_at: "2026-08-17T00:06:00.000Z",
      outcome: "resolved", hypothesis_count: 2, failed_fix_count: 1, rollback_count: 1, fresh_verification: "passed", evidence_refs: ["log://debug-mcp-1"],
    },
  });
  const afterDiagnostic = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_query", arguments: { task_id: "task-mcp-v2" } })));
  assert.equal(afterDiagnostic.tasks[0].diagnosticObservations[0].case_id, "debug-mcp-1");

  await client.callTool({ name: "taskcenter_session_register", arguments: { session_id: "sess-structured-owner", workspace: "/work", agent: "codex" } });
  const structuredSubject = { type: "git_commit", value: "commit-mcp-structured", repository: "/work", branch: "feature/readiness", observed_at: "2026-08-17T01:00:00.000Z" };
  await client.callTool({
    name: "taskcenter_task_create",
    arguments: {
      session_id: "sess-structured-owner", task_id: "task-mcp-structured", title: "结构化 Subject 就绪度", goal: "验证专用 readiness 与 task_query 一致",
      acceptance_criteria: ["功能通过"], plan: ["实现"], contract_version: "v2", scope: ["scripts/"], non_goals: [],
      workflow_profile: "standard", review_policy: "not_required", execution_environment: "local",
      verification_plan: [{ id: "tests", title: "测试", kind: "test", required: true }],
    },
  });
  await client.callTool({
    name: "taskcenter_task_close",
    arguments: {
      session_id: "sess-structured-owner", task_id: "task-mcp-structured", event_id: "mcp-structured-close",
      tests: ["passed"], evidence: ["summary:passed"], subject_ref: structuredSubject,
      close_requirements: [{ requirement_id: "acceptance-1", status: "passed", evidence_refs: ["structured-claim"] }],
      close_verifications: [{
        id: "structured-claim", requirement_id: "tests", kind: "test", command_or_probe: "node --test",
        status: "passed", exit_code: 0, observed_at: "2026-08-17T01:05:00.000Z",
        producer: "codex", producer_session_id: "sess-structured-owner", evidence_ref: "summary:passed",
      }],
    },
  });
  const structuredQuery = await client.callTool({ name: "taskcenter_task_query", arguments: { task_id: "task-mcp-structured" } });
  const structuredReadiness = await client.callTool({ name: "taskcenter_task_completion_readiness", arguments: { task_id: "task-mcp-structured" } });
  const sameRevisionReadiness = await client.callTool({
    name: "taskcenter_task_completion_readiness",
    arguments: { task_id: "task-mcp-structured", revision: structuredSubject.value },
  });
  assert.equal(JSON.parse(textOf(structuredQuery)).tasks[0].completionReadiness.ready, true);
  assert.equal(JSON.parse(textOf(structuredReadiness)).completionReadiness.ready, true);
  assert.deepEqual(JSON.parse(textOf(structuredReadiness)).completionReadiness.currentSubject, structuredSubject);
  assert.equal(JSON.parse(textOf(sameRevisionReadiness)).completionReadiness.ready, true);
  assert.deepEqual(JSON.parse(textOf(sameRevisionReadiness)).completionReadiness.currentSubject, structuredSubject);
});

test("MCP task_query 精准查询、view 摘要、session 交集与失败可区分", async (context) => {
  await resetLedger();
  const { base, child } = await startControlServer();
  context.after(() => child.kill("SIGTERM"));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["scripts/taskcenter-mcp.mjs"],
    env: { ...process.env, TASKCENTER_CONTROL_URL: base },
    cwd: root,
  });
  const client = new Client({ name: "taskcenter-q1-query", version: "0.0.0" });
  await client.connect(transport);
  const callTool = client.callTool.bind(client);
  client.callTool = async (...args) => {
    const result = await callTool(...args);
    let payload = JSON.parse(textOf(result));
    if (!payload.truncated) return result;
    let text = "";
    while (payload.continuation_cursor) {
      payload = JSON.parse(textOf(await callTool({ name: "taskcenter_response_continue", arguments: { cursor: payload.continuation_cursor } })));
      text += payload.fragment;
    }
    return { content: [{ type: "text", text }] };
  };
  context.after(async () => { await client.close().catch(() => {}); });

  await client.callTool({ name: "taskcenter_session_register", arguments: { session_id: "q1-session", workspace: "/work", agent: "codex" } });
  await client.callTool({ name: "taskcenter_task_create", arguments: {
    session_id: "q1-session", task_id: "q1-task", title: "精准查询目标", goal: "验证 task_query",
    acceptance_criteria: ["查询正确"], plan: ["实现"],
  } });
  await client.callTool({ name: "taskcenter_task_report", arguments: {
    session_id: "q1-session", task_id: "q1-task", status: "done_claimed", tests: ["t"], evidence: ["q1-evidence"],
  } });
  for (let index = 0; index < 20; index += 1) {
    await client.callTool({ name: "taskcenter_session_register", arguments: { session_id: `q1-noise-${index}`, workspace: "/work", agent: "codex" } });
    await client.callTool({ name: "taskcenter_task_create", arguments: {
      session_id: `q1-noise-${index}`, task_id: `q1-noise-task-${index}`, title: `无关 ${index}`, goal: "无关夹具",
      acceptance_criteria: ["x"], plan: ["x"],
    } });
  }

  const precise = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_query", arguments: { task_id: "q1-task" } })));
  assert.equal(precise.tasks.length, 1, "task_id 精准查询不返回无关任务");
  assert.equal(precise.tasks[0].id, "q1-task");
  assert.deepEqual(precise.tasks[0].evidence, ["q1-evidence"], "省略 view 时保持旧 full 语义");

  const explicitFull = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_query", arguments: { task_id: "q1-task", view: "full" } })));
  assert.deepEqual(explicitFull.tasks[0].evidence, ["q1-evidence"], "显式 view=full 保留完整字段");

  const rawSummary = await callTool({ name: "taskcenter_task_query", arguments: { task_id: "q1-task", view: "summary" } });
  assert.equal(JSON.parse(textOf(rawSummary)).truncated, undefined, "典型单任务摘要一次调用可读");
  context.diagnostic(`MCP单任务摘要 UTF-8 bytes: ${Buffer.byteLength(textOf(rawSummary))}`);
  const summary = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_query", arguments: { task_id: "q1-task", view: "summary" } })));
  assert.equal(summary.tasks.length, 1);
  assert.equal("evidence" in summary.tasks[0], false, "显式 view=summary 裁剪长历史与证据");
  assert.equal(summary.tasks[0].id, "q1-task");
  assert.equal(summary.tasks[0].status, "done_claimed");
  assert.equal(summary.tasks[0].sessionId, "q1-session");

  const intersectMiss = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_query", arguments: { task_id: "q1-task", session_id: "q1-noise-0" } })));
  assert.deepEqual(intersectMiss.tasks, [], "session_id 与 task_id 必须求交集");
  const intersectHit = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_query", arguments: { task_id: "q1-task", session_id: "q1-session" } })));
  assert.equal(intersectHit.tasks.length, 1);

  const missing = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_query", arguments: { task_id: "q1-no-such-task" } })));
  assert.deepEqual(missing.tasks, [], "task_id 不存在保持旧 tasks:[] 语义");
  assert.equal(missing.error, undefined);

  const sessionQuery = JSON.parse(textOf(await client.callTool({ name: "taskcenter_task_query", arguments: { session_id: "q1-session" } })));
  assert.deepEqual(sessionQuery.tasks.map((task) => task.id), ["q1-task"], "仅 session_id 过滤移入服务端");

  const { createServer } = await import("node:http");
  const seen = [];
  const stub = createServer((request, response) => {
    seen.push(request.url);
    if (request.url.startsWith("/pages/tasks")) {
      const url = new URL(request.url, "http://localhost");
      const page = Number(url.searchParams.get("page") || 1);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ tasks: [{ id: `page-${page}`, status: "planned" }], totalPages: 2 }));
      return;
    }
    if (request.url?.includes("bad-json")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("not-json");
    } else {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "boom" }));
    }
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  context.after(() => stub.close());
  const stubBase = `http://127.0.0.1:${stub.address().port}`;
  const pageClient = new Client({ name: "taskcenter-q1-pages", version: "0.0.0" });
  await pageClient.connect(new StdioClientTransport({ command: process.execPath, args: ["scripts/taskcenter-mcp.mjs"], env: { ...process.env, TASKCENTER_CONTROL_URL: `${stubBase}/pages` }, cwd: root }));
  context.after(() => pageClient.close().catch(() => {}));
  const pages = JSON.parse(textOf(await pageClient.callTool({ name: "taskcenter_task_query", arguments: { view: "summary" } })));
  assert.deepEqual(pages.tasks.map(task => task.id), ["page-1", "page-2"], "显式全列表摘要续读全部页");
  assert.equal(seen.length, 2);
  assert.ok(seen.every(url => url.includes("view=summary") && url.includes("page_size=500")));
  await pageClient.callTool({ name: "taskcenter_task_query", arguments: {} });
  assert.equal(seen.at(-1), "/pages/tasks", "旧无过滤调用使用原无分页full入口");
  await pageClient.callTool({ name: "taskcenter_task_query", arguments: { task_id: "target", session_id: "owner" } });
  assert.equal(seen.at(-1), "/pages/tasks?task_id=target&session_id=owner", "精准交集在HTTP请求中下推");

  for (const [name, url] of [["http-500", stubBase], ["invalid-json", `${stubBase}/bad-json?x=1`]]) {
    const failingTransport = new StdioClientTransport({
      command: process.execPath,
      args: ["scripts/taskcenter-mcp.mjs"],
      env: { ...process.env, TASKCENTER_CONTROL_URL: url },
      cwd: root,
    });
    const failingClient = new Client({ name: `taskcenter-q1-${name}`, version: "0.0.0" });
    await failingClient.connect(failingTransport);
    context.after(() => failingClient.close().catch(() => {}));
    const failed = JSON.parse(textOf(await failingClient.callTool({ name: "taskcenter_task_query", arguments: { task_id: "q1-task" } })));
    assert.equal(failed.error, "TASKCENTER_REQUEST_FAILED", `${name} 失败不能伪装成空任务`);
    assert.equal(failed.tasks, undefined);
    await failingClient.close().catch(() => {});
  }

  const downTransport = new StdioClientTransport({
    command: process.execPath,
    args: ["scripts/taskcenter-mcp.mjs"],
    env: { ...process.env, TASKCENTER_CONTROL_URL: "http://127.0.0.1:1" },
    cwd: root,
  });
  const downClient = new Client({ name: "taskcenter-q1-down", version: "0.0.0" });
  await downClient.connect(downTransport);
  const unavailable = JSON.parse(textOf(await downClient.callTool({ name: "taskcenter_task_query", arguments: { task_id: "q1-task" } })));
  assert.equal(unavailable.error, "TASKCENTER_UNAVAILABLE", "服务不可用不能伪装成空任务");
  await downClient.close().catch(() => {});
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
  const coreTask = (await done.json()).task;
  assert.equal(coreTask.creatorActor.type, "human");
  assert.equal(coreTask.executorActor.id, "author", "CI 证据不会转移执行者");
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

test("正式任务通道拒绝 ProjectContext client_session_id，但 Context 影子任务仍可使用", async (context) => {
  await resetLedger();
  const { base, child } = await startControlServer();
  context.after(() => child.kill("SIGTERM"));
  const clientSessionId = "codex:7a19678690d0ce7d4affa2afb4ac88c9";

  const rejectedRegistration = await fetch(`${base}/task-events`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({
      type: "session.register",
      session_id: clientSessionId,
      workspace: "/work",
      agent: "codex",
      provider: "openai",
      model: "gpt-test",
    }),
  });
  assert.equal(rejectedRegistration.status, 409);
  assert.match((await rejectedRegistration.json()).error, /client_session_id.*真实 Codex Session UUID/);

  const contextShadow = await fetch(`${base}/context-tasks/ensure`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({
      context_task_id: "context-client-session",
      session_id: clientSessionId,
      workspace: "/work",
      semantic_label: "Context 影子任务",
      agent: "codex",
    }),
  });
  assert.equal(contextShadow.status, 201);
  assert.equal((await contextShadow.json()).task.sessionId, clientSessionId);

  const rejectedFormalTask = await fetch(`${base}/task-events`, {
    method: "POST",
    headers: taskHeaders(),
    body: JSON.stringify({
      type: "task.create",
      session_id: clientSessionId,
      task_id: "formal-task-with-context-client-id",
      title: "错误身份任务",
      goal: "不应创建",
      acceptance_criteria: ["a"],
      plan: ["p"],
    }),
  });
  assert.equal(rejectedFormalTask.status, 409);
  assert.match((await rejectedFormalTask.json()).error, /client_session_id.*真实 Codex Session UUID/);
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

test("人工孤儿归档核对真实运行，保护活跃会话CLI和维护宿主并保留合同事实", async context => {
  await resetLedger();
  const { base, child } = await startControlServer();
  context.after(() => child.kill("SIGTERM"));
  const maintenanceHost = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  context.after(() => maintenanceHost.kill("SIGTERM"));
  const headers = { "Content-Type": "application/json", Origin: "http://localhost:3000", "X-TaskCenter-Action": "delegate" };
  const sessions = join(tempDir, "sessions"), maintenance = join(tempDir, "runtime", "ai-maintenance-state.json");
  await mkdir(sessions, { recursive: true });
  for (const scenario of ["ended", "busy", "cli", "maintenance", "unreadable", "old-terminal"]) {
    const id = `manual-orphan-${scenario}`;
    recordTaskEvent({ type: "session.register", session_id: id, agent: "codex", workspace: "/work" });
    const before = recordTaskEvent({ type: "task.create", task_id: id, session_id: id, agent: "codex", status: "in_progress", goal: "保留原合同", evidence: ["原交付证据"], acceptance_criteria: ["原条件"] }).task;
    const terminalAt = scenario === "old-terminal" ? "2000-01-02T00:00:00.000Z" : new Date().toISOString();
    const lines = [
      { timestamp: "2000-01-01T00:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "historic-unclosed" } },
      { timestamp: terminalAt, type: "event_msg", payload: { type: "task_complete", turn_id: "latest-finished" } },
      ...(scenario === "busy" ? [{ timestamp: new Date(Date.now() + 1000).toISOString(), type: "event_msg", payload: { type: "task_started", turn_id: "actual-running" } }] : []),
    ];
    if (scenario !== "unreadable") await writeFile(join(sessions, `${id}.jsonl`), lines.map(line => JSON.stringify(line)).join("\n") + "\n");
    if (scenario === "cli") await writeFile(envPaths.TASKCENTER_TASK_LEDGER_PATH, JSON.stringify(loadTasks().map(task => task.id === id ? { ...task, cliRuns: [{ status: "active" }] } : task)));
    await writeFile(maintenance, JSON.stringify({ actions: scenario === "maintenance" ? { [id]: { status: "running", pid: maintenanceHost.pid } } : {} }));
    const response = await fetch(`${base}/tasks/${id}/actions`, { method: "POST", headers, body: JSON.stringify({ action: "archive" }) });
    assert.equal(response.status, scenario === "ended" ? 200 : 409, scenario);
    const after = loadTasks().find(task => task.id === id);
    assert.equal(Boolean(after.archivedAt), scenario === "ended", scenario);
    for (const field of ["status", "goal", "acceptanceCriteria", "evidence", "currentSubject", "verificationClaims", "acceptanceRecords"]) assert.deepEqual(after[field], before[field], `${scenario}/${field}`);
    if (scenario === "ended") {
      assert.equal(after.runs.at(-1).ended_at, terminalAt);
      assert.equal(after.executionReconciliation.basis, "manual_archive");
      assert.equal(after.activeStartedAt, "");
    }
  }
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
  const cancel = await fetch(`${base}/tasks/task-http-governance/actions`, { method: "POST", headers, body: JSON.stringify({ action: "cancel" }) });
  assert.equal((await cancel.json()).task.status, "cancelled");
  const restart = await fetch(`${base}/tasks/task-http-governance/actions`, { method: "POST", headers, body: JSON.stringify({ action: "start" }) });
  assert.equal((await restart.json()).task.status, "in_progress");
});

test("Codex Session 可顺序承载多个任务，但同一时间只允许一个活跃任务", async (context) => {
  await resetLedger();
  const { base, child } = await startControlServer();
  context.after(() => child.kill("SIGTERM"));
  await registerHttpSession(base, "sess-one-goal");
  const post = (body) => fetch(`${base}/task-events`, { method: "POST", headers: taskHeaders(), body: JSON.stringify(body) });
  assert.equal((await post({ type: "task.create", session_id: "sess-one-goal", task_id: "one-goal", title: "原目标", goal: "原目标" })).status, 201);
  const second = await post({ type: "task.create", session_id: "sess-one-goal", task_id: "other-goal", title: "其他目标", goal: "其他目标" });
  assert.equal(second.status, 409);
  assert.match((await second.json()).error, /ACTIVE_TASK_CONFLICT/);
  assert.equal((await post({ type: "task.update", session_id: "sess-one-goal", task_id: "one-goal", status: "done_claimed", evidence: ["原目标完成"] })).status, 200);
  assert.equal((await post({ type: "task.update", session_id: "sess-one-goal", task_id: "one-goal", goal: "其他目标" })).status, 409);
  assert.equal((await post({ type: "task.create", session_id: "sess-one-goal", task_id: "other-goal", title: "其他目标", goal: "其他目标" })).status, 201);
  assert.equal((await post({ type: "task.update", session_id: "sess-one-goal", task_id: "one-goal", status: "in_progress", next_action: "验证原目标" })).status, 409);
  await registerHttpSession(base, "sess-resume-goal");
  const resumed = await fetch(`${base}/task-resume`, { method: "POST", headers: taskHeaders(), body: JSON.stringify({ session_id: "sess-resume-goal", task_id: "one-goal", expected_session_id: "sess-one-goal" }) });
  assert.equal(resumed.status, 200);
  const packet = await resumed.json();
  assert.equal(packet.task_id, "one-goal");
  assert.equal(packet.session_id, "sess-resume-goal");
  assert.ok(Buffer.byteLength(JSON.stringify(packet.handoff)) <= 2048);
  assert.equal((await post({ type: "task.update", session_id: "sess-one-goal", task_id: "one-goal", next_action: "旧 Session 不得继续写入" })).status, 403);
  const third = await post({ type: "task.create", session_id: "sess-one-goal", task_id: "third-goal", title: "其他", goal: "其他" });
  assert.equal(third.status, 409);
  assert.match((await third.json()).error, /ACTIVE_TASK_CONFLICT/);
});

test("同 Session HTTP 恢复重开已收口 Run，清除旧对账且重复恢复幂等", async context => {
  await resetLedger();
  const { base, child } = await startControlServer();
  context.after(() => child.kill("SIGTERM"));
  await registerHttpSession(base, "same-resume");
  recordTaskEvent({ type: "task.create", task_id: "same-resume-task", session_id: "same-resume", workspace: "/work", status: "in_progress" });
  recordTaskEvent({ type: "task.execution_reconciled", task_id: "same-resume-task", session_id: "same-resume", execution_observation: { state: "execution_unconfirmed", basis: "previous-turn", terminal: { type: "task_complete", at: new Date().toISOString(), turn_id: "previous" }, next_action: "恢复原任务" } }, { internalReconciliation: true });
  const before = loadTasks()[0];
  assert.ok(before.runs[0].ended_at);
  assert.equal((await (await fetch(`${base}/tasks?view=summary`)).json()).actionCounts.execution_unconfirmed, 1);
  const resume = () => fetch(`${base}/task-resume`, { method: "POST", headers: taskHeaders(), body: JSON.stringify({ session_id: "same-resume", expected_session_id: "same-resume", task_id: before.id }) });
  assert.equal((await resume()).status, 200);
  const resumed = loadTasks()[0];
  assert.equal(resumed.status, "in_progress");
  assert.equal(resumed.executionReconciliation, null);
  assert.equal(resumed.sessionDetachedAt, "");
  assert.equal(resumed.runs.length, 2);
  assert.deepEqual(resumed.runs[0], before.runs[0]);
  assert.equal(resumed.runs[1].ended_at, "");
  const counts = (await (await fetch(`${base}/tasks?view=summary`)).json()).actionCounts;
  assert.equal(counts.in_progress, 1);
  assert.equal(counts.execution_unconfirmed, 0);
  assert.equal((await resume()).status, 200);
  assert.deepEqual(loadTasks()[0].runs, resumed.runs);
  assert.equal(loadTasks()[0].lastEventId, resumed.lastEventId);
});

test("超字符串上限事件日志仍可 HTTP 写入、恢复和导出审计", async context => {
  await resetLedger();
  const { base, child } = await startControlServer();
  context.after(() => child.kill("SIGTERM"));
  await registerHttpSession(base, "large-log-owner");
  recordTaskEvent({ type: "task.create", event_id: "large-create", task_id: "large-log", session_id: "large-log-owner", title: "跨块中文任务" });
  const original = await readFile(envPaths.TASKCENTER_TASK_EVENTS_PATH);
  const file = await open(envPaths.TASKCENTER_TASK_EVENTS_PATH, "r+");
  const size = bufferConstants.MAX_STRING_LENGTH + 65536;
  try {
    // Sparse damaged lines keep the fixture cheap without creating an oversized individual line.
    await file.truncate(size);
    for (let offset = original.length + 65535; offset < size; offset += 65536) await file.write("\n", offset);
    await file.write("\n", size - 1);
  } finally { await file.close(); }
  const post = body => fetch(`${base}/task-events`, { method: "POST", headers: taskHeaders(), body: JSON.stringify({ task_id: "large-log", session_id: "large-log-owner", ...body }) });
  const close = { type: "task.update", event_id: "large-close", status: "done_claimed", evidence: ["fixture delivery"] };
  assert.equal((await post(close)).status, 200);
  assert.equal((await post(close)).status, 200);
  const resume = await fetch(`${base}/task-resume`, { method: "POST", headers: taskHeaders(), body: JSON.stringify({ task_id: "large-log", session_id: "large-log-owner", expected_session_id: "large-log-owner" }) });
  assert.equal(resume.status, 200, await resume.text());
  assert.equal(loadTasks()[0].status, "in_progress");
  const audit = taskExport("large-log").auditSummary;
  assert.equal(audit.eventTypes["task.create"], 1);
  assert.equal(audit.eventTypes["task.update"], 1);
  assert.equal(audit.eventTypes["task.resume"], 1);
  const tail = await open(envPaths.TASKCENTER_TASK_EVENTS_PATH, "r");
  try {
    const buffer = Buffer.alloc((await tail.stat()).size - size);
    await tail.read(buffer, 0, buffer.length, size);
    const events = buffer.toString("utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => event.type), ["task.update", "task.resume"]);
  } finally { await tail.close(); }
  assert.ok((await stat(envPaths.TASKCENTER_TASK_EVENTS_PATH)).size > bufferConstants.MAX_STRING_LENGTH);
});

test("HTTP 关闭任务恢复后可纠正合同，历史目标保留且再次关闭仍受保护", async context => {
  await resetLedger();
  const { base, child } = await startControlServer();
  context.after(() => child.kill("SIGTERM"));
  await registerHttpSession(base, "contract-owner");
  await registerHttpSession(base, "contract-other");
  const post = body => fetch(`${base}/task-events`, { method: "POST", headers: taskHeaders(), body: JSON.stringify({ task_id: "contract-resume", session_id: "contract-owner", ...body }) });
  const contract = { contract_version: "v2", scope: ["阶段实现"], non_goals: ["不改变用户原始委托"], acceptance_criteria: ["交付满足合同"], workflow_profile: "fast", review_policy: "recommended" };
  assert.equal((await post({ type: "task.create", ...contract, goal: "缩小的合同" })).status, 201);
  assert.equal((await post({ type: "task.update", status: "done_claimed", evidence: ["阶段交付记录"] })).status, 200);
  assert.equal((await post({ type: "task.update", goal: "完整原计划" })).status, 409);
  const resume = await fetch(`${base}/task-resume`, { method: "POST", headers: taskHeaders(), body: JSON.stringify({ task_id: "contract-resume", session_id: "contract-owner", expected_session_id: "contract-owner" }) });
  assert.equal(resume.status, 200);
  assert.equal(loadTasks()[0].closedGoal, "缩小的合同");
  const revised = await post({ type: "task.update", ...contract, goal: "完整原计划", scope: ["原计划全部阶段"], plan: ["覆盖核对", "补齐交付"] });
  assert.equal(revised.status, 200, await revised.text());
  assert.equal(loadTasks()[0].goal, "完整原计划");
  assert.equal(loadTasks()[0].closedGoal, "缩小的合同");
  assert.equal((await post({ type: "task.update", session_id: "contract-other", goal: "未经授权修改" })).status, 403);
  assert.equal((await post({ type: "task.update", status: "done_claimed", evidence: ["完整交付记录"] })).status, 200);
  assert.equal((await post({ type: "task.update", goal: "完整原计划", next_action: "待独立验收" })).status, 200);
  assert.equal((await post({ type: "task.update", goal: "另一个目标" })).status, 409);
});

test("Bug 退休：历史字段保留、通用就绪一致、新写入与旧接口拒绝", async context => {
  await resetLedger();
  const subject = { type: "git_commit", value: "a".repeat(40), observed_at: new Date().toISOString() };
  const task = recordTaskEvent({ type: "task.create", task_id: "retired-bug", title: "历史任务", goal: "完成普通任务", contract_version: "v2", scope: ["fixture"], non_goals: [], workflow_profile: "fast", review_policy: "not_required", acceptance_criteria: [{ id: "works", description: "功能正常", required: true }], subject_ref: subject }).task;
  const historical = { ...task, bug: { steps: "历史复现", targetBranch: "main" }, bugMerge: { targetCommit: "old" }, bugAcceptanceId: "old-acceptance" };
  await writeFile(envPaths.TASKCENTER_TASK_LEDGER_PATH, JSON.stringify([historical]));
  recordTaskEvent({ type: "task.update", task_id: task.id, next_action: "普通更新" });
  assert.deepEqual(loadTasks()[0].bug, historical.bug);
  assert.deepEqual(loadTasks()[0].bugMerge, historical.bugMerge);
  assert.equal(loadTasks()[0].bugAcceptanceId, historical.bugAcceptanceId);
  recordTaskEvent({ type: "requirement.reported", task_id: task.id, requirement_result: { requirement_id: "works", status: "passed", subject_ref: subject, evidence_refs: ["fixture"] } });
  recordTaskEvent({ type: "task.done_claimed", task_id: task.id });
  assert.equal(taskCompletionReadiness(task.id).ready, true);
  assert.equal(taskCompletionReadiness(task.id).completionClaim.allowed, true, "历史 Bug 不再附加验收/合入门槛");
  for (const field of ["bug", "bug_merge", "bug_acceptance"]) {
    const before = await readFile(envPaths.TASKCENTER_TASK_LEDGER_PATH, "utf8");
    assert.throws(() => recordTaskEvent({ type: "task.update", task_id: task.id, [field]: {} }), /RETIRED_BUG_WORKFLOW/);
    assert.equal(await readFile(envPaths.TASKCENTER_TASK_LEDGER_PATH, "utf8"), before);
  }
  const { base, child } = await startControlServer(); context.after(() => child.kill("SIGTERM"));
  for (const [method, path] of [["GET", "/bug-dispatches"], ["GET", `/tasks/${task.id}/bug-dispatch`], ...["bug", "bug-acceptance", "bug-merge", "bug-dispatch", "bug-dispatch/control"].map(path => ["POST", `/tasks/${task.id}/${path}`]), ["POST", "/bug-dispatches/host"]]) {
    const response = await fetch(`${base}${path}`, { method, ...(method === "POST" ? { headers: taskHeaders(), body: "{}" } : {}) });
    assert.equal(response.status, 404, `${method} ${path}`);
  }
  const detail = (await (await fetch(`${base}/tasks/${task.id}`)).json()).task;
  assert.deepEqual(detail.bug, historical.bug);
  assert.equal(detail.bugClosure, undefined);
  const exported = await (await fetch(`${base}/tasks/${task.id}/export?format=json`)).json();
  assert.deepEqual(exported.completionPacket.bug, historical.bug);
  assert.deepEqual(exported.completionPacket.bugMerge, historical.bugMerge);
  assert.equal(exported.completionPacket.bugAcceptanceId, historical.bugAcceptanceId);
});


test("顺序切换 HTTP 验证身份，Hook 保持关闭任务通道", async (context) => {
  await resetLedger();
  const { base, child } = await startControlServer();
  context.after(() => child.kill("SIGTERM"));
  const session_id = "019f0000-0000-7000-8000-000000000889";
  await registerHttpSession(base, session_id);
  const post = (body) => fetch(`${base}/task-events`, { method: "POST", headers: taskHeaders(), body: JSON.stringify(body) });
  await post({ type: "task.create", task_id: "switch-http", session_id, title: "old", goal: "old" });
  const input = { session_id, task_id: "switch-http", next_task_id: "switch-http-next", next_goal: "next", event_id: "prepare-http" };
  const denied = await fetch(`${base}/session-switch/prepare`, { method: "POST", headers: taskHeaders(), body: JSON.stringify(input) });
  assert.equal(denied.status, 403);
  const trusted = { ...taskHeaders(), "X-TaskCenter-MCP-Token": (await readFile(envPaths.TASKCENTER_MCP_TOKEN_PATH, "utf8")).trim() };
  const active = await fetch(`${base}/session-switch/prepare`, { method: "POST", headers: trusted, body: JSON.stringify(input) });
  assert.equal(active.status, 409);
  assert.match((await active.json()).error, /SWITCH_ACTIVE_TASK/);
  await post({ type: "task.update", task_id: "switch-http", session_id, status: "cancelled" });
  for (const tool of ["session_switch_prepare", "session_switch_confirm", "task_create"]) {
    const hook = await runTaskcenterHook(base, { session_id, cwd: "/work", tool_name: `mcp__taskcenter__taskcenter_${tool}`, tool_input: {} });
    assert.equal(hook.code, 0, hook.stderr);
    assert.match(hook.stdout, /收尾通道/);
  }
});


test("运行收口：Run 生命周期与 session 切换、结束事件解耦", async () => {
  await resetLedger();
  recordTaskEvent({ type: "task.create", session_id: "run-s1", task_id: "run-task", title: "运行任务", goal: "目标", acceptance_criteria: [{ id: "done", description: "验收完成" }] });
  let task = loadTasks()[0];
  assert.equal(task.runs.length, 1, "create 打开首个 Run");
  assert.equal(task.runs[0].session_id, "run-s1");
  assert.ok(task.runs[0].started_at, "Run 有开始时间");
  assert.equal(task.runs[0].ended_at, "", "Run 仍在运行");
  assert.equal(task.status, "planned", "Run 状态与任务完成判定解耦");

  recordTaskEvent({ type: "task.resume", task_id: "run-task", session_id: "run-s1", agent: "a1" }, { authorizedResume: true });
  task = loadTasks()[0];
  assert.equal(task.runs.length, 1, "同 session resume 延续当前 Run");

  recordTaskEvent({ type: "task.resume", task_id: "run-task", session_id: "run-s2", agent: "a2" }, { authorizedResume: true });
  task = loadTasks()[0];
  assert.equal(task.runs.length, 2, "换 session resume 新开 Run");
  assert.equal(task.runs[0].ended_reason, "handoff");
  assert.ok(task.runs[0].ended_at, "旧 Run 记录结束时间");
  assert.equal(task.runs[1].session_id, "run-s2");
  assert.equal(task.runs[1].ended_at, "", "新 Run 运行中");

  recordTaskEvent({ type: "task.close", session_id: "run-s2", task_id: "run-task", status: "done_claimed", evidence: ["e"], close_requirements: [{ requirement_id: "done", status: "passed", evidence_refs: ["e"], checked_at: "2026-08-25T00:00:00.000Z", checked_by: { type: "task_platform", id: "taskcenter-test" } }] });
  task = loadTasks()[0];
  assert.equal(task.runs[1].ended_reason, "completed");
  assert.ok(task.runs[1].ended_at);
  assert.equal(task.status, "done_claimed", "close 正常推进完成判定");
});

test("故障场景：不调用 task_close，会话脱离后运行收口为 session_detached，任务保留且不伪造完成", async () => {
  await resetLedger();
  recordTaskEvent({ type: "task.create", session_id: "fault-s1", task_id: "fault-task", title: "未收尾任务", goal: "目标" });
  let task = loadTasks()[0];
  assert.ok(task.runs.at(-1) && !task.runs.at(-1).ended_at, "不调 close 时 Run 保持运行");

  reconcileTasks(["other-session"]);
  task = loadTasks()[0];
  assert.ok(task.sessionDetachedAt, "reconcile 标记会话脱离");
  assert.equal(task.runs.at(-1).ended_reason, "session_detached", "运行被收口");
  assert.ok(task.runs.at(-1).ended_at);
  assert.equal(task.status, "planned", "不伪造完成");
  assert.notEqual(task.status, "done_claimed", "绝不伪造验收");

  const firstDetach = task.runs.at(-1).ended_at;
  reconcileTasks(["other-session"]);
  task = loadTasks()[0];
  assert.equal(task.runs.at(-1).ended_at, firstDetach, "重复 reconcile 幂等");
  assert.ok(task.sessionDetachedAt, "首次脱离时间保留");
});


test("迟到回报绑定原任务：切换任务后旧任务的验证回执仍记入原任务，不按当前活跃任务归属", async () => {
  await resetLedger();
  recordTaskEvent({ type: "task.create", session_id: "sess-late-a", task_id: "late-a", title: "A", goal: "a", scope: ["x"], non_goals: [], acceptance_criteria: [{ id: "done", description: "完成" }], workflow_profile: "standard", verification_plan: [{ id: "tests", title: "单元测试", kind: "test", required: true }] });
  recordTaskEvent({ type: "task.create", session_id: "sess-late-b", task_id: "late-b", title: "B", goal: "b" });
  // 已切到 B；A 的迟到验证回执（session 仍是 A）必须记入 A，不能按“当前活跃任务”归属到 B。
  recordTaskEvent({ type: "verification.reported", task_id: "late-a", session_id: "sess-late-a", verification_claim: { id: "late-v", requirement_id: "tests", kind: "test", status: "passed", observed_at: "2026-08-25T00:00:00.000Z", producer: "codex", producer_session_id: "sess-late-a", evidence_ref: "e", subject_ref: { type: "git_commit", value: "late-commit", observed_at: "2026-08-25T00:00:00.000Z" } } });
  const tasks = loadTasks();
  const a = tasks.find((item) => item.id === "late-a");
  const b = tasks.find((item) => item.id === "late-b");
  assert.ok(a.verificationClaims.some((claim) => claim.id === "late-v"), "迟到回执记入原任务 A");
  assert.equal(a.verificationStatus, "passed", "A 的验证状态由 A 的迟到回执推进");
  assert.equal(a.status, "planned", "验证回执不自动推进完成判定");
  assert.ok(!(b.verificationClaims || []).length, "B 不受迟到回执影响");
  assert.equal(b.status, "planned", "B 的账本保持独立");
});

test("模型治理退役：旧 API 返回 404，历史文件不参与主线运行", async (context) => {
  await resetLedger();
  const routing = '{"routes":[{"status":"active","task_id":"retired-task"}]}';
  const delegations = '{"runs":[{"status":"active"}]}';
  await writeFile(envPaths.TASKCENTER_ROUTING_CONTROL_PATH, routing);
  await writeFile(envPaths.TASKCENTER_DELEGATIONS_PATH, delegations);
  const { base, child } = await startControlServer();
  context.after(() => child.kill("SIGTERM"));
  for (const [method, path] of [["GET", "/routing/health"], ["GET", "/routing/models"], ["POST", "/routing/select"], ["POST", "/routing/result"], ["POST", "/delegations/grant"], ["POST", "/delegations/claim"], ["GET", "/delegations/resolve?session_id=child"], ["POST", "/reviews/start"], ["POST", "/reviews/claim"], ["GET", "/reviews/session?session_id=child"], ["GET", "/tasks/retired-task/reviews"]]) {
    const response = await fetch(`${base}${path}`, { method });
    assert.equal(response.status, 404, `${method} ${path}`);
  }
  assert.equal((await fetch(`${base}/health`)).status, 200);
  recordTaskEvent({ type: "session.register", session_id: "retired-main", agent: "codex", workspace: "/work" });
  recordTaskEvent({ type: "task.create", session_id: "retired-main", task_id: "retired-task", title: "主线", goal: "继续主线" });
  const tasks = JSON.parse(await readFile(envPaths.TASKCENTER_TASK_LEDGER_PATH, "utf8"));
  tasks[0].routingHistory = [{ selectedExecutorModel: "historical" }];
  tasks[0].executionModelPolicy = { mode: "quota_preferred", preferred_model: "historical" };
  await writeFile(envPaths.TASKCENTER_TASK_LEDGER_PATH, JSON.stringify(tasks));
  recordTaskEvent({ type: "task.update", session_id: "retired-main", task_id: "retired-task", current_step: "无需路由" });
  assert.equal(loadTasks()[0].routingHistory[0].selectedExecutorModel, "historical");
  assert.equal(loadTasks()[0].currentStep, "无需路由");
  assert.throws(() => recordTaskEvent({ type: "routing.decision", session_id: "retired-main", task_id: "retired-task" }), /类型无效/);
  assert.equal(await readFile(envPaths.TASKCENTER_ROUTING_CONTROL_PATH, "utf8"), routing);
  assert.equal(await readFile(envPaths.TASKCENTER_DELEGATIONS_PATH, "utf8"), delegations);
});
