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
    const sessionIds = [task.session_id || task.sessionId, ...(task.cliRuns || []).map((run) => run.delegateSessionId || run.delegate_session_id)].filter(Boolean);
    for (const sid of sessionIds) if (id) sessions.set(sid, [...(sessions.get(sid) || []), id]);
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
  const input = value(u.input_tokens);
  const output = value(u.output_tokens);
  return {
    input,
    cachedInput: value(u.cached_input_tokens),
    output,
    reasoning: value(u.reasoning_output_tokens),
    total: value(u.total_tokens, input + output),
  };
}
function timestampFrom(record) {
  const raw = record?.timestamp ?? record?.created_at ?? record?.payload?.timestamp;
  const parsed = Date.parse(raw || "");
  return Number.isFinite(parsed) ? parsed : null;
}
function mergeUsage(target, usage) { for (const key of ["input", "cachedInput", "output"]) target[key] += usage[key]; }

export function sessionIdentityFromRecord(record, fallback = "unknown") {
  if (record?.type !== "session_meta") return fallback;
  const payload = record.payload || {};
  return [payload.id, payload.session_id].find((value) => typeof value === "string" && value.trim())?.trim() || fallback;
}

export function sessionIdentityFromRecords(records, fallback = "unknown") {
  return (records || []).reduce((identity, record) => sessionIdentityFromRecord(record, identity), fallback);
}

export function parseSession(input, options = {}) {
  const records = lines(input);
  const fallback = options.sessionId || (typeof input === "string" ? sessionIdFromFile(input) : "unknown");
  const sessionId = sessionIdentityFromRecords(records, fallback);
  let model = "unknown";
  let contextWindow = 0;
  let cwd = "";
  const events = [];
  const lifetimeTotal = emptyLifetime();
  let missingTimestampUsage = 0;
  let phaseEnded = false;
  let compressionAfterPhase = 0;
  for (const record of records) {
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
      mergeLifetimeUsage(lifetimeTotal, { ...usage, count: 1 });
      const at = timestampFrom(record);
      if (at === null) missingTimestampUsage++;
      else events.push({ at, model, usage, contextWindow: value(record.payload?.model_context_window || record.payload?.info?.model_context_window, contextWindow), credits: record.rate_limits?.credits || null });
    }
  }
  return { sessionId, cwd, events, lifetimeTotal, compressionAfterPhase, missingTimestampUsage };
}

export function collectUsage({ sessionsRoot = DEFAULT_SESSIONS_ROOT, sessions, ledger = DEFAULT_LEDGER, rates = DEFAULT_RATES, now = new Date() } = {}) {
  const inputs = sessions || filesUnder(sessionsRoot).map((file) => ({ file, sessionId: sessionIdFromFile(file) }));
  const parsed = inputs.map((item) => parseSession(item.records || item.lines || item.file || item, { sessionId: item.sessionId })).filter((s) => s.events.length);
  return buildUsageReportFromParsed(parsed, { ledger, rates, now });
}

export function buildUsageReportFromParsed(parsed, { ledger = DEFAULT_LEDGER, rates = DEFAULT_RATES, now = new Date() } = {}) {
  const index = taskIndex(readJson(ledger, ledger));
  const rateTable = readJson(rates, rates);
  const at = new Date(now).getTime();
  const internalWindows = Object.fromEntries(Object.entries(WINDOWS).map(([name, duration]) => [name, { id: name, durationMs: duration, generatedAt: new Date(at).toISOString(), ...buildWindow(parsed, index, rateTable, at - duration, at) }]));
  const warnings = buildWarnings(parsed, index, internalWindows, at);
  const day = internalWindows["24h"];
  const windows = Object.fromEntries(Object.entries(internalWindows).map(([name, window]) => {
    const summary = { ...window, modelContinuations: window.eventCount };
    delete summary.continuationGroups;
    delete summary.eventCount;
    return [name, summary];
  }));
  return {
    generatedAt: new Date(at).toISOString(), windows, lifetime: buildLifetime(parsed, index), warnings, alerts: warnings,
    overall: {
      estimatedCredits: day.totals.cost,
      creditsEstimation: day.totals.costEstimation,
      modelContinuations: day.eventCount,
      input: day.totals.statistics,
      usage: day.totals.usage,
    },
  };
}

function buildWindow(parsed, index, rates, start, end) {
  const byModel = new Map();
  const byProject = new Map();
  const bySession = new Map();
  const byTask = new Map();
  const continuationGroups = new Map();
  const totals = emptyAggregate("all", "id");
  let eventCount = 0;
  for (const session of parsed) for (const event of session.events) if (eventAt(event) >= start && eventAt(event) <= end) {
    const model = eventModel(event);
    const usage = eventUsage(event);
    const taskIds = taskIdsAt(index, session.sessionId, eventAt(event));
    const rate = rateFor(rates, model);
    const row = { usage, sessionId: session.sessionId, project: session.cwd || "unattributed", cost: price(usage, rate), estimable: Boolean(rate) };
    addAggregate(byModel, model || "unknown", "model", row);
    addAggregate(byProject, row.project, "project", row);
    addAggregate(bySession, session.sessionId, "sessionId", row);
    for (const taskId of taskIds.length ? taskIds : ["unattributed"]) addAggregate(byTask, taskId, "id", row);
    mergeAggregate(totals, row);
    const continuationKey = `${session.sessionId}:${model}`;
    continuationGroups.set(continuationKey, { sessionId: session.sessionId, model, count: (continuationGroups.get(continuationKey)?.count || 0) + 1 });
    eventCount += 1;
  }
  return { eventCount, continuationGroups: [...continuationGroups.values()], byModel: finishAggregates(byModel), byProject: finishAggregates(byProject), bySession: finishAggregates(bySession), byTask: finishAggregates(byTask), totals: finishAggregate(totals) };
}
function emptyAggregate(id, key) { return { [key]: id, usage: { input: 0, cachedInput: 0, output: 0 }, samples: [], cost: 0, estimableCount: 0, unestimable: false, count: 0 }; }
function mergeAggregate(item, row) { mergeUsage(item.usage, row.usage); item.samples.push(row.usage.input); if (row.estimable) { item.cost += row.cost; item.estimableCount++; } item.unestimable ||= !row.estimable; item.count++; }
function addAggregate(map, id, key, row) { const item = map.get(id) || emptyAggregate(id, key); mergeAggregate(item, row); map.set(id, item); }
function finishAggregate(item) { const { samples, ...summary } = item; return { ...summary, statistics: percentiles(samples), cost: item.estimableCount ? item.cost : null, costEstimation: !item.estimableCount ? "unestimable" : item.unestimable ? "partial" : "complete" }; }
function finishAggregates(map) { return [...map.values()].map(finishAggregate); }
function eventAt(event) { return Array.isArray(event) ? Number(event[0]) : Number(event.at); }
function eventModel(event) { return Array.isArray(event) ? String(event[1] || "unknown") : String(event.model || "unknown"); }
function eventUsage(event) {
  if (!Array.isArray(event)) return event.usage;
  const input = value(event[2]);
  const output = value(event[4]);
  return { input, cachedInput: value(event[3]), output, reasoning: value(event[6]), total: value(event[7], input + output) };
}
export function createTaskUsageAttributor(ledger) {
  const index = taskIndex(readJson(ledger, ledger));
  return (sessionId, eventAt) => taskIdsAt(index, sessionId, eventAt);
}
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
function buildLifetime(parsed, index) {
  const byTask = new Map();
  const bySession = new Map();
  for (const session of parsed) {
    if (session.lifetimeTotal) {
      mergeLifetime(bySession, session.sessionId, session.lifetimeTotal);
    } else if (session.lifetimeByTask && Object.keys(session.lifetimeByTask).length) {
      for (const aggregate of Object.values(session.lifetimeByTask)) mergeLifetime(bySession, session.sessionId, aggregate);
    } else {
      for (const event of session.events) mergeLifetime(bySession, session.sessionId, { usage: eventUsage(event), count: 1 });
    }
    if (session.lifetimeByTask && Object.keys(session.lifetimeByTask).length) {
      for (const [taskId, aggregate] of Object.entries(session.lifetimeByTask)) mergeLifetime(byTask, taskId, aggregate);
      continue;
    }
    for (const event of session.events) {
      const taskIds = taskIdsAt(index, session.sessionId, eventAt(event));
      for (const taskId of taskIds) mergeLifetime(byTask, taskId, { usage: eventUsage(event), count: 1 });
    }
  }
  const rows = [...byTask.entries()].map(([id, aggregate]) => finishLifetime(id, aggregate));
  const totals = rows.reduce((sum, row) => mergeLifetimeUsage(sum, row), emptyLifetime());
  const unattributed = rows.find((row) => row.id === "unattributed") || finishLifetime("unattributed", emptyLifetime());
  const totalTokens = totals.total;
  return {
    attribution: "estimated",
    method: "last_token_usage_by_task_lifecycle",
    bySession: [...bySession.entries()].map(([sessionId, aggregate]) => finishSessionLifetime(sessionId, aggregate)),
    byTask: rows,
    totals: finishLifetime("all", totals),
    attributedTokenRatio: totalTokens > 0 ? (totalTokens - unattributed.totalTokens) / totalTokens : 0,
    missingTimestampEvents: parsed.reduce((sum, session) => sum + Number(session.missingTimestampUsage || 0), 0),
  };
}
function emptyLifetime() { return { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0, count: 0 }; }
function mergeLifetime(map, taskId, aggregate) {
  const current = map.get(taskId) || emptyLifetime();
  const usage = aggregate.usage || aggregate;
  mergeLifetimeUsage(current, { ...usage, count: aggregate.count });
  map.set(taskId, current);
}
function mergeLifetimeUsage(target, source) {
  for (const key of ["input", "cachedInput", "output", "reasoning"]) target[key] += value(source[key] ?? source.usage?.[key]);
  target.total += value(source.total ?? source.totalTokens ?? source.usage?.total, value(source.input ?? source.usage?.input) + value(source.output ?? source.usage?.output));
  target.count += value(source.count);
  return target;
}
function finishLifetime(id, aggregate) {
  return {
    id,
    usage: { input: aggregate.input, cachedInput: aggregate.cachedInput, output: aggregate.output, reasoning: aggregate.reasoning },
    totalTokens: aggregate.total,
    count: aggregate.count,
    attribution: id === "unattributed" ? "unattributed" : "estimated",
  };
}
function finishSessionLifetime(sessionId, aggregate) {
  return {
    sessionId,
    usage: { input: aggregate.input, cachedInput: aggregate.cachedInput, output: aggregate.output, reasoning: aggregate.reasoning },
    totalTokens: aggregate.total,
    count: aggregate.count,
  };
}
function buildWarnings(parsed, index, windows, now) {
  const warnings = [];
  const day = windows["24h"];
  const estimableSessions = day.bySession.filter((row) => row.estimableCount > 0);
  const totalCredits = estimableSessions.reduce((sum, row) => sum + row.cost, 0);
  for (const row of estimableSessions) if (totalCredits > 0 && row.cost / totalCredits > .2) warnings.push({ code: "SESSION_CREDIT_SHARE_HIGH", type: "session_credits_share", sessionId: row.sessionId, share: row.cost / totalCredits, message: "单 Session 占窗口估算 Credits 超过 20%" });
  const continuations = new Map();
  for (const row of day.continuationGroups) continuations.set(`${row.sessionId}:${row.model}`, row);
  for (const item of continuations.values()) if (item.count > 80) warnings.push({ code: "MODEL_CONTINUATIONS_HIGH", type: "model_continuation", ...item, message: "模型续调超过 80 次" });
  for (const session of parsed) { const taskCount = new Set(index.sessions.get(session.sessionId) || []).size; if (taskCount > 1) warnings.push({ code: "MULTIPLE_INDEPENDENT_TASKS", type: "multiple_independent_tasks", sessionId: session.sessionId, taskCount, message: "Session 存在多个独立任务" }); if (session.compressionAfterPhase) warnings.push({ code: "COMPRESSED_AFTER_MAIN_PHASE", type: "compression_after_phase", sessionId: session.sessionId, count: session.compressionAfterPhase, message: "主要阶段结束后已经发生压缩" }); if (session.missingTimestampUsage) warnings.push({ code: "USAGE_TIMESTAMP_MISSING", type: "usage_timestamp_missing", sessionId: session.sessionId, count: session.missingTimestampUsage, message: "Token 事件缺少可解析时间戳，未纳入时间窗口" }); const samples = session.events.filter((event) => eventAt(event) >= now - WINDOWS["24h"]).map((event) => eventUsage(event).input); if (samples.length >= 4 && percentiles(samples.slice(-Math.ceil(samples.length / 2))).average > percentiles(samples.slice(0, Math.floor(samples.length / 2))).average * 1.25) warnings.push({ code: "AVERAGE_INPUT_GROWING", type: "input_growth", sessionId: session.sessionId, message: "平均输入持续增长" }); }
  return warnings;
}

export function reportUsage(options = {}) { return collectUsage(options); }

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(reportUsage(), null, 2));
