import { SessionSwitchError, prepareSessionSwitch, confirmSessionSwitch, switchCheckpoint, readRecoveryCheckpoint } from "./session-switch.mjs";
import { withCodexCompactionHost } from "./codex-compaction-host.mjs";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  DispatchError,
} from "./dispatch-core.mjs";
import {
  defaultSessionsRoot,
} from "./session-cli.mjs";
import { HARNESS_IDS, harnessCapabilities } from "./harnesses/index.mjs";
import {
  completeContextTasks,
  completeTasksByReconciliation,
  canonicalSessionId,
  ensureContextTask,
  getSessionStatuses,
  loadSessionRegistry,
  loadTasks,
  loadVisibleTasks,
  reconcileContextShadowTasks,
  recordSessionL0Audit,
  recordTaskEvent,
  setSessionScheduledReadonlyScanExemption,
  supersedeContextShadowTask,
  taskCompletionPacket,
  taskCompletionReadiness,
  taskExport,
  taskPhaseReport,
  taskEventsPath,
  taskLedgerPath,
  taskReconcilePath,
  TaskLedgerError,
} from "./task-ledger.mjs";
import { runReconciliation, queryFindings, lastReconciliation } from "./task-reconciler.mjs";
import { requestAutomaticWork } from "./ai-observer.mjs";
import { auditWriter } from "./jev-advisor.mjs";
import {
  loadTaskReuseDecisions,
  recordTaskReuseDecision,
  summarizeTaskReuseDecisions,
  taskReuseCheck,
  TaskReuseAdvisorError,
} from "./task-reuse-advisor.mjs";
import { syncContextCompletionFromUi, syncContextEvent } from "./context-bridge.mjs";
import {
  decideReflectionProposal,
  emptyReflectionState,
  generateReflection,
  hydrateReflectionState,
  reconcileReflectionSessionSelection,
} from "./reflection-engine.mjs";
import { normalizeSessionAllowlist, readSessionAllowlist, sessionIdPattern, updateSessionAllowlist } from "./session-allowlist.mjs";
import { AiGovernanceError, aiActivity, createGovernanceRunner, governanceSnapshot, agentGuidance } from "./ai-governance.mjs";
import { recommendSessionLifecycle, machineHandoff } from "./session-lifecycle.mjs";
import { readRequestBudget } from "./request-budget.mjs";
import { boundedResponse } from "./bounded-response.mjs";
import { queryUsageReport } from "./usage-query.mjs";
import { buildGovernanceMetrics, gateDenialSnapshot, recordGateDenial } from "./governance-metrics.mjs";
import { taskMatchesBucket, taskMatchesQuery, taskPresentation } from "../lib/task-workspace.mjs";
import { enrichTaskWorkspaceEvent } from "../lib/git-workspace.mjs";
import {
  ContextManagementPilotError,
  pilotEventsPath,
  pilotSnapshot,
  readPilotEvents,
  recordPilotTrial,
  updatePilotIntent,
} from "./context-management-pilot.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const dashboardPath = resolve(process.env.TASKCENTER_DASHBOARD_PATH || join(projectRoot, "data", "dashboard.json"));
const dispatchesPath = resolve(process.env.TASKCENTER_DISPATCHES_PATH || join(projectRoot, "data", "dispatches.json"));
const overridesPath = resolve(process.env.TASKCENTER_OVERRIDES_PATH || join(projectRoot, "data", "requirement-overrides.json"));
const inboxDecisionsPath = resolve(process.env.TASKCENTER_INBOX_DECISIONS_PATH || join(projectRoot, "data", "inbox-decisions.json"));
const sessionSelectionPath = resolve(process.env.TASKCENTER_SESSION_SELECTION_PATH || join(projectRoot, "data", "session-selection.json"));
const gateSessionAllowlistPath = resolve(process.env.TASKCENTER_GATE_SESSION_ALLOWLIST_PATH || join(projectRoot, "data", "gate-session-allowlist.json"));
const localMcpTokenPath = resolve(process.env.TASKCENTER_MCP_TOKEN_PATH || join(projectRoot, ".local", "runtime", "mcp-token"));
const reflectionProposalsPath = resolve(process.env.TASKCENTER_REFLECTION_PROPOSALS_PATH || join(projectRoot, "data", "reflection-proposals.json"));
const contextAcceptanceToken = String(process.env.TASKCENTER_CONTEXT_ACCEPTANCE_TOKEN || "");
const acceptanceToken = String(process.env.TASKCENTER_ACCEPTANCE_TOKEN || "");
const watcherHeartbeatPath = resolve(process.env.TASKCENTER_WATCHER_HEARTBEAT_PATH || join(projectRoot, ".local", "runtime", "watcher-heartbeat.json"));
const usageReportPath = resolve(process.env.TASKCENTER_USAGE_REPORT_PATH || join(projectRoot, ".local", "runtime", "usage-report.json"));
const governanceMetricsPath = resolve(process.env.TASKCENTER_GOVERNANCE_METRICS_PATH || join(projectRoot, ".local", "runtime", "governance-metrics.json"));
const gateDenialsPath = resolve(process.env.TASKCENTER_GATE_DENIALS_PATH || join(projectRoot, ".local", "runtime", "gate-denials.jsonl"));
const taskEventIndexPath = resolve(process.env.TASKCENTER_TASK_EVENT_INDEX_PATH || join(projectRoot, ".local", "runtime", "task-event-index.json"));
const usageHealthPath = resolve(process.env.TASKCENTER_USAGE_HEALTH_PATH || join(projectRoot, ".local", "runtime", "usage-worker-health.json"));
const governanceHealthPath = resolve(process.env.TASKCENTER_GOVERNANCE_HEALTH_PATH || join(projectRoot, ".local", "runtime", "governance-worker-health.json"));
const contextManagementPilotPath = pilotEventsPath(projectRoot);
const aiActivityPath = resolve(process.env.TASKCENTER_AI_ACTIVITY_PATH || join(projectRoot, "data", "ai-activity.jsonl"));
const jevActivityPath = join(resolve(process.env.TASKCENTER_JEV_RUNTIME_DIR || join(projectRoot, ".local", "jev-pilot")), "events.jsonl");
const aiGovernance = createGovernanceRunner({ path: aiActivityPath });
const aiRuntime = resolve(process.env.TASKCENTER_RUNTIME_DIR || join(projectRoot, ".local/runtime"));
let proactiveWork = null;
const host = "127.0.0.1";
function releaseInfo() {
  const revision = String(process.env.TASKCENTER_RELEASE_REVISION || "").trim();
  let version = "";
  try {
    const parsed = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8"));
    if (parsed && typeof parsed.version === "string") version = parsed.version.trim();
  } catch { /* 读不到 package.json 时版本留空 */ }
  return { version, revision: revision ? (revision.length > 12 ? revision.slice(0, 12) : revision) : "" };
}

const port = Number(process.env.TASKCENTER_CONTROL_PORT || 3001);
const dryRun = process.env.TASKCENTER_DISPATCH_DRY_RUN === "1";
const reconcileLiveSessions = process.env.TASKCENTER_DISABLE_LIVE_SESSION_RECONCILIATION !== "1";
const sessionsRoot = defaultSessionsRoot();
const allowedOrigins = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://[::1]:3000",
]);
const dispatches = loadDispatches();
const requirementOverrides = loadJsonObject(overridesPath);
const inboxDecisions = loadJsonObject(inboxDecisionsPath);
let syncing = null;
const snapshotCache = new Map();
const localMcpToken = loadOrCreateLocalMcpToken();

const startupContextReconciliation = reconcileContextShadowTasks();
if (startupContextReconciliation.reconciled.length) {
  console.log(`[TaskCenter] 已收敛 ${startupContextReconciliation.reconciled.length} 条 Context 影子任务。`);
}
// 轻量对账：服务启动时恢复未处理记录（收口脱离会话的运行，生成缺项；不伪造验收、不自动重跑）。
if (reconcileLiveSessions) {
  try {
    void runReconciliation({ availableSessionIds: availableSessionIds() }).then(result => {
      console.log(`[TaskCenter] 启动对账：处置 ${result.actions.length} 条任务，发现 ${result.findings.length} 条缺项。`);
    }).catch(error => console.error(`[TaskCenter] 启动对账失败：${error.message}`));
  } catch (error) {
    console.error(`[TaskCenter] 启动对账失败：${error?.message || error}`);
  }
}
// 低频对账扫描：周期性核对运行事实与账本（幂等，只收口脱离运行并生成缺项）。
const reconciliationTimer = setInterval(async () => {
  if (!reconcileLiveSessions) return;
  try {
    const result = await runReconciliation({ availableSessionIds: availableSessionIds() });
    if (result.reconciled.length || result.findings.length) {
      console.log(`[TaskCenter] 对账扫描：收口 ${result.reconciled.length} 条脱离运行，发现 ${result.findings.length} 条缺项。`);
    }
  } catch (error) {
    console.error(`[TaskCenter] 对账扫描失败：${error?.message || error}`);
  }
}, 5 * 60_000);

const sessionSwitchOperations = new Map();
const server = createServer(async (request, response) => {
  try {
    setCors(request, response);
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      const dashboard = inspectFile(dashboardPath);
      const heartbeat = inspectFile(watcherHeartbeatPath, true);
      const watcherFresh = heartbeat.readable && Date.now() - Date.parse(heartbeat.updatedAt) < 30_000;
      const memory = process.memoryUsage();
      sendJson(response, 200, { ok: true, release: releaseInfo(), dryRun, syncing: Boolean(syncing), control: { uptimeSeconds: Math.round(process.uptime()), rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal, externalBytes: memory.external, arrayBuffersBytes: memory.arrayBuffers }, dashboard, ledger: { readable: inspectFile(taskLedgerPath).readable, eventsReadable: inspectFile(taskEventsPath).readable }, metrics: { usage: metricSnapshotStatus(usageReportPath, usageHealthPath, 120_000), governance: metricSnapshotStatus(governanceMetricsPath, governanceHealthPath, 15_000) }, watcher: { ...heartbeat, healthy: watcherFresh } });
      return;
    }
    if (request.method === "POST" && request.url === "/sync") {
      verifyActionRequest(request);
      sendJson(response, syncing ? 202 : 200, await syncNow());
      return;
    }
    if (request.method === "GET" && /^\/ai\/activity(?:\?|$)/.test(request.url)) {
      const params = new URL(request.url, "http://localhost").searchParams;
      const observer = readSnapshot(join(resolve(process.env.TASKCENTER_RUNTIME_DIR || join(projectRoot, ".local/runtime")), "ai-observer-health.json"), { status: "stopped" });
      const stale = !observer.updated_at || Date.now() - Date.parse(observer.updated_at) > 15_000;
      const work = readSnapshot(join(aiRuntime, "ai-work-request.json"), null);
      const state = readSnapshot(join(aiRuntime, "ai-observer-state.json"), { tasks: {} });
      const tasks = loadVisibleTasks();
      const pending = work ? work.task_ids.filter(id => tasks.some(task => task.id === id && !task.archivedAt && ["planned", "in_progress", "blocked"].includes(task.status)) && state.tasks[id]?.request_id !== work.id).length : 0;
      sendJson(response, 200, { ...await aiActivity({ path: aiActivityPath, jevPath: jevActivityPath, reconciliationPath: taskReconcilePath, params, tasks, running: aiGovernance.running || (!stale && observer.status === "analyzing") }), observer: { ...observer, stale }, work: work ? { id: work.id, at: work.at, total: work.task_ids.length, pending } : null });
      return;
    }
    if (request.method === "POST" && request.url === "/ai/work") {
      verifyManualTaskAction(request);
      await readJsonBody(request);
      if (!proactiveWork) proactiveWork = (async () => {
        const profile = readSnapshot(resolve(process.env.TASKCENTER_AI_CONFIG_PATH || join(projectRoot, "config/ai-governance.json")), {});
        const work = await requestAutomaticWork({ tasks: loadVisibleTasks(), workspace: resolve(process.env.TASKCENTER_AI_WORKSPACE || projectRoot), profile, runtime: aiRuntime, record: auditWriter(aiActivityPath), reconcile: () => runReconciliation({ availableSessionIds: availableSessionIds() }) });
        return { accepted: true, request_id: work.id, queued: work.task_ids.length, reused: work.reused };
      })().finally(() => { proactiveWork = null; });
      sendJson(response, 202, await proactiveWork);
      return;
    }
    if (request.method === "POST" && request.url === "/ai/analyze") {
      verifyManualTaskAction(request);
      const body = await readJsonBody(request);
      const task = loadVisibleTasks().find(item => item.id === body.task_id);
      if (!task) throw new AiGovernanceError(404, "任务不存在或不可见。");
      sendJson(response, 202, aiGovernance.start(task, body));
      return;
    }
    if (request.method === "GET" && /^\/ai\/snapshot\?/.test(request.url)) {
      const params = new URL(request.url, "http://localhost").searchParams;
      const task = loadVisibleTasks().find(item => item.id === params.get("task_id"));
      if (!task) throw new AiGovernanceError(404, "任务不存在或不可见。");
      sendJson(response, 200, governanceSnapshot(task, params.get("kind")));
      return;
    }
    if (request.method === "GET" && request.url === "/dashboard") {
      sendJson(response, 200, loadDashboard());
      return;
    }
    if (request.method === "GET" && /^\/usage-report(?:\?|$)/.test(request.url)) {
      const params = new URL(request.url, "http://localhost").searchParams;
      const indexPath = resolve(process.env.TASKCENTER_USAGE_INDEX_PATH || join(dirname(usageReportPath), "usage-index.json"));
      const filtered = ["project", "session", "task"].some((key) => params.has(key));
      sendJson(response, 200, queryUsageReport({ report: currentUsageReport(), index: filtered ? readSnapshot(indexPath, null) : null, tasks: filtered ? loadVisibleTasks() : [], params }));
      return;
    }
    if (request.method === "POST" && ["/session-switch/prepare", "/session-switch/confirm"].includes(request.url)) {
      verifyBoundMcpRequest(request);
      const body = await readJsonBody(request);
      const checkpoint = (id = body.task_id) => {
        const tasks = loadTasks();
        const task = tasks.find((item) => item.id === id && item.sessionId === body.session_id);
        if (tasks.some((item) => item.id === body.next_task_id)) throw new TaskLedgerError(409, "SWITCH_TARGET_EXISTS");
        return switchCheckpoint(task, tasks, loadSessionRegistry()[body.session_id], []);
      };
      if (request.url.endsWith("/prepare")) {
        sendJson(response, 200, { accepted: true, ...await prepareSessionSwitch(body, sessionsRoot, checkpoint) });
      } else {
        // Return before waiting for the invoking MCP turn to finish. The host
        // never interrupts that turn or starts a model turn to restore context.
        const key = `${body.session_id}:${body.switch_id}`;
        const recovery = readRecoveryCheckpoint(body.switch_id, body.session_id, checkpoint);
        for (const [id, value] of sessionSwitchOperations) if (Date.parse(value.expires_at) <= Date.now()) sessionSwitchOperations.delete(id);
        let operation = sessionSwitchOperations.get(key);
        if (operation?.status === "ready") {
          operation.receipt = await confirmSessionSwitch(body, sessionsRoot, checkpoint);
        }
        if (!operation) {
          const url = process.env.TASKCENTER_CODEX_APP_SERVER_URL;
          if (!url) throw new SessionSwitchError("HOST_COMPACTION_CAPABILITY_UNAVAILABLE");
          operation = { accepted: true, status: "pending", switch_id: body.switch_id, authority: false, expires_at: recovery.expires_at };
          sessionSwitchOperations.set(key, operation);
          withCodexCompactionHost({ url, sessionId: body.session_id, workspace: recovery.workspace }, (host) => confirmSessionSwitch(body, sessionsRoot, checkpoint, host))
            .then((receipt) => Object.assign(operation, { status: "ready", authority: true, receipt }))
            .catch((error) => Object.assign(operation, { accepted: false, status: "failed", error: error.message }));
        }
        sendJson(response, 200, operation);
      }
      return;
    }
    if (request.method === "POST" && request.url === "/task-resume") {
      verifyTaskRequest(request);
      const body = await readJsonBody(request);
      const task = loadVisibleTasks().find((item) => item.id === body.task_id);
      const registry = loadSessionRegistry()[body.session_id];
      if (!task || !registry) throw new TaskLedgerError(409, "恢复需要已有 task_id 和已登记的真实 Session。");
      if (registry.workspace !== task.workspace) throw new TaskLedgerError(409, "恢复 Session 的 workspace 与合同不一致。");
      if (["cancelled", "removed"].includes(task.status)) throw new TaskLedgerError(409, "TASK_NOT_RESUMABLE：已取消或移除任务不能接手。");
      const reopen = ["done_claimed", "verified"].includes(task.status);
      if (task.sessionId !== body.session_id || reopen) {
        if (task.sessionId !== body.expected_session_id) throw new TaskLedgerError(409, "SESSION_BINDING_CHANGED：请重新读取交接状态。");
        if (loadVisibleTasks().some((item) => item.id !== task.id && item.sessionId === body.session_id && ["planned", "in_progress", "blocked"].includes(item.status))) throw new TaskLedgerError(409, "ACTIVE_TASK_CONFLICT：目标 Session 已有其他活跃任务。");
        recordTaskEvent({ type: "task.resume", task_id: task.id, session_id: body.session_id, workspace: task.workspace, agent: registry.agent, model: registry.model, provider: registry.provider, event_id: body.event_id, ...((reopen || task.sessionId !== body.session_id) ? { status: "in_progress" } : {}) }, { requireRegistered: true, authorizedResume: true });
      }
      request.method = "GET";
      request.url = `/task-prepare?session_id=${encodeURIComponent(body.session_id)}`;
    }
    if (request.method === "GET" && request.url?.startsWith("/response-continue?")) {
      sendJson(response, 200, boundedResponse(null, { cursor: new URL(request.url, "http://localhost").searchParams.get("cursor") }));
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/task-prepare?")) {
      const params = new URL(request.url, "http://localhost").searchParams;
      const sessionId = params.get("session_id") || "";
      const registry = loadSessionRegistry()[sessionId];
      if (!registry) throw new TaskLedgerError(409, "当前 Session 尚未登记。");
      const tasks = loadVisibleTasks().filter((task) => task.sessionId === sessionId).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      const activeTask = tasks.find((item) => ["planned", "in_progress", "blocked"].includes(item.status));
      const task = activeTask || tasks[0] || null;
      const budget = await readRequestBudget(sessionId, sessionsRoot, task);
      sendJson(response, 200, boundedResponse({
        session_id: sessionId, task_id: task?.id || null, status: task?.status || null,
        active_task: activeTask ? Object.fromEntries(["id", "sessionId", "status", "dueAt", "estimatedEffortMs", "activeDurationMs", "activeStartedAt"].map((key) => [key, activeTask[key]])) : null,
        gate_allowlisted: readSessionAllowlist(gateSessionAllowlistPath).threadIds?.includes(sessionId) || false,
        scheduled_readonly: registry.scheduledReadonly || null,
        contract: task ? boundedResponse({ goal: task.goal, scope: task.scope, non_goals: task.nonGoals, acceptance_criteria: task.acceptanceCriteria, verification_plan: task.verificationPlan, subject: task.currentSubject, next_action: task.nextAction }, { maxBytes: budget.handoff_recommended || !activeTask ? 800 : 2600 }) : null,
        handoff: task && (budget.handoff_recommended || !activeTask) ? machineHandoff(task) : null,
        agent_guidance: task ? agentGuidance(task, aiActivityPath) : null,
        ...budget,
      }));
      return;
    }
    if (request.method === "GET" && request.url === "/governance-metrics") {
      sendJson(response, 200, { ...readSnapshot(governanceMetricsPath, buildGovernanceMetrics({ usageReport: currentUsageReport() })), snapshotStatus: metricSnapshotStatus(governanceMetricsPath, governanceHealthPath, 15_000) });
      return;
    }
    if (request.method === "GET" && request.url === "/context-management-pilots") {
      sendJson(response, 200, pilotSnapshot({ registry: loadSessionRegistry(), sessionTitles: loadSessionTitles(), tasks: loadTasks(), usageReport: currentUsageReport(), events: readPilotEvents(contextManagementPilotPath) }));
      return;
    }
    const pilotResultMatch = request.method === "POST" ? request.url?.match(/^\/context-management-pilots\/intents\/([0-9a-f-]{36})\/result$/i) : null;
    if (pilotResultMatch) {
      verifyTaskRequest(request);
      const body = await readJsonBody(request);
      if (!['succeeded', 'failed'].includes(body.status)) throw new ContextManagementPilotError(400, "项目回执必须是 succeeded 或 failed。");
      const intent = updatePilotIntent(contextManagementPilotPath, pilotResultMatch[1], body.status, body);
      sendJson(response, 200, { accepted: true, intent });
      return;
    }
    if (request.method === "POST" && request.url === "/context-management-pilots/trials") {
      verifyTaskRequest(request);
      const body = await readJsonBody(request);
      const report = recordPilotTrial(contextManagementPilotPath, body);
      sendJson(response, 201, { accepted: true, report });
      return;
    }
    const lifecycleMatch = request.method === "GET" ? request.url?.match(/^\/session-lifecycle(?:\?session_id=([^&]+))?$/) : null;
    if (lifecycleMatch) {
      const sessionId = lifecycleMatch[1] ? decodeURIComponent(lifecycleMatch[1]) : "";
      const tasks = loadVisibleTasks().filter((task) => !sessionId || task.sessionId === sessionId);
      const currentTask = tasks.filter((task) => ["planned", "in_progress", "blocked"].includes(task.status)).at(-1) || tasks.at(-1) || null;
      const workspaces = new Set(tasks.map((task) => task.workspace).filter(Boolean));
      const usage = currentUsageReport();
      const lifecycle = recommendSessionLifecycle({
        usage: {
          ...usage,
          alerts: (usage.alerts || []).filter((alert) => !sessionId || alert.sessionId === sessionId),
          projectChanged: workspaces.size > 1,
        },
        tasks,
        currentTask,
      });
      const budget = sessionId ? await readRequestBudget(sessionId, sessionsRoot, currentTask) : null;
      sendJson(response, 200, { ...lifecycle, ...(budget || {}), ...(budget?.handoff_recommended ? { handoff: machineHandoff(currentTask || {}), reasons: [...lifecycle.reasons, ...budget.recommendation_reasons] } : {}) });
      return;
    }
    if (request.method === "GET" && request.url === "/session-selection") {
      const dashboard = loadDashboard();
      sendJson(response, 200, {
        selection: loadSessionSelection(),
        availableThreads: dashboard.source?.availableThreads ?? dashboard.threads ?? [],
      });
      return;
    }
    if (request.method === "GET" && request.url === "/gate-session-allowlist") {
      const dashboard = loadDashboard();
      sendJson(response, 200, {
        selection: readSessionAllowlist(gateSessionAllowlistPath),
        availableThreads: dashboard.source?.availableThreads ?? dashboard.threads ?? [],
      });
      return;
    }
    if (request.method === "GET" && request.url === "/reconciliation") {
      sendJson(response, 200, { findings: queryFindings(), lastRunAt: lastReconciliation()?.observedAt || null });
      return;
    }
    if (request.method === "GET" && request.url === "/session-status") {
      const titles = new Map(loadSessionTitles().map((item) => [item.id, item]));
      const usageBySession = new Map((currentUsageReport().lifetime?.bySession || []).map((item) => [item.sessionId, item]));
      const sessions = getSessionStatuses(availableSessionIds(), loadVisibleTasks())
        .map((session) => ({ ...session, harness: harnessCapabilities(HARNESS_IDS.includes(session.agent) ? session.agent : "unknown"), title: titles.get(session.sessionId)?.title || "", updatedAt: latestTimestamp(titles.get(session.sessionId)?.updatedAt, session.lastSeenAt, session.lastTaskAt), tokenUsage: usageBySession.get(session.sessionId) || null }))
        .sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt));
      sendJson(response, 200, { sessions });
      return;
    }
    if (request.method === "POST" && request.url === "/sessions/l0-audit") {
      verifyTaskRequest(request);
      const body = await readJsonBody(request);
      const audit = recordSessionL0Audit(String(body.session_id || ""));
      sendJson(response, 200, { accepted: true, l0Audit: audit });
      return;
    }
    // Hook/CLI 拒绝即时检测：落盘安全分类并同步返回短窗口去重后的批量/连续评估与恢复步骤。
    if (request.method === "GET" && new URL(request.url, "http://localhost").pathname === "/gate-denials") {
      const query = new URL(request.url, "http://localhost").searchParams;
      const limit = query.has("limit") ? Number(query.get("limit")) : 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TaskLedgerError(400, "拒绝记录条数须为 1–50。");
      sendJson(response, 200, gateDenialSnapshot(gateDenialsPath, { limit }));
      return;
    }
    if (request.method === "POST" && request.url === "/gate-denials") {
      verifyTaskRequest(request);
      const body = await readJsonBody(request);
      const { record, assessment } = recordGateDenial(gateDenialsPath, body);
      sendJson(response, 200, { accepted: true, denial: record, assessment });
      return;
    }
    if (request.method === "POST" && request.url === "/session-selection") {
      verifyActionRequest(request);
      const body = await readJsonBody(request);
      if (!["allowlist", "selected", "all"].includes(body.mode)) throw new DispatchError(400, "会话白名单模式无效。");
      const selection = normalizeSessionAllowlist({
        mode: "allowlist",
        threadIds: body.threadIds,
        updatedAt: new Date().toISOString(),
      });
      persistJsonObject(sessionSelectionPath, selection);
      if (selection.threadIds.length > 0) {
        cancelLegacyAllowlistSetupTasks();
        persistJsonObject(
          reflectionProposalsPath,
          reconcileReflectionSessionSelection(loadReflectionState(), selection),
        );
      }
      const result = await syncNow();
      sendJson(response, 200, { ...result, selection });
      return;
    }
    if (request.method === "POST" && request.url === "/gate-session-allowlist") {
      verifyActionRequest(request);
      const body = await readJsonBody(request);
      const selection = normalizeSessionAllowlist({
        mode: "allowlist",
        threadIds: body.threadIds,
        updatedAt: new Date().toISOString(),
      });
      persistJsonObject(gateSessionAllowlistPath, selection);
      sendJson(response, 200, { selection });
      return;
    }
    if (request.method === "POST" && request.url === "/gate-session-allowlist/session") {
      verifyActionRequest(request);
      const body = await readJsonBody(request);
      const sessionId = String(body.session_id || "").trim().toLowerCase();
      if (!sessionIdPattern.test(sessionId)) throw new DispatchError(400, "Session ID 无效。");
      if (typeof body.enabled !== "boolean") throw new DispatchError(400, "enabled 必须是 boolean。");
      const selection = updateSessionAllowlist(readSessionAllowlist(gateSessionAllowlistPath), sessionId, body.enabled);
      persistJsonObject(gateSessionAllowlistPath, selection);
      sendJson(response, 200, {
        accepted: true,
        session: { sessionId, gateExempt: body.enabled },
        selection,
      });
      return;
    }
    if (request.method === "POST" && request.url === "/gate-session-exemption/status") {
      verifyBoundMcpRequest(request);
      const body = await readJsonBody(request);
      const sessionId = String(body.session_id || "").trim().toLowerCase();
      if (!sessionIdPattern.test(sessionId)) throw new DispatchError(400, "Session ID 无效。");
      const registered = Boolean(loadSessionRegistry()[sessionId]);
      const selection = readSessionAllowlist(gateSessionAllowlistPath);
      sendJson(response, 200, {
        accepted: true,
        session: { sessionId, registered, gateExempt: selection.threadIds.includes(sessionId) },
      });
      return;
    }
    if (request.method === "POST" && request.url === "/gate-session-exemption/set") {
      verifyBoundMcpRequest(request);
      const body = await readJsonBody(request);
      const sessionId = String(body.session_id || "").trim().toLowerCase();
      if (!sessionIdPattern.test(sessionId)) throw new DispatchError(400, "Session ID 无效。");
      if (typeof body.enabled !== "boolean") throw new DispatchError(400, "enabled 必须是 boolean。");
      if (!loadSessionRegistry()[sessionId]) throw new DispatchError(409, "当前 Session 尚未登记，不能修改门禁豁免。");
      const selection = updateSessionAllowlist(readSessionAllowlist(gateSessionAllowlistPath), sessionId, body.enabled);
      persistJsonObject(gateSessionAllowlistPath, selection);
      sendJson(response, 200, {
        accepted: true,
        session: { sessionId, registered: true, gateExempt: body.enabled },
      });
      return;
    }
    if (request.method === "POST" && request.url === "/scheduled-readonly-scan-exemption/status") {
      verifyBoundMcpRequest(request);
      const body = await readJsonBody(request);
      const sessionId = String(body.session_id || "").trim().toLowerCase();
      if (!sessionIdPattern.test(sessionId)) throw new DispatchError(400, "Session ID 无效。");
      const profile = loadSessionRegistry()[sessionId]?.scheduledReadonly;
      sendJson(response, 200, {
        accepted: true,
        session: {
          sessionId,
          scheduledReadonly: profile?.profile === "scheduled_readonly",
          scanExempt: profile?.scanExempt === true,
        },
      });
      return;
    }
    if (request.method === "POST" && request.url === "/scheduled-readonly-scan-exemption/set") {
      verifyBoundMcpRequest(request);
      const body = await readJsonBody(request);
      const sessionId = String(body.session_id || "").trim().toLowerCase();
      if (!sessionIdPattern.test(sessionId)) throw new DispatchError(400, "Session ID 无效。");
      if (typeof body.enabled !== "boolean") throw new DispatchError(400, "enabled 必须是 boolean。");
      const profile = setSessionScheduledReadonlyScanExemption(sessionId, body.enabled);
      sendJson(response, 200, {
        accepted: true,
        session: { sessionId, scheduledReadonly: true, scanExempt: profile.scanExempt === true },
      });
      return;
    }
    if (request.method === "GET" && request.url === "/dispatches") {
      sendJson(response, 200, { dispatches: dispatches.slice(-30).reverse() });
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/tasks")) {
      const url = new URL(request.url, `http://${host}:${port}`);
      if (url.pathname !== "/tasks") {
        // 交给下方 task 子资源路由。
      } else {
        const usageByTask = new Map((currentUsageReport().lifetime?.byTask || []).map((item) => [item.id, item]));
        const tasks = loadVisibleTasks().slice().reverse().map((task) => ({ ...task, tokenUsage: usageByTask.get(task.id) || null }));
        const taskId = url.searchParams.get("task_id") || "";
        const sessionId = url.searchParams.get("session_id") || "";
        if (taskId || sessionId) {
          const matching = tasks.filter(task => (!taskId || task.id === taskId) && (!sessionId || task.sessionId === sessionId));
          sendJson(response, 200, { tasks: url.searchParams.get("view") === "summary" ? matching.map(task => ({ ...taskSummary(task), agent_guidance: agentGuidance(task, taskId ? aiActivityPath : undefined) })) : matching });
          return;
        }
        if (!url.searchParams.size) {
          sendJson(response, 200, { tasks: tasks });
          return;
        }
        const sessionRegistry = loadSessionRegistry();
        const presentedTasks = tasks.map((task) => taskPresentation({
          ...sessionRegistry[task.sessionId],
          ...task,
          workspace: task.workspace || sessionRegistry[task.sessionId]?.workspace || "",
        }));
        const project = url.searchParams.get("project") || "all";
        const bucket = url.searchParams.get("bucket") || "all";
        const query = url.searchParams.get("query") || "";
        const projectTasks = presentedTasks.filter((task) => project === "all" || task.project.id === project);
        const filteredTasks = projectTasks.filter((task) => taskMatchesQuery(task, query) && taskMatchesBucket(task, bucket));
        const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
        const pageSize = Math.min(500, Math.max(1, Number.parseInt(url.searchParams.get("page_size") || "40", 10) || 40));
        const start = (page - 1) * pageSize;
        const pageTasks = filteredTasks.slice(start, start + pageSize);
        const actionCounts = Object.fromEntries(["planned", "in_progress", "execution_unconfirmed", "completed", "attention", "awaiting_verification", "awaiting_acceptance", "blocked"].map((name) => [name, projectTasks.filter((task) => taskMatchesBucket(task, name)).length]));
        actionCounts.all = projectTasks.length;
        const projects = new Map();
        for (const task of presentedTasks) if (!projects.has(task.project.id)) projects.set(task.project.id, task.project);
        sendJson(response, 200, {
          tasks: url.searchParams.get("view") === "summary" ? pageTasks.map(taskSummary) : pageTasks,
          page,
          pageSize,
          total: filteredTasks.length,
          totalPages: Math.max(1, Math.ceil(filteredTasks.length / pageSize)),
          actionCounts,
          projects: [...projects.values()].sort((left, right) => left.label.localeCompare(right.label, "zh-CN")),
        });
        return;
      }
    }
    if (request.method === "POST" && request.url === "/task-reuse/check") {
      verifyTaskRequest(request);
      const body = await readJsonBody(request);
      const identity = requireRegisteredReuseSession(body);
      const advice = taskReuseCheck({ ...body, project_id: identity.projectIdentity.project_id }, {
        tasks: loadVisibleTasks(),
        sessionRegistry: identity.registry,
        canonicalSessionId,
        projectIdentity: identity.projectIdentity,
      });
      sendJson(response, 200, advice);
      return;
    }
    if (request.method === "POST" && request.url === "/task-reuse/decisions") {
      verifyTaskRequest(request);
      const body = await readJsonBody(request);
      const identity = requireRegisteredReuseSession(body);
      const result = recordTaskReuseDecision({ ...body, project_id: identity.projectIdentity.project_id });
      sendJson(response, result.idempotent ? 200 : 201, { accepted: true, ...result });
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/task-reuse/decisions")) {
      verifyBoundMcpRequest(request);
      const url = new URL(request.url, `http://${host}:${port}`);
      if (url.pathname !== "/task-reuse/decisions") {
        sendJson(response, 404, { error: "接口不存在。" });
        return;
      }
      const decisionFilters = {
        workspace: url.searchParams.get("workspace") || "",
        project_id: url.searchParams.get("project_id") || "",
        limit: url.searchParams.get("limit") || "100",
      };
      const reuseDecisions = loadTaskReuseDecisions(decisionFilters);
      sendJson(response, 200, { decisions: reuseDecisions, summary: summarizeTaskReuseDecisions(reuseDecisions) });
      return;
    }
    if (request.method === "GET" && request.url === "/reflections") {
      const current = loadReflectionState();
      const reconciled = reconcileReflectionSessionSelection(current, loadSessionSelection());
      if (reconciled !== current) persistJsonObject(reflectionProposalsPath, reconciled);
      sendJson(response, 200, hydrateReflectionState(reconciled, loadVisibleTasks(), dispatches));
      return;
    }
    if (request.method === "POST" && request.url === "/reflections/run") {
      verifyManualTaskAction(request);
      const state = generateReflection({
        tasks: loadVisibleTasks(),
        sessionSelection: loadSessionSelection(),
        previousState: loadReflectionState(),
      });
      persistJsonObject(reflectionProposalsPath, state);
      sendJson(response, 200, hydrateReflectionState(state, loadVisibleTasks(), dispatches));
      return;
    }
    const reflectionActionMatch = request.method === "POST"
      ? request.url?.match(/^\/reflections\/([A-Za-z0-9._-]{1,160})\/actions$/)
      : null;
    if (reflectionActionMatch) {
      verifyManualTaskAction(request);
      const body = await readJsonBody(request);
      const decision = String(body.decision || "");
      try {
        const state = decideReflectionProposal(
          loadReflectionState(),
          reflectionActionMatch[1],
          decision,
          body.reason,
        );
        persistJsonObject(reflectionProposalsPath, state);
        sendJson(response, 200, hydrateReflectionState(state, loadVisibleTasks(), dispatches));
      } catch (error) {
        throw new DispatchError(400, error instanceof Error ? error.message : "反思提案操作失败。");
      }
      return;
    }
    if (request.method === "POST" && request.url === "/context-tasks/ensure") {
      verifyTaskRequest(request);
      const body = await readJsonBody(request);
      const result = ensureContextTask(body);
      sendJson(response, result.created ? 201 : 200, { accepted: true, ...result });
      return;
    }
    if (request.method === "POST" && request.url === "/context-tasks/complete") {
      verifyTaskRequest(request);
      const body = await readJsonBody(request);
      const result = completeContextTasks(body);
      sendJson(response, 200, result);
      return;
    }
    if (request.method === "POST" && request.url === "/maintenance/context-tasks/reconcile") {
      verifyManualTaskAction(request);
      const body = await readJsonBody(request);
      if (body.confirm !== true) throw new TaskLedgerError(400, "生命周期清理需要显式 confirm=true。");
      const replacements = Array.isArray(body.shadowReplacements) ? body.shadowReplacements.slice(0, 50) : [];
      const superseded = replacements.map((item) => supersedeContextShadowTask(
        String(item?.shadowTaskId || ""),
        String(item?.replacementTaskId || ""),
        String(item?.reason || "人工确认内部影子任务已被正式任务接管。"),
      ).task);
      const automatic = reconcileContextShadowTasks();
      const completed = completeTasksByReconciliation(
        Array.isArray(body.completeTaskIds) ? body.completeTaskIds.slice(0, 50) : [],
        String(body.completionEvidence || "人工核对本地 Session final_answer 与 task_complete 后补齐完成上报。"),
      );
      sendJson(response, 200, {
        accepted: true,
        superseded,
        automaticallySuperseded: automatic.reconciled,
        completed: completed.completed,
      });
      return;
    }
    const taskDetailMatch = request.method === "GET" ? request.url?.match(/^\/tasks\/([A-Za-z0-9._-]+)$/) : null;
    if (taskDetailMatch) {
      const task = loadTasks().find((item) => item.id === taskDetailMatch[1]);
      if (!task) throw new TaskLedgerError(404, "任务不存在。");
      const session = loadSessionRegistry()[task.sessionId] || {};
      const workspace = task.workspace || session.workspace || "";
      const tokenUsage = (currentUsageReport().lifetime?.byTask || []).find((item) => item.id === task.id) || null;
      sendJson(response, 200, { task: taskPresentation({ ...session, ...task, workspace, tokenUsage }) });
      return;
    }
    const taskEventsMatch = request.method === "GET" ? request.url?.match(/^\/tasks\/([A-Za-z0-9._-]+)\/events(?:\?limit=(\d+))?$/) : null;
    if (taskEventsMatch) {
      const taskId = taskEventsMatch[1];
      const allEvents = readTaskEvents(taskId);
      const limit = taskEventsMatch[2] ? Math.min(100, Math.max(1, Number(taskEventsMatch[2]))) : null;
      const events = (limit ? allEvents.slice(-limit) : allEvents).reverse();
      sendJson(response, 200, { taskId, events });
      return;
    }
    const readinessMatch = request.method === "GET" ? request.url?.match(/^\/tasks\/([A-Za-z0-9._-]+)\/completion-readiness(?:\?revision=([^&]+))?$/) : null;
    if (readinessMatch) {
      sendJson(response, 200, {
        taskId: readinessMatch[1],
        completionReadiness: taskCompletionReadiness(readinessMatch[1], readinessMatch[2] ? decodeURIComponent(readinessMatch[2]) : ""),
      });
      return;
    }
    const packetMatch = request.method === "GET" ? request.url?.match(/^\/tasks\/([A-Za-z0-9._-]+)\/completion-packet$/) : null;
    if (packetMatch) {
      sendJson(response, 200, { taskId: packetMatch[1], completionPacket: taskCompletionPacket(packetMatch[1]) });
      return;
    }
    const phaseReportMatch = request.method === "GET" ? request.url?.match(/^\/tasks\/([A-Za-z0-9._-]+)\/phase-report(?:\?as_of=([^&]+))?$/) : null;
    if (phaseReportMatch) {
      const asOf = phaseReportMatch[2] ? decodeURIComponent(phaseReportMatch[2]) : "";
      sendJson(response, 200, { taskId: phaseReportMatch[1], phaseTiming: taskPhaseReport(phaseReportMatch[1], asOf) });
      return;
    }
    const contextCompletionMatch = request.method === "POST"
      ? request.url?.match(/^\/tasks\/([A-Za-z0-9._-]+)\/sync-project-context$/)
      : null;
    if (contextCompletionMatch) {
      verifyManualTaskAction(request);
      const body = await readJsonBody(request);
      if (body.confirm !== true) throw new TaskLedgerError(400, "同步 ProjectContext 需要显式 confirm=true。");
      const task = loadTasks().find(item => item.id === contextCompletionMatch[1]);
      if (!task) throw new TaskLedgerError(404, "任务不存在。");
      const completionPacket = taskCompletionPacket(task.id);
      if (completionPacket.completionReadiness?.completionClaim?.allowed !== true) {
        throw new TaskLedgerError(409, `完成门禁未满足: ${(completionPacket.completionReadiness?.reasons || []).join(", ") || "unknown"}`);
      }
      const contextResult = await syncContextCompletionFromUi(task, completionPacket, { requestId: body.requestId });
      sendJson(response, 200, { accepted: true, task, completionPacket, contextResult });
      return;
    }
    const exportMatch = request.method === "GET" ? request.url?.match(/^\/tasks\/([A-Za-z0-9._-]+)\/export(?:\?format=(json|markdown))?$/) : null;
    if (exportMatch) {
      const format = exportMatch[2] || "json";
      if (format === "markdown") {
        response.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
        response.end(taskExport(exportMatch[1], "markdown"));
      } else sendJson(response, 200, { taskId: exportMatch[1], completionPacket: taskExport(exportMatch[1], "json") });
      return;
    }
    if (request.method === "POST" && request.url === "/core/task-events") {
      verifyCoreRequest(request);
      const body = await readJsonBody(request);
      if (body.status === "verified" || String(body.type || "").startsWith("acceptance.")) throw new TaskLedgerError(403, "核心事件通道不能自行提交最终验收。");
      const result = recordTaskEvent(body);
      sendJson(response, body.type === "task.create" && !result.idempotent ? 201 : 200, { accepted: true, idempotent: Boolean(result.idempotent), event: result.event, task: result.task, agent_guidance: agentGuidance(result.task, aiActivityPath) });
      return;
    }
    if (request.method === "POST" && request.url === "/tasks/import-evidence") {
      verifyCoreRequest(request);
      const body = await readJsonBody(request);
      const events = Array.isArray(body.events) ? body.events.slice(0, 100) : [];
      if (!events.length) throw new TaskLedgerError(400, "证据导入至少包含一个事件。");
      const imported = events.map((event) => {
        if (!["subject.updated", "requirement.reported", "verification.reported", "review.reported", "review_cycle.reported"].includes(event?.type)) throw new TaskLedgerError(400, "证据导入事件类型无效。");
        return recordTaskEvent({ ...event, task_id: event.task_id || body.task_id }).event;
      });
      sendJson(response, 200, { accepted: true, importedCount: imported.length, events: imported });
      return;
    }
    if (request.method === "POST" && request.url === "/task-acceptance-report") {
      verifyAcceptanceRequest(request);
      const body = await readJsonBody(request);
      const outcome = body.outcome === "rejected" ? "rejected" : "accepted";
      const result = recordTaskEvent({ type: `acceptance.${outcome}`, event_id: body.event_id, task_id: body.task_id, session_id: body.session_id, acceptance_record: { ...body.acceptance_record, outcome }, occurred_at: body.occurred_at });
      sendJson(response, 200, { accepted: true, idempotent: Boolean(result.idempotent), event: result.event, task: result.task });
      return;
    }
    if (request.method === "POST" && request.url === "/task-acceptance-sync") {
      verifyContextAcceptanceRequest(request);
      const body = await readJsonBody(request);
      const task = loadTasks().find((item) => item.id === body.task_id);
      if (!task) throw new TaskLedgerError(404, "任务不存在。");
      const outcome = body.outcome === "rejected" ? "rejected" : "accepted";
      const result = recordTaskEvent({
        type: `acceptance.${outcome}`,
        event_id: body.event_id,
        task_id: task.id,
        session_id: task.sessionId,
        context_task_id: body.context_task_id,
        context_completion_id: body.context_completion_id,
        authorization_id: body.authorization_id,
        revision: body.revision,
        reason: body.reason,
        acceptance_record: {
          id: body.context_completion_id || body.event_id,
          source: "context_agent",
          actor: { type: "task_platform", id: "trusted-context", provider: "context" },
          subject_ref: body.subject_ref || (body.revision ? { type: "external", value: body.revision, observed_at: body.occurred_at || new Date().toISOString() } : undefined),
          observed_at: body.occurred_at || new Date().toISOString(),
          authorization_id: body.authorization_id,
          reason: body.reason,
        },
        actor: { type: "task_platform", id: "trusted-context", provider: "context" },
        agent: "unknown",
      });
      sendJson(response, 200, { accepted: true, idempotent: Boolean(result.idempotent), event: result.event, task: result.task });
      return;
    }
    if (request.method === "POST" && request.url === "/task-events") {
      verifyTaskRequest(request);
      const input = await readJsonBody(request);
      const body = enrichTaskWorkspaceEvent(input, loadSessionRegistry()[input.session_id], loadTasks().find((task) => task.id === input.task_id));
      if (body.type === "task.review" || body.status === "verified" || String(body.type || "").startsWith("acceptance.")) {
        throw new TaskLedgerError(403, "人工审核必须通过本机任务操作入口完成。");
      }
      const sessionIds = availableSessionIds();
      const result = recordTaskEvent(body, { ...(reconcileLiveSessions ? { availableSessionIds: sessionIds } : {}), requireRegistered: true });
      // 本地账本事件幂等不等于外部同步已成功。重复投递仍使用同一派生 event_id
      // 重试 Context MCP，由 Context 侧幂等键消除已成功的副作用并补偿超时/失败。
      const contextSync = await syncContextEvent(result.event, result.task);
      const warnings = contextSync.status === "failed"
        ? [{
          code: "SESSION_NOTIFICATION_FAILED",
          message: "验证事件已可靠写入本地账本，但 Session 通知失败；可使用相同 event_id 重试通知。",
          detail: contextSync.error,
        }]
        : [];
      // 幂等重投递（重复 event_id）返回 200，只有真正新建任务时才用 201。
      sendJson(response, body.type === "task.create" && !result.idempotent ? 201 : 200, {
        accepted: true,
        idempotent: Boolean(result.idempotent),
        event: result.event,
        task: result.task,
        agent_guidance: agentGuidance(result.task, aiActivityPath),
        contextSync,
        warnings,
      });
      return;
    }
    // 人工操作端点：本机 UI 对任务的状态变更（开始/阻塞/声明完成/取消/移除）
    const taskActionMatch = request.method === "POST"
      ? request.url?.match(/^\/tasks\/([A-Za-z0-9._-]+)\/actions$/)
      : null;
    if (taskActionMatch) {
      verifyManualTaskAction(request);
      const taskId = taskActionMatch[1];
      const body = await readJsonBody(request);
      const action = String(body.action || "");
      if (!["start", "block", "done", "cancel", "remove", "verify", "reject", "archive", "unarchive", "schedule"].includes(action)) {
        throw new TaskLedgerError(400, "任务操作无效。");
      }
      const currentTask = loadTasks().find((item) => item.id === taskId);
      if (action === "verify" && currentTask?.requirementId) verifyRequirementExists(currentTask.requirementId.replace(/^promoted-/, ""));
      const result = applyManualTaskAction(taskId, action, body.reason, body.expectedAt, body.estimatedEffortMinutes);
      const contextSync = await syncContextEvent(result.event, result.task);
      if (action === "verify" && result.task.requirementId) {
        const requirementId = result.task.requirementId.replace(/^promoted-/, "");
        verifyRequirementExists(requirementId);
        requirementOverrides[requirementId] = {
          ...(requirementOverrides[requirementId] || {}),
          status: "verified", hidden: false, source: "manual", updatedAt: result.task.reviewedAt,
        };
        persistJsonObject(overridesPath, requirementOverrides);
      }
      if (action === "reject" && result.task.requirementId) {
        const requirementId = result.task.requirementId.replace(/^promoted-/, "");
        verifyRequirementExists(requirementId);
        requirementOverrides[requirementId] = {
          ...(requirementOverrides[requirementId] || {}),
          status: "needs_validation", hidden: false, source: "manual", updatedAt: result.task.reviewedAt,
        };
        persistJsonObject(overridesPath, requirementOverrides);
      }
      sendJson(response, 200, {
        accepted: true,
        action,
        task: result.task,
        contextSync,
        actor: "manual",
      });
      return;
    }
    if (request.method === "GET" && request.url === "/requirement-overrides") {
      sendJson(response, 200, { overrides: requirementOverrides });
      return;
    }
    if (request.method === "GET" && request.url === "/inbox-decisions") {
      sendJson(response, 200, { decisions: inboxDecisions });
      return;
    }
    const inboxBatchMatch = request.method === "POST" && request.url === "/inbox-decisions/batch";
    if (inboxBatchMatch) {
      verifyActionRequest(request);
      const body = await readJsonBody(request);
      const ids = Array.isArray(body.ids) ? [...new Set(body.ids)] : [];
      validateInboxIds(ids);
      const decision = body.decision === "clear" ? undefined : body.decision;
      validateInboxDecision(body.decision);
      const nextDecisions = { ...inboxDecisions };
      for (const id of ids) {
        if (decision) nextDecisions[id] = decision;
        else delete nextDecisions[id];
      }
      persistJsonObject(inboxDecisionsPath, nextDecisions);
      Object.keys(inboxDecisions).forEach((id) => delete inboxDecisions[id]);
      Object.assign(inboxDecisions, nextDecisions);
      sendJson(response, 200, { decisions: inboxDecisions });
      return;
    }
    const inboxDecisionMatch = request.method === "POST"
      ? request.url?.match(/^\/inbox-decisions\/([A-Za-z0-9._-]{1,160})$/)
      : null;
    if (inboxDecisionMatch) {
      verifyActionRequest(request);
      const id = inboxDecisionMatch[1];
      const body = await readJsonBody(request);
      validateInboxIds([id]);
      validateInboxDecision(body.decision);
      const nextDecisions = { ...inboxDecisions };
      if (body.decision === "clear") delete nextDecisions[id];
      else nextDecisions[id] = body.decision;
      persistJsonObject(inboxDecisionsPath, nextDecisions);
      Object.keys(inboxDecisions).forEach((existingId) => delete inboxDecisions[existingId]);
      Object.assign(inboxDecisions, nextDecisions);
      sendJson(response, 200, { id, decision: inboxDecisions[id] });
      return;
    }
    const decisionMatch = request.method === "POST"
      ? request.url?.match(/^\/requirements\/([A-Za-z0-9._-]{1,160})\/decision$/)
      : null;
    if (decisionMatch) {
      verifyActionRequest(request);
      const requirementId = decisionMatch[1].replace(/^promoted-/, "");
      const body = await readJsonBody(request);
      const action = String(body.action || "");
      if (!["complete", "remove", "restore"].includes(action)) {
        throw new DispatchError(400, "需求操作无效。");
      }
      verifyRequirementExists(requirementId);
      const current = requirementOverrides[requirementId] || {};
      requirementOverrides[requirementId] = {
        ...current,
        ...(action === "complete" ? { status: "verified", hidden: false } : {}),
        ...(action === "remove" ? { hidden: true } : {}),
        ...(action === "restore" ? { hidden: false } : {}),
        source: "manual",
        updatedAt: new Date().toISOString(),
      };
      persistJsonObject(overridesPath, requirementOverrides);
      sendJson(response, 200, {
        requirementId,
        override: requirementOverrides[requirementId],
      });
      return;
    }
    sendJson(response, 404, { error: "接口不存在。" });
  } catch (error) {
    const known = error instanceof AiGovernanceError || error instanceof SessionSwitchError || error instanceof DispatchError || error instanceof TaskLedgerError || error instanceof TaskReuseAdvisorError || error instanceof ContextManagementPilotError;
    const statusCode = known ? error.statusCode : 500;
    if (!known) {
      console.error("TaskCenter control error:", safeError(error));
    }
    sendJson(response, statusCode, {
      error: known ? error.message : "本地控制服务失败，请查看控制服务日志。",
      ...(error.code ? { code: error.code, legacy_code: error.legacyCode } : {}),
    });
  }
});

function currentUsageReport() {
  return readSnapshot(usageReportPath, emptyUsageReport());
}

function readSnapshot(path, fallback, select = (value) => value, key = "") {
  try {
    const info = statSync(path);
    const identity = `${info.dev || 0}:${info.ino || 0}:${info.size}:${info.mtimeMs}:${key}`;
    if (snapshotCache.get(path)?.identity === identity) return snapshotCache.get(path).value;
    // Release the stale snapshot before parsing its replacement within the bounded heap.
    snapshotCache.delete(path);
    const value = select(JSON.parse(readFileSync(path, "utf8")));
    snapshotCache.set(path, { identity, value });
    return value;
  } catch {
    return fallback;
  }
}

function emptyUsageReport(now = Date.now()) {
  const generatedAt = new Date(now).toISOString();
  const window = (id, durationMs) => ({ id, durationMs, generatedAt, byModel: [], byProject: [], bySession: [], byTask: [], totals: { usage: { input: 0, cachedInput: 0, output: 0 }, statistics: { average: null, p50: null, p95: null }, cost: null, costEstimation: "unestimable" }, modelContinuations: 0 });
  return { generatedAt, windows: { "5h": window("5h", 18_000_000), "24h": window("24h", 86_400_000), "7d": window("7d", 604_800_000) }, lifetime: { attribution: "estimated", method: "last_token_usage_by_task_lifecycle", bySession: [], byTask: [], totals: { id: "all", usage: { input: 0, cachedInput: 0, output: 0, reasoning: 0 }, totalTokens: 0, count: 0, attribution: "estimated" }, attributedTokenRatio: 0, missingTimestampEvents: 0 }, warnings: [], alerts: [], overall: { estimatedCredits: null, creditsEstimation: "unestimable", modelContinuations: 0, input: { average: null, p50: null, p95: null }, usage: { input: 0, cachedInput: 0, output: 0 } }, source: { mode: "snapshot_pending" } };
}

function taskSummary(task) {
  const summary = { ...task };
  for (const key of ["requirementResults", "verificationClaims", "reviewAttestations", "diagnosticObservations", "acceptanceRecords", "subjectHistory", "phaseEvents", "evidence", "changedFiles", "tests"]) delete summary[key];
  return { ...summary, estimateHistory: (task.estimateHistory || []).slice(-3) };
}

function metricSnapshotStatus(snapshotPath, healthPath, maxAgeMs) {
  const snapshot = inspectFile(snapshotPath);
  const health = readSnapshot(healthPath, { ok: null, lastRefreshError: "" });
  const snapshotAt = Date.parse(snapshot.generatedAt || "");
  const healthAt = Date.parse(health.heartbeatAt || health.updatedAt || "");
  const freshnessAt = Number.isFinite(healthAt) ? healthAt : snapshotAt;
  const ageMs = Number.isFinite(freshnessAt) ? Math.max(0, Date.now() - freshnessAt) : null;
  const refreshOk = health.refreshOk ?? health.ok;
  return {
    readable: snapshot.readable,
    stale: !snapshot.readable || ageMs === null || ageMs > maxAgeMs || refreshOk === false,
    ageMs,
    snapshotAgeMs: Number.isFinite(snapshotAt) ? Math.max(0, Date.now() - snapshotAt) : null,
    refreshOk,
    lastRefreshError: health.lastRefreshError || "",
    heartbeatAt: health.heartbeatAt || health.updatedAt || "",
    lastAttemptAt: health.lastAttemptAt || "",
    lastSuccessAt: health.lastSuccessAt || "",
    updatedAt: health.updatedAt || snapshot.generatedAt || "",
  };
}

server.listen(port, host, () => {
  console.log(`TaskCenter control server is listening on http://${host}:${port}.`);
});

function cancelLegacyAllowlistSetupTasks() {
  for (const task of loadTasks()) {
    if (task.requirementId !== "reflection:reflection-empty-allowlist") continue;
    if (!["planned", "in_progress", "blocked"].includes(task.status)) continue;
    recordTaskEvent({
      type: "task.update",
      event_id: `manual-resolve-empty-allowlist-${task.id}`,
      task_id: task.id,
      session_id: task.sessionId,
      status: "cancelled",
      current_step: "Session 白名单已配置；旧版误建的人工配置任务已自动结束。",
      next_action: "无需 Agent 执行；后续直接在本机页面管理白名单。",
    });
  }
}

function safeError(error) {
  return String(error instanceof Error ? error.message : error || "未知错误").replace(/\s+/g, " ").slice(0, 300);
}

function inspectFile(path, parseJson = false) {
  try {
    const stat = statSync(path);
    const mtime = new Date(stat.mtimeMs).toISOString();
    if (!parseJson) return { readable: true, exists: true, generatedAt: mtime };
    try {
      return { readable: true, exists: true, generatedAt: mtime, updatedAt: JSON.parse(readFileSync(path, "utf8")).updatedAt || mtime };
    } catch {
      return { readable: false, exists: true, generatedAt: mtime, updatedAt: mtime };
    }
  } catch {
    return { readable: false, exists: false, generatedAt: "", updatedAt: "" };
  }
}

function readTaskEvents(taskId) {
  const indexed = readSnapshot(taskEventIndexPath, [], (value) => value.byTask?.[taskId] || [], taskId);
  const recent = readTaskEventTail(taskId);
  const merged = new Map();
  for (const event of [...indexed, ...recent]) merged.set(event.event_id || `${event.type}:${event.recorded_at || event.created_at}`, event);
  return [...merged.values()];
}

function readTaskEventTail(taskId, maxBytes = 2 * 1024 * 1024) {
  let descriptor;
  try {
    const info = statSync(taskEventsPath);
    const start = Math.max(0, info.size - maxBytes);
    const buffer = Buffer.allocUnsafe(info.size - start);
    descriptor = openSync(taskEventsPath, "r");
    readSync(descriptor, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    const safeText = start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
    return safeText.split("\n").flatMap((line) => {
      if (!line.trim()) return [];
      try { const event = JSON.parse(line); return event.task_id === taskId ? [event] : []; } catch { return []; }
    });
  } catch {
    return [];
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function runSync() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, "sync-codex.mjs")], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `同步进程退出码 ${code}`));
        return;
      }
      try {
        const dashboard = JSON.parse(readFileSync(dashboardPath, "utf8"));
        resolve({
          syncing: false,
          generatedAt: dashboard.generatedAt,
          threadCount: dashboard.source?.threadCount ?? dashboard.threads?.length ?? 0,
          messageCount: dashboard.source?.messageCount ?? 0,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function syncNow() {
  if (syncing) return { syncing: true, message: "已有一次扫描正在执行，请稍候刷新看板。" };
  syncing = runSync();
  try {
    return await syncing;
  } finally {
    syncing = null;
  }
}

function verifyActionRequest(request) {
  const origin = request.headers.origin;
  if (!origin || !allowedOrigins.has(origin)) {
    throw new DispatchError(403, "请求来源不是本机 TaskCenter 页面。");
  }
  if (request.headers["x-taskcenter-action"] !== "delegate") {
    throw new DispatchError(403, "缺少 Session 投递确认标记。");
  }
  if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
    throw new DispatchError(415, "请求必须使用 JSON。");
  }
}

function validateInboxIds(ids) {
  if (!ids.length || ids.some((id) => typeof id !== "string" || !/^[A-Za-z0-9._-]{1,160}$/.test(id))) {
    throw new DispatchError(400, "Inbox 需求 ID 无效。");
  }
}

function validateInboxDecision(decision) {
  if (!["continue", "discard", "clear"].includes(decision)) {
    throw new DispatchError(400, "Inbox 决策无效。");
  }
}

function verifyTaskRequest(request) {
  // MCP/Hook 请求只允许本机客户端携带协议标记，不开放给浏览器跨域调用。
  const protocolTask = request.headers["x-taskcenter-task"] || request.headers["x-reqradar-task"];
  if (["mcp", "hook"].includes(protocolTask)) {
    if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
      throw new TaskLedgerError(415, "任务事件必须使用 JSON。");
    }
    return;
  }
  // 人工操作：需要浏览器来源和确认标记
  const origin = request.headers.origin;
  if (!origin || !allowedOrigins.has(origin)) {
    throw new TaskLedgerError(403, "请求来源不是本机 TaskCenter 页面。");
  }
  if (request.headers["x-taskcenter-action"] !== "delegate") {
    throw new TaskLedgerError(403, "缺少任务操作确认标记。");
  }
  if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
    throw new TaskLedgerError(415, "任务事件必须使用 JSON。");
  }
}

function requireRegisteredReuseSession(input) {
  const sessionId = String(input?.session_id || "").trim();
  const workspace = String(input?.workspace || "").trim();
  const projectId = String(input?.project_id || "").trim();
  if (!sessionId || !workspace || !projectId) {
    throw new TaskReuseAdvisorError(400, "复用请求缺少 session_id、workspace 或 project_id。");
  }
  const registry = loadSessionRegistry();
  const canonical = canonicalSessionId(sessionId);
  const session = registry[canonical] || registry[sessionId];
  if (!session) throw new TaskReuseAdvisorError(409, "复用请求 Session 尚未登记。");
  if (resolve(session.workspace || "") !== resolve(workspace)) {
    throw new TaskReuseAdvisorError(403, "复用请求 workspace 与已登记 Session 不一致。");
  }
  const registeredProjectId = String(session.projectId || session.project_id || "").trim();
  if (registeredProjectId && registeredProjectId !== projectId) {
    throw new TaskReuseAdvisorError(403, "复用请求 project_id 与已登记 Session 不一致。");
  }
  return {
    registry,
    projectIdentity: {
      status: registeredProjectId ? "registered" : "unknown",
      project_id: registeredProjectId || "unknown",
    },
  };
}

function verifyBoundMcpRequest(request) {
  verifyTaskRequest(request);
  if (request.headers["x-taskcenter-mcp-token"] !== localMcpToken) {
    throw new TaskLedgerError(403, "MCP 运行时身份凭据无效。");
  }
}

function loadOrCreateLocalMcpToken() {
  if (existsSync(localMcpTokenPath)) {
    const metadata = lstatSync(localMcpTokenPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("MCP 运行时身份凭据必须是普通文件。");
    }
    if ((metadata.mode & 0o077) !== 0) chmodSync(localMcpTokenPath, 0o600);
    const token = readFileSync(localMcpTokenPath, "utf8").trim();
    if (token.length >= 64) return token;
  }
  mkdirSync(dirname(localMcpTokenPath), { recursive: true });
  const token = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
  const temporaryPath = `${localMcpTokenPath}.tmp`;
  writeFileSync(temporaryPath, `${token}\n`, { mode: 0o600 });
  renameSync(temporaryPath, localMcpTokenPath);
  return token;
}

function verifyCoreRequest(request) {
  if (!['mcp', 'core', 'adapter'].includes(request.headers['x-taskcenter-task'])) {
    throw new TaskLedgerError(403, "核心事件只接受本机 TaskCenter 客户端。");
  }
  if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
    throw new TaskLedgerError(415, "核心事件必须使用 JSON。");
  }
}

function verifyAcceptanceRequest(request) {
  if (!acceptanceToken) throw new TaskLedgerError(503, "独立验收 API 尚未配置 TASKCENTER_ACCEPTANCE_TOKEN。");
  if (request.headers["x-taskcenter-acceptance-token"] !== acceptanceToken) throw new TaskLedgerError(403, "验收身份未获 Workspace Policy 入口授权。");
  if (!String(request.headers["content-type"] || "").startsWith("application/json")) throw new TaskLedgerError(415, "验收报告必须使用 JSON。");
}

function verifyContextAcceptanceRequest(request) {
  if (!contextAcceptanceToken) throw new TaskLedgerError(503, "可信 Context 验收同步尚未配置。");
  if (request.headers["x-taskcenter-context-token"] !== contextAcceptanceToken) {
    throw new TaskLedgerError(403, "最终验收只接受可信 Context 同步。");
  }
  if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
    throw new TaskLedgerError(415, "Context 验收同步必须使用 JSON。");
  }
}

function verifyManualTaskAction(request) {
  const origin = request.headers.origin;
  if (!origin || !allowedOrigins.has(origin)) {
    throw new TaskLedgerError(403, "人工操作请求来源不是本机 TaskCenter 页面。");
  }
  if (request.headers["x-taskcenter-action"] !== "delegate") {
    throw new TaskLedgerError(403, "缺少人工操作确认标记。");
  }
  if (!String(request.headers["content-type"] || "").startsWith("application/json")) {
    throw new TaskLedgerError(415, "人工操作请求必须使用 JSON。");
  }
}

function applyManualTaskAction(taskId, action, reason = "", expectedAt = "", estimatedEffortMinutes = undefined) {
  const tasks = loadTasks();
  const task = tasks.find((item) => item.id === taskId);
  if (!task) {
    throw new TaskLedgerError(404, "任务不存在。");
  }
  if (action === "verify" && task.status !== "done_claimed") {
    throw new TaskLedgerError(409, "只有已声明完成的任务可以验收。");
  }
  if (action === "verify" && task.contractVersion === "v2") {
    throw new TaskLedgerError(409, "v2 任务必须通过独立授权的通用验收 API 完成最终验收。");
  }
  if (action === "archive" && !["done_claimed", "verified", "cancelled"].includes(task.status)) {
    throw new TaskLedgerError(409, "只有已完成、已验收或已取消任务可以归档。");
  }
  const effortMinutes = Number(estimatedEffortMinutes);
  const hasEffort = Number.isFinite(effortMinutes) && effortMinutes > 0;
  if (action === "schedule" && !expectedAt && !hasEffort) {
    throw new TaskLedgerError(400, "至少填写截止时间或预计有效工时。");
  }
  if (action === "schedule" && expectedAt && !Number.isFinite(Date.parse(expectedAt))) {
    throw new TaskLedgerError(400, "截止时间必须是可解析的 ISO 时间。");
  }
  if (action === "reject" && !["done_claimed", "verified"].includes(task.status)) {
    throw new TaskLedgerError(409, "只有已完成或历史已验收任务可以打回。");
  }
  const event = {
    event_id: `manual-${randomUUID()}`,
    type: ["remove", "verify", "reject", "archive", "unarchive"].includes(action) ? "task.review" : "task.update",
    task_id: taskId,
    session_id: task.sessionId,
    status: action === "start" ? "in_progress" : action === "block" ? "blocked" : action === "done" ? "done_claimed" : action === "cancel" ? "cancelled" : action === "remove" ? "removed" : action === "verify" ? "verified" : action === "reject" ? "in_progress" : undefined,
    archived_at: action === "archive" ? new Date().toISOString() : action === "unarchive" ? "__UNARCHIVE__" : undefined,
    due_at: action === "schedule" && expectedAt ? expectedAt : undefined,
    estimated_effort_ms: action === "schedule" && hasEffort ? Math.round(effortMinutes * 60_000) : undefined,
    estimate_reason: action === "schedule" ? String(reason || "人工调整估时").slice(0, 1_000) : undefined,
    review_reason: action === "reject" ? String(reason || "人工打回，需补充证据").slice(0, 1_000) : action === "verify" ? String(reason || "人工验收通过").slice(0, 1_000) : "",
    reviewed_at: ["verify", "reject"].includes(action) ? new Date().toISOString() : "",
    created_at: new Date().toISOString(),
  };
  const result = recordTaskEvent(event);
  return { event, task: result.task };
}

async function readJsonBody(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 16_384) {
      throw new DispatchError(413, "请求内容过大。");
    }
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new DispatchError(400, "请求 JSON 无效。");
  }
}

function setCors(request, response) {
  const origin = request.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-TaskCenter-Action");
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function loadDispatches() {
  if (!existsSync(dispatchesPath)) return [];
  try {
    const value = JSON.parse(readFileSync(dispatchesPath, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function loadJsonObject(path) {
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function loadSessionSelection() {
  return readSessionAllowlist(sessionSelectionPath);
}

function loadReflectionState() {
  if (!existsSync(reflectionProposalsPath)) return emptyReflectionState();
  try {
    const value = JSON.parse(readFileSync(reflectionProposalsPath, "utf8"));
    if (value?.version === 1 && Array.isArray(value.proposals)) return value;
  } catch {
    // A partial local file must not widen the data boundary or invent proposals.
  }
  return emptyReflectionState();
}

function persistJsonObject(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

function verifyRequirementExists(requirementId) {
  const dashboard = JSON.parse(readFileSync(dashboardPath, "utf8"));
  if (!(dashboard.requirements || []).some((item) => item.id === requirementId)) {
    throw new DispatchError(404, "需求不存在或已被重新整理。");
  }
}

function loadDashboard() {
  try {
    return JSON.parse(readFileSync(dashboardPath, "utf8"));
  } catch {
    return { source: {}, threads: [] };
  }
}

function availableSessionIds() {
  const dashboard = loadDashboard();
  const threads = dashboard.source?.availableThreads ?? dashboard.threads ?? [];
  return threads.flatMap((thread) => [thread.id, ...(thread.sessionIds ?? [])]).filter(Boolean);
}

function loadSessionTitles() {
  const dashboard = loadDashboard();
  const fallback = (dashboard.source?.availableThreads ?? dashboard.threads ?? [])
    .filter((thread) => thread.titleSource === "codex")
    .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
  return [...fallback, ...(dashboard.source?.sessionTitles ?? [])]
    .filter((item) => item.id && item.title);
}

function latestTimestamp(...values) {
  return values.filter(Boolean).sort((left, right) => timestamp(left) - timestamp(right)).at(-1) || "";
}

function timestamp(value) {
  return Date.parse(value || "") || 0;
}

function shutdown() {
  clearInterval(reconciliationTimer);
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
