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
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  DispatchError,
  loadDispatchTarget,
} from "./dispatch-core.mjs";
import { ModelRoleConfigError, updateOptionalAstraPolicy } from "./model-role-config.mjs";
import {
  defaultSessionsRoot,
  inspectSessionState,
  resumeSession,
} from "./session-cli.mjs";
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
  reconcileTasks,
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
  TaskLedgerError,
} from "./task-ledger.mjs";
import {
  loadTaskReuseDecisions,
  recordTaskReuseDecision,
  summarizeTaskReuseDecisions,
  taskReuseCheck,
  TaskReuseAdvisorError,
} from "./task-reuse-advisor.mjs";
import { syncContextCompletionFromUi, syncContextEvent } from "./context-bridge.mjs";
import {
  beginReflectionExecution,
  buildReflectionExecutionPrompt,
  decideReflectionProposal,
  emptyReflectionState,
  generateReflection,
  hydrateReflectionState,
  reconcileReflectionSessionSelection,
  updateReflectionExecution,
} from "./reflection-engine.mjs";
import { normalizeSessionAllowlist, readSessionAllowlist, sessionIdPattern, updateSessionAllowlist } from "./session-allowlist.mjs";
import {
  claimDelegation,
  DelegationError,
  delegationsPath,
  grantDelegation,
  listDelegations,
  reportDelegation,
  resolveDelegation,
  revokeDelegation,
  touchDelegation,
} from "./delegation-store.mjs";
import {
  RoutingControlError,
  routingControlPath,
  routingHealth,
  routingResult,
  routingRoles,
  routingSelect,
} from "./routing-control.mjs";
import { recommendSessionLifecycle } from "./session-lifecycle.mjs";
import { buildGovernanceMetrics } from "./governance-metrics.mjs";
import { taskMatchesBucket, taskMatchesQuery, taskPresentation } from "../lib/task-workspace.mjs";

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
const taskEventIndexPath = resolve(process.env.TASKCENTER_TASK_EVENT_INDEX_PATH || join(projectRoot, ".local", "runtime", "task-event-index.json"));
const usageHealthPath = resolve(process.env.TASKCENTER_USAGE_HEALTH_PATH || join(projectRoot, ".local", "runtime", "usage-worker-health.json"));
const governanceHealthPath = resolve(process.env.TASKCENTER_GOVERNANCE_HEALTH_PATH || join(projectRoot, ".local", "runtime", "governance-worker-health.json"));
const host = "127.0.0.1";
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
const activeThreadDispatches = new Set();
let lastDispatchAt = 0;
let processingQueue = false;
let syncing = null;
const snapshotCache = new Map();
const localMcpToken = loadOrCreateLocalMcpToken();

mkdirSync(dirname(dispatchesPath), { recursive: true });
migrateLegacyDispatches();
const startupContextReconciliation = reconcileContextShadowTasks();
if (startupContextReconciliation.reconciled.length) {
  console.log(`[TaskCenter] 已收敛 ${startupContextReconciliation.reconciled.length} 条 Context 影子任务。`);
}
const queueTimer = setInterval(() => void processQueue(), 5_000);
queueTimer.unref();
void processQueue();

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
      sendJson(response, 200, { ok: true, dryRun, syncing: Boolean(syncing), control: { uptimeSeconds: Math.round(process.uptime()), rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal, externalBytes: memory.external, arrayBuffersBytes: memory.arrayBuffers }, dashboard, ledger: { readable: inspectFile(taskLedgerPath).readable, eventsReadable: inspectFile(taskEventsPath).readable, delegationsReadable: inspectFile(delegationsPath).readable, routingControlReadable: inspectFile(routingControlPath).readable }, metrics: { usage: metricSnapshotStatus(usageReportPath, usageHealthPath, 120_000), governance: metricSnapshotStatus(governanceMetricsPath, governanceHealthPath, 15_000) }, routing: { models: routingHealth(), roles: routingRoles() }, watcher: { ...heartbeat, healthy: watcherFresh } });
      return;
    }
    if (request.method === "POST" && request.url === "/sync") {
      verifyActionRequest(request);
      sendJson(response, syncing ? 202 : 200, await syncNow());
      return;
    }
    if (request.method === "GET" && request.url === "/dashboard") {
      sendJson(response, 200, loadDashboard());
      return;
    }
    if (request.method === "GET" && request.url === "/usage-report") {
      sendJson(response, 200, { ...currentUsageReport(), snapshotStatus: metricSnapshotStatus(usageReportPath, usageHealthPath, 120_000) });
      return;
    }
    if (request.method === "GET" && request.url === "/governance-metrics") {
      sendJson(response, 200, { ...readSnapshot(governanceMetricsPath, buildGovernanceMetrics({ usageReport: currentUsageReport() })), snapshotStatus: metricSnapshotStatus(governanceMetricsPath, governanceHealthPath, 15_000) });
      return;
    }
    const lifecycleMatch = request.method === "GET" ? request.url?.match(/^\/session-lifecycle(?:\?session_id=([^&]+))?$/) : null;
    if (lifecycleMatch) {
      const sessionId = lifecycleMatch[1] ? decodeURIComponent(lifecycleMatch[1]) : "";
      const tasks = loadVisibleTasks().filter((task) => !sessionId || task.sessionId === sessionId);
      const currentTask = tasks.filter((task) => ["planned", "in_progress", "blocked"].includes(task.status)).at(-1) || tasks.at(-1) || null;
      const workspaces = new Set(tasks.map((task) => task.workspace).filter(Boolean));
      const usage = currentUsageReport();
      sendJson(response, 200, recommendSessionLifecycle({
        usage: {
          ...usage,
          alerts: (usage.alerts || []).filter((alert) => !sessionId || alert.sessionId === sessionId),
          projectChanged: workspaces.size > 1,
        },
        tasks,
        currentTask,
      }));
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
    if (request.method === "GET" && request.url === "/session-status") {
      if (reconcileLiveSessions) reconcileTasks(availableSessionIds());
      sendJson(response, 200, { sessions: getSessionStatuses(availableSessionIds(), loadVisibleTasks()) });
      return;
    }
    if (request.method === "POST" && request.url === "/sessions/l0-audit") {
      verifyTaskRequest(request);
      const body = await readJsonBody(request);
      const audit = recordSessionL0Audit(String(body.session_id || ""), String(body.workspace || ""));
      sendJson(response, 200, { accepted: true, l0Audit: audit });
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
      if (reconcileLiveSessions) reconcileTasks(availableSessionIds());
        const tasks = loadVisibleTasks().slice().reverse();
        if (!url.searchParams.size) {
          sendJson(response, 200, { tasks: withDelegations(tasks) });
          return;
        }
        const sessionRegistry = loadSessionRegistry();
        const presentedTasks = tasks.map((task) => taskPresentation({ ...task, workspace: task.workspace || sessionRegistry[task.sessionId]?.workspace || "" }));
        const project = url.searchParams.get("project") || "all";
        const bucket = url.searchParams.get("bucket") || "all";
        const query = url.searchParams.get("query") || "";
        const projectTasks = presentedTasks.filter((task) => project === "all" || task.project.id === project);
        const filteredTasks = projectTasks.filter((task) => taskMatchesQuery(task, query) && taskMatchesBucket(task, bucket));
        const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
        const pageSize = Math.min(500, Math.max(1, Number.parseInt(url.searchParams.get("page_size") || "40", 10) || 40));
        const start = (page - 1) * pageSize;
        const pageTasks = withDelegations(filteredTasks.slice(start, start + pageSize));
        const actionCounts = Object.fromEntries(["attention", "in_progress", "awaiting_verification", "awaiting_acceptance", "blocked"].map((name) => [name, projectTasks.filter((task) => taskMatchesBucket(task, name)).length]));
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
        delegations: listDelegations(),
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
    if (request.method === "GET" && request.url === "/routing/health") {
      sendJson(response, 200, { models: routingHealth(), roles: routingRoles() });
      return;
    }
    if (request.method === "GET" && request.url === "/routing/optional-astra-policy") {
      const usage = currentUsageReport().rate_limits?.primary?.used_percent;
      const policy = routingRoles().optional_astra_policy;
      sendJson(response, 200, { policy, used_percent: Number.isFinite(Number(usage)) ? Number(usage) : null, optional_enhancement_allowed: Number.isFinite(Number(usage)) && Number(usage) <= policy.threshold_percent });
      return;
    }
    if (request.method === "POST" && request.url === "/routing/optional-astra-policy") {
      verifyTaskRequest(request);
      const body = await readJsonBody(request);
      const policy = updateOptionalAstraPolicy(body, "local-ui");
      sendJson(response, 200, { accepted: true, policy });
      return;
    }
    if (request.method === "POST" && request.url === "/routing/select") {
      verifyTaskRequest(request);
      const body = await readJsonBody(request);
      const task = loadTasks().find((item) => item.id === body.task_id);
      if (!task || !["planned", "in_progress", "blocked"].includes(task.status)) throw new RoutingControlError(409, "routing_select 要求存在活跃正式任务。");
      const sessionId = canonicalSessionId(task.sessionId);
      const sessionModel = loadSessionRegistry()[sessionId]?.model;
      const orchestratorModel = sessionModel && sessionModel !== "unknown"
        ? sessionModel
        : task.model && task.model !== "unknown" ? task.model : "";
      if (!orchestratorModel) throw new RoutingControlError(409, "任务所属 Session 未登记当前主模型；请重新登记 Session 后再选择路由。");
      const executionModelPolicy = task.executionModelPolicy || { mode: "auto" };
      if (executionModelPolicy.mode === "quota_preferred" && body.preferred_model && body.preferred_model !== executionModelPolicy.preferred_model) {
        throw new RoutingControlError(409, "routing_select 的 preferred_model 与任务持久化策略不一致。");
      }
      const quotaSnapshot = executionModelPolicy.quota_limit_id
        ? currentUsageReport().rate_limits?.by_limit_id?.[executionModelPolicy.quota_limit_id] || null
        : null;
      const result = routingSelect({ ...body, orchestrator_model: orchestratorModel, execution_model_policy: executionModelPolicy, quota_snapshot: quotaSnapshot });
      recordRoutingAudit(result.auditEvents, task);
      sendJson(response, result.idempotent ? 200 : 201, { accepted: true, ...result, auditEvents: undefined });
      return;
    }
    if (request.method === "POST" && request.url === "/routing/result") {
      verifyTaskRequest(request);
      const body = await readJsonBody(request);
      const result = routingResult(body);
      const task = loadTasks().find((item) => item.id === result.route.task_id);
      if (!task) throw new RoutingControlError(404, "路由关联任务不存在。");
      recordRoutingAudit(result.auditEvents, task);
      sendJson(response, 200, { accepted: true, ...result, auditEvents: undefined });
      return;
    }
    const delegationResolve = request.method === "GET" ? request.url?.match(/^\/delegations\/resolve\?session_id=([^&]+)&workspace=(.+)$/) : null;
    if (delegationResolve) {
      const sessionId = decodeURIComponent(delegationResolve[1]);
      const workspace = decodeURIComponent(delegationResolve[2]);
      const delegation = resolveDelegation(sessionId, workspace);
      const task = delegation ? loadTasks().find((item) => item.id === delegation.taskId) : null;
      const active = Boolean(task && ["planned", "in_progress", "blocked"].includes(task.status));
      sendJson(response, 200, { delegation: active ? delegation : null, task: active ? task : null });
      return;
    }
    if (request.method === "POST" && request.url === "/delegations/grant") {
      verifyTaskRequest(request);
      const body = await readJsonBody(request);
      const task = loadTasks().find((item) => item.id === body.task_id);
      const parentSession = getSessionStatuses(availableSessionIds(), loadVisibleTasks()).find((item) => item.sessionId === body.parent_session_id);
      if (!parentSession || parentSession.status !== "registered") throw new DelegationError(409, "主任务 Session 必须已登记。");
      const result = grantDelegation(body, task ? { ...task, workspace: task.workspace || parentSession.workspace } : task);
      sendJson(response, result.idempotent ? 200 : 201, { accepted: true, ...result });
      return;
    }
    if (request.method === "POST" && request.url === "/delegations/claim") {
      verifyTaskRequest(request);
      const body = await readJsonBody(request);
      const session = getSessionStatuses(availableSessionIds(), loadVisibleTasks()).find((item) => item.sessionId === body.session_id);
      const result = claimDelegation(body, session);
      sendJson(response, 200, { accepted: true, ...result });
      return;
    }
    if (request.method === "POST" && request.url === "/delegations/report") {
      verifyTaskRequest(request);
      const body = await readJsonBody(request);
      const result = reportDelegation(body);
      sendJson(response, 200, { accepted: true, ...result });
      return;
    }
    if (request.method === "POST" && request.url === "/delegations/touch") {
      verifyTaskRequest(request);
      const body = await readJsonBody(request);
      sendJson(response, 200, { accepted: true, ...touchDelegation(body) });
      return;
    }
    if (request.method === "POST" && request.url === "/delegations/revoke") {
      verifyTaskRequest(request);
      const body = await readJsonBody(request);
      sendJson(response, 200, { accepted: true, ...revokeDelegation(body) });
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
    const reflectionExecuteMatch = request.method === "POST"
      ? request.url?.match(/^\/reflections\/([A-Za-z0-9._-]{1,160})\/execute$/)
      : null;
    if (reflectionExecuteMatch) {
      verifyManualTaskAction(request);
      const body = await readJsonBody(request);
      const mode = String(body.mode || "new_session");
      const requestId = String(body.requestId || "");
      const targetSessionId = String(body.threadId || "");
      if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new DispatchError(400, "改进任务请求 ID 无效。");
      if (!["new_session", "existing_session"].includes(mode)) throw new DispatchError(400, "改进任务执行模式无效。");
      if (mode === "existing_session" && !/^[0-9a-f-]{36}$/i.test(targetSessionId)) {
        throw new DispatchError(400, "目标 Session ID 无效。");
      }
      if (mode === "existing_session" && !availableSessionIds().includes(targetSessionId)) {
        throw new DispatchError(409, "目标 Session 不在当前本机会话列表中。");
      }
      const currentState = loadReflectionState();
      const currentProposal = currentState.proposals.find((proposal) => proposal.id === reflectionExecuteMatch[1]);
      const existingReplay = currentProposal?.executions?.find((execution) => execution.requestId === requestId);
      if (existingReplay) {
        sendJson(response, 200, hydrateReflectionState(currentState, loadVisibleTasks(), dispatches));
        return;
      }
      if (Date.now() - lastDispatchAt < 5_000) throw new DispatchError(429, "发送过于频繁，请稍后再试。");
      const executionId = randomUUID();
      const execution = {
        id: executionId,
        requestId,
        taskId: `task-reflection-${executionId}`,
        dispatchId: randomUUID(),
        mode,
        sessionId: mode === "existing_session" ? targetSessionId : "",
        status: "preparing",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        error: "",
      };
      let started;
      try {
        started = beginReflectionExecution(currentState, reflectionExecuteMatch[1], execution, loadVisibleTasks());
      } catch (error) {
        throw new DispatchError(409, error instanceof Error ? error.message : "改进任务无法启动。");
      }
      const proposal = started.proposal;
      const prompt = buildReflectionExecutionPrompt(proposal, execution.taskId);
      const record = {
        id: execution.dispatchId,
        requirementId: `reflection:${proposal.id}`,
        requirementTitle: proposal.title,
        proposalId: proposal.id,
        reflectionExecutionId: execution.id,
        taskId: execution.taskId,
        contextThreadId: targetSessionId,
        threadId: mode === "new_session" ? "" : targetSessionId,
        threadTitle: mode === "new_session" ? `改进任务：${proposal.title}` : `改进：${proposal.title}`,
        mode,
        status: dryRun ? "dry_run" : "preparing",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        error: "",
      };
      persistJsonObject(reflectionProposalsPath, started.state);
      dispatches.push(record);
      persistDispatches();
      lastDispatchAt = Date.now();

      try {
        if (dryRun) {
          finishDispatch(record, "dry_run", "演练模式：未创建正式任务，也未启动或投递 Session。");
        } else if (mode === "existing_session") {
          ensureReflectionTask(proposal, execution, targetSessionId);
          record.pendingPrompt = prompt;
          record.workingDirectory = projectRoot;
          const sessionState = inspectSessionState(record.threadId, sessionsRoot);
          if (sessionState.busy || activeThreadDispatches.has(record.threadId)) {
            finishDispatch(record, "queued", "目标 Session 正忙，正式任务已创建，空闲后自动投递。", false);
          } else {
            void startExistingDispatch(record);
          }
        } else {
          const result = await sendToCodex(mode, "", prompt, projectRoot, {
            onThreadStarted: async (sessionId) => {
              record.threadId = sessionId;
              ensureReflectionTask(proposal, execution, sessionId);
              updateReflectionExecutionState(record, { sessionId, status: "running" });
              persistDispatches();
            },
          });
          record.threadId = result.threadId;
          finishDispatch(record, "delivered", "新 Session 已启动，正式改进任务已创建并开始执行。");
        }
      } catch (error) {
        const reason = safeError(error);
        finishDispatch(record, "failed", `改进任务派发失败：${reason}`);
        blockReflectionTask(record, reason);
        throw new DispatchError(502, `改进任务未能启动：${reason}`);
      }
      sendJson(response, dryRun || ["queued", "preparing", "delivering", "running"].includes(record.status) ? 202 : 200, hydrateReflectionState(loadReflectionState(), loadVisibleTasks(), dispatches));
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
      const workspace = task.workspace || loadSessionRegistry()[task.sessionId]?.workspace || "";
      sendJson(response, 200, { task: taskPresentation({ ...withDelegations([task])[0], workspace }) });
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
      sendJson(response, body.type === "task.create" && !result.idempotent ? 201 : 200, { accepted: true, idempotent: Boolean(result.idempotent), event: result.event, task: result.task });
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
      const body = await readJsonBody(request);
      if (body.type === "task.review" || body.status === "verified" || String(body.type || "").startsWith("acceptance.")) {
        throw new TaskLedgerError(403, "人工审核必须通过本机任务操作入口完成。");
      }
      const sessionIds = availableSessionIds();
      if (reconcileLiveSessions) reconcileTasks(sessionIds);
      const result = recordTaskEvent(body, {
        ...(reconcileLiveSessions ? { availableSessionIds: sessionIds } : {}),
        requireRegistered: true,
      });
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
    const cancelMatch = request.method === "POST"
      ? request.url?.match(/^\/dispatches\/([0-9a-f-]+)\/cancel$/i)
      : null;
    if (cancelMatch) {
      verifyActionRequest(request);
      const record = dispatches.find((item) => item.id === cancelMatch[1]);
      if (!record) throw new DispatchError(404, "找不到这条投递记录。");
      if (record.status !== "queued") {
        throw new DispatchError(409, "只有仍在等待的队列任务可以取消；已经开始执行的任务不能强制中断。");
      }
      finishDispatch(record, "cancelled", "已人工取消自动投递，可复制任务信息后手动发送。");
      cancelReflectionTask(record);
      sendJson(response, 200, { dispatch: record });
      return;
    }
    if (request.method === "POST" && request.url === "/dispatch") {
      verifyActionRequest(request);
      const body = await readJsonBody(request);
      const mode = String(body.mode || "new_session");
      if (!["new_session", "existing_session"].includes(mode)) {
        throw new DispatchError(400, "投递模式无效。");
      }
      const target = loadDispatchTarget(
        dashboardPath,
        String(body.requirementId || ""),
        String(body.threadId || ""),
      );
      const duplicate = dispatches.find(
        (item) =>
          item.requirementId === body.requirementId &&
          (item.contextThreadId || item.sourceThreadId || item.threadId) === body.threadId &&
          item.mode === mode &&
          ["queued", "delivering", "running"].includes(item.status),
      );
      if (duplicate) {
        throw new DispatchError(409, "这条需求正在投递到该 Session，请稍候。");
      }
      if (Date.now() - lastDispatchAt < 5_000) {
        throw new DispatchError(429, "发送过于频繁，请稍后再试。");
      }
      lastDispatchAt = Date.now();
      const record = {
        id: randomUUID(),
        requirementId: body.requirementId,
        requirementTitle: target.requirement.title,
        contextThreadId: body.threadId,
        threadId: mode === "new_session" ? "" : body.threadId,
        threadTitle: mode === "new_session"
          ? `新任务：${target.requirement.title}`
          : target.thread.title,
        mode,
        status: dryRun ? "dry_run" : "delivering",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        error: "",
      };
      dispatches.push(record);
      persistDispatches();
      if (!dryRun) {
        try {
          if (mode === "existing_session") {
            record.pendingPrompt = target.prompt;
            record.workingDirectory = target.cwd;
            const state = inspectSessionState(record.threadId, sessionsRoot);
            if (state.busy || activeThreadDispatches.has(record.threadId)) {
              const reason = state.busy
                ? `目标 Session 正在处理 ${state.activeTurns.length} 个 turn`
                : "同一 Session 已有一条 TaskCenter 消息正在投递";
              finishDispatch(record, "queued", `${reason}，完成后自动投递。`, false);
            } else {
              void startExistingDispatch(record);
            }
          } else {
            const result = await sendToCodex(mode, record.threadId, target.prompt, target.cwd);
            record.threadId = result.threadId;
            finishDispatch(record, "delivered");
          }
        } catch (error) {
          const reason = safeError(error);
          finishDispatch(record, "failed", `投递失败：${reason}`);
          throw new DispatchError(502, `消息未能投递到目标 Session：${reason}`);
        }
      }
      sendJson(response, dryRun || ["queued", "delivering", "running"].includes(record.status) ? 202 : 200, { dispatch: record });
      return;
    }
    sendJson(response, 404, { error: "接口不存在。" });
  } catch (error) {
    const known = error instanceof DispatchError || error instanceof TaskLedgerError || error instanceof DelegationError || error instanceof RoutingControlError || error instanceof TaskReuseAdvisorError || error instanceof ModelRoleConfigError;
    const statusCode = known ? error.statusCode : 500;
    if (!known) {
      console.error("TaskCenter control error:", safeError(error));
    }
    sendJson(response, statusCode, {
      error: known ? error.message : "本地 Session 投递服务失败，请查看控制服务日志。",
    });
  }
});

function recordRoutingAudit(events, task) {
  for (const event of events || []) {
    recordTaskEvent({
      ...event,
      session_id: task.sessionId,
      agent: task.agent,
      provider: task.provider,
      model: task.model,
      workspace: task.workspace,
    });
  }
}

function currentUsageReport() {
  return readSnapshot(usageReportPath, emptyUsageReport());
}

function readSnapshot(path, fallback) {
  try {
    const info = statSync(path);
    const identity = `${info.dev || 0}:${info.ino || 0}:${info.size}:${info.mtimeMs}`;
    const cached = snapshotCache.get(path);
    if (cached?.identity === identity) return cached.value;
    const value = JSON.parse(readFileSync(path, "utf8"));
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

function withDelegations(tasks) {
  const byTask = new Map();
  for (const delegation of listDelegations()) {
    const list = byTask.get(delegation.taskId) || [];
    list.push(delegation);
    byTask.set(delegation.taskId, list);
  }
  return tasks.map((task) => ({ ...task, cliRuns: byTask.get(task.id) || [] }));
}

function taskSummary(task) {
  const summary = { ...task };
  for (const key of ["requirementResults", "verificationClaims", "reviewAttestations", "diagnosticObservations", "acceptanceRecords", "subjectHistory", "phaseEvents", "evidence", "changedFiles", "tests"]) delete summary[key];
  return { ...summary, estimateHistory: (task.estimateHistory || []).slice(-3), routingHistory: (task.routingHistory || []).slice(-3), cliRuns: (task.cliRuns || []).map(compactDelegationRun) };
}

function compactDelegationRun(run) {
  return Object.fromEntries(["id", "status", "delegateSessionId", "executorModel", "scope", "toolCalls", "completedAt"].flatMap((key) => run[key] === undefined ? [] : [[key, run[key]]]));
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

async function sendToCodex(mode, threadId, prompt, workingDirectory, hooks = {}) {
  const moduleName = process.env.TASKCENTER_CODEX_SDK_MODULE || "@openai/codex-sdk";
  const moduleSpecifier = isAbsolute(moduleName) ? pathToFileURL(moduleName).href : moduleName;
  const { Codex } = await import(moduleSpecifier);
  const codex = new Codex();
  const options = {
    workingDirectory: validCwd(workingDirectory),
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
  };
  const thread = mode === "new_session"
    ? codex.startThread(options)
    : codex.resumeThread(threadId, options);
  const { events } = await thread.runStreamed(prompt);
  const iterator = events[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) throw new Error("Codex SDK 未返回任务启动事件");
  if (first.value?.type === "error" || first.value?.type === "turn.failed") {
    throw new Error(first.value.message || "目标 Session 拒绝接收消息");
  }
  const startedThreadId = first.value?.type === "thread.started"
    ? first.value.thread_id
    : threadId;
  if (mode === "new_session" && !startedThreadId) {
    throw new Error("Codex SDK 未返回新 Session ID");
  }
  await hooks.onThreadStarted?.(startedThreadId);
  void drainDelegation(iterator);
  return { threadId: startedThreadId };
}

async function drainDelegation(iterator) {
  try {
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      if (next.value?.type === "error" || next.value?.type === "turn.failed") {
        console.error("TaskCenter delegated turn failed after delivery:", safeError(next.value.message));
      }
    }
  } catch (error) {
    console.error("TaskCenter delegated stream failed after delivery:", safeError(error));
  }
}

function finishDispatch(record, status, error, clearPending = true) {
  record.status = status;
  delete record.pid;
  if (clearPending) {
    delete record.pendingPrompt;
    delete record.workingDirectory;
  }
  record.error = String(error || "").slice(0, 500);
  record.updatedAt = new Date().toISOString();
  persistDispatches();
  if (record.proposalId && record.reflectionExecutionId) {
    updateReflectionExecutionState(record, {
      sessionId: record.threadId || "",
      status,
      error: record.error,
      updatedAt: record.updatedAt,
    });
  }
}

function validCwd(candidate) {
  if (candidate && existsSync(candidate)) return candidate;
  throw new Error("解析出的项目工作目录已不存在，请重新同步看板。");
}

async function startExistingDispatch(record) {
  if (activeThreadDispatches.has(record.threadId)) return;
  activeThreadDispatches.add(record.threadId);
  finishDispatch(record, "delivering", "", false);
  try {
    await resumeSession({
      threadId: record.threadId,
      prompt: record.pendingPrompt,
      workingDirectory: validCwd(record.workingDirectory),
      sessionsRoot,
      onStarted: () => finishDispatch(record, "running", "消息已写入原 Session，Codex 正在处理。", false),
    });
    finishDispatch(record, "completed", "原 Session 已完成本次 turn。");
  } catch (error) {
    const reason = safeError(error);
    finishDispatch(record, "failed", `投递失败：${reason}`);
    blockReflectionTask(record, reason);
  } finally {
    activeThreadDispatches.delete(record.threadId);
  }
}

function ensureReflectionTask(proposal, execution, sessionId) {
  const planningAcceptance = proposal.kind === "planning_quality" ? [
    "retrospective 必须记录估时偏差原因分类及其证据",
    "对当前 Session 可控的活跃逾期任务更新 expected_at，或将过大范围拆成可独立验收任务",
  ] : [];
  const registration = recordTaskEvent({
    type: "session.register",
    event_id: `reflection-register-${execution.id}`,
    session_id: sessionId,
    agent: "codex",
    provider: "openai",
    model: "unknown",
    workspace: projectRoot,
  });
  const created = recordTaskEvent({
    type: "task.create",
    event_id: `reflection-create-${execution.id}`,
    task_id: execution.taskId,
    requirement_id: `reflection:${proposal.id}`,
    session_id: sessionId,
    agent: "codex",
    provider: "openai",
    model: "unknown",
    workspace: projectRoot,
    title: `改进：${proposal.title}`,
    goal: proposal.recommendation,
    status: "in_progress",
    priority: "P1",
    plan: [
      "核对反思提案的聚合证据与当前实现",
      proposal.recommendation,
      "运行与风险相称的验证并提交 evidence",
      "上报 done_claimed，后续通过再次反思确认效果",
    ],
    acceptance_criteria: [
      proposal.recommendation,
      ...planningAcceptance,
      "上报 done_claimed 时必须提供 tests 或 evidence 任一项",
      "禁止复制未授权 Session 正文",
      "完成状态上报为 done_claimed；若后续发现未完成，可人工打回",
    ],
    risks: [proposal.risk],
    current_step: "正式改进任务已由 TaskCenter 创建，等待目标 Session 开始执行。",
    next_action: "目标 Session 按照提案完成改进并在 done_claimed 中上报 tests 或 evidence。",
  }, {
    availableSessionIds: availableSessionIds(),
    requireRegistered: true,
  });
  return { registration, task: created.task };
}

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

function updateReflectionExecutionState(record, patch) {
  const current = loadReflectionState();
  const next = updateReflectionExecution(
    current,
    record.proposalId,
    record.reflectionExecutionId,
    patch,
  );
  if (next !== current) persistJsonObject(reflectionProposalsPath, next);
}

function blockReflectionTask(record, reason) {
  if (!record.taskId || !record.threadId) return;
  const task = loadTasks().find((item) => item.id === record.taskId);
  if (!task || !["planned", "in_progress"].includes(task.status)) return;
  try {
    recordTaskEvent({
      type: "task.blocked",
      event_id: `reflection-dispatch-failed-${record.id}`,
      task_id: record.taskId,
      session_id: record.threadId,
      status: "blocked",
      blocker: `TaskCenter 自动派发失败：${String(reason || "未知错误").slice(0, 300)}`,
      next_action: "检查本地 Codex CLI/SDK 和目标 Session 状态后重试。",
    });
  } catch (error) {
    console.error("TaskCenter failed to block reflection task:", safeError(error));
  }
}

function cancelReflectionTask(record) {
  if (!record.proposalId || !record.taskId || !record.threadId) return;
  const task = loadTasks().find((item) => item.id === record.taskId);
  if (!task || !["planned", "in_progress", "blocked"].includes(task.status)) return;
  try {
    recordTaskEvent({
      type: "task.update",
      event_id: `reflection-dispatch-cancelled-${record.id}`,
      task_id: record.taskId,
      session_id: record.threadId,
      status: "cancelled",
      current_step: "人工取消了尚未开始的反思提案自动投递。",
      next_action: "如仍需改进，请重新采纳提案并选择执行 Session。",
    });
  } catch (error) {
    console.error("TaskCenter failed to cancel reflection task:", safeError(error));
  }
}

async function processQueue() {
  if (processingQueue) return;
  processingQueue = true;
  try {
    for (const record of dispatches.filter((item) => item.status === "queued")) {
      try {
        if (activeThreadDispatches.has(record.threadId)) continue;
        const state = inspectSessionState(record.threadId, sessionsRoot);
        if (state.busy) continue;
        void startExistingDispatch(record);
      } catch (error) {
        finishDispatch(record, "failed", `队列检查失败：${safeError(error)}`);
      }
    }
  } finally {
    processingQueue = false;
  }
}

function migrateLegacyDispatches() {
  let changed = false;
  for (const record of dispatches) {
    if (["running", "delivering"].includes(record.status)) {
      record.status = "failed";
      record.error = "控制服务曾在投递过程中停止。为避免重复执行，系统没有自动重发；请先检查原 Session 再决定是否重试。";
      record.updatedAt = new Date().toISOString();
      delete record.pendingPrompt;
      delete record.workingDirectory;
      changed = true;
      continue;
    }
    if (record.status === "queued" && (!record.pendingPrompt || !record.workingDirectory)) {
      record.status = "failed";
      record.error = "历史记录：缺少可恢复的队列上下文，请重新发送。";
      record.updatedAt = new Date().toISOString();
      delete record.pid;
      changed = true;
      continue;
    }
    if (
      !record.proposalId
      && record.mode !== "session_message"
      && ["failed", "completed"].includes(record.status)
      && !String(record.error || "").startsWith("历史记录：")
    ) {
      record.error = record.status === "completed"
        ? "历史记录：旧版嵌套执行曾结束，但不代表需求完成或已验收。"
        : "历史记录：旧版嵌套执行失败，现已改为 Session 消息投递。";
      record.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) persistDispatches();
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
  const indexed = readSnapshot(taskEventIndexPath, { byTask: {} }).byTask?.[taskId] || [];
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

function persistDispatches() {
  const next = dispatches.slice(-200);
  const temporaryPath = `${dispatchesPath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, dispatchesPath);
}

function shutdown() {
  clearInterval(queueTimer);
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
