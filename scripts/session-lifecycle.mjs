const actions = Object.freeze({
  CONTINUE: "continue_current_session",
  NEW_SESSION: "recommend_new_codex_session",
  HANDOFF: "require_handoff_before_continue",
});

export function recommendSessionLifecycle({ usage = {}, tasks = [], currentTask = null } = {}) {
  const alerts = Array.isArray(usage.alerts) ? usage.alerts : [];
  const completed = tasks.filter((task) => ["done_claimed", "verified"].includes(task.status));
  const projectChanged = Boolean(usage.projectChanged || usage.primaryGoalChanged || primaryGoalChanged(tasks));
  const compressedAfterPhase = alerts.some((item) => item.code === "COMPRESSED_AFTER_MAIN_PHASE");
  const pressure = alerts.some((item) => ["SESSION_CREDIT_SHARE_HIGH", "MODEL_CONTINUATIONS_HIGH"].includes(item.code));
  const multipleIndependentTasks = alerts.some((item) => item.code === "MULTIPLE_INDEPENDENT_TASKS") || completed.length > 1;
  const reasons = [];
  if (projectChanged) reasons.push("project_or_primary_goal_changed");
  if (compressedAfterPhase) reasons.push("compressed_after_main_phase");
  if (pressure) reasons.push("usage_pressure");
  if (multipleIndependentTasks) reasons.push("multiple_independent_tasks_completed");
  const action = projectChanged
    ? actions.HANDOFF
    : reasons.length
      ? actions.NEW_SESSION
      : actions.CONTINUE;
  return {
    action,
    reasons,
    handoff: action === actions.CONTINUE ? "" : buildHandoffPackage({ currentTask, tasks, reasons }),
    taskSemantics: "新建 Codex Session 不等于新建 TaskCenter task；同一交付继续复用原任务。",
  };
}

function primaryGoalChanged(tasks) {
  const ordered = tasks
    .filter((task) => task && (task.goal || task.title))
    .toSorted((left, right) => Date.parse(left.createdAt || left.updatedAt || "") - Date.parse(right.createdAt || right.updatedAt || ""));
  if (ordered.length < 2) return false;
  const identity = (task) => String(task.goal || task.title).trim().toLocaleLowerCase();
  return identity(ordered.at(-2)) !== identity(ordered.at(-1));
}

export function buildHandoffPackage({ currentTask = null, tasks = [], reasons = [] } = {}) {
  const task = currentTask || tasks.at(-1) || {};
  const subject = task.currentSubject
    ? `${task.currentSubject.type}:${task.currentSubject.value || "none"}`
    : task.currentRevision || "未记录";
  const lines = [
    "# TaskCenter Session Handoff",
    `目标：${task.goal || task.title || "未记录"}`,
    `约束：${list(task.nonGoals?.length ? task.nonGoals : task.scope)}`,
    `当前 Subject/Revision：${subject}`,
    `已完成变更：${list(task.changedFiles)}`,
    `验证和审查结果：验证=${task.verificationStatus || "unknown"}；审查=${task.reviewStatus || "unknown"}`,
    `未决问题：${list(task.openQuestions)}`,
    `下一步：${task.nextAction || "继续当前任务的下一未完成步骤"}`,
    `换会话原因：${reasons.join(", ") || "none"}`,
    "语义边界：新建 Codex Session 不等于新建 TaskCenter task；同一交付继续复用原任务。",
  ];
  return truncateUtf8(lines.join("\n"), 2_048);
}

function list(values) {
  return Array.isArray(values) && values.length ? values.join("；") : "无";
}

function truncateUtf8(value, maxBytes) {
  const buffer = Buffer.from(value);
  if (buffer.length <= maxBytes) return value;
  return `${buffer.subarray(0, Math.max(0, maxBytes - 3)).toString("utf8").replace(/�+$/u, "")}…`;
}

export { actions as sessionLifecycleActions };
