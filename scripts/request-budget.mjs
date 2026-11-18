import { stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { consumeJsonl, jsonlCheckpointFingerprint } from "./jsonl-stream.mjs";
import { findSessionPath } from "./session-cli.mjs";

const cache = new Map();
const inFlight = new Map();
export const recoveryOperations = ["diagnose", "checkpoint", "task_close", "handoff"];

export function consumeBudgetRecord(state, record) {
  const payload = record.payload || {};
  if (record.type === "session_meta") state.sessionId = payload.id || payload.session_id;
  if (record.type === "compacted" || payload.type === "context_compacted") state.compactions++;
  const usage = payload.info?.last_token_usage;
  if (record.type !== "event_msg" || payload.type !== "token_count" || !usage) return;
  const fingerprint = JSON.stringify(payload.info?.total_token_usage || [record.timestamp, usage]);
  if (fingerprint === state.lastUsage) return;
  state.lastUsage = fingerprint;
  state.requests.push({ at: Date.parse(record.timestamp || ""), input: Number(usage.input_tokens || 0) });
}

export async function readRequestBudget(sessionId, root, task = null) {
  if (!sessionId) return budgetSnapshot(null, task);
  const read = async (id) => {
    const key = `${root}:${id}`;
    let pending = inFlight.get(key);
    if (!pending) {
      pending = readSessionBudget(id, root).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        cache.delete(key);
        return null;
      }).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    // Build per-task projections only after the shared filesystem refresh.
    return budgetSnapshot(await pending, task);
  };
  const result = await read(sessionId);
  for (const previous of task?.sessionHistory || []) {
    if (previous === sessionId) continue;
    const history = await read(previous);
    result.continuation_count.task = result.continuation_count.task === null || history.continuation_count.task === null ? null : result.continuation_count.task + history.continuation_count.task;
    result.token_budget.input_used = result.token_budget.input_used === null || history.token_budget.input_used === null ? null : result.token_budget.input_used + history.token_budget.input_used;
  }
  return result;
}

export async function readPreparationBudget(task, read, waitMs = 400) {
  const started = performance.now();
  let timer;
  try {
    const budget = await Promise.race([
      Promise.resolve().then(read),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs); }),
    ]);
    return { budget: budget ?? budgetSnapshot(null, task), timedOut: budget === null, elapsedMs: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

async function readSessionBudget(sessionId, root) {
  let state = cache.get(`${root}:${sessionId}`);
  const path = state?.path || findSessionPath(sessionId, root);
  if (!path) return null;
  const info = await stat(path);
  const identity = `${info.dev}:${info.ino}`;
  if (!state || state.identity !== identity || info.size < state.offset || state.hash !== await jsonlCheckpointFingerprint(path, state.offset)) {
    state = { path, identity, offset: 0, requests: [], compactions: 0, lastUsage: "", sessionId: null };
  }
  if (info.size > state.offset) {
    const result = await consumeJsonl(path, { start: state.offset, end: info.size - 1, onLine: (line) => {
      let record;
      try { record = JSON.parse(line); } catch { return; }
      consumeBudgetRecord(state, record);
    } });
    state.offset = result.offset;
    state.hash = await jsonlCheckpointFingerprint(path, state.offset);
  }
  if (!cache.has(`${root}:${sessionId}`) && cache.size >= 64) cache.delete(cache.keys().next().value);
  cache.set(`${root}:${sessionId}`, state);
  return state.sessionId === sessionId ? state : null;
}

export function budgetSnapshot(state, task = null) {
  const phases = (task?.phaseEvents || []).filter((item) => item.transition === "started").toSorted((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
  const phase = phases.at(-1);
  const taskStart = Date.parse(task?.createdAt || "");
  const requests = state?.requests || [];
  const taskRequests = requests.filter((item) => !Number.isFinite(item.at) || !Number.isFinite(taskStart) || item.at >= taskStart);
  const phaseRequests = taskRequests.filter((item) => {
    if (!phase || !Number.isFinite(item.at)) return true;
    const active = phases.findLast((entry) => Date.parse(entry.occurred_at || entry.occurredAt || "") <= item.at);
    return active?.phase === phase.phase;
  });
  const limit = task?.workflowProfile === "fast" ? 8 : 35;
  const compactions = state?.compactions ?? null;
  const handoff = Boolean(state && (phaseRequests.length >= limit || compactions >= 2));
  return {
    source: state ? "session_jsonl_incremental" : "unavailable",
    continuation_count: { session: state ? requests.length : null, task: state ? taskRequests.length : null, phase: state ? phaseRequests.length : null },
    phase: phase?.phase || "implementation", request_limit: limit, limit_scope: "current_session_phase",
    token_budget: { input_used: state ? taskRequests.reduce((sum, item) => sum + item.input, 0) : null, limit: null },
    compaction_count: compactions, handoff_required: false, new_session_required: false,
    handoff_recommended: handoff, new_session_recommended: Boolean(compactions >= 2),
    recommendation_reasons: [...(state && phaseRequests.length >= limit ? ["request_budget_exhausted"] : []), ...(compactions >= 2 ? ["second_compaction"] : [])],
    allowed_operations: [...recoveryOperations, "implement", "query", "verify"],
  };
}
