import { stat } from "node:fs/promises";
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
    const previous = inFlight.get(key) || Promise.resolve();
    const pending = previous.catch(() => {}).then(() => readSessionBudget(id, root, task));
    inFlight.set(key, pending);
    try { return await pending; } finally { if (inFlight.get(key) === pending) inFlight.delete(key); }
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

async function readSessionBudget(sessionId, root, task) {
  let state = cache.get(`${root}:${sessionId}`);
  const path = state?.path || findSessionPath(sessionId, root);
  if (!path) return budgetSnapshot(null, task);
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
  return budgetSnapshot(state.sessionId === sessionId ? state : null, task);
}

export function budgetSnapshot(state, task = null) {
  const phases = (task?.phaseEvents || []).filter((item) => item.transition === "started").toSorted((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
  const phase = phases.at(-1);
  const taskStart = Date.parse(task?.createdAt || "");
  const firstPhase = phases.find((item) => item.phase === phase?.phase);
  const phaseStart = Date.parse(firstPhase?.occurred_at || firstPhase?.occurredAt || task?.createdAt || "");
  const requests = state?.requests || [];
  const taskRequests = requests.filter((item) => !Number.isFinite(item.at) || !Number.isFinite(taskStart) || item.at >= taskStart);
  const phaseRequests = requests.filter((item) => !Number.isFinite(item.at) || !Number.isFinite(phaseStart) || item.at >= phaseStart);
  const limit = task?.workflowProfile === "fast" ? 8 : 35;
  const compactions = state?.compactions ?? null;
  const handoff = Boolean(state && (phaseRequests.length >= limit || compactions >= 2));
  return {
    source: state ? "session_jsonl_incremental" : "unavailable",
    continuation_count: { session: state ? requests.length : null, task: state ? taskRequests.length : null, phase: state ? phaseRequests.length : null },
    phase: phase?.phase || "implementation", request_limit: limit, limit_scope: "current_session_phase",
    token_budget: { input_used: state ? taskRequests.reduce((sum, item) => sum + item.input, 0) : null, limit: null },
    compaction_count: compactions, handoff_required: handoff, new_session_required: Boolean(compactions >= 2),
    allowed_operations: handoff ? recoveryOperations : [...recoveryOperations, "implement", "query", "verify"],
  };
}
