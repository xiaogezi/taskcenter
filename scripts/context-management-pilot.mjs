import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const actions = new Set(["enable", "disable", "refresh"]);
const results = new Set(["pending", "processing", "succeeded", "failed"]);
const activeTaskStatuses = new Set(["planned", "in_progress", "blocked"]);
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export class ContextManagementPilotError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function contextManagementPilotEventsPath(projectRoot) {
  return resolve(process.env.TASKCENTER_CONTEXT_MANAGEMENT_PILOT_EVENTS_PATH || join(projectRoot, "data", "context-management-pilot-events.jsonl"));
}

export function readContextManagementPilotEvents(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export function appendContextManagementPilotEvent(path, input) {
  const event = normalizeEvent(input);
  const existing = readContextManagementPilotEvents(path).find((item) => item.event_id === event.event_id);
  if (existing) return existing;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  return event;
}

export function createContextManagementIntent(path, input) {
  const requestId = String(input.request_id || "");
  if (!uuidPattern.test(requestId)) throw new ContextManagementPilotError(400, "request_id 必须是 UUID。");
  if (!actions.has(input.action)) throw new ContextManagementPilotError(400, "试点操作无效。");
  const replay = readContextManagementPilotEvents(path).find((item) => item.type === "context_management.intent.created" && item.request_id === requestId);
  if (replay) return { intent: replay, idempotent: true };
  const intent = appendContextManagementPilotEvent(path, {
    type: "context_management.intent.created",
    event_id: `context-management-intent-${requestId}`,
    intent_id: randomUUID(),
    request_id: requestId,
    project_id: input.project_id,
    workspace: input.workspace,
    workspaces: Array.isArray(input.workspaces) ? input.workspaces : [input.workspace],
    action: input.action,
    status: "pending",
    occurred_at: input.occurred_at,
  });
  return { intent, idempotent: false };
}

export function updateContextManagementIntent(path, intentId, status, patch = {}) {
  if (!uuidPattern.test(String(intentId || ""))) throw new ContextManagementPilotError(400, "intent_id 无效。");
  if (!results.has(status)) throw new ContextManagementPilotError(400, "试点回执状态无效。");
  const events = readContextManagementPilotEvents(path);
  const created = events.find((item) => item.type === "context_management.intent.created" && item.intent_id === intentId);
  if (!created) throw new ContextManagementPilotError(404, "试点 intent 不存在。");
  if (patch.project_id && patch.project_id !== created.project_id) throw new ContextManagementPilotError(409, "试点 intent 与项目不匹配。");
  return appendContextManagementPilotEvent(path, {
    type: "context_management.intent.status",
    event_id: String(patch.event_id || randomUUID()),
    intent_id: intentId,
    request_id: created.request_id,
    project_id: created.project_id,
    workspace: created.workspace,
    action: created.action,
    status,
    message: patch.message,
    observed_state: patch.observed_state,
    evidence: patch.evidence,
    occurred_at: patch.occurred_at,
  });
}

export function recordContextManagementTrial(path, input) {
  const projectId = bounded(input.project_id, 200);
  const taskId = bounded(input.task_id, 200);
  if (!projectId || !taskId) throw new ContextManagementPilotError(400, "试点报告缺少 project_id 或 task_id。");
  return appendContextManagementPilotEvent(path, {
    type: "context_management.trial.reported",
    event_id: String(input.event_id || randomUUID()),
    project_id: projectId,
    workspace: input.workspace,
    task_id: taskId,
    prepare_turn: normalizeKnown(input.prepare_turn, ["passed", "failed", "unknown"]),
    repeated_reads: finiteOrUnknown(input.repeated_reads),
    recovery_cost_tokens: finiteOrUnknown(input.recovery_cost_tokens),
    rework_count: finiteOrUnknown(input.rework_count),
    authority_violations: finiteOrUnknown(input.authority_violations),
    note: input.note,
    occurred_at: input.occurred_at,
  });
}

export function contextManagementPilotSnapshot({ registry = {}, tasks = [], usageReport = {}, events = [], now = new Date().toISOString() }) {
  const projects = registeredProjects(registry);
  const intentStates = reduceIntents(events);
  const reports = reduceTrials(events);
  const usageByTask = new Map((usageReport?.lifetime?.byTask || []).map((item) => [item.id, item]));
  return {
    schema_version: "taskcenter-context-management-pilot/v1",
    generated_at: now,
    projects: projects.map((project) => {
      const projectTasks = tasks.filter((task) => project.workspaces.includes(resolve(String(task.workspace || "."))));
      const trials = [...reports.values()]
        .filter((report) => report.project_id === project.project_id)
        .sort((left, right) => String(left.occurred_at).localeCompare(String(right.occurred_at)))
        .slice(-3)
        .map((report) => enrichTrial(report, projectTasks, usageByTask));
      return {
        ...project,
        context_management: inspectProjectConfigs(project.workspaces, now),
        latest_intent: [...intentStates.values()].filter((intent) => intent.project_id === project.project_id).sort((left, right) => String(left.updated_at).localeCompare(String(right.updated_at))).at(-1) || null,
        trial: { completed: trials.length, target: 3, tasks: trials },
      };
    }),
  };
}

export function resolveMainBrainTarget(tasks = [], registry = {}, targetProjectId = "") {
  const candidates = tasks.filter((task) => activeTaskStatuses.has(task.status))
    .filter((task) => registry[task.sessionId])
    .filter((task) => task.sessionId && String(registry[task.sessionId]?.projectId || "") !== targetProjectId)
    .filter((task) => /(?:^|[\\/])DevWorkbench(?:[\\/]|$)/i.test(task.workspace || registry[task.sessionId]?.workspace || ""))
    .sort((left, right) => String(left.updatedAt || left.createdAt || "").localeCompare(String(right.updatedAt || right.createdAt || "")));
  const task = candidates.at(-1);
  if (!task) throw new ContextManagementPilotError(409, "未找到已登记且活跃的 DevWorkbench 主脑 Session。");
  const session = registry[task.sessionId];
  return { session_id: task.sessionId, workspace: session.workspace || task.workspace, task_id: task.id };
}

export function buildContextManagementIntentPrompt(intent, callbackBase = "http://127.0.0.1:3001") {
  const behavior = intent.action === "disable"
    ? "当前正在运行的 Astra 任务先软停止依赖自动历史；在目标项目关闭 experimental_mode 后，新建 Astra 任务完成硬回退。"
    : intent.action === "enable"
      ? "只在目标项目启用 experimental_mode；该设置仅对之后新建的 Astra 任务生效。"
      : "只刷新项目配置与试点证据，不修改目标项目。";
  return [
    "[TaskCenter 主脑接续] context_management 试点 intent 已创建。",
    `intentId=${intent.intent_id}`,
    `project=${intent.project_id}`,
    `workspace=${intent.workspace}`,
    `registeredWorkspaces=${(intent.workspaces || [intent.workspace]).join(",")}`,
    `action=${intent.action}`,
    behavior,
    "请遵守目标项目 AGENTS、TaskCenter 与 ProjectContext 门禁，创建或复用合法项目任务并派发；TaskCenter 本身不得修改目标项目或 ~/.codex。",
    "完成或失败后向以下本机接口 POST JSON 回执：",
    `${callbackBase}/context-management-pilots/${encodeURIComponent(intent.project_id)}/intents/${intent.intent_id}/result`,
    "Headers: Content-Type=application/json, X-TaskCenter-Task=mcp",
    "Body: {status:'succeeded'|'failed', observed_state:'enabled'|'disabled'|'unknown', message, evidence:[...]}。",
  ].join("\n");
}

function registeredProjects(registry) {
  const values = new Map();
  for (const session of Object.values(registry)) {
    const projectId = bounded(session?.projectId || session?.project_id, 200);
    const workspace = session?.workspace ? resolve(String(session.workspace)) : "";
    if (!projectId || !workspace) continue;
    const current = values.get(projectId) || { project_id: projectId, workspace, workspaces: [] };
    if (!current.workspaces.includes(workspace)) current.workspaces.push(workspace);
    values.set(projectId, current);
  }
  return [...values.values()].map((item) => ({ ...item, workspaces: item.workspaces.sort() })).sort((left, right) => left.project_id.localeCompare(right.project_id, "en"));
}

export function projectRootFromWorkspace(workspace) {
  if (!workspace) return "";
  const value = resolve(String(workspace));
  const match = value.match(/^(.*[\\/])([^\\/]+)-worktrees[\\/][^\\/]+(?:[\\/].*)?$/);
  return match ? resolve(match[1], match[2]) : value;
}

export function inspectProjectConfig(workspace, observedAt = new Date().toISOString()) {
  const configPath = join(workspace, ".codex", "config.toml");
  try {
    if (!existsSync(configPath)) return { state: "unknown", experimental_mode: "unknown", config_path: configPath, observed_at: observedAt, applies_to: "new_tasks_only", error: "未配置" };
    const info = lstatSync(configPath);
    if (!info.isFile() || info.isSymbolicLink()) return { state: "unknown", experimental_mode: "unknown", config_path: configPath, observed_at: observedAt, applies_to: "new_tasks_only", error: "配置不是普通文件" };
    const value = parseExperimentalMode(readFileSync(configPath, "utf8"));
    return { state: value === true ? "enabled" : value === false ? "disabled" : "unknown", experimental_mode: value, config_path: configPath, observed_at: observedAt, applies_to: "new_tasks_only" };
  } catch (error) {
    return { state: "unknown", experimental_mode: "unknown", config_path: configPath, observed_at: observedAt, applies_to: "new_tasks_only", error: bounded(error instanceof Error ? error.message : "读取失败", 300) };
  }
}

export function inspectProjectConfigs(workspaces, observedAt = new Date().toISOString()) {
  const evidence = [...new Set(workspaces || [])].map((workspace) => ({ workspace, ...inspectProjectConfig(workspace, observedAt) }));
  const known = evidence.filter((item) => item.state !== "unknown");
  const states = new Set(known.map((item) => item.state));
  const state = states.size === 1 && known.length === evidence.length ? known[0].state : "unknown";
  return {
    state,
    experimental_mode: state === "enabled" ? true : state === "disabled" ? false : "unknown",
    observed_at: observedAt,
    applies_to: "new_tasks_only",
    evidence,
    error: states.size > 1 ? "已登记 workspace 配置冲突" : known.length !== evidence.length ? "部分 workspace 未配置或不可核实" : undefined,
  };
}

export function parseExperimentalMode(source) {
  let inSection = false;
  for (const raw of String(source || "").split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const section = line.match(/^\[([^\]]+)]$/);
    if (section) { inSection = section[1].trim() === "features.context_management"; continue; }
    if (!inSection) continue;
    const value = line.match(/^experimental_mode\s*=\s*(true|false)\s*$/i);
    if (value) return value[1].toLowerCase() === "true";
  }
  return "unknown";
}

function reduceIntents(events) {
  const values = new Map();
  for (const event of events) {
    if (event.type === "context_management.intent.created") values.set(event.intent_id, { ...event, updated_at: event.occurred_at });
    if (event.type === "context_management.intent.status" && values.has(event.intent_id)) values.set(event.intent_id, { ...values.get(event.intent_id), ...event, updated_at: event.occurred_at });
  }
  return values;
}

function reduceTrials(events) {
  const values = new Map();
  for (const event of events) if (event.type === "context_management.trial.reported") values.set(`${event.project_id}:${event.task_id}`, event);
  return values;
}

function enrichTrial(report, tasks, usageByTask) {
  const task = tasks.find((item) => item.id === report.task_id);
  const usage = usageByTask.get(report.task_id)?.usage;
  const prepareTurn = report.prepare_turn !== "unknown"
    ? report.prepare_turn
    : task && Object.entries(task.toolCalls || {}).some(([name, count]) => /(?:^|\.)prepare_turn$/.test(name) && Number(count) > 0) ? "passed" : "unknown";
  return {
    task_id: report.task_id,
    prepare_turn: prepareTurn,
    repeated_reads: report.repeated_reads,
    recovery_cost_tokens: report.recovery_cost_tokens,
    input_tokens: Number.isFinite(Number(usage?.input)) ? Number(usage.input) : "unknown",
    cached_input_tokens: Number.isFinite(Number(usage?.cachedInput)) ? Number(usage.cachedInput) : "unknown",
    rework_count: report.rework_count,
    verification: task?.verificationStatus || "unknown",
    review: task?.reviewStatus || "unknown",
    authority_violations: report.authority_violations,
    note: report.note || "",
    observed_at: report.occurred_at,
  };
}

function normalizeEvent(input) {
  const now = new Date().toISOString();
  return {
    ...input,
    event_id: bounded(input.event_id || randomUUID(), 200),
    project_id: bounded(input.project_id, 200),
    workspace: bounded(input.workspace, 500),
    message: bounded(input.message, 500),
    note: bounded(input.note, 500),
    evidence: Array.isArray(input.evidence) ? input.evidence.slice(0, 12).map((item) => bounded(item, 500)).filter(Boolean) : [],
    occurred_at: validDate(input.occurred_at) || now,
    recorded_at: now,
  };
}

function normalizeKnown(value, allowed) {
  return allowed.includes(value) ? value : "unknown";
}

function finiteOrUnknown(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : "unknown";
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : "";
}

function bounded(value, limit) {
  return String(value || "").trim().slice(0, limit);
}
