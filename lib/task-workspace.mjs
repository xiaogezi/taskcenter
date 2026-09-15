export const taskTabs = ["overview", "evidence", "activity", "routing", "bug"];

export function parseTaskWorkspaceSearch(search) {
  const params = new URLSearchParams(search);
  const page = Number.parseInt(params.get("page") || "1", 10);
  return {
    project: params.get("project") || "all",
    bucket: params.get("bucket") || "all",
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
    ["执行", task.status || "unknown"],
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

export function actionReasons(task = {}) {
  const reasons = [];
  const add = (code, label, detail = "") => reasons.push({ code, label, ...(detail ? { detail } : {}) });
  if (task.status === "blocked") add("blocked", "任务已阻塞", task.blocker || "");
  if (task.blocker && task.status !== "blocked") add("blocker", "存在阻塞说明", task.blocker);
  if (task.verificationStatus === "failed") add("verification_failed", "验证失败");
  if (task.verificationStatus === "stale") add("verification_stale", "验证已过期");
  if (task.acceptanceStatus === "rejected") add("acceptance_rejected", "验收已拒绝");
  if (task.acceptanceStatus === "stale") add("acceptance_stale", "验收已过期");
  return reasons;
}

export function taskActions(task = {}) {
  const reasons = Array.isArray(task.actionReasons) ? task.actionReasons : actionReasons(task);
  const actions = [];
  if (task.status === "blocked") actions.push({ action: "start", label: "恢复执行" });
  else if (task.status === "planned") actions.push({ action: "start", label: "开始执行" });
  else if (reasons.length) {
    const needsRework = task.status !== "cancelled" && reasons.some((reason) => /^(review_|acceptance_|unresolved_)/.test(reason.code));
    actions.push({ action: "start", label: needsRework ? "返工处理" : "重新处理" });
  }
  if (["planned", "in_progress", "blocked"].includes(task.status)) actions.push({ action: "cancel", label: "关闭任务" });
  if (task.status === "cancelled") actions.push({ action: "archive", label: "归档" });
  return actions;
}

export function taskViewBuckets(task = {}) {
  const executionComplete = ["done_claimed", "verified"].includes(task.status);
  const verificationDone = ["passed", "not_required"].includes(task.verificationStatus);
  return {
    attention: actionReasons(task).length > 0,
    bugs: Boolean(task.bug),
    awaiting_merge: task.bugClosure?.status === "awaiting_merge",
    completed_bugs: task.bugClosure?.status === "completed",
    in_progress: task.status === "in_progress",
    awaiting_verification: executionComplete && task.verificationStatus === "pending",
    awaiting_acceptance: executionComplete && verificationDone && ["pending", "ready"].includes(task.acceptanceStatus),
    blocked: task.status === "blocked",
  };
}

export function taskMatchesBucket(task, bucket) {
  return bucket === "all" || !bucket || Boolean(taskViewBuckets(task)[bucket]);
}

export function taskMatchesQuery(task, query) {
  const value = String(query || "").trim().toLowerCase();
  return !value || [task.id, task.title, task.goal].some((field) => String(field || "").toLowerCase().includes(value));
}

export function taskPresentation(task) {
  return { ...task, project: projectInfo(task.workspace, task.projectId, task.repositoryRoot), actionReasons: actionReasons(task), viewBuckets: taskViewBuckets(task) };
}
