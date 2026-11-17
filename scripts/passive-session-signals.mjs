// A later turn after a long idle period is not evidence of the earlier model request's latency.
const MAX_RESPONSE_GAP_MS = 30 * 60_000;
const RECENT_CALL_IDS = 512;

export function consumePassiveSessionRecord(state, record) {
  if (record?.type !== "response_item") return;
  const payload = record.payload || {};
  const at = Date.parse(record.timestamp || "");
  if (!Number.isFinite(at)) return;
  state.responseInputs ||= [];
  state.responseGaps ||= [];
  state.toolSamples ||= [];
  state.pendingToolCalls ||= {};
  state.recentCallIds ||= {};

  const inputKind = payload.type === "message" && payload.role === "user" ? "user"
    : ["custom_tool_call_output", "function_call_output"].includes(payload.type) ? "tool_result" : "";
  if (inputKind) {
    state.responseInputs.push([at, inputKind]);
    state.pendingResponseInput = [at, inputKind];
  } else if (["reasoning", "custom_tool_call", "function_call"].includes(payload.type)
    || payload.type === "message" && payload.role === "assistant") {
    const pending = state.pendingResponseInput;
    if (pending && at > pending[0] && at - pending[0] <= MAX_RESPONSE_GAP_MS) {
      state.responseGaps.push([pending[0], at - pending[0], pending[1]]);
    }
    state.pendingResponseInput = null;
  }

  if (payload.type === "custom_tool_call" && typeof payload.call_id === "string" && payload.call_id) {
    const duplicate = Object.hasOwn(state.recentCallIds, payload.call_id);
    const index = state.toolSamples.push([at, "custom", 0, duplicate ? 1 : 0]) - 1;
    state.pendingToolCalls[payload.call_id] = index;
    const pendingIds = Object.keys(state.pendingToolCalls);
    if (pendingIds.length > RECENT_CALL_IDS) delete state.pendingToolCalls[pendingIds[0]];
    state.recentCallIds[payload.call_id] = at;
    const ids = Object.keys(state.recentCallIds);
    if (ids.length > RECENT_CALL_IDS) delete state.recentCallIds[ids[0]];
  } else if (payload.type === "custom_tool_call_output" && typeof payload.call_id === "string") {
    const index = state.pendingToolCalls[payload.call_id];
    if (Number.isInteger(index) && state.toolSamples[index]) state.toolSamples[index][2] = 1;
    delete state.pendingToolCalls[payload.call_id];
  }
}

export function prunePassiveSessionSignals(state, cutoff) {
  for (const key of ["responseInputs", "responseGaps"]) {
    state[key] = (state[key] || []).filter((sample) => sample[0] >= cutoff);
  }
  const offsets = new Map();
  state.toolSamples = (state.toolSamples || []).filter((sample, oldIndex) => {
    if (sample[0] < cutoff) return false;
    offsets.set(oldIndex, offsets.size);
    return true;
  });
  if (state.pendingResponseInput?.[0] < cutoff) state.pendingResponseInput = null;
  state.pendingToolCalls = Object.fromEntries(Object.entries(state.pendingToolCalls || {})
    .filter(([, index]) => offsets.has(index)).map(([id, index]) => [id, offsets.get(index)]));
  state.recentCallIds = Object.fromEntries(Object.entries(state.recentCallIds || {})
    .filter(([, at]) => at >= cutoff).slice(-RECENT_CALL_IDS));
}
