import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { taskTimeState, STALE_TASK_MS } from "../app/task-time-state.mjs";

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
export { taskTimeState, STALE_TASK_MS };

export function loadTasks() {
  return readLedger()
    .filter((task) => task.status !== "removed")
    .map((task) => ({ ...task, sessionId: canonicalSessionId(task.sessionId) }));
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

export function loadSessionRegistry() {
  let registry = {};
  if (existsSync(sessionRegistryPath)) {
    try {
      const value = JSON.parse(readFileSync(sessionRegistryPath, "utf8"));
      registry = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      registry = {};
    }
  }
  // 兼容注册表上线前的历史事件：已有 session.register 也应显示为已登记。
  try {
    if (existsSync(taskEventsPath)) {
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
  return normalized;
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
      registeredAt: entry?.registeredAt || "",
      lastSeenAt: entry?.lastSeenAt || "",
      status: entry ? "registered" : "unregistered",
      reason: entry ? "已登记 Session，等待任务或持续上报" : "未发现 session.register",
      taskCount: sessionTasks.length,
      lastTaskAt: sessionTasks.reduce((latest, task) => task.updatedAt > latest ? task.updatedAt : latest, ""),
    };
  });
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
  if (!existsSync(taskLedgerPath)) return [];
  try {
    const value = JSON.parse(readFileSync(taskLedgerPath, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function recordTaskEvent(input, options = {}) {
  const event = normalizeEvent(input);
  const sessionRegistry = loadSessionRegistry();
  const isRegistered = Boolean(sessionRegistry[event.session_id]);

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
  const tasks = loadTasks();
  const current = event.task_id ? tasks.find((task) => task.id === event.task_id) : null;
  const processed = loadProcessedEventIds();
  if (processed.has(event.event_id)) {
    const original = findStoredTaskEvent(event.event_id);
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
    if (!event.event_id.startsWith("manual-") && current.sessionId && current.sessionId !== event.session_id) {
      throw new TaskLedgerError(403, "当前 Session 不是该任务的登记 Session。");
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
  let next = event.type === "session.register" ? null : applyEvent(current, event);
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
  persistTasks(nextTasks);
  touchSession(event);
  processed.add(event.event_id);
  persistProcessedEventIds(processed);
  return { event, task: next, supersededTaskIds };
}

const activeTaskStatuses = new Set(["planned", "in_progress", "blocked"]);

const idempotentEventFields = [
  "event_id", "type", "task_id", "context_task_id", "requirement_id", "session_id",
  "agent", "provider", "model", "workspace", "title", "goal", "status", "priority",
  "plan", "current_step", "next_action", "blocker", "acceptance_criteria", "changed_files",
  "tests", "evidence", "assumptions", "risks", "tradeoffs", "open_questions", "retrospective",
  "expected_at", "archived_at", "superseded_by", "review_reason", "reviewed_at", "tool_name",
  "tool_use_id", "routing_action", "orchestrator_model", "preferred_executor_model",
  "selected_executor_model", "dispatch_channel", "routing_reason", "routing_outcome", "policy_version",
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
  const pick = (event) => Object.fromEntries(idempotentEventFields.map((field) => [field, event[field]]));
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
  });
  return { task: result.task, created: true, resumed: false, reactivated: false };
}

/** 仅由 context.complete_task 调用；commit_turn / SessionEnd 不应进入此路径。 */
export function completeContextTasks(input) {
  const contextTaskId = cleanText(input?.context_task_id, 200);
  if (!contextTaskId) throw new TaskLedgerError(400, "缺少 context_task_id。");
  const completed = [];
  for (const task of loadTasks().filter(
    (item) => item.contextTaskId === contextTaskId && activeTaskStatuses.has(item.status)
  )) {
    const result = recordTaskEvent({
      type: "task.report",
      event_id: `context-complete-${contextIdentity(`${contextTaskId}:${task.id}:${task.lastEventId || task.updatedAt}`)}`,
      task_id: task.id,
      context_task_id: contextTaskId,
      session_id: task.sessionId,
      status: "done_claimed",
      current_step: "ProjectContext semantic task 已完成。",
      evidence: [cleanText(input.summary, 1_000)].filter(Boolean),
    });
    completed.push(result.task);
  }
  return { contextTaskId, completed };
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

function normalizeEvent(input) {
  if (!input || typeof input !== "object") throw new TaskLedgerError(400, "任务事件必须是 JSON 对象。");
  const type = String(input.type || "");
  const sessionId = String(input.session_id || "");
  const allowedTypes = new Set(["session.register", "task.create", "task.update", "task.blocked", "task.done_claimed", "task.report", "task.review", "tool.call", "routing.decision"]);
  if (!allowedTypes.has(type)) throw new TaskLedgerError(400, "任务事件类型无效。");
  if (!sessionId) throw new TaskLedgerError(400, "任务事件缺少 session_id。");
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
    title: cleanText(input.title, 200),
    goal: cleanText(input.goal, 1_000),
    status: statuses.has(input.status) ? input.status : undefined,
    priority: cleanText(input.priority, 20),
    plan: cleanList(input.plan, 20, 500),
    current_step: cleanText(input.current_step, 500),
    next_action: cleanText(input.next_action, 500),
    blocker: cleanText(input.blocker, 1_000),
    acceptance_criteria: cleanList(input.acceptance_criteria, 20, 500),
    changed_files: cleanList(input.changed_files, 50, 500),
    tests: cleanList(input.tests, 30, 500),
    evidence: cleanList(input.evidence, 30, 1_000),
    assumptions: cleanList(input.assumptions, 20, 500),
    risks: cleanList(input.risks, 20, 500),
    tradeoffs: cleanList(input.tradeoffs, 20, 500),
    open_questions: cleanList(input.open_questions, 20, 500),
    retrospective: cleanText(input.retrospective, 2_000),
    expected_at: cleanText(input.expected_at, 80),
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
    policy_version: cleanText(input.policy_version, 80),
    created_at: new Date().toISOString(),
  };
  if (event.expected_at && !Number.isFinite(Date.parse(event.expected_at))) {
    throw new TaskLedgerError(400, "expected_at 必须是可解析的 ISO 时间。");
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
    };
    return {
      ...current,
      routing,
      routingHistory: [...(current.routingHistory || []), routing].slice(-routingHistoryLimit),
      routingRecordedAt: event.created_at,
    };
  }
  const now = event.created_at;
  const base = current || {
    id: event.task_id,
    sessionId: event.session_id,
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
    createdAt: now,
  };
  const next = {
    ...base,
    sessionId: event.session_id || base.sessionId,
    agent: event.agent !== "unknown" ? event.agent : (base.agent || "unknown"),
    provider: event.provider !== "unknown" ? event.provider : (base.provider || "unknown"),
    model: event.model !== "unknown" ? event.model : (base.model || "unknown"),
    workspace: event.workspace || base.workspace,
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
    expectedAt: event.expected_at || base.expectedAt || "",
    archivedAt: event.archived_at === "__UNARCHIVE__" ? "" : (event.archived_at || base.archivedAt || ""),
    supersededBy: event.superseded_by || base.supersededBy,
    supersededAt: event.superseded_by ? now : (base.supersededAt || ""),
    actualAt: event.status === "in_progress"
      ? ""
      : event.type === "task.done_claimed" || event.status === "done_claimed" || event.status === "cancelled" ? (base.actualAt || now) : (base.actualAt || ""),
    reviewReason: event.review_reason || base.reviewReason || "",
    reviewedAt: event.reviewed_at || base.reviewedAt || "",
    toolCalls: { ...(base.toolCalls || {}) },
  };
  if (event.type === "tool.call" && event.tool_name) next.toolCalls[event.tool_name] = (next.toolCalls[event.tool_name] || 0) + 1;
  if (event.type === "task.review") next.status = event.status || base.status;
  return next;
}

function touchSession(event) {
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
      registeredAt: current?.registeredAt || now,
      lastSeenAt: now,
    };
    mkdirSync(dirname(sessionRegistryPath), { recursive: true });
    const temporaryPath = `${sessionRegistryPath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, sessionRegistryPath);
  }
}

function persistTasks(tasks) {
  mkdirSync(dirname(taskLedgerPath), { recursive: true });
  const temporaryPath = `${taskLedgerPath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(tasks.slice(-500), null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, taskLedgerPath);
}

function cleanText(value, limit) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function cleanList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string").map((item) => cleanText(item, maxLength)).filter(Boolean).slice(0, maxItems);
}

export class TaskLedgerError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}
