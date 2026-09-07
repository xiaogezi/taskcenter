import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { consumeJsonl, jsonlCheckpointFingerprint } from "./jsonl-stream.mjs";
import { buildUsageReportFromParsed, createTaskUsageAttributor, sessionIdentityFromRecord } from "./usage-report.mjs";

const INDEX_VERSION = 7;
const RETENTION_MS = 7 * 24 * 60 * 60_000;

export async function updateUsageIndex(options) {
  const now = Number(options.now || Date.now());
  const files = await filesUnder(options.sessionsRoot);
  const existing = await readJson(options.indexPath, { version: INDEX_VERSION, files: {} });
  const index = existing?.version === INDEX_VERSION && existing.files ? existing : { version: INDEX_VERSION, files: {} };
  const seen = new Set(files);
  const attributeTask = createTaskUsageAttributor(options.ledger);

  for (const path of files) {
    const info = await stat(path);
    const previous = index.files[path];
    const sessionId = await sessionIdentityFromFile(path);
    const identity = `${info.dev || 0}:${info.ino || 0}`;
    const previousOffset = Number(previous?.offset || 0);
    const checkpointMatches = previous?.checkpointHash && previous?.headHash
      && previous.checkpointHash === await jsonlCheckpointFingerprint(path, previousOffset)
      && previous.headHash === await jsonlCheckpointFingerprint(path, Math.min(previousOffset, 4096));
    const reusable = previous && previous.identity === identity && info.size >= previousOffset && checkpointMatches;
    const state = reusable && previous.sessionId === sessionId ? previous : emptyFileState(path, identity, sessionId);
    if (info.size > Number(state.offset || 0)) {
      const result = await consumeJsonl(path, {
        start: Number(state.offset || 0),
        end: info.size - 1,
        onLine: (line) => consumeRecord(state, line, attributeTask),
      });
      state.offset = result.offset;
      state.skippedOversizedLines = Number(state.skippedOversizedLines || 0) + result.skippedOversizedLines;
    }
    state.identity = identity;
    state.size = info.size;
    state.mtimeMs = info.mtimeMs;
    state.checkpointHash = await jsonlCheckpointFingerprint(path, state.offset);
    state.headHash = await jsonlCheckpointFingerprint(path, Math.min(state.offset, 4096));
    state.events = (state.events || []).filter((event) => Number(Array.isArray(event) ? event[0] : event.at) >= now - RETENTION_MS);
    index.files[path] = state;
  }
  for (const path of Object.keys(index.files)) if (!seen.has(path)) delete index.files[path];

  index.updatedAt = new Date(now).toISOString();
  await writeJsonAtomic(options.indexPath, index);
  const parsed = Object.values(index.files).map((state) => ({
    sessionId: state.sessionId,
    cwd: state.cwd,
    events: state.events || [],
    compressionAfterPhase: Number(state.compressionAfterPhase || 0),
    missingTimestampUsage: Number(state.missingTimestampUsage || 0),
    lifetimeTotal: state.lifetimeTotal || emptyLifetime(),
    lifetimeByTask: state.lifetimeByTask || {},
    latestRateLimits: state.latestRateLimits || migrateLatestRateLimit(state.latestPrimaryRateLimit),
  })).filter((session) => session.events.length || session.lifetimeTotal.count || Object.keys(session.lifetimeByTask).length || Object.keys(session.latestRateLimits || {}).length || session.latestPrimaryRateLimit);
  return {
    report: buildUsageReportFromParsed(parsed, {
      ledger: options.ledger,
      rates: options.rates,
      now,
    }),
    index,
  };
}

function emptyFileState(path, identity, sessionId = sessionIdFromFile(path)) {
  return {
    identity,
    offset: 0,
    size: 0,
    mtimeMs: 0,
    sessionId,
    cwd: "",
    model: "unknown",
    contextWindow: 0,
    phaseEnded: false,
    compressionAfterPhase: 0,
    missingTimestampUsage: 0,
    skippedOversizedLines: 0,
    checkpointHash: "",
    headHash: "",
    events: [],
    lifetimeTotal: emptyLifetime(),
    lifetimeByTask: {},
    latestRateLimits: {},
  };
}

function consumeRecord(state, line, attributeTask) {
  let record;
  try { record = JSON.parse(line.toString("utf8")); } catch { return; }
  if (record.type === "session_meta") {
    state.sessionId = sessionIdentityFromRecord(record, state.sessionId);
    state.cwd = record.payload?.cwd || state.cwd;
  }
  if (record.type === "event_msg" && ["task_complete", "task_done", "phase_complete"].includes(record.payload?.type)) state.phaseEnded = true;
  if (state.phaseEnded && (record.type === "compacted" || record.payload?.type === "context_compacted" || record.payload?.compacted === true || record.payload?.compaction)) {
    state.compressionAfterPhase += 1;
    state.phaseEnded = false;
  }
  if (record.type === "turn_context") {
    if (state.phaseEnded && (record.payload?.compaction || record.payload?.compacted)) state.compressionAfterPhase += 1;
    if (record.payload?.compaction || record.payload?.compacted) state.phaseEnded = false;
    state.model = record.payload?.model || state.model;
    state.contextWindow = number(record.payload?.model_context_window, state.contextWindow);
  }
  const rateLimits = record?.payload?.rate_limits;
  const primary = rateLimits?.primary;
  const rawTime = record.timestamp ?? record.created_at ?? record.payload?.timestamp;
  const rateLimitAt = Date.parse(rawTime || "");
  const limitId = typeof rateLimits?.limit_id === "string" && rateLimits.limit_id.trim() ? rateLimits.limit_id.trim() : "codex";
  if (primary && typeof primary === "object" && Number.isFinite(Number(primary.used_percent)) && Number.isFinite(rateLimitAt)
    && (!state.latestRateLimits?.[limitId] || rateLimitAt > state.latestRateLimits[limitId].at)) {
    state.latestRateLimits ||= {};
    state.latestRateLimits[limitId] = {
      limit_id: limitId,
      limit_name: typeof rateLimits.limit_name === "string" ? rateLimits.limit_name : null,
      primary: normalizeRateWindow(primary),
      secondary: normalizeRateWindow(rateLimits.secondary),
      rate_limit_reached_type: rateLimits.rate_limit_reached_type ?? null,
      at: rateLimitAt,
    };
  }
  const usage = record?.payload?.info?.last_token_usage;
  if (!usage || typeof usage !== "object") return;
  mergeLifetimeTotal(state.lifetimeTotal, usage);
  const at = rateLimitAt;
  if (!Number.isFinite(at)) {
    state.missingTimestampUsage += 1;
    return;
  }
  const event = [
    at,
    state.model,
    number(usage.input_tokens),
    number(usage.cached_input_tokens),
    number(usage.output_tokens),
    number(record.payload?.model_context_window || record.payload?.info?.model_context_window, state.contextWindow),
    number(usage.reasoning_output_tokens),
    number(usage.total_tokens, number(usage.input_tokens) + number(usage.output_tokens)),
  ];
  state.events.push(event);
  const taskIds = attributeTask(state.sessionId, at);
  for (const taskId of taskIds) mergeLifetime(state, taskId, event);
}

function normalizeRateWindow(window) {
  if (!window || typeof window !== "object" || !Number.isFinite(Number(window.used_percent))) return null;
  return {
    used_percent: Number(window.used_percent),
    window_minutes: Number.isFinite(Number(window.window_minutes)) ? Number(window.window_minutes) : null,
    resets_at: window.resets_at ?? null,
  };
}

function migrateLatestRateLimit(snapshot) {
  if (!snapshot) return {};
  return { codex: { limit_id: "codex", limit_name: null, primary: { used_percent: snapshot.used_percent, window_minutes: snapshot.window_minutes, resets_at: snapshot.resets_at }, secondary: null, rate_limit_reached_type: null, at: snapshot.at } };
}

function emptyLifetime() {
  return { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0, count: 0 };
}

function mergeLifetimeTotal(target, usage) {
  target.input += number(usage.input_tokens);
  target.cachedInput += number(usage.cached_input_tokens);
  target.output += number(usage.output_tokens);
  target.reasoning += number(usage.reasoning_output_tokens);
  target.total += number(usage.total_tokens, number(usage.input_tokens) + number(usage.output_tokens));
  target.count += 1;
}

function mergeLifetime(state, taskId, event) {
  const current = state.lifetimeByTask[taskId] || { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0, count: 0 };
  current.input += number(event[2]);
  current.cachedInput += number(event[3]);
  current.output += number(event[4]);
  current.reasoning += number(event[6]);
  current.total += number(event[7], number(event[2]) + number(event[4]));
  current.count += 1;
  state.lifetimeByTask[taskId] = current;
}

async function filesUnder(root) {
  if (!root || !existsSync(root)) return [];
  const result = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(path);
    }
  }
  return result.sort();
}

function sessionIdFromFile(path) {
  return basename(path).match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i)?.[1]
    || basename(path).replace(/\.jsonl$/i, "");
}

async function sessionIdentityFromFile(path) {
  const fallback = sessionIdFromFile(path);
  let handle;
  try {
    handle = await open(path, "r");
    const chunks = [];
    let size = 0;
    for (;;) {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) return fallback;
      const newline = buffer.indexOf(10, 0, bytesRead);
      const end = newline === -1 ? bytesRead : newline;
      size += end;
      if (size > 2 * 1024 * 1024) return fallback;
      chunks.push(buffer.subarray(0, end));
      if (newline !== -1) break;
    }
    const line = Buffer.concat(chunks, size).toString("utf8").trim();
    return sessionIdentityFromRecord(JSON.parse(line), fallback);
  } catch {
    return fallback;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function number(value, fallback = 0) { return Number.isFinite(Number(value)) ? Number(value) : fallback; }

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
