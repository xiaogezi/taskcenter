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

const STALE_IN_PROGRESS_MS = 24 * 60 * 60 * 1000; // 24 小时无活动视为孤儿

export function taskActions(task = {}) {
  if (task.archivedAt) return [{ action: "unarchive", label: "取消归档" }];
  const actions = [];
  if (task.status === "blocked") actions.push({ action: "start", label: "恢复为执行中" });
  else if (task.status === "planned") actions.push({ action: "start", label: "标记执行中" });
  else if (["done_claimed", "verified", "cancelled"].includes(task.status)) {
    actions.push({ action: "start", label: "重新处理" });
  }
  // 判断 in_progress 是否真有活跃运行：有活跃 cliRun 或 activeStartedAt 在 24h 内，视为真在跑；
  // 否则视为孤儿任务（状态没收口、无执行事实），主操作给"归档"，次操作才是"取消"。
  const hasActiveRun = (Array.isArray(task.cliRuns) && task.cliRuns.some((run) => run && run.status === "active"));
  const activeRecent = (() => {
    const t = Date.parse(task.activeStartedAt || "");
    // 没有 activeStartedAt 视为未知历史数据，不判为孤儿。
    if (!Number.isFinite(t)) return true;
    return Date.now() - t < STALE_IN_PROGRESS_MS;
  })();
  const isOrphanInProgress = task.status === "in_progress" && !hasActiveRun && !activeRecent;
  if (isOrphanInProgress) {
    actions.push({ action: "archive", label: "归档（孤儿任务）" });
    actions.push({ action: "cancel", label: "标记取消" });
  } else {
    if (["planned", "in_progress", "blocked"].includes(task.status)) actions.push({ action: "cancel", label: "取消任务" });
    if (["done_claimed", "verified", "cancelled"].includes(task.status)) actions.push({ action: "archive", label: "归档" });
  }
  return actions;
}

export function taskViewBuckets(task = {}) {
  const executionComplete = ["done_claimed", "verified"].includes(task.status);
  const verificationDone = ["passed", "not_required"].includes(task.verificationStatus);
  return {
    attention: actionReasons(task).length > 0,
    planned: task.status === "planned",
    in_progress: task.status === "in_progress",
    completed: ["done_claimed", "verified", "cancelled", "rejected"].includes(task.status),
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
