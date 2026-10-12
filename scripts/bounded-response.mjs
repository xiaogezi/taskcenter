import { randomUUID } from "node:crypto";

const snapshots = new Map();
export const DEFAULT_RESPONSE_BYTES = 4096;
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

// Bounded, expiring snapshots keep cursors stable when the underlying data changes.
export function boundedResponse(payload, { cursor, summary, maxBytes = DEFAULT_RESPONSE_BYTES } = {}) {
  const now = Date.now();
  for (const [id, entry] of snapshots) if (entry.expires <= now) snapshots.delete(id);
  if (cursor) {
    const [id, rawOffset] = String(cursor).split(":");
    const entry = snapshots.get(id);
    const offset = Number(rawOffset);
    if (!entry || !Number.isSafeInteger(offset) || offset < 0 || offset >= entry.text.length) return { error: "CURSOR_EXPIRED", next_action: "repeat_original_query" };
    let end = Math.min(entry.text.length, offset + 512);
    if (end < entry.text.length && /[\uD800-\uDBFF]/.test(entry.text[end - 1])) end--;
    return { encoding: "json_text_fragment", offset, fragment: entry.text.slice(offset, end), continuation_cursor: end < entry.text.length ? `${id}:${end}` : null };
  }
  if (bytes(payload) <= maxBytes) return payload;
  const id = randomUUID();
  while (snapshots.size >= 32) snapshots.delete(snapshots.keys().next().value);
  snapshots.set(id, { text: JSON.stringify(payload), expires: now + 300_000 });
  const fallback = Object.fromEntries(["accepted", "task_id", "status", "error", "code", "http_status", "request_id", "assessment", "handoff_required", "new_session_required", "handoff_recommended", "new_session_recommended", "recommendation_reasons", "allowed_operations", "active_task", "delegation", "gate_allowlisted", "session_id", "source", "request_limit", "continuation_count", "compaction_count"].filter((key) => Object.hasOwn(payload, key)).map((key) => [key, payload[key]]));
  if (payload.task?.id) fallback.task_id = payload.task.id;
  if (payload.agent_guidance) fallback.agent_guidance = { advisory_only: true, task_id: payload.agent_guidance.task_id, source: "rules", steps: payload.agent_guidance.steps?.slice(0, 1), next_action: "完整规则与 AI 建议见 continuation；继续契约内工作，建议不授予权限。" };
  if (payload.route) fallback.route = Object.fromEntries(["route_id", "task_id", "selected_model", "native_model", "channel", "cli_profile", "harness", "reasoning_effort", "available", "role", "reason", "status", "expires_at", "fallback_from", "fallback_reason", "result", "next_action"].filter((key) => Object.hasOwn(payload.route, key)).map((key) => [key, payload.route[key]]));
  const result = { ...fallback, summary: summary || { fields: Object.keys(payload).slice(0, 30), bytes: bytes(payload) }, truncated: true, continuation_cursor: `${id}:0` };
  if (bytes(result) > DEFAULT_RESPONSE_BYTES) result.summary = { bytes: bytes(payload) };
  if (bytes(result) > DEFAULT_RESPONSE_BYTES) {
    const emergency = { truncated: true, handoff_required: payload.handoff_required === true, new_session_required: payload.new_session_required === true, summary: { bytes: bytes(payload) }, continuation_cursor: `${id}:0` };
    const scalars = (value, keys) => Object.fromEntries(keys.filter(key => ["string", "boolean", "number"].includes(typeof value[key])).map(key => [key, typeof value[key] === "string" ? value[key].slice(0, 200) : value[key]]));
    Object.assign(emergency, scalars(payload, ["accepted", "task_id", "status", "error", "code", "http_status", "request_id", "handoff_recommended", "new_session_recommended", "source", "request_limit", "continuation_count", "compaction_count"]));
    for (const key of ["recommendation_reasons", "allowed_operations", "continuation_count"]) if (Object.hasOwn(payload, key) && bytes(payload[key]) <= 600) emergency[key] = payload[key];
    if (payload.route) emergency.route = scalars(payload.route, ["route_id", "task_id", "selected_model", "native_model", "reasoning_effort", "channel", "status", "available", "expires_at", "next_action"]);
    if (payload.assessment) emergency.assessment = scalars(payload.assessment, ["category", "reason", "recovery", "verification"]);
    if (fallback.agent_guidance) emergency.agent_guidance = fallback.agent_guidance;
    // Full evidence remains in the cursor; oversized metadata must not hide the safe next step.
    if (bytes(emergency) > DEFAULT_RESPONSE_BYTES) delete emergency.assessment;
    if (bytes(emergency) > DEFAULT_RESPONSE_BYTES) emergency.route = { route_id: "", available: false, next_action: "响应过大，先读取 continuation 或重新查询有效路由；不得据此执行。" };
    if (bytes(emergency) > DEFAULT_RESPONSE_BYTES) return { truncated: true, accepted: false, summary: { bytes: bytes(payload) }, continuation_cursor: `${id}:0`, next_action: "响应过大，先读取 continuation 或重新查询；不得据此执行。" };
    return emergency;
  }
  return result;
}
