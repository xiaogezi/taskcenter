export const taskTabs = ["overview", "evidence", "activity"];

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

export function projectInfo(workspace) {
  const path = typeof workspace === "string" ? workspace.trim() : "";
  if (!path) return { id: "unknown", label: "未知" };
  const parts = path.split(/[\\/]/).filter(Boolean);
  const worktrees = parts.find((part) => part.endsWith("-worktrees"));
  const label = worktrees ? worktrees.slice(0, -"-worktrees".length) : parts.at(-1) || path;
  return { id: `project:${label.toLocaleLowerCase("en-US")}`, label };
}

export function actionReasons(task = {}) {
  const reasons = [];
  const add = (code, label, detail = "") => reasons.push({ code, label, ...(detail ? { detail } : {}) });
  if (task.status === "blocked") add("blocked", "任务已阻塞", task.blocker || "");
  if (task.blocker && task.status !== "blocked") add("blocker", "存在阻塞说明", task.blocker);
  if (task.verificationStatus === "failed") add("verification_failed", "验证失败");
  if (task.verificationStatus === "stale") add("verification_stale", "验证已过期");
  if (task.reviewStatus === "changes_requested") add("review_changes_requested", "审查要求修改", task.reviewReason || "");
  if (task.reviewStatus === "rejected") add("review_rejected", "审查已拒绝", task.reviewReason || "");
  if (task.reviewStatus === "stale") add("review_stale", "审查已过期");
  if (task.acceptanceStatus === "rejected") add("acceptance_rejected", "验收已拒绝");
  if (task.acceptanceStatus === "stale") add("acceptance_stale", "验收已过期");
  const unresolved = task.reviewAttestations?.some((item) => Number(item?.unresolvedFindings) > 0)
    || Array.isArray(task.completionReadiness?.unresolvedFindings) && task.completionReadiness.unresolvedFindings.length > 0;
  if (unresolved) add("unresolved_findings", "存在未解决审查问题");
  return reasons;
}

export function taskViewBuckets(task = {}) {
  const executionComplete = ["done_claimed", "verified"].includes(task.status);
  const verificationDone = ["passed", "not_required"].includes(task.verificationStatus);
  const reviewDone = ["passed", "not_required"].includes(task.reviewStatus);
  return {
    attention: actionReasons(task).length > 0,
    in_progress: task.status === "in_progress",
    awaiting_verification: executionComplete && task.verificationStatus === "pending",
    awaiting_acceptance: executionComplete && verificationDone && reviewDone && ["pending", "ready"].includes(task.acceptanceStatus),
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
  return { ...task, project: projectInfo(task.workspace), actionReasons: actionReasons(task), viewBuckets: taskViewBuckets(task) };
}
