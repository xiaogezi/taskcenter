import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const actions = new Set(["enable", "disable", "refresh"]);
const statuses = new Set(["pending", "processing", "succeeded", "failed"]);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export class ContextManagementPilotError extends Error {
  constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}

export function pilotEventsPath(projectRoot) {
  return resolve(process.env.TASKCENTER_CONTEXT_MANAGEMENT_PILOT_EVENTS_PATH || join(projectRoot, "data", "context-management-pilot-events.jsonl"));
}

export function readPilotEvents(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export function createPilotIntent(path, input) {
  const requestId = String(input.request_id || "");
  if (!uuid.test(requestId)) throw new ContextManagementPilotError(400, "request_id 必须是 UUID。");
  if (!actions.has(input.action)) throw new ContextManagementPilotError(400, "试点操作无效。");
  const replay = readPilotEvents(path).find((event) => event.type === "context_management.intent" && event.request_id === requestId);
  if (replay) return { intent: replay, idempotent: true };
  return {
    intent: appendPilotEvent(path, {
      type: "context_management.intent",
      event_id: `context-management-intent-${requestId}`,
      intent_id: randomUUID(),
      request_id: requestId,
      project_id: input.project_id,
      workspace: input.workspace,
      action: input.action,
      status: "pending",
      occurred_at: input.occurred_at,
    }),
    idempotent: false,
  };
}

export function updatePilotIntent(path, intentId, status, patch = {}) {
  if (!uuid.test(String(intentId || "")) || !statuses.has(status)) throw new ContextManagementPilotError(400, "试点回执无效。");
  const history = readPilotEvents(path).filter((event) => event.intent_id === intentId);
  const created = history.find((event) => event.type === "context_management.intent");
  if (!created) throw new ContextManagementPilotError(404, "试点 intent 不存在。");
  const latest = history.at(-1);
  if (latest?.status === status) return latest;
  if (["succeeded", "failed"].includes(latest?.status)) throw new ContextManagementPilotError(409, "试点 intent 已进入终态，请新建操作。");
  return appendPilotEvent(path, {
    ...created,
    type: "context_management.intent.status",
    event_id: String(patch.event_id || randomUUID()),
    status,
    message: patch.message,
    observed_state: patch.observed_state,
    evidence: patch.evidence,
    occurred_at: patch.occurred_at,
  });
}

export function recordPilotTrial(path, input) {
  if (!String(input.project_id || "") || !String(input.workspace || "") || !String(input.task_id || "")) {
    throw new ContextManagementPilotError(400, "试点报告缺少 project_id、workspace 或 task_id。");
  }
  const qualificationEvidence = Array.isArray(input.qualification_evidence)
    ? input.qualification_evidence.slice(0, 12).map((item) => text(item, 500)).filter(Boolean)
    : [];
  return appendPilotEvent(path, {
    type: "context_management.trial",
    event_id: String(input.event_id || randomUUID()),
    project_id: input.project_id,
    workspace: input.workspace,
    task_id: input.task_id,
    prepare_turn: known(input.prepare_turn, ["passed", "failed", "unknown"]),
    repeated_reads: numberOrUnknown(input.repeated_reads),
    recovery_cost_tokens: numberOrUnknown(input.recovery_cost_tokens),
    rework_count: numberOrUnknown(input.rework_count),
    authority_violations: numberOrUnknown(input.authority_violations),
    natural_long_task: input.natural_long_task === true && qualificationEvidence.length ? "qualified" : "unknown",
    qualification_evidence: qualificationEvidence,
    note: input.note,
    occurred_at: input.occurred_at,
  });
}

export function pilotSnapshot({ registry = {}, sessionTitles = [], tasks = [], usageReport = {}, events = [], now = new Date().toISOString() }) {
  const intents = latestIntents(events);
  const reports = latestTrials(events);
  const usageByTask = new Map((usageReport?.lifetime?.byTask || []).map((row) => [row.id, row.usage]));
  return {
    schema_version: "taskcenter-context-management-pilot/v1",
    generated_at: now,
    projects: registeredProjectWorkspaces(registry, sessionTitles).map((project) => {
      const projectIntents = [...intents.values()]
        .filter((intent) => intent.project_id === project.project_id && resolve(intent.workspace) === project.workspace)
        .sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
      const latestIntent = projectIntents.at(-1) || null;
      const terminalToggle = projectIntents.filter((intent) => intent.status === "succeeded" && ["enable", "disable"].includes(intent.action)).at(-1);
      const activationAt = terminalToggle?.action === "enable" ? terminalToggle.occurred_at : "";
      const projectTasks = tasks
        .filter((task) => resolve(task.workspace || registry[task.sessionId]?.workspace || "") === project.workspace)
        .filter((task) => /astra/i.test(String(task.model || "")))
        .filter((task) => activationAt && Date.parse(task.createdAt || "") >= Date.parse(activationAt))
        .filter((task) => reports.get(`${project.project_id}:${project.workspace}:${task.id}`)?.natural_long_task === "qualified")
        .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
        .slice(0, 3);
      const trials = projectTasks.map((task) => enrichTrial(
        reports.get(`${project.project_id}:${project.workspace}:${task.id}`),
        task,
        usageByTask.get(task.id),
      ));
      return {
        ...project,
        context_management: inspectProjectConfig(project.workspace, now),
        latest_intent: latestIntent,
        trial: { completed: trials.filter((trial) => trial.reported).length, target: 3, tasks: trials },
      };
    }),
  };
}

export function registeredProjectWorkspaces(registry, sessionTitles = []) {
  const titles = new Map(sessionTitles.map((item) => [item.id, item]));
  const projects = new Map();
  for (const [registryId, session] of Object.entries(registry)) {
    const projectId = text(session?.projectId || session?.project_id, 200);
    const workspace = text(session?.workspace, 500);
    if (!projectId || !workspace || workspace === "/") continue;
    const resolved = resolve(workspace);
    const key = `${projectId}\u0000${resolved}`;
    const project = projects.get(key) || { project_id: projectId, workspace: resolved, sessions: [] };
    const sessionId = text(session?.sessionId || registryId, 200);
    const indexed = titles.get(sessionId);
    const lastSeenAt = text(session?.lastSeenAt, 100);
    const updatedAt = [lastSeenAt, text(indexed?.updatedAt, 100)].filter(Boolean).sort((a, b) => (Date.parse(a) || 0) - (Date.parse(b) || 0)).at(-1) || "";
    project.sessions.push({ session_id: sessionId, title: indexed?.title || "", last_seen_at: lastSeenAt, updated_at: updatedAt });
    projects.set(key, project);
  }
  return [...projects.values()]
    .map((project) => ({ ...project, sessions: project.sessions.sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0) || a.session_id.localeCompare(b.session_id)) }))
    .sort((a, b) => `${a.project_id}:${a.workspace}`.localeCompare(`${b.project_id}:${b.workspace}`, "zh-CN"));
}

export function inspectProjectConfig(workspace, observedAt = new Date().toISOString()) {
  const configPath = join(workspace, ".codex", "config.toml");
  const base = { config_path: configPath, observed_at: observedAt, applies_to: "new_tasks_only" };
  try {
    if (!existsSync(configPath)) return { ...base, state: "unknown", experimental_mode: "unknown" };
    const info = lstatSync(configPath);
    if (!info.isFile() || info.isSymbolicLink()) return { ...base, state: "unknown", experimental_mode: "unknown" };
    const value = parseExperimentalMode(readFileSync(configPath, "utf8"));
    return { ...base, state: value === true ? "enabled" : value === false ? "disabled" : "unknown", experimental_mode: value };
  } catch {
    return { ...base, state: "unknown", experimental_mode: "unknown" };
  }
}

export function parseExperimentalMode(source) {
  if (/'''|"""/.test(String(source || ""))) return "unknown";
  let section = "";
  let targetSections = 0;
  let value = "unknown";
  for (const raw of String(source || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const heading = line.match(/^\[([^\]]+)]\s*(?:#.*)?$/);
    if (line.startsWith("[") && !heading) return "unknown";
    if (heading) {
      section = heading[1].trim();
      if (section === "features.context_management") targetSections += 1;
      if (targetSections > 1) return "unknown";
      continue;
    }
    if (section !== "features.context_management") continue;
    if (!/^(?:experimental_mode|["']experimental_mode["'])\s*=/.test(line)) continue;
    const match = line.match(/^(?:experimental_mode|"experimental_mode"|'experimental_mode')\s*=\s*(true|false)\s*(?:#.*)?$/);
    if (!match || value !== "unknown") return "unknown";
    value = match[1].toLowerCase() === "true";
  }
  return value;
}

export function buildPilotPrompt(intent, callbackBase = "http://127.0.0.1:3001") {
  const instruction = intent.action === "enable"
    ? "在目标 workspace 的项目级 .codex/config.toml 中启用 [features.context_management] experimental_mode=true；仅影响之后新建的 Astra 任务。"
    : intent.action === "disable"
      ? "在目标 workspace 的项目级 .codex/config.toml 中明确关闭 experimental_mode；当前任务只能软停止依赖历史，硬回退需要新建 Astra 任务。"
      : "只刷新配置与三任务试点证据，不修改项目配置。";
  return [
    "[TaskCenter 主脑唤醒] 收到 context_management 项目试点 intent。",
    `intent_id=${intent.intent_id}`,
    `project_id=${intent.project_id}`,
    `workspace=${intent.workspace}`,
    `action=${intent.action}`,
    instruction,
    "请遵守目标项目 AGENTS，先登记 Session 和正式任务，再由主脑派发目标项目。TaskCenter 不得直接修改目标项目或 ~/.codex。",
    "完成或失败后回写本机控制 API：",
    `${callbackBase}/context-management-pilots/intents/${intent.intent_id}/result`,
    "Header: Content-Type=application/json, X-TaskCenter-Task=mcp",
    "Body: {status:'succeeded'|'failed', observed_state:'enabled'|'disabled'|'unknown', message, evidence:[...]}。",
    "每个自然长任务另向 /context-management-pilots/trials 上报 natural_long_task=true、qualification_evidence，以及 prepare_turn、重复读取、恢复成本、返工、验证、Review、权威违规；不能证明的值写 unknown。",
  ].join("\n");
}

export function resolvePilotMainBrain(tasks, registry) {
  const task = tasks
    .filter((item) => ["planned", "in_progress", "blocked"].includes(item.status))
    .filter((item) => registry[item.sessionId])
    .filter((item) => /(?:^|[\\/])DevWorkbench(?:[\\/]|$)/i.test(item.workspace || registry[item.sessionId]?.workspace || ""))
    .sort((a, b) => String(a.updatedAt || a.createdAt || "").localeCompare(String(b.updatedAt || b.createdAt || "")))
    .at(-1);
  if (!task) throw new ContextManagementPilotError(409, "未找到已登记且活跃的 DevWorkbench 主脑 Session。");
  return { session_id: task.sessionId, workspace: registry[task.sessionId].workspace || task.workspace, task_id: task.id };
}

function appendPilotEvent(path, input) {
  const event = normalizeEvent(input);
  if (readPilotEvents(path).some((item) => item.event_id === event.event_id)) return event;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  return event;
}

function latestIntents(events) {
  const values = new Map();
  for (const event of events) {
    if (event.type === "context_management.intent") values.set(event.intent_id, event);
    if (event.type === "context_management.intent.status" && values.has(event.intent_id)) values.set(event.intent_id, { ...values.get(event.intent_id), ...event });
  }
  return values;
}

function latestTrials(events) {
  const values = new Map();
  for (const event of events) if (event.type === "context_management.trial") values.set(`${event.project_id}:${event.workspace}:${event.task_id}`, event);
  return values;
}

function enrichTrial(report, task, usage) {
  const calledPrepareTurn = task && Object.entries(task.toolCalls || {}).some(([name, count]) => /(?:^|_)context_prepare_turn$|(?:^|\.)prepare_turn$/.test(name) && Number(count) > 0);
  return {
    task_id: task.id,
    reported: Boolean(report),
    qualification_evidence: report?.qualification_evidence || [],
    prepare_turn: report?.prepare_turn !== "unknown" && report?.prepare_turn ? report.prepare_turn : calledPrepareTurn ? "passed" : "unknown",
    repeated_reads: report?.repeated_reads ?? "unknown",
    recovery_cost_tokens: report?.recovery_cost_tokens ?? "unknown",
    input_tokens: numberOrUnknown(usage?.input),
    cached_input_tokens: numberOrUnknown(usage?.cachedInput),
    rework_count: report?.rework_count ?? "unknown",
    verification: task?.verificationStatus || "unknown",
    review: task?.reviewStatus || "unknown",
    authority_violations: report?.authority_violations ?? "unknown",
    observed_at: report?.occurred_at || "unknown",
    note: report?.note || "",
  };
}

function normalizeEvent(input) {
  const now = new Date().toISOString();
  return {
    ...input,
    event_id: text(input.event_id || randomUUID(), 200),
    project_id: text(input.project_id, 200),
    workspace: text(input.workspace, 500),
    message: text(input.message, 500),
    note: text(input.note, 500),
    evidence: Array.isArray(input.evidence) ? input.evidence.slice(0, 12).map((item) => text(item, 500)).filter(Boolean) : [],
    occurred_at: validDate(input.occurred_at) || now,
    recorded_at: now,
  };
}

function known(value, allowed) { return allowed.includes(value) ? value : "unknown"; }
function numberOrUnknown(value) {
  if (value === null || typeof value === "boolean" || (typeof value === "string" && !value.trim())) return "unknown";
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : "unknown";
}
function validDate(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : ""; }
function text(value, limit) { return String(value || "").trim().slice(0, limit); }
