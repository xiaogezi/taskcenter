import { createHash } from "node:crypto";
import { taskTimeState } from "../app/task-time-state.mjs";

const DEFAULT_TASK_SCOPE = 1;
const VERIFICATION_CYCLE_MS = 24 * 60 * 60 * 1000;

function parseTaskTime(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function isActiveTask(task) {
  return ["planned", "in_progress", "blocked"].includes(task?.status);
}

function isOverdueBeyondOneCycle(task, now = Date.now()) {
  if (!isActiveTask(task)) return false;
  const state = taskTimeState(task, now);
  if (!state.overdue) return false;
  const dueAt = parseTaskTime(task.dueAt);
  if (dueAt) return now - dueAt > VERIFICATION_CYCLE_MS * DEFAULT_TASK_SCOPE;
  const fallback = parseTaskTime(task.updatedAt || task.startedAt || task.actualAt);
  return Number.isFinite(fallback) ? now - fallback > VERIFICATION_CYCLE_MS * DEFAULT_TASK_SCOPE : state.stale;
}

function overdueSessionClusterCount(tasks, now = Date.now()) {
  const grouped = new Map();
  for (const task of tasks) {
    if (!isOverdueBeyondOneCycle(task, now) || !task.sessionId) continue;
    const existing = grouped.get(task.sessionId);
    if (existing) existing.push(task);
    else grouped.set(task.sessionId, [task]);
  }
  const clusters = [...grouped.values()].filter((items) => items.length > DEFAULT_TASK_SCOPE);
  return {
    clusters,
    count: clusters.length,
    taskIds: clusters.flatMap((group) => group.map((task) => task.id)).filter(Boolean),
  };
}

function collectOverduePlanningSignals(tasks, now = Date.now()) {
  const overdue = tasks.filter((task) => isActiveTask(task) && taskTimeState(task, now).overdue);
  const splitCandidates = overdue.filter((task) => isOverdueBeyondOneCycle(task, now));
  const clusters = overdueSessionClusterCount(splitCandidates, now);
  const overdueHours = overdue
    .map((task) => parseTaskTime(task.dueAt))
    .filter(Number.isFinite)
    .map((expectedAt) => Math.max(1, Math.ceil((now - expectedAt) / VERIFICATION_CYCLE_MS * 24)))
    .sort((left, right) => left - right);
  const middle = Math.floor(overdueHours.length / 2);
  const medianOverdueHours = overdueHours.length
    ? overdueHours.length % 2
      ? overdueHours[middle]
      : Math.ceil((overdueHours[middle - 1] + overdueHours[middle]) / 2)
    : 0;
  const calibrationStates = tasks
    .map((task) => taskTimeState(task, now))
    .filter((state) => state.activeElapsedMs !== null && state.estimatedEffortMs !== null);
  const effortVariancePercents = calibrationStates
    .map((state) => Math.round((state.effortVarianceMs / state.estimatedEffortMs) * 100));
  const blockedRatios = tasks
    .map((task) => taskTimeState(task, now).blockedRatio)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  return {
    overdue,
    splitCandidates,
    clusters,
    maxOverdueHours: overdueHours.at(-1) || 0,
    medianOverdueHours,
    effortSampleCount: calibrationStates.length,
    averageActiveEffortVariancePercent: average(effortVariancePercents),
    averageBlockedRatioPercent: Math.round(average(blockedRatios) * 100),
  };
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

const proposalDefinitions = [
  {
    id: "reflection-evidence-gap",
    kind: "evidence_quality",
    title: "补强完成声明的验证证据",
    select: (tasks) => tasks.filter((task) => task.status === "done_claimed" && !(task.tests?.length) && !(task.evidence?.length)),
    threshold: 1,
    recommendation: "把 tests 与 evidence 都为空的完成声明退回补证，并把至少一项验证证据写入任务验收标准。",
    risk: "证据不足会让 done_claimed 被误当作真实完成，增加回归与错误验收风险。",
  },
  {
    id: "reflection-blocker-cluster",
    kind: "delivery_blocker",
    title: "集中处理反复出现的阻塞任务",
    select: (tasks) => tasks.filter((task) => task.status === "blocked"),
    threshold: 2,
    recommendation: "为阻塞任务建立共同的解除条件、负责人和预计时间，优先消除共享依赖。",
    risk: "阻塞任务持续累积会掩盖真实在制品数量并拖慢后续交付。",
  },
  {
    id: "reflection-overdue-work",
    kind: "planning_quality",
    title: "校准任务预计时间与拆分粒度",
    select: (tasks, now = Date.now()) => collectOverduePlanningSignals(tasks, now).overdue,
    threshold: 2,
    recommendation: "复盘逾期任务的估时偏差原因；为仍活跃任务更新预计时间，范围过大时拆成可独立验收的小任务。",
    risk: "长期逾期会降低预计时间的可信度，使风险发现滞后。",
    collectEvidence: (tasks, now = Date.now()) => {
      const signal = collectOverduePlanningSignals(tasks, now);
      const taskIds = signal.overdue.map((task) => task.id).filter(Boolean).slice(0, 50);
      const splitTaskIds = signal.splitCandidates.map((task) => task.id).filter(Boolean).slice(0, 50);
      const clustersTaskIds = signal.clusters.taskIds.filter(Boolean).slice(0, 50);
      return [
        { metric: "planning_quality", count: taskIds.length, taskIds },
        { metric: "planning_max_overdue_hours", count: signal.maxOverdueHours, taskIds: [] },
        { metric: "planning_median_overdue_hours", count: signal.medianOverdueHours, taskIds: [] },
        { metric: "planning_split_candidates", count: splitTaskIds.length, taskIds: splitTaskIds },
        { metric: "planning_dependency_clusters", count: signal.clusters.count, taskIds: clustersTaskIds },
        { metric: "planning_active_effort_variance_percent", count: Math.round(signal.averageActiveEffortVariancePercent), taskIds: [] },
        { metric: "planning_blocked_ratio_percent", count: signal.averageBlockedRatioPercent, taskIds: [] },
        { metric: "planning_effort_sample_count", count: signal.effortSampleCount, taskIds: [] },
      ];
    },
    summaryTemplate: (signal) => {
      const splitCount = signal.splitCandidates.length;
      const clusterCount = signal.clusters.count;
      if (!clusterCount && !splitCount) {
        return "本轮发现符合逾期条件的任务，但未检测到持续超期或同会话依赖聚类。";
      }
      return `本轮发现 ${signal.overdue.length} 个逾期任务，中位逾期 ${signal.medianOverdueHours} 小时、最大逾期 ${signal.maxOverdueHours} 小时；有效执行工时平均偏差 ${Math.round(signal.averageActiveEffortVariancePercent)}%，阻塞占比 ${signal.averageBlockedRatioPercent}%；其中 ${splitCount} 个超出一个验证周期，且检测到 ${clusterCount} 个同会话高风险依赖簇。`;
    },
  },
  {
    id: "reflection-review-rework",
    kind: "review_feedback",
    title: "把验收打回原因前移到任务定义",
    select: (tasks) => tasks.filter((task) => task.reviewReason && task.status !== "verified"),
    threshold: 2,
    recommendation: "归纳近期打回原因，并将共性要求加入新任务的 assumptions、risks 和 acceptance criteria。",
    risk: "同类验收问题反复出现会产生可避免的返工。",
  },
];

function fingerprint(id, taskIds, boundary) {
  return createHash("sha256")
    .update(JSON.stringify([id, taskIds.slice().sort(), boundary]))
    .digest("hex")
    .slice(0, 20);
}

export function emptyReflectionState() {
  return {
    version: 1,
    generatedAt: "",
    dataBoundary: { sessionMode: "allowlist", allowedSessionCount: 0, taskCount: 0 },
    proposals: [],
  };
}

export function reconcileReflectionSessionSelection(state, sessionSelection, now = new Date().toISOString()) {
  const allowedSessionCount = Array.isArray(sessionSelection?.threadIds) ? sessionSelection.threadIds.length : 0;
  if (allowedSessionCount === 0) return state;
  const proposals = (state.proposals || []).filter((proposal) => proposal.id !== "reflection-empty-allowlist");
  if (state.dataBoundary?.allowedSessionCount === allowedSessionCount && proposals.length === (state.proposals || []).length) {
    return state;
  }
  return {
    ...state,
    generatedAt: now,
    dataBoundary: {
      ...(state.dataBoundary || {}),
      sessionMode: "allowlist",
      allowedSessionCount,
    },
    proposals,
  };
}

export function generateReflection({ tasks = [], sessionSelection, previousState, now = new Date().toISOString() }) {
  const allowedSessionCount = Array.isArray(sessionSelection?.threadIds) ? sessionSelection.threadIds.length : 0;
  const boundary = { sessionMode: "allowlist", allowedSessionCount, taskCount: tasks.length };
  const previous = new Map((previousState?.proposals || []).map((proposal) => [proposal.id, proposal]));
  const nowMs = Date.parse(now);
  const proposals = [];

  if (allowedSessionCount === 0) {
    const id = "reflection-empty-allowlist";
    const currentFingerprint = fingerprint(id, [], boundary);
    proposals.push(mergeDecision(previous.get(id), currentFingerprint, {
      id,
      kind: "data_boundary",
      executionPolicy: "manual_only",
      title: "先配置 Session 白名单",
      summary: "当前白名单为空，反思未读取任何 Codex 会话内容。",
      recommendation: "从本地 Session 列表中显式勾选允许读取的会话，再重新运行反思。",
      risk: "在没有获准数据的情况下扩大读取范围会破坏本地隐私边界。",
      evidence: [{ metric: "allowed_session_count", count: 0, taskIds: [] }],
      fingerprint: currentFingerprint,
      generatedAt: now,
    }, tasks));
  }

  for (const definition of proposalDefinitions) {
    const matched = definition.select(tasks, nowMs);
    if (matched.length < definition.threshold) continue;
    const taskIds = matched.map((task) => task.id).filter(Boolean).slice(0, 50);
    const evidence = definition.collectEvidence
      ? definition.collectEvidence(tasks, nowMs)
      : [{ metric: definition.kind, count: matched.length, taskIds }];
    const summary = definition.summaryTemplate
      ? definition.summaryTemplate(collectOverduePlanningSignals(tasks, nowMs))
      : `本轮发现 ${matched.length} 个相关任务，仅记录任务 ID 与聚合计数。`;
    const currentFingerprint = fingerprint(definition.id, taskIds, boundary);
    proposals.push(mergeDecision(previous.get(definition.id), currentFingerprint, {
      id: definition.id,
      kind: definition.kind,
      executionPolicy: "agent_task",
      title: definition.title,
      summary,
      recommendation: definition.recommendation,
      risk: definition.risk,
      evidence,
      fingerprint: currentFingerprint,
      generatedAt: now,
    }, tasks));
  }

  const currentIds = new Set(proposals.map((proposal) => proposal.id));
  for (const prior of previous.values()) {
    if (prior.executionPolicy === "manual_only") continue;
    if (currentIds.has(prior.id) || !(prior.executions?.length)) continue;
    const task = linkedTaskForProposal(prior, tasks);
    if (["done_claimed", "verified"].includes(task?.status)) {
      proposals.push({
        ...prior,
        status: "resolved",
        resolvedAt: now,
        generatedAt: now,
        summary: "关联改进任务已声明完成，本轮反思未再检测到该问题。",
      });
    } else if (task && ["planned", "in_progress", "blocked"].includes(task.status)) {
      proposals.push({ ...prior, status: "accepted", generatedAt: now });
    }
  }

  return { version: 1, generatedAt: now, dataBoundary: boundary, proposals };
}

export function decideReflectionProposal(state, proposalId, decision, reason = "", now = new Date().toISOString()) {
  if (!["accepted", "rejected", "proposed"].includes(decision)) throw new Error("反思提案决策无效。");
  const index = state.proposals.findIndex((proposal) => proposal.id === proposalId);
  if (index < 0) throw new Error("反思提案不存在或已被新一轮数据替换。");
  const proposals = state.proposals.slice();
  proposals[index] = {
    ...proposals[index],
    status: decision,
    decidedAt: decision === "proposed" ? "" : now,
    decisionReason: decision === "proposed" ? "" : String(reason || "").trim().slice(0, 500),
  };
  return { ...state, proposals };
}

function mergeDecision(previous, currentFingerprint, proposal, tasks) {
  const executions = previous?.executions || [];
  const latestTask = previous ? linkedTaskForProposal(previous, tasks) : null;
  if (latestTask && ["planned", "in_progress", "blocked"].includes(latestTask.status)) {
    return {
      ...proposal,
      status: "accepted",
      decidedAt: previous.decidedAt || "",
      decisionReason: previous.decisionReason || "",
      executions,
    };
  }
  if (!previous || previous.fingerprint !== currentFingerprint || ["done_claimed", "verified", "cancelled"].includes(latestTask?.status)) {
    return {
      ...proposal,
      status: "proposed",
      decidedAt: "",
      decisionReason: "",
      executions,
      retryReady: ["done_claimed", "verified"].includes(latestTask?.status),
    };
  }
  return {
    ...proposal,
    status: ["accepted", "rejected"].includes(previous.status) ? previous.status : "proposed",
    decidedAt: previous.decidedAt || "",
    decisionReason: previous.decisionReason || "",
    executions,
  };
}

export function beginReflectionExecution(state, proposalId, execution, tasks = []) {
  const index = state.proposals.findIndex((proposal) => proposal.id === proposalId);
  if (index < 0) throw new Error("反思提案不存在或已被新一轮数据替换。");
  const proposal = state.proposals[index];
  if (proposal.status !== "accepted") throw new Error("只有已采纳的反思提案可以创建改进任务。");
  if (proposal.executionPolicy !== "agent_task") throw new Error("该提案需要人工操作，不能自动派发给 Agent。");
  const replay = (proposal.executions || []).find((item) => item.requestId === execution.requestId);
  if (replay) return { state, proposal, execution: replay, replayed: true };
  const latest = proposal.executions?.at(-1);
  const latestTask = linkedTaskForProposal(proposal, tasks);
  if ((latest && !latestTask) || ["planned", "in_progress", "blocked"].includes(latestTask?.status) || (["done_claimed", "verified"].includes(latestTask?.status) && !proposal.retryReady)) {
    throw new Error("该提案已有未结束的改进任务，请先完成或取消后再重试。");
  }
  const nextProposal = {
    ...proposal,
    retryReady: false,
    executions: [...(proposal.executions || []), execution],
  };
  const proposals = state.proposals.slice();
  proposals[index] = nextProposal;
  return { state: { ...state, proposals }, proposal: nextProposal, execution, replayed: false };
}

export function updateReflectionExecution(state, proposalId, executionId, patch) {
  const index = state.proposals.findIndex((proposal) => proposal.id === proposalId);
  if (index < 0) return state;
  const proposal = state.proposals[index];
  const executionIndex = (proposal.executions || []).findIndex((execution) => execution.id === executionId);
  if (executionIndex < 0) return state;
  const executions = proposal.executions.slice();
  executions[executionIndex] = { ...executions[executionIndex], ...patch };
  const proposals = state.proposals.slice();
  proposals[index] = { ...proposal, executions };
  return { ...state, proposals };
}

export function hydrateReflectionState(state, tasks = [], dispatches = []) {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const dispatchById = new Map(dispatches.map((dispatch) => [dispatch.id, dispatch]));
  return {
    ...state,
    proposals: state.proposals.map((proposal) => {
      const executions = proposal.executions || [];
      const representedTaskIds = new Set(executions.map((execution) => execution.taskId));
      const nativeTask = linkedTaskForProposal(proposal, tasks);
      const hydrated = executions.map((execution) => {
        const task = taskById.get(execution.taskId);
        const dispatch = dispatchById.get(execution.dispatchId);
        return {
          ...execution,
          taskStatus: task?.status || "",
          dispatchStatus: dispatch?.status || execution.status,
          dispatchError: dispatch?.error || execution.error || "",
        };
      });
      if (nativeTask && !representedTaskIds.has(nativeTask.id)) {
        hydrated.push({
          id: `native-${nativeTask.id}`,
          requestId: "",
          taskId: nativeTask.id,
          dispatchId: "",
          mode: "native",
          sessionId: nativeTask.sessionId || "",
          status: nativeTask.status,
          taskStatus: nativeTask.status,
          dispatchStatus: "native",
          dispatchError: "自动 Session 不可用时由原生 Agent 接管。",
          createdAt: nativeTask.createdAt || "",
          updatedAt: nativeTask.updatedAt || "",
        });
      }
      return { ...proposal, executions: hydrated };
    }),
  };
}

function linkedTaskForProposal(proposal, tasks) {
  const executionTaskIds = new Set((proposal.executions || []).map((execution) => execution.taskId));
  const requirementId = `reflection:${proposal.id}`;
  return tasks
    .filter((task) => executionTaskIds.has(task.id) || task.requirementId === requirementId)
    .filter((task) => !["cancelled", "removed"].includes(task.status))
    .sort((left, right) => Date.parse(left.updatedAt || left.createdAt || 0) - Date.parse(right.updatedAt || right.createdAt || 0))
    .at(-1) || null;
}

export function buildReflectionExecutionPrompt(proposal, taskId) {
  const planningInstructions = proposal.kind === "planning_quality" ? [
    "估时复盘要求：优先依据任务账本的 estimatedEffortMs、activeElapsedMs、blockedElapsedMs、dueAt 与 estimateHistory，记录偏差属于范围膨胀、依赖阻塞、风险遗漏还是执行效率偏差；旧任务缺少分段数据时不得把墙钟耗时当作有效执行工时。",
    "对当前 Session 可控的任务，使用 taskcenter_task_update 更新 expected_at（旧客户端兼容别名）或 due_at，并同步 estimated_effort_ms 与 estimate_reason；若范围已不可控，拆成可独立验收的小任务。不得绕过 Session 归属修改其他会话任务。",
  ] : [];
  return [
    "【TaskCenter 已采纳改进提案】",
    `提案 ID：${bounded(proposal.id, 160)}`,
    `正式任务 ID：${bounded(taskId, 200)}`,
    `改进目标：${bounded(proposal.title, 200)}`,
    `建议：${bounded(proposal.recommendation, 700)}`,
    `风险：${bounded(proposal.risk, 700)}`,
    "",
    "TaskCenter 已为当前真实 Session 自动登记并创建以上正式任务。开始修改前仍需调用 taskcenter_session_register，并以同一 task_id 调用 taskcenter_task_create 确认任务；不得创建第二条任务。",
    "随后先核对当前代码和提案证据，再更新该任务的 current_step / next_action。实施完成后运行必要测试并调用 taskcenter_task_report 上报 done_claimed；后续反思若仍发现问题，会重新进入改进。",
    ...planningInstructions,
    "未经明确授权不执行 git add、commit、push，不修改 ~/.codex，不上传 Session 内容。若 MCP 不可用，只做只读检查并报告 TASKCENTER_UNAVAILABLE。",
  ].join("\n").slice(0, 3_500);
}

function bounded(value, limit) {
  const text = String(value || "未记录").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
