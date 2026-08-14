export function taskEventStatus(event) {
  if (event?.type === "routing.decision") return "仅审计";
  return text(event?.status, "未标状态");
}

export function taskEventSummary(event) {
  if (event?.type !== "routing.decision") {
    return text(event?.current_step || event?.tool_name || event?.review_reason, "无摘要");
  }
  const models = event.orchestrator_model && event.selected_executor_model
    ? `${event.orchestrator_model} → ${event.selected_executor_model}`
    : event.selected_executor_model || event.orchestrator_model;
  return [models, event.dispatch_channel, event.routing_outcome, event.routing_reason]
    .map((value) => text(value, ""))
    .filter(Boolean)
    .join(" · ") || "路由记录";
}

export function hasTaskEventDetails(task, hasStructuredDetails = false) {
  return Boolean(hasStructuredDetails || task?.routingRecordedAt);
}

function text(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
