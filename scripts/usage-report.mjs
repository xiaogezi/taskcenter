import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_SESSIONS_ROOT = process.env.TASKCENTER_SESSIONS_ROOT || join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
const DEFAULT_LEDGER = join(import.meta.dirname, "..", "data", "task-ledger.json");
const DEFAULT_RATES = join(import.meta.dirname, "..", "config", "model-rates.json");
const WINDOWS = { "5h": 5 * 60 * 60_000, "24h": 24 * 60 * 60_000, "7d": 7 * 24 * 60 * 60_000 };

function filesUnder(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : [];
  });
}
function value(value, fallback = 0) { return Number.isFinite(Number(value)) ? Number(value) : fallback; }
function sessionIdFromFile(path) {
  return basename(path).match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i)?.[1]
    || basename(path).replace(/\.jsonl$/i, "");
}
function readJson(input, fallback) {
  if (input && typeof input === "object") return input;
  if (typeof input !== "string" || !existsSync(input)) return fallback;
  try { return JSON.parse(readFileSync(input, "utf8")); } catch { return fallback; }
}
function lines(input) {
  if (Array.isArray(input)) return input;
  if (typeof input !== "string" || !existsSync(input)) return [];
  return readFileSync(input, "utf8").split("\n").flatMap((line) => { try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; } });
}
function percentiles(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { average: null, p50: null, p95: null };
  const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
  return { average: sorted.reduce((a, b) => a + b, 0) / sorted.length, p50: percentile(.5), p95: percentile(.95) };
}
function walkLedger(ledger) {
  const rows = Array.isArray(ledger) ? ledger : Array.isArray(ledger?.tasks) ? ledger.tasks : ledger?.events || [];
  return rows.concat(Array.isArray(ledger?.events) ? ledger.events : []).filter(Boolean);
}
function taskIndex(ledger) {
  const tasks = new Map();
  const sessions = new Map();
  for (const row of walkLedger(ledger)) {
    const task = row.task_id ? { id: row.task_id, ...row } : row;
    if (!task.id && !task.taskId) continue;
    const id = task.id || task.taskId;
    if (task.session_id || task.sessionId || task.workspace || task.cwd) tasks.set(id, { ...tasks.get(id), ...task, id });
    const sid = task.session_id || task.sessionId;
    if (sid && id) sessions.set(sid, [...(sessions.get(sid) || []), id]);
  }
  return { tasks, sessions };
}
function rateFor(rates, model) {
  const entry = rates?.[model] || rates?.models?.[model];
  if (!entry) return null;
  return { input: value(entry.input ?? entry.inputPerMillion), cachedInput: value(entry.cachedInput ?? entry.cached_input ?? entry.cachedInputPerMillion), output: value(entry.output ?? entry.outputPerMillion) };
}
function price(usage, rate) {
  if (!rate) return null;
  const uncachedInput = Math.max(0, usage.input - usage.cachedInput);
  return (uncachedInput * rate.input + usage.cachedInput * rate.cachedInput + usage.output * rate.output) / 1_000_000;
}
function usageFrom(record) {
  const u = record?.payload?.info?.last_token_usage;
  if (!u || typeof u !== "object") return null;
  return { input: value(u.input_tokens), cachedInput: value(u.cached_input_tokens), output: value(u.output_tokens) };
}
function timestampFrom(record) {
  const raw = record?.timestamp ?? record?.created_at ?? record?.payload?.timestamp;
  const parsed = Date.parse(raw || "");
  return Number.isFinite(parsed) ? parsed : null;
}
function mergeUsage(target, usage) { for (const key of ["input", "cachedInput", "output"]) target[key] += usage[key]; }

export function parseSession(input, options = {}) {
  const sessionId = options.sessionId || (typeof input === "string" ? sessionIdFromFile(input) : "unknown");
  let model = "unknown";
  let contextWindow = 0;
  let cwd = "";
  const events = [];
  let missingTimestampUsage = 0;
  let phaseEnded = false;
  let compressionAfterPhase = 0;
  for (const record of lines(input)) {
    if (record.type === "session_meta") cwd = record.payload?.cwd || cwd;
    if (record.type === "event_msg" && ["task_complete", "task_done", "phase_complete"].includes(record.payload?.type)) phaseEnded = true;
    if (phaseEnded && (record.type === "compacted" || record.payload?.type === "context_compacted" || record.payload?.compacted === true || record.payload?.compaction)) {
      compressionAfterPhase++;
      phaseEnded = false;
    }
    if (record.type === "turn_context") {
      if (phaseEnded && (record.payload?.compaction || record.payload?.compacted)) compressionAfterPhase++;
      if (record.payload?.compaction || record.payload?.compacted) phaseEnded = false;
      model = record.payload?.model || model;
      contextWindow = value(record.payload?.model_context_window, contextWindow);
    }
    const usage = usageFrom(record);
    if (usage) {
      const at = timestampFrom(record);
      if (at === null) missingTimestampUsage++;
      else events.push({ at, model, usage, contextWindow: value(record.payload?.model_context_window || record.payload?.info?.model_context_window, contextWindow), credits: record.rate_limits?.credits || null });
    }
  }
  return { sessionId, cwd, events, compressionAfterPhase, missingTimestampUsage };
}

export function collectUsage({ sessionsRoot = DEFAULT_SESSIONS_ROOT, sessions, ledger = DEFAULT_LEDGER, rates = DEFAULT_RATES, now = new Date() } = {}) {
  const inputs = sessions || filesUnder(sessionsRoot).map((file) => ({ file, sessionId: sessionIdFromFile(file) }));
  const parsed = inputs.map((item) => parseSession(item.records || item.lines || item.file || item, { sessionId: item.sessionId })).filter((s) => s.events.length);
  const index = taskIndex(readJson(ledger, ledger));
  const rateTable = readJson(rates, rates);
  const at = new Date(now).getTime();
  const internalWindows = Object.fromEntries(Object.entries(WINDOWS).map(([name, duration]) => [name, { id: name, durationMs: duration, generatedAt: new Date(at).toISOString(), ...buildWindow(parsed, index, rateTable, at - duration, at) }]));
  const warnings = buildWarnings(parsed, index, internalWindows, at);
  const day = internalWindows["24h"];
  const windows = Object.fromEntries(Object.entries(internalWindows).map(([name, window]) => {
    const { rows, ...summary } = window;
    return [name, { ...summary, modelContinuations: rows.length }];
  }));
  return {
    generatedAt: new Date(at).toISOString(), windows, warnings, alerts: warnings,
    overall: {
      estimatedCredits: day.totals.cost,
      creditsEstimation: day.totals.costEstimation,
      modelContinuations: day.rows.length,
      input: day.totals.statistics,
      usage: day.totals.usage,
    },
  };
}

function buildWindow(parsed, index, rates, start, end) {
  const rows = [];
  for (const session of parsed) for (const event of session.events) if (event.at >= start && event.at <= end) {
    const taskIds = taskIdsAt(index, session.sessionId, event.at);
    rows.push({ ...event, sessionId: session.sessionId, project: session.cwd || "unattributed", taskIds: taskIds.length ? taskIds : ["unattributed"], cost: price(event.usage, rateFor(rates, event.model)), estimable: Boolean(rateFor(rates, event.model)) });
  }
  const groups = (key) => [...rows.reduce((map, row) => { const id = row[key] || "unattributed"; const item = map.get(id) || { [key]: id, usage: { input: 0, cachedInput: 0, output: 0 }, samples: [], cost: 0, estimableCount: 0, unestimable: false, count: 0 }; mergeUsage(item.usage, row.usage); item.samples.push(row.usage.input); if (row.estimable) { item.cost += row.cost; item.estimableCount++; } item.unestimable ||= !row.estimable; item.count++; map.set(id, item); return map; }, new Map()).values()];
  const by = (key) => groups(key).map((item) => ({ ...item, statistics: percentiles(item.samples) }));
  const byTask = [...rows.reduce((map, row) => { for (const taskId of row.taskIds) { const copy = { ...row, taskId }; const list = map.get(taskId) || []; list.push(copy); map.set(taskId, list); } return map; }, new Map())].map(([taskId, list]) => summarizeRows(taskId, list));
  return { rows, byModel: by("model"), byProject: by("project"), bySession: by("sessionId"), byTask, totals: summarizeRows("all", rows) };
}
function summarizeRows(id, rows) { const usage = { input: 0, cachedInput: 0, output: 0 }; const samples = []; let cost = 0; let estimableCount = 0; let unestimable = false; for (const row of rows) { mergeUsage(usage, row.usage); samples.push(row.usage.input); if (row.estimable) { cost += row.cost; estimableCount++; } unestimable ||= !row.estimable; } return { id, usage, statistics: percentiles(samples), cost: estimableCount ? cost : null, unestimable, costEstimation: !estimableCount ? "unestimable" : unestimable ? "partial" : "complete" }; }
function taskIdsAt(index, sessionId, eventAt) {
  const candidates = (index.sessions.get(sessionId) || []).filter((taskId, position, all) => all.indexOf(taskId) === position).filter((taskId) => {
    const task = index.tasks.get(taskId) || {};
    const start = Date.parse(task.firstStartedAt || task.startedAt || task.createdAt || "");
    const terminal = ["done_claimed", "verified", "cancelled"].includes(task.status);
    const end = Date.parse(task.actualAt || (terminal ? task.updatedAt : "") || "");
    return (!Number.isFinite(start) || eventAt >= start) && (!Number.isFinite(end) || eventAt <= end);
  });
  return candidates.length === 1 ? candidates : ["unattributed"];
}
function buildWarnings(parsed, index, windows, now) {
  const warnings = [];
  const day = windows["24h"];
  const estimableSessions = day.bySession.filter((row) => row.estimableCount > 0);
  const totalCredits = estimableSessions.reduce((sum, row) => sum + row.cost, 0);
  for (const row of estimableSessions) if (totalCredits > 0 && row.cost / totalCredits > .2) warnings.push({ code: "SESSION_CREDIT_SHARE_HIGH", type: "session_credits_share", sessionId: row.sessionId, share: row.cost / totalCredits, message: "单 Session 占窗口估算 Credits 超过 20%" });
  const continuations = new Map();
  for (const row of day.rows) {
    const key = `${row.sessionId}:${row.model}`;
    continuations.set(key, { sessionId: row.sessionId, model: row.model, count: (continuations.get(key)?.count || 0) + 1 });
  }
  for (const item of continuations.values()) if (item.count > 80) warnings.push({ code: "MODEL_CONTINUATIONS_HIGH", type: "model_continuation", ...item, message: "模型续调超过 80 次" });
  for (const session of parsed) { const taskCount = new Set(index.sessions.get(session.sessionId) || []).size; if (taskCount > 1) warnings.push({ code: "MULTIPLE_INDEPENDENT_TASKS", type: "multiple_independent_tasks", sessionId: session.sessionId, taskCount, message: "Session 存在多个独立任务" }); if (session.compressionAfterPhase) warnings.push({ code: "COMPRESSED_AFTER_MAIN_PHASE", type: "compression_after_phase", sessionId: session.sessionId, count: session.compressionAfterPhase, message: "主要阶段结束后已经发生压缩" }); if (session.missingTimestampUsage) warnings.push({ code: "USAGE_TIMESTAMP_MISSING", type: "usage_timestamp_missing", sessionId: session.sessionId, count: session.missingTimestampUsage, message: "Token 事件缺少可解析时间戳，未纳入时间窗口" }); const samples = session.events.filter((event) => event.at >= now - WINDOWS["24h"]).map((e) => e.usage.input); if (samples.length >= 4 && percentiles(samples.slice(-Math.ceil(samples.length / 2))).average > percentiles(samples.slice(0, Math.floor(samples.length / 2))).average * 1.25) warnings.push({ code: "AVERAGE_INPUT_GROWING", type: "input_growth", sessionId: session.sessionId, message: "平均输入持续增长" }); }
  return warnings;
}

export function reportUsage(options = {}) { return collectUsage(options); }

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(reportUsage(), null, 2));
