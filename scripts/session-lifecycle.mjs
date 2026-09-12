const actions = Object.freeze({
  CONTINUE: "continue_current_session",
  NEW_SESSION: "recommend_new_codex_session",
  HANDOFF: "require_handoff_before_continue",
});

export function recommendSessionLifecycle({ usage = {}, tasks = [], currentTask = null } = {}) {
  const alerts = Array.isArray(usage.alerts) ? usage.alerts : [];
  const projectChanged = Boolean(usage.projectChanged);
  const compressedAfterPhase = alerts.some((item) => item.code === "COMPRESSED_AFTER_MAIN_PHASE");
  const pressure = alerts.some((item) => ["SESSION_CREDIT_SHARE_HIGH", "MODEL_CONTINUATIONS_HIGH"].includes(item.code));
  const reasons = [];
  if (projectChanged) reasons.push("project_changed");
  if (compressedAfterPhase) reasons.push("compressed_after_main_phase");
  if (pressure) reasons.push("usage_pressure");
  const action = projectChanged
    ? actions.HANDOFF
    : reasons.length
      ? actions.NEW_SESSION
      : actions.CONTINUE;
  return {
    action,
    reasons,
    handoff: action === actions.CONTINUE ? "" : buildHandoffPackage({ currentTask, tasks, reasons }),
    taskSemantics: "同一 Codex Session 可顺序承载多个 TaskCenter task；同一时间只允许一个活跃任务。",
  };
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
    "语义边界：同一 Session 可顺序承载多个任务；同一时间只允许一个活跃任务。",
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

export function machineHandoff(task = {}) {
  const packet = {
    protocol: "taskcenter-handoff/v1", task_id: task.id || null, session_id: task.sessionId || null,
    goal: task.goal || task.title || "", constraints: task.nonGoals || [], subject: task.currentSubject || null,
    changed_files: task.changedFiles || [], verification: task.verificationStatus || "unknown", review: task.reviewStatus || "unknown",
    unresolved: task.openQuestions || [], next_action: task.nextAction || "",
  };
  for (const key of ["constraints", "changed_files", "unresolved"]) packet[key] = packet[key].slice(0, 3).map((item) => truncateUtf8(String(item), 100));
  packet.goal = truncateUtf8(packet.goal, 300);
  packet.next_action = truncateUtf8(packet.next_action, 200);
  if (Buffer.byteLength(JSON.stringify(packet)) > 2048) {
    packet.subject = task.currentSubject ? { type: task.currentSubject.type, value: truncateUtf8(task.currentSubject.value || "", 150) } : null;
    packet.constraints = []; packet.changed_files = []; packet.unresolved = [];
    packet.details_in_task = true;
  }
  if (Buffer.byteLength(JSON.stringify(packet)) > 2048) {
    return { protocol: packet.protocol, task_id: packet.task_id, session_id: packet.session_id, details_in_task: true, next_action: "taskcenter_task_prepare" };
  }
  return packet;
}


export function recommendTaskClose({ new_independent_goal = false, context_large = false, expected_more_rounds = false } = {}) {
  if (context_large && expected_more_rounds) return { action: "recommend_compact", reason: "large_context_with_more_rounds" };
  return { action: "continue", reason: new_independent_goal ? "new_task_same_session" : "small_context_or_finishing" };
}
