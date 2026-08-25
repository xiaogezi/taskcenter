import { STALE_TASK_MS, taskTimeState } from "./task-time-state.mjs";

export const taskLifecycleFilters = [
  { id: "all", label: "全部" },
  { id: "unfinished", label: "未完成" },
  { id: "planned", label: "待开始" },
  { id: "in_progress", label: "执行中" },
  { id: "blocked", label: "阻塞" },
  { id: "overdue", label: "交付逾期" },
  { id: "stale", label: "陈旧未闭环" },
  { id: "needs_verification", label: "验证未就绪" },
  { id: "needs_review", label: "Review 未就绪" },
  { id: "stale_evidence", label: "证据已过期" },
];

const activeStatuses = new Set(["planned", "in_progress", "blocked"]);
const verificationReasons = new Set(["required_verification_missing", "verification_failed", "portable_evidence_missing"]);
const reviewReasons = new Set(["required_review_missing"]);
const staleEvidenceReasons = new Set(["requirement_result_stale", "verification_stale", "review_stale", "acceptance_stale"]);

const reasonLabels = new Map([
  ["execution_not_done_claimed", "未声明完成"],
  ["current_subject_missing", "缺少 Subject"],
  ["acceptance_criterion_pending", "验收条件待确认"],
  ["required_verification_missing", "验证未齐"],
  ["verification_failed", "验证失败"],
  ["verification_stale", "验证已过期"],
  ["portable_evidence_missing", "缺可移植证据"],
  ["required_review_missing", "Review 未齐"],
  ["review_stale", "Review 已过期"],
  ["requirement_result_stale", "验收结果已过期"],
  ["acceptance_stale", "验收已过期"],
]);

export function isActiveTask(task) {
  return activeStatuses.has(task?.status) && !task?.archivedAt;
}

export function matchesTaskLifecycleFilter(task, filter, now = Date.now()) {
  if (task?.archivedAt) return false;
  if (filter === "all") return true;
  if (filter === "unfinished") return isActiveTask(task);
  if (["planned", "in_progress", "blocked"].includes(filter)) return task?.status === filter;
  if (!isActiveTask(task)) return false;

  const reasons = new Set(task?.completionReadiness?.reasons || []);
  if (filter === "overdue") return taskTimeState(task, now).overdue;
  if (filter === "stale") {
    const updatedAt = Date.parse(String(task?.updatedAt || ""));
    return Number.isFinite(updatedAt) && now - updatedAt > STALE_TASK_MS;
  }
  if (filter === "needs_verification") {
    return ["pending", "failed"].includes(task?.verificationStatus)
      || [...verificationReasons].some((reason) => reasons.has(reason));
  }
  if (filter === "needs_review") {
    return ["pending", "changes_requested", "rejected"].includes(task?.reviewStatus)
      || [...reviewReasons].some((reason) => reasons.has(reason));
  }
  if (filter === "stale_evidence") {
    return task?.verificationStatus === "stale"
      || task?.reviewStatus === "stale"
      || task?.acceptanceStatus === "stale"
      || [...staleEvidenceReasons].some((reason) => reasons.has(reason));
  }
  return false;
}

export function taskLifecycleFilterCounts(tasks, now = Date.now()) {
  return Object.fromEntries(taskLifecycleFilters.map(({ id }) => [
    id,
    tasks.filter((task) => matchesTaskLifecycleFilter(task, id, now)).length,
  ]));
}

export function taskClosureReasonLabels(task) {
  if (!isActiveTask(task)) return [];
  return [...new Set((task?.completionReadiness?.reasons || []).map((reason) => reasonLabels.get(reason)).filter(Boolean))];
}
