import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { taskTimeState, STALE_TASK_MS } from "../app/task-time-state.mjs";
import {
  applyCompletionEvent,
  buildCompletionPacket,
  completionPacketMarkdown,
  computeCompletionReadiness,
  normalizeCompletionEvent,
  withCompletionState,
} from "./completion-state.mjs";
import {
  applyTaskPhaseEvent,
  buildTaskPhaseTiming,
  validatePhaseEvent,
  withTaskPhaseTiming,
} from "./task-phase-timing.mjs";
import { listDelegations } from "./delegation-store.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
export const taskEventsPath = resolve(process.env.TASKCENTER_TASK_EVENTS_PATH || join(projectRoot, "data", "task-events.jsonl"));
export const taskLedgerPath = resolve(process.env.TASKCENTER_TASK_LEDGER_PATH || join(projectRoot, "data", "task-ledger.json"));
export const processedEventIdsPath = resolve(process.env.TASKCENTER_TASK_EVENT_IDS_PATH || join(projectRoot, "data", "task-event-ids.json"));
export const taskReconcilePath = resolve(process.env.TASKCENTER_TASK_RECONCILE_PATH || join(projectRoot, "data", "task-reconcile.jsonl"));
export const sessionRegistryPath = resolve(process.env.TASKCENTER_SESSION_REGISTRY_PATH || join(projectRoot, "data", "session-registry.json"));
export const sessionMergesPath = resolve(process.env.TASKCENTER_SESSION_MERGES_PATH || join(projectRoot, "data", "session-merges.json"));

const statuses = new Set(["planned", "in_progress", "blocked", "done_claimed", "verified", "cancelled", "removed"]);
const routingActions = new Set(["direct_execute", "delegate_native", "fallback_cli", "reasoned_override"]);
const dispatchChannels = new Set(["direct", "native", "cli", "other"]);
const routingOutcomes = new Set(["selected", "started", "succeeded", "failed"]);
const routingHistoryLimit = 20;
const demoPattern = /^ui-demo-/;
const contextShadowPattern = /^context-[0-9a-f]{24}$/;
let ledgerCache = null;
let normalizedTasksCache = null;
let sessionRegistryCache = null;
export { taskTimeState, STALE_TASK_MS };

export function loadTasks() {
  const source = readLedger();
  if (normalizedTasksCache?.source === source) return normalizedTasksCache.tasks.map((task) => withTaskPhaseTiming(task));
  const tasks = source
    .filter((task) => task.status !== "removed")
    .map((task) => normalizeDueAtSemantics(task))
    .map((task) => withCompletionState({ ...task, sessionId: canonicalSessionId(task.sessionId) }));
  normalizedTasksCache = { source, tasks };
  return tasks.map((task) => withTaskPhaseTiming(task));
}

function normalizeDueAtSemantics(task) {
  if (task.dueAtExplicit === true) return task;
  return { ...task, dueAt: "", dueAtExplicit: false };
}

export function taskCompletionReadiness(taskId, revision = "") {
  const task = loadTasks().find((item) => item.id === taskId);
  if (!task) throw new TaskLedgerError(404, "任务不存在。");
  return computeCompletionReadiness(task, revision || task.currentSubject || task.currentRevision || null);
}

export function taskCompletionPacket(taskId) {
  const task = loadTasks().find((item) => item.id === taskId);
  if (!task) throw new TaskLedgerError(404, "任务不存在。");
  return buildCompletionPacket(task);
}

export function taskPhaseReport(taskId, asOf = "") {
  const task = loadTasks().find((item) => item.id === taskId);
  if (!task) throw new TaskLedgerError(404, "任务不存在。");
  if (asOf !== "" && asOf !== undefined && asOf !== null) {
    const parsed = asOf instanceof Date ? asOf.getTime() : Date.parse(asOf);
    if (!Number.isFinite(parsed)) throw new TaskLedgerError(400, "as_of 必须是有效 ISO 时间。");
  }
  return buildTaskPhaseTiming(task, asOf || undefined);
}

function contextCompletionTask(contextTaskId, taskCenterTaskId = "") {
  const candidates = loadTasks().filter((task) => task.contextTaskId === contextTaskId);
  if (taskCenterTaskId) {
    const exact = candidates.find((task) => task.id === taskCenterTaskId);
    if (!exact) throw new TaskLedgerError(404, "TaskCenter task 与 context_task_id 不匹配。");
    return exact;
  }
  const formal = candidates.filter((task) => !isContextShadowTask(task));
  const ready = formal.filter((task) => task.completionReadiness?.completionClaim?.allowed === true);
  if (ready.length === 1) return ready[0];
  if (ready.length > 1) throw new TaskLedgerError(409, "同一 Context task 对应多个可完成 TaskCenter task，请显式指定 taskcenter_task_id。");
  if (formal.length === 1) return formal[0];
  if (formal.length > 1) throw new TaskLedgerError(409, "同一 Context task 对应多个 TaskCenter task，请显式指定 taskcenter_task_id。");
  const shadows = candidates.filter((task) => isContextShadowTask(task));
  if (shadows.length === 1) return shadows[0];
  if (!shadows.length) throw new TaskLedgerError(404, "未找到关联的 TaskCenter task。");
  throw new TaskLedgerError(409, "同一 Context task 对应多个影子任务，无法确定完成对象。");
}

export function taskExport(taskId, format = "json") {
  const task = loadTasks().find((item) => item.id === taskId);
  if (!task) throw new TaskLedgerError(404, "任务不存在。");
  const auditSummary = taskAuditSummary(taskId);
  const estimateCalibration = taskEstimateCalibration(task);
  return format === "markdown"
    ? `${completionPacketMarkdown(task)}\n## Estimate calibration\n\n- Delivery due: ${estimateCalibration.dueAt || "none"}\n- Estimated active effort: ${formatExportDuration(estimateCalibration.estimatedEffortMs)}\n- Wall elapsed: ${formatExportDuration(estimateCalibration.wallElapsedMs)}\n- Active elapsed: ${estimateCalibration.activeElapsedKnown ? formatExportDuration(estimateCalibration.activeElapsedMs) : "unknown"}\n- Blocked elapsed: ${estimateCalibration.blockedElapsedMs === null ? "unknown" : formatExportDuration(estimateCalibration.blockedElapsedMs)}\n- Schedule overdue: ${formatExportDuration(estimateCalibration.scheduleOverdueMs)}\n- Effort variance: ${estimateCalibration.effortVarianceMs === null ? "unknown" : formatExportDuration(estimateCalibration.effortVarianceMs)}\n- Estimate revisions: ${estimateCalibration.estimateHistory.length}\n\n## Audit summary\n\n- Events: ${auditSummary.eventCount}\n- First occurred: ${auditSummary.firstOccurredAt || "none"}\n- Last recorded: ${auditSummary.lastRecordedAt || "none"}\n`
    : { ...buildCompletionPacket(task), estimateCalibration, auditSummary };
}

function taskEstimateCalibration(task) {
  const timing = taskTimeState(task);
  return {
    dueAt: task.dueAt || "",
    estimatedEffortMs: timing.estimatedEffortMs,
    wallElapsedMs: timing.wallElapsedMs,
    activeElapsedMs: timing.activeElapsedMs,
    activeElapsedKnown: timing.activeElapsedKnown,
    blockedElapsedMs: timing.blockedElapsedMs,
    blockedRatio: timing.blockedRatio,
    scheduleOverdueMs: timing.scheduleOverdueMs,
    effortVarianceMs: timing.effortVarianceMs,
    estimateHistory: timing.estimateHistory,
  };
}

function formatExportDuration(value) {
  if (value === null || !Number.isFinite(Number(value))) return "unknown";
  return `${Math.round(Number(value) / 60000)} minutes`;
}

function taskAuditSummary(taskId) {
  if (!existsSync(taskEventsPath)) return { eventCount: 0, eventTypes: {}, firstOccurredAt: "", lastRecordedAt: "" };
  const events = readFileSync(taskEventsPath, "utf8").split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try { const event = JSON.parse(line); return event.task_id === taskId ? [event] : []; } catch { return []; }
  });
  const eventTypes = {};
  for (const event of events) eventTypes[event.type] = (eventTypes[event.type] || 0) + 1;
  return {
    eventCount: events.length,
    eventTypes,
    firstOccurredAt: events.map((event) => event.occurred_at || event.created_at).filter(Boolean).sort()[0] || "",
    lastRecordedAt: events.map((event) => event.recorded_at || event.created_at).filter(Boolean).sort().at(-1) || "",
  };
}

export function isContextShadowTask(taskOrId) {
  const taskId = typeof taskOrId === "string" ? taskOrId : taskOrId?.id;
  return contextShadowPattern.test(String(taskId || ""));
}

export function loadVisibleTasks() {
  return loadTasks().filter((task) => !isContextShadowTask(task));
}

export function loadSessionMerges() {
  if (!existsSync(sessionMergesPath)) return {};
  try {
    const value = JSON.parse(readFileSync(sessionMergesPath, "utf8"));
    const canonical = typeof value?.canonicalSessionId === "string" ? value.canonicalSessionId : "";
    const aliases = Array.isArray(value?.aliases) ? value.aliases : [];
    if (!canonical) return {};
    return Object.fromEntries(aliases.filter((id) => typeof id === "string" && id).map((id) => [id, canonical]));
  } catch {
    return {};
  }
}

export function canonicalSessionId(sessionId) {
  const value = String(sessionId || "");
  return loadSessionMerges()[value] || value;
}

export function isProjectContextClientSessionId(sessionId) {
  return /^codex:[0-9a-f]{32}$/i.test(String(sessionId || ""));
}

export function loadSessionRegistry() {
  let registry = {};
  const registryIdentity = fileIdentity(sessionRegistryPath);
  const mergesIdentity = fileIdentity(sessionMergesPath);
  if (existsSync(sessionRegistryPath)) {
    try {
      const value = JSON.parse(readFileSync(sessionRegistryPath, "utf8"));
      registry = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      registry = {};
    }
  }
  const useLegacyEvents = Object.keys(registry).length === 0;
  const cacheIdentity = `${registryIdentity}:${mergesIdentity}:${useLegacyEvents ? fileIdentity(taskEventsPath) : "registry-primary"}`;
  if (sessionRegistryCache?.identity === cacheIdentity) return { ...sessionRegistryCache.value };
  // 兼容注册表上线前的历史事件：已有 session.register 也应显示为已登记。
  try {
    if (useLegacyEvents && existsSync(taskEventsPath)) {
      for (const line of readFileSync(taskEventsPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type !== "session.register" || !event.session_id) continue;
        const current = registry[event.session_id];
        registry[event.session_id] = {
          ...(current || {}),
          sessionId: event.session_id,
          agent: current?.agent || event.agent || "unknown",
          provider: current?.provider || event.provider || "unknown",
          model: current?.model || event.model || "unknown",
          workspace: current?.workspace || event.workspace || "",
          registeredAt: current?.registeredAt || event.created_at || "",
          lastSeenAt: event.created_at || current?.lastSeenAt || "",
        };
      }
    }
  } catch {
    registry = {};
  }
  const merges = loadSessionMerges();
  const normalized = {};
  for (const [sessionId, entry] of Object.entries(registry)) {
    if (merges[sessionId]) continue;
    const canonical = canonicalSessionId(entry?.sessionId || sessionId);
    if (!canonical || normalized[canonical]) continue;
    normalized[canonical] = { ...entry, sessionId: canonical };
  }
  sessionRegistryCache = { identity: cacheIdentity, value: normalized };
  return normalized;
}

function fileIdentity(path) {
  try { const info = statSync(path); return `${info.dev || 0}:${info.ino || 0}:${info.size}:${info.mtimeMs}`; } catch { return "missing"; }
}

export function getSessionStatuses(availableSessionIds = [], tasks = loadTasks()) {
  const registry = loadSessionRegistry();
  const ids = new Set([
    ...Object.keys(registry),
    ...availableSessionIds.filter((id) => typeof id === "string" && id),
    ...tasks.map((task) => task.sessionId).filter(Boolean),
  ]);
  return [...ids].map((sessionId) => {
    const entry = registry[sessionId];
    const sessionTasks = tasks.filter((task) => task.sessionId === sessionId);
    return {
      sessionId,
      agent: entry?.agent || "unknown",
      provider: entry?.provider || "unknown",
      model: entry?.model || "unknown",
      workspace: entry?.workspace || "",
      registeredAt: entry?.registeredAt || "",
      lastSeenAt: entry?.lastSeenAt || "",
      l0Audit: entry?.l0Audit || { count: 0, lastAt: "" },
      scheduledReadonly: entry?.scheduledReadonly || null,
      status: entry ? "registered" : "unregistered",
      reason: entry ? "已登记 Session，等待任务或持续上报" : "未发现 session.register",
      taskCount: sessionTasks.length,
      lastTaskAt: sessionTasks.reduce((latest, task) => task.updatedAt > latest ? task.updatedAt : latest, ""),
    };
  });
}

export function setSessionScheduledReadonlyProfile(sessionId, profile) {
  const registry = loadSessionRegistry();
  const current = registry[sessionId];
  if (!current) throw new TaskLedgerError(409, "当前 Session 尚未登记，请先完成 SessionStart 登记。");
  const next = {
    profile: String(profile?.profile || ""),
    automationId: String(profile?.automation_id || profile?.automationId || ""),
    projectId: String(profile?.project_id || profile?.projectId || ""),
    workspaceRoot: String(profile?.workspace_root || profile?.workspaceRoot || ""),
    reportPath: String(profile?.report_path || profile?.reportPath || ""),
    taskMutation: false,
    pcaMutation: false,
    reportMutation: profile?.report_mutation === true || profile?.reportMutation === true,
    network: false,
    activatedAt: new Date().toISOString(),
    scanExempt: current.scheduledReadonly?.scanExempt === true,
    scanExemptUpdatedAt: current.scheduledReadonly?.scanExemptUpdatedAt || "",
  };
  if (next.profile !== "scheduled_readonly" || next.automationId !== "cyberrole-agent-context" || next.projectId !== "cyberrole") {
    throw new TaskLedgerError(400, "scheduled_readonly Session Profile 身份无效。");
  }
  if (!next.workspaceRoot || !next.reportPath || !next.reportMutation) {
    throw new TaskLedgerError(400, "scheduled_readonly Session Profile 缺少资源绑定或唯一报告写能力。");
  }
  registry[sessionId] = { ...current, scheduledReadonly: next, lastSeenAt: next.activatedAt };
  persistSessionRegistry(registry);
  return next;
}

export function setSessionScheduledReadonlyScanExemption(sessionId, enabled) {
  const registry = loadSessionRegistry();
  const current = registry[sessionId];
  if (!current) throw new TaskLedgerError(409, "当前 Session 尚未登记，请先完成 SessionStart 登记。");
  if (current.scheduledReadonly?.profile !== "scheduled_readonly") {
    throw new TaskLedgerError(409, "当前 Session 未绑定 scheduled_readonly Profile。");
  }
  const updatedAt = new Date().toISOString();
  registry[sessionId] = {
    ...current,
    lastSeenAt: updatedAt,
    scheduledReadonly: {
      ...current.scheduledReadonly,
      scanExempt: enabled === true,
      scanExemptUpdatedAt: updatedAt,
    },
  };
  persistSessionRegistry(registry);
  return registry[sessionId].scheduledReadonly;
}

// L0 only retains a per-session aggregate.  It deliberately creates neither a
// task nor an append-only command log, which keeps inspection history private.
export function recordSessionL0Audit(sessionId, workspace = "") {
  const registry = loadSessionRegistry();
  const current = registry[sessionId];
  if (!current) throw new TaskLedgerError(409, "当前 Session 尚未登记，请先完成 SessionStart 登记。");
  const now = new Date().toISOString();
  registry[sessionId] = {
    ...current,
    workspace: workspace || current.workspace || "",
    lastSeenAt: now,
    l0Audit: { count: Number(current.l0Audit?.count || 0) + 1, lastAt: now },
  };
  persistSessionRegistry(registry);
  return registry[sessionId].l0Audit;
}

function persistSessionRegistry(registry) {
  mkdirSync(dirname(sessionRegistryPath), { recursive: true });
  const temporaryPath = `${sessionRegistryPath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, sessionRegistryPath);
  sessionRegistryCache = null;
}

export function reconcileTasks(availableSessionIds) {
  const available = new Set([...availableSessionIds]
    .filter((id) => typeof id === "string" && id)
    .map(canonicalSessionId));
  const registered = new Set(Object.keys(loadSessionRegistry()).map(canonicalSessionId));
  const tasks = readLedger();
  const stale = tasks.filter((task) => {
    if (task.status === "removed") return false;
    const sessionId = canonicalSessionId(task.sessionId);
    if (!sessionId) return false;
    return !available.has(sessionId) && !registered.has(sessionId);
  });
  if (!stale.length) return [];
  const now = new Date().toISOString();
  const removedIds = new Set(stale.map((task) => task.id));
  const nextTasks = tasks.map((task) => removedIds.has(task.id)
    ? { ...task, status: "removed", updatedAt: now, lastEventId: `cleanup-${randomUUID()}` }
    : task);
  persistTasks(nextTasks);
  mkdirSync(dirname(taskReconcilePath), { recursive: true });
  appendFileSync(taskReconcilePath, `${JSON.stringify({
    type: "task.reconcile",
    removedAt: now,
    reason: "任务 session_id 不在当前可用 Codex 会话源中",
    availableSessionCount: available.size,
    tasks: stale.map((task) => ({ id: task.id, sessionId: task.sessionId, title: task.title })),
  })}\n`, { mode: 0o600 });
  return stale;
}

function readLedger() {
  if (!existsSync(taskLedgerPath)) {
    ledgerCache = null;
    return [];
  }
  try {
    const info = statSync(taskLedgerPath);
    const identity = `${info.dev || 0}:${info.ino || 0}:${info.size}:${info.mtimeMs}`;
    if (ledgerCache?.identity === identity) return ledgerCache.tasks;
    const value = JSON.parse(readFileSync(taskLedgerPath, "utf8"));
    const tasks = Array.isArray(value) ? value : [];
    ledgerCache = { identity, tasks };
    return tasks;
  } catch {
    return [];
  }
}

export function recordTaskEvent(input, options = {}) {
  const tasks = loadTasks();
  const current = input?.task_id ? tasks.find((task) => task.id === String(input.task_id)) : null;
  const event = normalizeEvent(input, current);
  const sessionRegistry = loadSessionRegistry();
  const eventSessionId = canonicalSessionId(event.session_id);
  const isRegistered = Boolean(eventSessionId && sessionRegistry[eventSessionId]);

  if (options.requireRegistered
    && ["session.register", "task.create"].includes(event.type)
    && isProjectContextClientSessionId(event.session_id)) {
    throw new TaskLedgerError(409, "检测到 ProjectContext client_session_id；正式 TaskCenter 任务必须使用真实 Codex Session UUID。");
  }

  // 已注册的 session 始终有效，无需在 Codex dashboard 中检查
  if (event.type === "task.create" && options.availableSessionIds && !isRegistered) {
    const available = new Set(options.availableSessionIds);
    if (!available.has(event.session_id)) {
      throw new TaskLedgerError(409, "任务 session_id 不在当前可用会话中，已拒绝写入。");
    }
  }
  if (event.type === "task.create" && options.requireRegistered && !isRegistered) {
    throw new TaskLedgerError(409, "当前 Session 尚未登记，请先调用 taskcenter_session_register。");
  }
  const processed = loadProcessedEventIds();
  const projectedPhaseEvent = event.type === "phase.reported"
    ? (current?.phaseEvents || []).find((item) => item.event_id === event.event_id)
    : null;
  const storedEvent = processed.has(event.event_id) || event.type === "task.close" || projectedPhaseEvent
    ? findStoredTaskEvent(event.event_id)
    : null;
  if (processed.has(event.event_id) || storedEvent || projectedPhaseEvent) {
    const original = storedEvent;
    if (!original) {
      throw new TaskLedgerError(409, "event_id 已处理，但找不到原始事件，拒绝不安全重放。");
    }
    // task.create 未显式传 task_id 时由首次请求生成；重试仍应命中首次生成的任务。
    if (event.type === "task.create" && !String(input.task_id || "")) {
      event.task_id = original.task_id;
    }
    if (!sameIdempotentEvent(original, event)) {
      throw new TaskLedgerError(409, "event_id 已被不同事件使用，拒绝重放。");
    }
    const originalTask = original.task_id
      ? tasks.find((task) => task.id === original.task_id) ?? null
      : null;
    // 返回首次持久化的事件，确保外部补偿同步不能被重投 payload 篡改。
    return { event: original, task: originalTask, idempotent: true };
  }
  // 对已存在的任务，先校验 session 归属，再决定幂等或拒绝。
  if (current) {
    // 人工操作事件（event_id 以 "manual-" 开头）绕过归属校验，但必须本机 UI 来源
    const reviewEvidence = ["review.reported", "review_cycle.reported"].includes(event.type);
    const phaseEvidence = event.type === "phase.reported";
    const ownerSession = canonicalSessionId(current.sessionId);
    const sameOwnerSession = Boolean(ownerSession && eventSessionId && ownerSession === eventSessionId);
    const authorizedPhaseSession = phaseEvidence && authorizePhaseSession(current, event, sameOwnerSession);
    if (!event.event_id.startsWith("manual-") && !reviewEvidence && !authorizedPhaseSession && current.sessionId && event.session_id && !sameOwnerSession) {
      throw new TaskLedgerError(403, "当前 Session 不是该任务的登记 Session。");
    }
    if (options.requireRegistered && (reviewEvidence || (phaseEvidence && !sameOwnerSession)) && !isRegistered) {
      throw new TaskLedgerError(409, phaseEvidence ? "阶段事件 Session 尚未登记。" : "Reviewer Session 尚未登记。");
    }
    // 任务幂等：同一 session 的 task.create 对已存在的任务视为幂等更新，不新建。
    if (event.type === "task.create") {
      return { event, task: current, idempotent: true };
    }
  } else {
    // 任务不存在时，只有 task.create 可以创建，其他操作返回 404。
    if (event.type !== "task.create" && event.type !== "session.register") {
      throw new TaskLedgerError(404, "任务不存在，请先创建任务。");
    }
  }
  if (event.status === "done_claimed" && !event.event_id.startsWith("manual-") && !event.tests.length && !event.evidence.length) {
    throw new TaskLedgerError(400, "done_claimed 需附带 tests 或 evidence，避免将未验证完成误判为已完成。");
  }
  let next = event.type === "session.register"
    ? null
    : event.type === "task.reminder"
      ? current
      : applyEvent(current, event);
  if (next) {
    event.previous_state = current ? auditState(current) : null;
    event.new_state = auditState(next);
    event.timestamp = event.created_at;
  }
  let nextTasks = next
    ? current ? tasks.map((task) => task.id === next.id ? next : task) : [...tasks, next]
    : tasks;
  const supersededTaskIds = next && event.type === "task.create"
    ? contextShadowsAdoptedBy(next, tasks)
    : [];
  if (supersededTaskIds.length) {
    event.superseded_task_ids = supersededTaskIds;
    next = {
      ...next,
      adoptedTaskIds: [...new Set([...(next.adoptedTaskIds || []), ...supersededTaskIds])],
    };
    nextTasks = tasks
      .map((task) => supersededTaskIds.includes(task.id) ? supersedeShadow(task, next.id, event) : task)
      .concat(next);
  }
  mkdirSync(dirname(taskEventsPath), { recursive: true });
  appendFileSync(taskEventsPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  const derivedEvents = derivedCompletionEvents(current, next, event);
  for (const derived of derivedEvents) appendFileSync(taskEventsPath, `${JSON.stringify(derived)}\n`, { mode: 0o600 });
  persistTasks(nextTasks);
  touchSession(event);
  processed.add(event.event_id);
  for (const derived of derivedEvents) processed.add(derived.event_id);
  persistProcessedEventIds(processed);
  return { event, task: next, supersededTaskIds };
}

function authorizePhaseSession(task, event, sameOwnerSession) {
  let delegated = false;
  if (event.delegation_id) {
    const delegation = listDelegations(task.id).find((item) => item.id === event.delegation_id);
    if (!delegation) throw new TaskLedgerError(404, "阶段事件引用的 delegation 不存在或不属于该任务。");
    if (canonicalSessionId(delegation.delegateSessionId) !== canonicalSessionId(event.session_id)) {
      throw new TaskLedgerError(403, "阶段事件 Session 不是该 delegation 的执行 Session。");
    }
    delegated = true;
  }
  let reviewActor = false;
  if (event.review_cycle_id) {
    const cycle = (task.reviewCycles || []).find((item) => item.cycle_id === event.review_cycle_id);
    if (!cycle) throw new TaskLedgerError(404, "阶段事件引用的 Review Cycle 不存在。");
    const reviewerSession = cycle.reviewer?.session_id || cycle.reviewer?.id || "";
    reviewActor = Boolean(reviewerSession && canonicalSessionId(reviewerSession) === canonicalSessionId(event.session_id));
  }
  return sameOwnerSession || delegated || reviewActor;
}

function derivedCompletionEvents(previous, next, source) {
  if (!previous || !next) return [];
  const transitions = [];
  const add = (type, reason) => transitions.push({
    event_id: `${source.event_id}:${type}`,
    type,
    task_id: next.id,
    context_task_id: next.contextTaskId || "",
    session_id: source.session_id,
    timestamp: source.created_at,
    created_at: source.created_at,
    occurred_at: source.occurred_at || source.created_at,
    recorded_at: source.created_at,
    actor: source.actor || source.agent,
    subject_ref: next.currentSubject || null,
    reason,
    previous_state: auditState(previous),
    new_state: auditState(next),
  });
  if (previous.verificationStatus !== "stale" && next.verificationStatus === "stale") add("verification.staled", "current subject changed after verification");
  if (previous.reviewStatus !== "stale" && next.reviewStatus === "stale") add("review.staled", "current subject changed after review");
  if (!previous.completionReadiness?.ready && next.completionReadiness?.ready) add("acceptance.ready", "all completion requirements satisfied");
  return transitions;
}

const activeTaskStatuses = new Set(["planned", "in_progress", "blocked"]);

const idempotentEventFields = [
  "event_id", "type", "task_id", "context_task_id", "requirement_id", "session_id",
  "agent", "provider", "model", "workspace", "project_id", "title", "goal", "status", "priority",
  "plan", "current_step", "next_action", "blocker", "acceptance_criteria", "changed_files",
  "tests", "evidence", "assumptions", "risks", "tradeoffs", "open_questions", "retrospective",
  "expected_at", "archived_at", "superseded_by", "review_reason", "reviewed_at", "tool_name",
  "due_at", "estimated_effort_ms", "estimate_reason",
  "tool_use_id", "routing_action", "orchestrator_model", "preferred_executor_model",
  "selected_executor_model", "dispatch_channel", "routing_reason", "routing_outcome", "policy_version",
  "fallback_from", "fallback_reason", "retry_after_at", "review_artifacts",
  "contract_version", "scope", "non_goals", "workflow_profile", "review_policy", "execution_environment",
  "verification_plan", "revision", "requirement_result", "verification_claim", "review_attestation", "review_cycle",
  "phase", "transition", "activity_source", "activity_id", "delegation_id", "review_cycle_id",
  "diagnostic_observation",
  "close_requirements", "close_verifications",
  "context_completion_id", "authorization_id", "reason", "actor", "subject_ref", "acceptance_record", "workspace_policy",
];

function findStoredTaskEvent(eventId) {
  if (!existsSync(taskEventsPath)) return null;
  const lines = readFileSync(taskEventsPath, "utf8").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].includes(eventId)) continue;
    try {
      const candidate = JSON.parse(lines[index]);
      if (candidate.event_id === eventId) return candidate;
    } catch {
      // 忽略其他损坏行，继续寻找精确 event_id。
    }
  }
  return null;
}

function sameIdempotentEvent(left, right) {
  const fields = left?.type === "phase.reported" || right?.type === "phase.reported"
    ? [...idempotentEventFields, "occurred_at"]
    : idempotentEventFields;
  const pick = (event) => Object.fromEntries(fields.map((field) => [field, event[field]]));
  return JSON.stringify(pick(left)) === JSON.stringify(pick(right));
}

function contextIdentity(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
}

function contextShadowsAdoptedBy(task, tasks) {
  if (isContextShadowTask(task) || !task.contextTaskId) return [];
  const sessionId = canonicalSessionId(task.sessionId);
  return tasks
    .filter((candidate) => (
      isContextShadowTask(candidate)
      && canonicalSessionId(candidate.sessionId) === sessionId
      && candidate.contextTaskId === task.contextTaskId
      && !candidate.supersededBy
    ))
    .map((candidate) => candidate.id);
}

function supersedeShadow(task, replacementTaskId, event) {
  const active = activeTaskStatuses.has(task.status);
  return {
    ...task,
    status: active ? "cancelled" : task.status,
    currentStep: active ? "内部 Context 影子任务已由正式 TaskCenter 任务接管。" : task.currentStep,
    nextAction: active ? "" : task.nextAction,
    blocker: active ? "" : task.blocker,
    archivedAt: task.archivedAt || event.created_at,
    actualAt: active ? event.created_at : task.actualAt,
    supersededBy: replacementTaskId,
    supersededAt: event.created_at,
    updatedAt: event.created_at,
    lastEventId: event.event_id,
  };
}

export function supersedeContextShadowTask(shadowTaskId, replacementTaskId, reason = "") {
  const tasks = loadTasks();
  const shadow = tasks.find((task) => task.id === shadowTaskId);
  const replacement = tasks.find((task) => task.id === replacementTaskId);
  if (!shadow || !isContextShadowTask(shadow)) {
    throw new TaskLedgerError(404, "未找到可接管的 Context 影子任务。");
  }
  if (!replacement || isContextShadowTask(replacement)) {
    throw new TaskLedgerError(404, "未找到用于接管的正式 TaskCenter 任务。");
  }
  if (canonicalSessionId(shadow.sessionId) !== canonicalSessionId(replacement.sessionId)) {
    throw new TaskLedgerError(409, "影子任务与正式任务不属于同一个 Session。");
  }
  if (shadow.contextTaskId && replacement.contextTaskId && shadow.contextTaskId !== replacement.contextTaskId) {
    throw new TaskLedgerError(409, "影子任务与正式任务不属于同一个 Context semantic task。");
  }
  if (shadow.supersededBy === replacement.id) {
    return { task: shadow, replacement, idempotent: true };
  }
  const eventId = `manual-reconcile-shadow-${contextIdentity(`${shadow.id}:${replacement.id}`)}`;
  const result = recordTaskEvent({
    type: "task.review",
    event_id: eventId,
    task_id: shadow.id,
    context_task_id: shadow.contextTaskId,
    session_id: shadow.sessionId,
    status: activeTaskStatuses.has(shadow.status) ? "cancelled" : shadow.status,
    archived_at: shadow.archivedAt || new Date().toISOString(),
    superseded_by: replacement.id,
    current_step: "内部 Context 影子任务已由正式 TaskCenter 任务接管。",
    retrospective: cleanText(reason, 2_000) || `由正式任务 ${replacement.id} 接管。`,
  });
  return { ...result, replacement };
}

export function reconcileContextShadowTasks() {
  const tasks = loadTasks();
  const reconciled = [];
  for (const shadow of tasks.filter((task) => isContextShadowTask(task) && !task.supersededBy)) {
    if (!shadow.contextTaskId) continue;
    const shadowCreatedAt = Date.parse(shadow.createdAt || "");
    if (!Number.isFinite(shadowCreatedAt)) continue;
    const replacement = tasks
      .filter((task) => (
        !isContextShadowTask(task)
        && canonicalSessionId(task.sessionId) === canonicalSessionId(shadow.sessionId)
        && task.contextTaskId === shadow.contextTaskId
        && Number.isFinite(Date.parse(task.createdAt || ""))
        && Date.parse(task.createdAt) >= shadowCreatedAt
      ))
      .sort((left, right) => Date.parse(right.createdAt || "") - Date.parse(left.createdAt || ""))[0];
    if (!replacement) continue;
    reconciled.push(supersedeContextShadowTask(
      shadow.id,
      replacement.id,
      "同 Session、同 Context semantic task 已存在正式 TaskCenter 任务，自动收敛内部影子记录。",
    ).task);
  }
  return { reconciled };
}

export function completeTasksByReconciliation(taskIds, evidence = "") {
  const completed = [];
  for (const taskId of [...new Set(taskIds || [])]) {
    const task = loadTasks().find((item) => item.id === taskId);
    if (!task || isContextShadowTask(task)) {
      throw new TaskLedgerError(404, `未找到可完成的正式任务: ${taskId}`);
    }
    if (!activeTaskStatuses.has(task.status)) {
      completed.push(task);
      continue;
    }
    const result = recordTaskEvent({
      type: "task.report",
      event_id: `manual-reconcile-complete-${contextIdentity(`${task.id}:${task.lastEventId || task.updatedAt}`)}`,
      task_id: task.id,
      context_task_id: task.contextTaskId,
      session_id: task.sessionId,
      agent: "system",
      provider: "local",
      model: "reconciliation",
      status: "done_claimed",
      current_step: "根据本机会话终止证据补齐完成上报。",
      evidence: [cleanText(evidence, 1_000)].filter(Boolean),
    });
    completed.push(result.task);
  }
  return { completed };
}

/**
 * 确保一个 Context semantic task 在当前客户端 Session 中有且只有一个活跃执行任务。
 * 正式任务不会被 Context ensure 重新激活；仅内部影子任务允许按 semantic task 新建执行代次。
 * 这样 follow-up 可先获得影子记录，再由本轮显式创建的正式 TaskCenter 任务接管。
 */
export function ensureContextTask(input) {
  const contextTaskId = cleanText(input?.context_task_id, 200);
  const sessionId = canonicalSessionId(String(input?.session_id || ""));
  const workspace = String(input?.workspace || "");
  if (!contextTaskId) throw new TaskLedgerError(400, "缺少 context_task_id。");
  if (!sessionId) throw new TaskLedgerError(400, "缺少 session_id。");

  if (!loadSessionRegistry()[sessionId]) {
    recordTaskEvent({
      type: "session.register",
      event_id: `context-session-${contextIdentity(sessionId)}`,
      session_id: sessionId,
      workspace,
      agent: input.agent || "unknown",
      provider: input.provider || "unknown",
      model: input.model || "unknown",
    });
  }

  const mapped = loadTasks()
    .filter((task) => task.sessionId === sessionId && task.contextTaskId === contextTaskId)
    .sort((left, right) => Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || ""));
  const activeFormal = mapped.find((task) => !isContextShadowTask(task) && activeTaskStatuses.has(task.status));
  if (activeFormal) {
    return { task: activeFormal, created: false, resumed: true, reactivated: false };
  }
  const shadows = mapped.filter((task) => isContextShadowTask(task) && !task.supersededBy);
  const activeShadow = shadows.find((task) => activeTaskStatuses.has(task.status));
  if (activeShadow) {
    return { task: activeShadow, created: false, resumed: true, reactivated: false };
  }
  const completedShadow = shadows.find((task) => task.status === "done_claimed");
  if (completedShadow) {
    const result = recordTaskEvent({
      type: "task.update",
      event_id: `context-reactivate-${contextIdentity(`${completedShadow.id}:${completedShadow.lastEventId || completedShadow.updatedAt}`)}`,
      task_id: completedShadow.id,
      context_task_id: contextTaskId,
      session_id: sessionId,
      status: "in_progress",
      current_step: "Context semantic task 仍在进行，继续复用执行任务。",
    });
    return { task: result.task, created: false, resumed: true, reactivated: true };
  }

  const generation = mapped.filter((task) => isContextShadowTask(task)).length + 1;
  const taskId = `context-${contextIdentity(`${sessionId}:${contextTaskId}:${generation}`)}`;
  const result = recordTaskEvent({
    type: "task.create",
    event_id: `context-create-${taskId}`,
    task_id: taskId,
    context_task_id: contextTaskId,
    session_id: sessionId,
    workspace,
    agent: input.agent || "unknown",
    provider: input.provider || "unknown",
    model: input.model || "unknown",
    title: cleanText(input.semantic_label, 200) || `Context 任务 ${contextTaskId}`,
    goal: cleanText(input.semantic_label, 1_000) || `跟踪 ProjectContext semantic task ${contextTaskId}`,
    status: "in_progress",
    priority: "P1",
    contract_version: "v2",
    scope: ["ProjectContext semantic task lifecycle"],
    non_goals: [],
    workflow_profile: "fast",
    review_policy: "not_required",
    acceptance_criteria: [{ id: "context_goal", description: "ProjectContext 已声明语义目标完成", required: true }],
  });
  return { task: result.task, created: true, resumed: false, reactivated: false };
}

/** 仅由 context.complete_task 调用；commit_turn / SessionEnd 不应进入此路径。 */
export function completeContextTasks(input) {
  const contextTaskId = cleanText(input?.context_task_id, 200);
  if (!contextTaskId) throw new TaskLedgerError(400, "缺少 context_task_id。");
  const completed = [];
  let task = contextCompletionTask(contextTaskId, cleanText(input?.taskcenter_task_id, 200));
  if (isContextShadowTask(task) && activeTaskStatuses.has(task.status)) {
    const result = recordTaskEvent({
      type: "task.close",
      event_id: `context-complete-${contextIdentity(`${contextTaskId}:${task.id}:${task.lastEventId || task.updatedAt}`)}`,
      task_id: task.id,
      context_task_id: contextTaskId,
      session_id: task.sessionId,
      status: "done_claimed",
      current_step: "ProjectContext semantic task 已完成。",
      evidence: [cleanText(input.summary, 1_000)].filter(Boolean),
      ...(task.contractVersion === "v2" ? {} : {
        contract_version: "v2",
        scope: ["ProjectContext semantic task lifecycle"],
        non_goals: [],
        workflow_profile: "fast",
        review_policy: "not_required",
        acceptance_criteria: [{ id: "context_goal", description: "ProjectContext 已声明语义目标完成", required: true }],
      }),
      close_requirements: [{
        requirement_id: "context_goal",
        status: "passed",
        evidence_refs: [cleanText(input.summary, 1_000) || `context-task:${contextTaskId}`],
        checked_at: new Date().toISOString(),
        checked_by: { type: "task_platform", id: "project-context" },
      }],
    });
    completed.push(result.task);
    task = result.task;
  }
  const completionPacket = buildCompletionPacket(task);
  const accepted = completionPacket.completionReadiness?.completionClaim?.allowed === true;
  return {
    accepted,
    contextTaskId,
    taskId: task.id,
    completed,
    completionPacket,
    ...(accepted ? {} : {
      error: "completion_claim_blocked",
      reasons: completionPacket.completionReadiness?.completionClaim?.blockingReasons || [],
    }),
  };
}

function loadProcessedEventIds() {
  if (!existsSync(processedEventIdsPath)) return new Set();
  try {
    const value = JSON.parse(readFileSync(processedEventIdsPath, "utf8"));
    return new Set(Array.isArray(value) ? value : []);
  } catch {
    return new Set();
  }
}

function persistProcessedEventIds(set) {
  mkdirSync(dirname(processedEventIdsPath), { recursive: true });
  const arr = [...set].slice(-5_000);
  const temporaryPath = `${processedEventIdsPath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(arr)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, processedEventIdsPath);
}

function normalizeEvent(input, current = null) {
  if (!input || typeof input !== "object") throw new TaskLedgerError(400, "任务事件必须是 JSON 对象。");
  const type = String(input.type || "");
  const sessionId = String(input.session_id || "");
  const allowedTypes = new Set([
    "session.register", "task.create", "task.update", "task.blocked", "task.done_claimed", "task.report", "task.close", "task.review",
    "task.reminder", "tool.call", "routing.decision", "routing.result", "routing.health", "requirement.reported", "verification.reported", "review.reported", "review_cycle.reported",
    "acceptance.accepted", "acceptance.rejected", "subject.updated", "diagnostic.reported", "phase.reported",
  ]);
  if (!allowedTypes.has(type)) throw new TaskLedgerError(400, "任务事件类型无效。");
  if (input.status !== undefined && !statuses.has(input.status)) throw new TaskLedgerError(400, "任务状态无效。");
  if (input.contract_version !== undefined && !["legacy", "v2"].includes(input.contract_version)) throw new TaskLedgerError(400, "contract_version 无效。");
  if (type === "session.register" && !sessionId) throw new TaskLedgerError(400, "Session 登记事件缺少 session_id。");
  if (type !== "session.register" && type !== "task.create" && !String(input.task_id || "")) {
    throw new TaskLedgerError(400, "任务事件缺少 task_id。");
  }
  const event = {
    event_id: String(input.event_id || randomUUID()),
    type,
    task_id: String(input.task_id || (type === "task.create" ? `task-${randomUUID()}` : "")),
    context_task_id: cleanText(input.context_task_id, 200),
    requirement_id: cleanText(input.requirement_id, 200),
    session_id: sessionId,
    agent: cleanText(input.agent, 40) || "unknown",
    provider: cleanText(input.provider, 80) || "unknown",
    model: cleanText(input.model, 120) || "unknown",
    workspace: String(input.workspace || ""),
    project_id: cleanText(input.project_id, 200),
    title: cleanText(input.title, 200),
    goal: cleanText(input.goal, 1_000),
    status: statuses.has(input.status) ? input.status : undefined,
    priority: cleanText(input.priority, 20),
    plan: cleanList(input.plan, 20, 500),
    current_step: cleanText(input.current_step, 500),
    next_action: cleanText(input.next_action, 500),
    blocker: cleanText(input.blocker, 1_000),
    acceptance_criteria: cleanAcceptanceCriteria(input.acceptance_criteria),
    changed_files: cleanList(input.changed_files, 50, 500),
    tests: cleanList(input.tests, 30, 500),
    evidence: cleanList(input.evidence, 30, 1_000),
    assumptions: cleanList(input.assumptions, 20, 500),
    risks: cleanList(input.risks, 20, 500),
    tradeoffs: cleanList(input.tradeoffs, 20, 500),
    open_questions: cleanList(input.open_questions, 20, 500),
    retrospective: cleanText(input.retrospective, 2_000),
    expected_at: cleanText(input.expected_at, 80),
    due_at: cleanText(input.due_at, 80),
    estimated_effort_ms: normalizePositiveInteger(input.estimated_effort_ms),
    estimate_reason: cleanText(input.estimate_reason, 1_000),
    archived_at: cleanText(input.archived_at, 80),
    superseded_by: cleanText(input.superseded_by, 200),
    review_reason: cleanText(input.review_reason, 1_000),
    reviewed_at: cleanText(input.reviewed_at, 80),
    tool_name: cleanText(input.tool_name, 120),
    tool_use_id: cleanText(input.tool_use_id, 200),
    routing_action: cleanText(input.routing_action, 40),
    orchestrator_model: cleanText(input.orchestrator_model, 120),
    preferred_executor_model: cleanText(input.preferred_executor_model, 120),
    selected_executor_model: cleanText(input.selected_executor_model, 120),
    dispatch_channel: cleanText(input.dispatch_channel, 40),
    routing_reason: cleanText(input.routing_reason, 1_000),
    routing_outcome: cleanText(input.routing_outcome, 40),
    fallback_from: cleanText(input.fallback_from, 120),
    fallback_reason: cleanText(input.fallback_reason, 200),
    policy_version: cleanText(input.policy_version, 80),
    route_id: cleanText(input.route_id, 200),
    task_class: cleanText(input.task_class, 80),
    circuit_state: cleanText(input.circuit_state, 40),
    health_model: cleanText(input.health_model, 120),
    health_transition: cleanText(input.health_transition, 80),
    consecutive_failures: normalizeNonNegativeInteger(input.consecutive_failures),
    active_executors: normalizeNonNegativeInteger(input.active_executors),
    retry_after_at: cleanText(input.retry_after_at, 80),
    review_artifacts: normalizeReviewArtifacts(input.review_artifacts),
    ...normalizeCompletionEvent(input, current?.currentSubject || null),
    phase: cleanText(input.phase, 40),
    transition: cleanText(input.transition, 40),
    activity_source: cleanText(input.activity_source, 40),
    activity_id: cleanText(input.activity_id, 200),
    delegation_id: cleanText(input.delegation_id, 200),
    review_cycle_id: cleanText(input.review_cycle_id, 120),
    created_at: new Date().toISOString(),
  };
  event.recorded_at = event.created_at;
  event.occurred_at ||= event.created_at;
  if (event.expected_at && !Number.isFinite(Date.parse(event.expected_at))) {
    throw new TaskLedgerError(400, "expected_at 必须是可解析的 ISO 时间。");
  }
  if (event.due_at && !Number.isFinite(Date.parse(event.due_at))) {
    throw new TaskLedgerError(400, "due_at 必须是可解析的 ISO 时间。");
  }
  if (input.estimated_effort_ms !== undefined && event.estimated_effort_ms === undefined) {
    throw new TaskLedgerError(400, "estimated_effort_ms 必须是正整数毫秒。");
  }
  if (type === "routing.decision") {
    if (!routingActions.has(event.routing_action)) throw new TaskLedgerError(400, "routing_action 无效。");
    if (!dispatchChannels.has(event.dispatch_channel)) throw new TaskLedgerError(400, "dispatch_channel 无效。");
    if (event.routing_outcome && !routingOutcomes.has(event.routing_outcome)) throw new TaskLedgerError(400, "routing_outcome 无效。");
    if (!event.orchestrator_model || !event.preferred_executor_model || !event.selected_executor_model || !event.routing_reason) {
      throw new TaskLedgerError(400, "路由决定缺少模型或原因字段。");
    }
    const expectedChannel = {
      direct_execute: "direct",
      delegate_native: "native",
      fallback_cli: "cli",
    }[event.routing_action];
    if (expectedChannel && event.dispatch_channel !== expectedChannel) {
      throw new TaskLedgerError(400, `${event.routing_action} 必须使用 ${expectedChannel} 通道；特殊路由请使用 reasoned_override。`);
    }
    if (event.routing_action === "direct_execute" && event.selected_executor_model !== event.orchestrator_model) {
      throw new TaskLedgerError(400, "direct_execute 的执行模型必须与编排模型一致；特殊路由请使用 reasoned_override。");
    }
    if (["delegate_native", "fallback_cli"].includes(event.routing_action)
      && event.selected_executor_model !== event.preferred_executor_model) {
      throw new TaskLedgerError(400, `${event.routing_action} 默认使用首选执行模型；特殊路由请使用 reasoned_override。`);
    }
    event.routing_outcome ||= "selected";
    event.policy_version ||= "soft-routing-v1";
  }
  if (type === "routing.health") {
    if (!event.route_id || !event.health_model || !["closed", "open", "half_open"].includes(event.circuit_state)) {
      throw new TaskLedgerError(400, "路由健康事件缺少 route_id、model 或有效 circuit_state。");
    }
  }
  if (type === "routing.result" && (!event.route_id || !event.routing_outcome)) {
    throw new TaskLedgerError(400, "routing.result 缺少 route_id 或 outcome。");
  }
  if (type === "diagnostic.reported" && !event.diagnostic_observation?.case_id) {
    throw new TaskLedgerError(400, "diagnostic.reported 缺少有效 diagnostic_observation。");
  }
  if (type === "phase.reported") {
    if (!String(input.event_id || "").trim()) throw new TaskLedgerError(400, "阶段事件必须显式提供 event_id。");
    if (!String(input.session_id || "").trim()) throw new TaskLedgerError(400, "阶段事件必须显式提供 session_id。");
    if (!String(input.occurred_at || "").trim()) throw new TaskLedgerError(400, "阶段事件必须显式提供 occurred_at。");
    if (!input.subject_ref || typeof input.subject_ref !== "object") throw new TaskLedgerError(400, "阶段事件必须显式提供 subject_ref。");
    if (!String(input.reason || "").trim()) throw new TaskLedgerError(400, "阶段事件必须显式提供 reason。");
    try {
      validatePhaseEvent(event, {
        taskId: event.task_id,
        previousEvents: current?.phaseEvents || [],
        reviewCycles: current?.reviewCycles,
      });
    } catch (error) {
      if (Number.isInteger(error?.statusCode)) throw new TaskLedgerError(error.statusCode, error.message);
      throw error;
    }
  }
  return event;
}

function applyEvent(current, event) {
  const alreadyTerminal = ["done_claimed", "verified", "cancelled"].includes(current?.status);
  const supersedingActiveShadow = event.status === "cancelled" && Boolean(event.superseded_by);
  if (event.archived_at && event.archived_at !== "__UNARCHIVE__" && current && !alreadyTerminal && !supersedingActiveShadow) {
    throw new TaskLedgerError(409, "只有已完成、已验收或已取消任务可以归档。");
  }
  // 会话不能自行把任务标成"已验收"。验收必须由 TaskCenter 基于代码/测试证据单独判定，
  // done_claimed 只能停留在"声明完成"，不会自动升级为 verified。
  if (event.status === "verified" && (event.type !== "task.review" || !event.event_id.startsWith("manual-"))) {
    throw new TaskLedgerError(400, "会话不能直接把任务标记为已验收；验收需由 TaskCenter 基于证据判定。");
  }
  // 人工移除操作：允许移除演示任务，真实任务需确认
  if (event.status === "removed") {
    if (!current?.id) {
      throw new TaskLedgerError(404, "任务不存在，无法移除。");
    }
    // 人工操作事件允许移除演示任务；真实任务通过人工操作端点移除时需额外确认
    if (!event.event_id.startsWith("manual-") && !demoPattern.test(current.id)) {
      throw new TaskLedgerError(403, "只有演示任务可以移除；真实任务应取消而非删除。");
    }
    // 非演示任务的人工移除需在 control-server 层额外校验
    if (event.event_id.startsWith("manual-") && !demoPattern.test(current.id)) {
      // 允许人工移除真实任务，但标记为已取消更合理
      return { ...current, status: "cancelled", updatedAt: event.created_at, lastEventId: event.event_id };
    }
    return { ...current, status: "removed", updatedAt: event.created_at, lastEventId: event.event_id };
  }
  if (event.type === "routing.decision") {
    const routing = {
      action: event.routing_action,
      orchestratorModel: event.orchestrator_model,
      preferredExecutorModel: event.preferred_executor_model,
      selectedExecutorModel: event.selected_executor_model,
      dispatchChannel: event.dispatch_channel,
      reason: event.routing_reason,
      outcome: event.routing_outcome,
      policyVersion: event.policy_version,
      recordedAt: event.created_at,
      eventId: event.event_id,
      routeId: event.route_id || undefined,
      taskClass: event.task_class || undefined,
      circuitState: event.circuit_state || undefined,
      fallbackFrom: event.fallback_from || undefined,
      fallbackReason: event.fallback_reason || undefined,
      retryAfterAt: event.retry_after_at || undefined,
      reviewArtifacts: event.review_artifacts || undefined,
    };
    return {
      ...current,
      routing,
      routingHistory: [...(current.routingHistory || []), routing].slice(-routingHistoryLimit),
      routingRecordedAt: event.created_at,
    };
  }
  if (event.type === "routing.health") {
    const health = {
      routeId: event.route_id,
      model: event.health_model,
      state: event.circuit_state,
      transition: event.health_transition,
      consecutiveFailures: event.consecutive_failures ?? 0,
      activeExecutors: event.active_executors ?? 0,
      retryAfterAt: event.retry_after_at || "",
      recordedAt: event.created_at,
      eventId: event.event_id,
    };
    return {
      ...current,
      routingHealth: health,
      routingHealthHistory: [...(current.routingHealthHistory || []), health].slice(-routingHistoryLimit),
    };
  }
  if (event.type === "routing.result") {
    const result = {
      routeId: event.route_id,
      outcome: event.routing_outcome,
      recordedAt: event.created_at,
      eventId: event.event_id,
    };
    return {
      ...current,
      routingResult: result,
      routingResultHistory: [...(current.routingResultHistory || []), result].slice(-routingHistoryLimit),
    };
  }
  const now = event.created_at;
  const base = current || {
    id: event.task_id,
    sessionId: event.session_id,
    ownerActor: event.actor,
    agent: event.agent,
    provider: event.provider,
    model: event.model,
    workspace: event.workspace,
    title: event.title || "未命名任务",
    goal: event.goal || "未记录目标",
    requirementId: event.requirement_id || undefined,
    contextTaskId: event.context_task_id || undefined,
    status: "planned",
    priority: event.priority || "P1",
    plan: [],
    acceptanceCriteria: [],
    changedFiles: [],
    tests: [],
    evidence: [],
    assumptions: [],
    risks: [],
    tradeoffs: [],
    openQuestions: [],
    routing: null,
    routingHistory: [],
    routingHealth: null,
    routingHealthHistory: [],
    phaseEvents: [],
    createdAt: now,
    timingModelVersion: "estimate-calibration-v1",
    firstStartedAt: "",
    activeStartedAt: "",
    blockedStartedAt: "",
    activeDurationMs: 0,
    blockedDurationMs: 0,
    estimateHistory: [],
    expectedAtHistory: [],
    dueAtExplicit: false,
  };
  const preservesTaskOwner = ["review.reported", "review_cycle.reported", "phase.reported"].includes(event.type);
  let next = {
    ...base,
    sessionId: preservesTaskOwner ? base.sessionId : (event.session_id || base.sessionId),
    ownerActor: event.type === "task.create" ? (event.actor || base.ownerActor) : base.ownerActor,
    agent: preservesTaskOwner ? base.agent : event.agent !== "unknown" ? event.agent : (base.agent || "unknown"),
    provider: preservesTaskOwner ? base.provider : event.provider !== "unknown" ? event.provider : (base.provider || "unknown"),
    model: preservesTaskOwner ? base.model : event.model !== "unknown" ? event.model : (base.model || "unknown"),
    workspace: preservesTaskOwner ? base.workspace : (event.workspace || base.workspace),
    title: event.title || base.title,
    goal: event.goal || base.goal,
    requirementId: event.requirement_id || base.requirementId,
    contextTaskId: event.context_task_id || base.contextTaskId,
    priority: event.priority || base.priority,
    status: event.status || (event.type === "task.blocked" ? "blocked" : event.type === "task.done_claimed" ? "done_claimed" : event.type === "task.create" ? "planned" : base.status),
    plan: event.plan.length ? event.plan : base.plan,
    currentStep: event.current_step || base.currentStep || "",
    nextAction: event.next_action || base.nextAction || "",
    blocker: event.blocker || (event.type === "task.blocked" ? "已报告阻塞，等待处理。" : ""),
    acceptanceCriteria: event.acceptance_criteria.length ? event.acceptance_criteria : base.acceptanceCriteria,
    changedFiles: event.changed_files.length ? event.changed_files : base.changedFiles,
    tests: event.tests.length ? event.tests : base.tests,
    evidence: event.evidence.length ? event.evidence : base.evidence,
    assumptions: event.assumptions.length ? event.assumptions : base.assumptions,
    risks: event.risks.length ? event.risks : base.risks,
    tradeoffs: event.tradeoffs.length ? event.tradeoffs : base.tradeoffs,
    openQuestions: event.open_questions.length ? event.open_questions : base.openQuestions,
    retrospective: event.retrospective || base.retrospective || "",
    updatedAt: now,
    lastEventId: event.event_id,
    startedAt: base.startedAt || (event.type === "task.create" ? now : ""),
    dueAt: event.due_at || base.dueAt || "",
    dueAtExplicit: event.due_at ? true : base.dueAtExplicit === true,
    expectedAt: event.expected_at || base.expectedAt || "",
    estimatedEffortMs: event.estimated_effort_ms ?? base.estimatedEffortMs,
    estimateReason: event.estimate_reason || base.estimateReason || "",
    archivedAt: event.archived_at === "__UNARCHIVE__" ? "" : (event.archived_at || base.archivedAt || ""),
    supersededBy: event.superseded_by || base.supersededBy,
    supersededAt: event.superseded_by ? now : (base.supersededAt || ""),
    actualAt: event.status === "in_progress"
      ? ""
      : event.type === "task.done_claimed" || event.status === "done_claimed" || event.status === "cancelled" ? (base.actualAt || now) : (base.actualAt || ""),
    reviewReason: event.review_reason || base.reviewReason || "",
    reviewedAt: event.reviewed_at || base.reviewedAt || "",
    toolCalls: { ...(base.toolCalls || {}) },
    diagnosticObservations: [...(base.diagnosticObservations || [])],
  };
  next = applyTimingTransition(current, base, next, event, now);
  if (event.type === "tool.call" && event.tool_name) next.toolCalls[event.tool_name] = (next.toolCalls[event.tool_name] || 0) + 1;
  if (event.type === "task.review") next.status = event.status || base.status;
  try {
    next = applyCompletionEvent(next, event);
    if (event.type === "phase.reported") next = applyTaskPhaseEvent(next, event);
    else if (event.type === "review_cycle.reported") next = withTaskPhaseTiming(next);
  } catch (error) {
    // completion-state 使用 statusCode 表达协议校验失败。这里必须把它转换成
    // TaskLedgerError，否则控制服务会把合法的 4xx 误报成“Session 投递失败”。
    if (Number.isInteger(error?.statusCode)) {
      throw new TaskLedgerError(error.statusCode, error.message);
    }
    throw error;
  }
  return next;
}

function auditState(task) {
  return {
    execution_status: task.status,
    verification_status: task.verificationStatus || "not_required",
    review_status: task.reviewStatus || "not_required",
    acceptance_status: task.acceptanceStatus || "pending",
    current_subject: task.currentSubject || null,
  };
}

function touchSession(event) {
  if (!event.session_id) return;
  const registry = loadSessionRegistry();
  const current = registry[event.session_id];
  if (event.type === "session.register" || current) {
    const now = event.created_at;
    registry[event.session_id] = {
      ...(current || {}),
      sessionId: event.session_id,
      agent: event.agent !== "unknown" ? event.agent : (current?.agent || "unknown"),
      provider: event.provider !== "unknown" ? event.provider : (current?.provider || "unknown"),
      model: event.model !== "unknown" ? event.model : (current?.model || "unknown"),
      workspace: event.workspace || current?.workspace || "",
      projectId: event.project_id || current?.projectId || "",
      registeredAt: current?.registeredAt || now,
      lastSeenAt: now,
    };
    mkdirSync(dirname(sessionRegistryPath), { recursive: true });
    const temporaryPath = `${sessionRegistryPath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, sessionRegistryPath);
    sessionRegistryCache = null;
  }
}

function persistTasks(tasks) {
  mkdirSync(dirname(taskLedgerPath), { recursive: true });
  const temporaryPath = `${taskLedgerPath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(tasks.slice(-500), null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, taskLedgerPath);
  ledgerCache = null;
  normalizedTasksCache = null;
}

function cleanText(value, limit) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function cleanList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string").map((item) => cleanText(item, maxLength)).filter(Boolean).slice(0, maxItems);
}

function normalizeReviewArtifacts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const normalize = (item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const ref = cleanText(item.ref, 1_000);
    const fingerprint = cleanText(item.fingerprint, 300);
    return ref || fingerprint ? { ref: ref || null, fingerprint: fingerprint || null } : null;
  };
  const subject = normalize(value.subject);
  const bundle = normalize(value.bundle);
  const rules = normalize(value.rules);
  return subject && bundle && rules ? { subject, bundle, rules } : undefined;
}

function normalizePositiveInteger(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeNonNegativeInteger(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function applyTimingTransition(current, base, next, event, now) {
  const migrating = base.timingModelVersion !== "estimate-calibration-v1";
  const previousStatus = current?.status || "planned";
  const statusChanged = previousStatus !== next.status;
  let activeDurationMs = safeDuration(base.activeDurationMs);
  let blockedDurationMs = safeDuration(base.blockedDurationMs);
  let activeStartedAt = base.activeStartedAt || "";
  let blockedStartedAt = base.blockedStartedAt || "";
  if (statusChanged && previousStatus === "in_progress" && activeStartedAt) {
    activeDurationMs += durationBetween(activeStartedAt, now);
    activeStartedAt = "";
  }
  if (statusChanged && previousStatus === "blocked" && blockedStartedAt) {
    blockedDurationMs += durationBetween(blockedStartedAt, now);
    blockedStartedAt = "";
  }
  let firstStartedAt = base.firstStartedAt || (migrating ? base.startedAt || "" : "");
  if (statusChanged && next.status === "in_progress") {
    activeStartedAt = now;
    firstStartedAt ||= now;
  } else if (statusChanged && next.status === "blocked") {
    blockedStartedAt = now;
  }
  if (migrating && next.status === "in_progress" && !activeStartedAt) activeStartedAt = now;
  if (migrating && next.status === "blocked" && !blockedStartedAt) blockedStartedAt = now;
  const incomingDue = event.due_at || "";
  const dueChanged = Boolean(incomingDue) && incomingDue !== (base.dueAt || "");
  const incomingExpectedAt = event.expected_at || "";
  const expectedAtChanged = Boolean(incomingExpectedAt) && incomingExpectedAt !== (base.expectedAt || "");
  const effortChanged = event.estimated_effort_ms !== undefined && event.estimated_effort_ms !== base.estimatedEffortMs;
  const estimateHistory = [...(base.estimateHistory || [])];
  if (dueChanged || effortChanged) {
    estimateHistory.push({
      eventId: event.event_id,
      actor: event.actor || null,
      previousDueAt: base.dueAt || "",
      dueAt: incomingDue || base.dueAt || "",
      previousEstimatedEffortMs: base.estimatedEffortMs ?? null,
      estimatedEffortMs: event.estimated_effort_ms ?? base.estimatedEffortMs ?? null,
      reason: event.estimate_reason || (current ? "未提供（兼容旧客户端）" : "初始预估"),
      occurredAt: event.occurred_at || now,
      recordedAt: now,
    });
  }
  const expectedAtHistory = [...(base.expectedAtHistory || [])];
  if (expectedAtChanged) {
    expectedAtHistory.push({
      eventId: event.event_id,
      previousExpectedAt: base.expectedAt || "",
      expectedAt: incomingExpectedAt,
      reason: event.estimate_reason || "旧预计完成时间调整",
      occurredAt: event.occurred_at || now,
      recordedAt: now,
    });
  }
  return {
    ...next,
    timingModelVersion: base.timingModelVersion || "estimate-calibration-v1",
    timingTrackedSinceAt: base.timingTrackedSinceAt || now,
    firstStartedAt,
    activeStartedAt,
    blockedStartedAt,
    activeDurationMs,
    blockedDurationMs,
    estimateHistory: estimateHistory.slice(-50),
    expectedAtHistory: expectedAtHistory.slice(-50),
  };
}

function safeDuration(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function durationBetween(start, end) {
  const startAt = Date.parse(start);
  const endAt = Date.parse(end);
  return Number.isFinite(startAt) && Number.isFinite(endAt) ? Math.max(0, endAt - startAt) : 0;
}

function cleanAcceptanceCriteria(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((item) => {
    if (typeof item === "string") return [cleanText(item, 500)].filter(Boolean);
    if (!item || typeof item !== "object") return [];
    const id = cleanText(item.id, 120);
    const description = cleanText(item.description ?? item.title, 500);
    if (!id || !description) return [];
    return [{ id, description, required: item.required !== false }];
  });
}

export class TaskLedgerError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}
