import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const projectRoot = resolve(import.meta.dirname, "..");
export const taskEventsPath = resolve(process.env.REQRADAR_TASK_EVENTS_PATH || join(projectRoot, "data", "task-events.jsonl"));
export const taskLedgerPath = resolve(process.env.REQRADAR_TASK_LEDGER_PATH || join(projectRoot, "data", "task-ledger.json"));
export const processedEventIdsPath = resolve(process.env.REQRADAR_TASK_EVENT_IDS_PATH || join(projectRoot, "data", "task-event-ids.json"));
export const taskReconcilePath = resolve(process.env.REQRADAR_TASK_RECONCILE_PATH || join(projectRoot, "data", "task-reconcile.jsonl"));
export const sessionRegistryPath = resolve(process.env.REQRADAR_SESSION_REGISTRY_PATH || join(projectRoot, "data", "session-registry.json"));
export const sessionMergesPath = resolve(process.env.REQRADAR_SESSION_MERGES_PATH || join(projectRoot, "data", "session-merges.json"));

const statuses = new Set(["planned", "in_progress", "blocked", "done_claimed", "verified", "cancelled", "removed"]);
const demoPattern = /^ui-demo-/;

export function loadTasks() {
  return readLedger()
    .filter((task) => task.status !== "removed")
    .map((task) => ({ ...task, sessionId: canonicalSessionId(task.sessionId) }));
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
  const available = new Set([...availableSessionIds].filter((id) => typeof id === "string" && id));
  const registered = new Set(Object.keys(loadSessionRegistry()));
  const tasks = readLedger();
  const stale = tasks.filter((task) => task.status !== "removed" && !available.has(task.sessionId) && !registered.has(task.sessionId));
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
    throw new TaskLedgerError(409, "当前 Session 尚未登记，请先调用 reqradar_session_register。");
  }
  const tasks = loadTasks();
  const current = event.task_id ? tasks.find((task) => task.id === event.task_id) : null;
  const processed = loadProcessedEventIds();
  if (processed.has(event.event_id)) {
    // 事件幂等：同一 event_id 重复投递时直接返回已有状态，不再写入或重放副作用。
    return { event, task: current ?? null, idempotent: true };
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
  const next = event.type === "session.register" ? null : applyEvent(current, event);
  const nextTasks = next
    ? current ? tasks.map((task) => task.id === next.id ? next : task) : [...tasks, next]
    : tasks;
  mkdirSync(dirname(taskEventsPath), { recursive: true });
  appendFileSync(taskEventsPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  persistTasks(nextTasks);
  touchSession(event);
  processed.add(event.event_id);
  persistProcessedEventIds(processed);
  return { event, task: next };
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
  const allowedTypes = new Set(["session.register", "task.create", "task.update", "task.blocked", "task.done_claimed", "task.report", "task.review"]);
  if (!allowedTypes.has(type)) throw new TaskLedgerError(400, "任务事件类型无效。");
  if (!sessionId) throw new TaskLedgerError(400, "任务事件缺少 session_id。");
  if (type !== "session.register" && type !== "task.create" && !String(input.task_id || "")) {
    throw new TaskLedgerError(400, "任务事件缺少 task_id。");
  }
  return {
    event_id: String(input.event_id || randomUUID()),
    type,
    task_id: String(input.task_id || (type === "task.create" ? `task-${randomUUID()}` : "")),
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
    created_at: new Date().toISOString(),
  };
}

function applyEvent(current, event) {
  // 会话不能自行把任务标成"已验收"。验收必须由 ReqRadar 基于代码/测试证据单独判定，
  // done_claimed 只能停留在"声明完成"，不会自动升级为 verified。
  if (event.status === "verified") {
    throw new TaskLedgerError(400, "会话不能直接把任务标记为已验收；验收需由 ReqRadar 基于证据判定。");
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
  };
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
      agent: event.agent || current?.agent || "unknown",
      provider: event.provider || current?.provider || "unknown",
      model: event.model || current?.model || "unknown",
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
