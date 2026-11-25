export const taskTabs = ["overview", "evidence", "activity"];

export function parseTaskWorkspaceSearch(search) {
  const params = new URLSearchParams(search);
  const page = Number.parseInt(params.get("page") || "1", 10);
  return {
    project: params.get("project") || "all",
    bucket: ["bugs", "awaiting_merge", "completed_bugs"].includes(params.get("bucket")) ? "all" : params.get("bucket") || "all",
    query: params.get("query") || "",
    page: Number.isFinite(page) && page > 0 ? page : 1,
    task: params.get("task") || "",
    tab: taskTabs.includes(params.get("tab")) ? params.get("tab") : "overview",
  };
}

export function taskListRequestKey(state) {
  return [state.project, state.bucket, state.query, state.page].join("\u0000");
}

export function taskAxes(task = {}) {
  return [
    ...(task.status === "cancelled" ? [["管理", "cancelled"]] : []),
    ["执行", executionDisplayStatus(task)],
    ["验证", task.verificationStatus || "unknown"],
    ["审查", task.reviewStatus || "unknown"],
    ["验收", task.acceptanceStatus || "unknown"],
  ];
}

export function projectInfo(workspace, projectId = "", repositoryRoot = "") {
  const path = typeof workspace === "string" ? workspace.trim() : "";
  const stableId = typeof projectId === "string" ? projectId.trim().toLocaleLowerCase("en-US") : "";
  const labelPath = typeof repositoryRoot === "string" && repositoryRoot.trim() ? repositoryRoot.trim() : path;
  if (!labelPath) return stableId ? { id: `project:${stableId}`, label: projectId } : { id: "unknown", label: "未知" };
  const parts = labelPath.split(/[\\/]/).filter(Boolean);
  const worktrees = parts.find((part) => part.endsWith("-worktrees"));
  const label = worktrees ? worktrees.slice(0, -"-worktrees".length) : parts.at(-1) || labelPath;
  return { id: `project:${stableId || label.toLocaleLowerCase("en-US")}`, label };
}

// A closed Run is not final acceptance. Derive follow-up from the existing
// readiness projection; never create evidence or relax its contract bindings.
export function evidenceFollowUp(task = {}) {
  if (!task || !["done_claimed", "verified"].includes(task.status) || task.acceptanceStatus === "accepted") return null;
  const readiness = task.completionReadiness || {};
  const labels = new Map([
    ...(task.acceptanceRequirements || []).map(item => [item.id, item.description || item.id]),
    ...(task.verificationPlan || []).map(item => [item.id, item.title || item.id]),
  ]);
  const missing = [...new Set(readiness.missingRequirements || [])].map(id => labels.get(id) || id);
  const failed = [...new Set(readiness.failedRequirements || [])].map(id => labels.get(id) || id);
  const stale = [...new Set(readiness.staleEvidence || [])];
  const reasons = new Set(readiness.reasons || []);
  const items = [
    ...missing.map(label => `待补${label}`),
    ...failed.map(label => `待修复并验证${label}`),
    ...(stale.length ? ["待更新过期证据"] : []),
    ...(reasons.has("current_subject_missing") ? ["待补交付版本"] : []),
    ...(reasons.has("portable_evidence_missing") ? ["待补可追溯验证证据"] : []),
    ...(reasons.has("legacy_contract") ? ["待补正式验收契约"] : []),
  ];
  if (!items.length && task.verificationStatus === "pending") items.push("待补验证证据");
  if (!items.length) return null;
  return { code: "evidence_follow_up", label: [...new Set(items)].join("；"),
    detail: "执行已收尾，尚未通过最终验收；请按当前契约和交付版本补齐上述缺项。", items: [...new Set(items)] };
}

function cancelledExecutionNeedsCheck(task) {
  if (task.status !== "cancelled" || task.executionControl?.executionStatus === "confirmed_stopped") return false;
  if (task.cliRuns?.some(run => run?.status === "active")) return true;
  // A Run may be preallocated at task creation, before execution actually begins.
  const lastRun = task.runs?.at(-1);
  if (!lastRun || lastRun.ended_at || task.sessionDetachedAt) return false;
  return Boolean(task.firstStartedAt) || Object.values(task.toolCalls ?? {}).some(count => count > 0);
}

export function actionReasons(task = {}) {
  const reasons = [];
  const add = (code, label, detail = "") => reasons.push({ code, label, ...(detail ? { detail } : {}) });
  if (executionDisplayStatus(task) === "execution_unconfirmed") add("execution_unconfirmed", "执行待确认", task.executionReconciliation?.next_action || "执行是否结束尚未确认；请核对宿主运行事实，再决定收尾或恢复。");
  if (task.executionReconciliation?.state === "recovery_pending" && ["planned", "in_progress", "blocked"].includes(task.status)) add("recovery_pending", "待补运行事实", task.executionReconciliation.next_action);
  if (cancelledExecutionNeedsCheck(task)) add("cancelled_execution_unconfirmed", "管理已取消，执行待确认", executionStopPresentation(task).detail);
  if (task.status === "blocked") add("blocked", "任务已阻塞", task.blocker || "");
  if (task.blocker && task.status !== "blocked") add("blocker", "存在阻塞说明", task.blocker);
  if (task.verificationStatus === "failed") add("verification_failed", "验证失败");
  if (task.verificationStatus === "stale") add("verification_stale", "验证已过期");
  if (task.acceptanceStatus === "rejected") add("acceptance_rejected", "验收已拒绝");
  if (task.acceptanceStatus === "stale") add("acceptance_stale", "验收已过期");
  const followUp = evidenceFollowUp(task);
  if (followUp) reasons.push(followUp);
  return reasons;
}

const STALE_IN_PROGRESS_MS = 24 * 60 * 60 * 1000;

export function taskActions(task = {}) {
  if (task.archivedAt) return [{ action: "unarchive", label: "取消归档" }];
  const actions = [];
  if (task.status === "blocked") actions.push({ action: "start", label: "恢复为执行中" });
  else if (task.status === "planned") actions.push({ action: "start", label: "标记执行中" });
  else if (["done_claimed", "verified", "cancelled"].includes(task.status)) {
    actions.push({ action: "start", label: "重新处理" });
  }
  // 开始时间过旧仅提供核对入口；是否仍在运行由归档请求读取真实会话后判断。
  const hasActiveRun = (Array.isArray(task.cliRuns) && task.cliRuns.some((run) => run && run.status === "active"));
  const activeRecent = (() => {
    const t = Date.parse(task.activeStartedAt || "");
    // 没有 activeStartedAt 视为未知历史数据，不判为孤儿。
    if (!Number.isFinite(t)) return true;
    return Date.now() - t < STALE_IN_PROGRESS_MS;
  })();
  const isOrphanInProgress = task.status === "in_progress" && !hasActiveRun && !activeRecent;
  if (isOrphanInProgress) {
    actions.push({ action: "archive", label: "归档（核对运行）" });
    actions.push({ action: "cancel", label: "取消管理（不会停止执行）" });
  } else {
    if (["planned", "in_progress", "blocked"].includes(task.status)) actions.push({ action: "cancel", label: "取消管理（不会停止执行）" });
    if (["done_claimed", "verified", "cancelled"].includes(task.status)) actions.push({ action: "archive", label: "归档" });
  }
  return actions;
}

export function responsibilityQueue(task) {
  if (task.archivedAt || task.supersededAt || task.acceptanceStatus === "accepted") return null;
  if (["done_claimed", "verified"].includes(task.status) && task.acceptanceStatus === "ready" && task.completionReadiness?.ready) return "independent_acceptance";
  if (evidenceFollowUp(task)) return "executor_evidence";
  if (executionDisplayStatus(task) === "execution_unconfirmed" || cancelledExecutionNeedsCheck(task) || task.status === "blocked") return "execution_recovery";
  return null;
}

export function taskViewBuckets(task = {}) {
  const executionComplete = ["done_claimed", "verified"].includes(task.status);
  const verificationDone = ["passed", "not_required"].includes(task.verificationStatus);
  return {
    attention: actionReasons(task).length > 0,
    planned: executionDisplayStatus(task) === "planned",
    in_progress: executionDisplayStatus(task) === "in_progress",
    execution_unconfirmed: executionDisplayStatus(task) === "execution_unconfirmed",
    completed: !cancelledExecutionNeedsCheck(task) && !evidenceFollowUp(task) && (task.acceptanceStatus === "accepted" || ["cancelled", "rejected"].includes(task.status)),
    awaiting_verification: executionComplete && task.verificationStatus === "pending",
    awaiting_acceptance: executionComplete && verificationDone && ["pending", "ready"].includes(task.acceptanceStatus),
    blocked: task.status === "blocked",
  };
}

export const managementCancelNotice = "已取消任务管理；未请求停止执行，也未确认执行已停止。请到执行宿主核对或停止运行。";
export function managementCancelConfirmation(title) {
  return `确认取消任务“${title}”的管理？历史会保留；此操作不会停止执行，也不会发送停止请求。若要停止 Agent，请到执行宿主操作并核对结果。`;
}

// Management lifecycle is not evidence of host execution stopping. Legacy
// cancelled records without the new projection remain unknown, even if a Run
// was historically closed by the old cancellation implementation.
export function executionStopPresentation(task = {}) {
  const control = task.executionControl;
  if (task.status !== "cancelled" && !control) return null;
  const requested = control?.stopRequestStatus === "requested";
  const confirmed = control?.executionStatus === "confirmed_stopped";
  return {
    status: confirmed ? "execution_stopped" : requested ? "stop_requested" : "stop_unknown",
    requestLabel: requested ? "已请求停止" : "未请求停止",
    executionLabel: confirmed ? "已确认停止" : "停止状态未知",
    detail: confirmed ? "执行宿主已确认停止。" : requested
      ? "已请求停止，等待宿主确认；不能据此认定执行已停止。"
      : "未请求停止执行，也未确认执行已停止；管理取消不会停止执行，请到执行宿主核对或停止运行。",
  };
}

export function executionDisplayStatus(task = {}) {
  const stop = executionStopPresentation(task);
  if (stop) return stop.status;
  const runs = task.runs || [];
  if (["planned", "in_progress", "blocked"].includes(task.status) && (["recovery_pending", "execution_unconfirmed"].includes(task.executionReconciliation?.state)
    || (task.status === "in_progress" && runs.length && !runs.some(run => !run.ended_at)))) return "execution_unconfirmed";
  return task.status || "unknown";
}

export function taskMatchesBucket(task, bucket) {
  if (!bucket || bucket === "all") return true;
  if (["executor_evidence", "execution_recovery", "independent_acceptance"].includes(bucket)) {
    return (Object.hasOwn(task, "responsibilityQueue") ? task.responsibilityQueue : responsibilityQueue(task)) === bucket;
  }
  return Boolean((task.viewBuckets || taskViewBuckets(task))[bucket]);
}

export function taskMatchesQuery(task, query) {
  const value = String(query || "").trim().toLowerCase();
  return !value || [task.id, task.title, task.goal].some((field) => String(field || "").toLowerCase().includes(value));
}

export function taskPresentation(task) {
  return { ...task, responsibilityQueue: responsibilityQueue(task), project: projectInfo(task.workspace, task.projectId, task.repositoryRoot), actionReasons: actionReasons(task), viewBuckets: taskViewBuckets(task) };
}
