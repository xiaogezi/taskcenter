const CODE_LIKE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "java", "kt", "kts", "swift", "cs", "cpp", "cc", "cxx", "c", "h", "hpp", "go", "rs", "rb", "php", "scala", "dart", "sh", "bash", "yaml", "yml", "json", "mdx", "css", "scss", "sass", "less", "html", "sql", "xml",
]);
const INVALID_DEVIATION_REASONS = [
  "用户未要求子 Agent",
  "用户未要求子代理",
  "用户未要求子 agent",
  "user did not request sub agent",
  "user did not request child",
];
const SUB_TASK_PATTERNS = [
  /\b(__tests__|test|spec)\b/i,
  /[\\/](__tests__|test|tests)[\\/]/i,
];
const TEST_FILE_PATTERN = /\.((?:test|spec)\.)[^.\\/\\]+$/i;

export function taskEventStatus(event) {
  if (event?.type === "routing.decision") return "仅审计";
  if (event?.type === "task.reminder") return "估时提醒";
  const completionStatuses = {
    "requirement.reported": "验收条件",
    "verification.reported": "验证证据",
    "verification.staled": "验证过期",
    "review.reported": "独立审查",
    "review_cycle.reported": "Review 阶段",
    "review.staled": "审查过期",
    "acceptance.ready": "待最终验收",
    "acceptance.accepted": "已最终验收",
    "acceptance.rejected": "验收拒绝",
  };
  if (completionStatuses[event?.type]) return completionStatuses[event.type];
  return text(event?.status, "未标状态");
}

export function taskEventSummary(event) {
  if (event?.type === "task.reminder") return text(event?.next_action, "任务已超过预计完成时间");
  if (event?.type === "requirement.reported") return [event.requirement_result?.requirement_id, event.requirement_result?.status, event.requirement_result?.note].map((value) => text(value, "")).filter(Boolean).join(" · ") || "验收条件结果";
  if (event?.type === "verification.reported") return [event.verification_claim?.kind, event.verification_claim?.status, subjectLabel(event.verification_claim?.subject_ref) || event.verification_claim?.revision, identityLabel(event.verification_claim?.producer), event.verification_claim?.summary].map((value) => text(value, "")).filter(Boolean).join(" · ") || "验证证据";
  if (event?.type === "review.reported") return [identityLabel(event.review_attestation?.reviewer), event.review_attestation?.verdict, subjectLabel(event.review_attestation?.subject_ref) || event.review_attestation?.revision, event.review_attestation?.summary].map((value) => text(value, "")).filter(Boolean).join(" · ") || "独立审查";
  if (event?.type === "review_cycle.reported") return [event.review_cycle?.cycle_id, event.review_cycle?.phase, event.review_cycle?.review_scope, identityLabel(event.review_cycle?.reviewer), event.review_cycle?.model, event.review_cycle?.outcome].map((value) => text(value, "")).filter(Boolean).join(" · ") || "Review 阶段";
  if (["acceptance.accepted", "acceptance.rejected"].includes(event?.type) && event.acceptance_record) return [event.acceptance_record.source, identityLabel(event.acceptance_record.actor), subjectLabel(event.acceptance_record.subject_ref), event.acceptance_record.reason].map((value) => text(value, "")).filter(Boolean).join(" · ");
  if (["verification.staled", "review.staled", "acceptance.ready", "acceptance.accepted", "acceptance.rejected"].includes(event?.type)) return text(event?.reason, "完成保障状态已变化");
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
  return Boolean(hasStructuredDetails || task?.routingRecordedAt || task?.contractVersion === "v2");
}

export function detectRoutingAdvisory(task, configuredExecutorModel) {
  const routingHistory = Array.isArray(task?.routingHistory) ? task.routingHistory : [];
  const changedFiles = Array.isArray(task?.changedFiles) ? task.changedFiles : [];
  const expectedModel = String(configuredExecutorModel || routingHistory.find((entry) => entry?.preferredExecutorModel)?.preferredExecutorModel || "").toLowerCase();
  const hasExecutorLifecycle = routingHistory.some((entry) => {
    const selected = String(entry?.selectedExecutorModel || entry?.preferredExecutorModel || "").toLowerCase();
    const outcome = String(entry?.outcome || "");
    return selected && selected === expectedModel && (outcome === "started" || outcome === "succeeded");
  });
  if (!hasExecutorLifecycle) {
    const invalidReason = routingHistory.some((entry) => INVALID_DEVIATION_REASONS.some((phrase) => String(entry?.reason || "").toLowerCase().includes(phrase.toLowerCase())));
    const codeLikeChanges = changedFiles.filter((path) => isCodeLikeFile(String(path || ""))).length;
    const hasSubtaskHint = changedFiles.some((path) => isSubTaskFile(String(path || "")));
    const hasEnoughChanges = codeLikeChanges >= 3 || hasSubtaskHint;
    if ((invalidReason || hasEnoughChanges) && routingHistory.length > 0) {
      const configuredExpectation = routingHistory.some((entry) => {
        const selected = String(entry?.selectedExecutorModel || "").toLowerCase();
        const preferred = String(entry?.preferredExecutorModel || "").toLowerCase();
        return expectedModel && (selected === expectedModel || preferred === expectedModel);
      });
      return {
        triggered: true,
        title: "模型路由偏离提醒",
        message: configuredExpectation
          ? "当前任务未形成配置执行器的成功派发链路，请确认本次是否存在偏离。"
          : `当前任务为实质性代码改动，但未形成 ${expectedModel || "配置执行器"} 的 started/succeeded 路由记录。`,
        suggestion: "请确认现有偏离理由是否具体且仍成立；若存在可安全隔离的搜索、实现、测试或审查阶段，优先使用集中配置中的执行器。"
      };
    }
  }
  return null;
}

function isCodeLikeFile(path) {
  const cleaned = String(path || "").trim();
  if (!cleaned) return false;
  if (isSubTaskFile(cleaned)) return true;
  const match = cleaned.match(/\.([^.\/\\]+)$/);
  if (!match) return false;
  const extension = match[1].toLowerCase();
  return CODE_LIKE_EXTENSIONS.has(extension);
}

function isSubTaskFile(path) {
  return TEST_FILE_PATTERN.test(path) || SUB_TASK_PATTERNS.some((pattern) => pattern.test(path));
}

function text(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function identityLabel(value) {
  if (typeof value === "string") return value;
  return value?.display_name || value?.id || "";
}

function subjectLabel(value) {
  return value?.type ? `${value.type}:${value.value || "none"}` : "";
}
