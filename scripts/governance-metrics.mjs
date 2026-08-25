import { existsSync, readFileSync } from "node:fs";

export function readTaskEvents(path) {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export function buildGovernanceMetrics({ tasks = [], events = [], usageReport = null } = {}) {
  const visible = tasks.filter((task) => task.status !== "removed");
  const groups = {
    workflow_profile: groupMetrics(visible, events, (task) => task.workflowProfile || "legacy"),
    task_class: groupMetrics(visible, events, (task) => task.routing?.taskClass || task.taskClass || "unclassified"),
    model: groupMetrics(visible, events, (task) => task.routing?.selectedExecutorModel || task.model || "unknown"),
  };
  const generatedAt = Date.parse(usageReport?.generatedAt || "");
  const windowDuration = Number(usageReport?.windows?.["24h"]?.durationMs || 86_400_000);
  const windowStart = Number.isFinite(generatedAt) ? generatedAt - windowDuration : -Infinity;
  const completed = visible.filter((task) => isCompleted(task) && timestampOf(task) >= windowStart);
  const windowEvents = events.filter((event) => eventTimestamp(event) >= windowStart);
  const touchedTaskIds = new Set(windowEvents.map((event) => event.task_id).filter(Boolean));
  const overallUsage = usageReport?.overall || {};
  const estimatedCredits = finiteOrNull(overallUsage.estimatedCredits);
  const creditsEstimation = ["complete", "partial", "unestimable"].includes(overallUsage.creditsEstimation)
    ? overallUsage.creditsEstimation
    : estimatedCredits === null ? "unestimable" : "complete";
  const continuations = number(overallUsage.modelContinuations);
  const attributionCoverage = buildAttributionCoverage(usageReport?.windows?.["24h"]);
  const diagnostics = buildDiagnosticMetrics(visible, windowStart);
  const reviews = buildReviewMetrics(visible);
  return {
    schemaVersion: "taskcenter-governance-metrics-v2",
    completedTasks: completed.length,
    creditsPerCompletedTask: estimatedCredits === null || !completed.length ? null : estimatedCredits / completed.length,
    creditsEstimation,
    modelContinuationsPerTask: completed.length ? continuations / completed.length : null,
    inputTokens: {
      average: number(overallUsage.input?.average),
      p50: number(overallUsage.input?.p50),
      p95: number(overallUsage.input?.p95),
    },
    taskCenterCallsPerTask: touchedTaskIds.size ? windowEvents.filter((event) => event.task_id).length / touchedTaskIds.size : 0,
    reworkRate: completed.length ? completed.filter(hasRework).length / completed.length : 0,
    durationMs: distribution(completed.map(durationMs).filter(Number.isFinite)),
    attributionCoverage,
    diagnostics,
    reviews,
    groups,
    comparisons: buildMatchedComparisons(groups, usageReport?.windows || []),
  };
}

function buildReviewMetrics(tasks) {
  const implementationTasks = tasks.filter((task) => !isIndependentReviewTask(task));
  const independentReviewTasks = tasks.filter(isIndependentReviewTask);
  const taskSummaries = implementationTasks.flatMap((task) => summarizeTaskReview(task));
  const cycles = taskSummaries.flatMap((item) => item.cycles.map((cycle) => ({ ...cycle, taskId: item.taskId })));
  const effectiveAttestations = implementationTasks.flatMap((task) => (task.reviewAttestations || []).filter((item) => item.effective_review !== false));
  const findings = effectiveAttestations.flatMap((item) => item.findings || []);
  const reviewedTaskSummaries = taskSummaries.filter((item) => item.reviewRounds > 0);
  const cycleTasks = new Set(taskSummaries.map((item) => item.taskId));
  const activeSamples = cycles.filter((item) => item.activeMs !== null);
  const phase = (value) => cycles.filter((item) => item.phase === value).length;
  return {
    taskRoles: { implementation: implementationTasks.length, independent_review: independentReviewTasks.length },
    coverage: {
      eligibleTasks: implementationTasks.length,
      tasksWithCycles: cycleTasks.size,
      cycleCoverage: implementationTasks.length ? cycleTasks.size / implementationTasks.length : null,
      cycles: cycles.length,
      cyclesWithActiveTime: activeSamples.length,
      activeTimeCoverage: cycles.length ? activeSamples.length / cycles.length : null,
      note: "缺少阶段事件或 active time 时显示数据不足，不推断为 0。",
    },
    funnel: {
      pending_review: phase("pending_review"), reviewing: phase("reviewing"), fixing: phase("fixing"),
      rereview: cycles.filter((item) => item.reviewScope === "incremental").length,
      approved: cycles.filter((item) => item.outcome === "approved").length,
    },
    rounds: {
      perTask: distribution(reviewedTaskSummaries.map((item) => item.reviewRounds)),
      firstPassRate: reviewedTaskSummaries.length ? reviewedTaskSummaries.filter((item) => item.firstPass).length / reviewedTaskSummaries.length : null,
      changesRequested: taskSummaries.reduce((sum, item) => sum + item.changesRequestedRounds, 0),
      full: cycles.filter((item) => item.reviewScope === "full").length,
      incremental: cycles.filter((item) => item.reviewScope === "incremental").length,
    },
    timeMs: {
      wait: distribution(cycles.map((item) => item.waitMs).filter(Number.isFinite)),
      reviewElapsed: distribution(cycles.map((item) => item.reviewElapsedMs).filter(Number.isFinite)),
      fixElapsed: distribution(cycles.map((item) => item.fixElapsedMs).filter(Number.isFinite)),
      verificationElapsed: distribution(cycles.map((item) => item.verificationElapsedMs).filter(Number.isFinite)),
      wall: distribution(cycles.map((item) => item.wallMs).filter(Number.isFinite)),
      active: distribution(cycles.map((item) => item.activeMs).filter(Number.isFinite)),
      wallToTaskRatio: distribution(taskSummaries.map((item) => item.reviewWallToTaskRatio).filter(Number.isFinite)),
    },
    findings: {
      total: findings.length,
      byCategory: countBy(findings, "category"), bySeverity: countBy(findings, "severity"), byValidity: countBy(findings, "validity"),
      validRatio: ratioOf(findings, "validity", "valid"), duplicateRatio: ratioOf(findings, "validity", "duplicate"), falsePositiveRatio: ratioOf(findings, "validity", "false_positive"),
    },
    waitReasons: countBy(cycles.filter((item) => item.waitReason).map((item) => ({ reason: item.waitReason })), "reason"),
    reviewLoopWarnings: taskSummaries.flatMap((item) => item.warnings),
    longTailTasks: taskSummaries.filter((item) => item.warnings.length).map((item) => ({ taskId: item.taskId, warnings: item.warnings.map((warning) => warning.type), reviewRounds: item.reviewRounds, reviewWallMs: item.reviewWallMs })),
    taskSummaries,
    note: "团队与流程诊断数据，不用于 reviewer、模型或个人排名，也不参与任务门禁。",
  };
}

function summarizeTaskReview(task) {
  const cycles = (task.reviewCycles || []).map(summarizeCycle);
  const reviews = (task.reviewAttestations || []).filter((item) => item.effective_review !== false);
  if (!cycles.length && !reviews.length) return [];
  const changesRequestedRounds = reviews.filter((item) => item.verdict === "changes_requested").length;
  const reviewWallMs = sumKnown(cycles.map((item) => item.wallMs));
  const taskWallMs = completedDurationMs(task);
  const reviewWallToTaskRatio = reviewWallMs !== null && Number.isFinite(taskWallMs) && taskWallMs > 0 ? reviewWallMs / taskWallMs : null;
  const warnings = [];
  const add = (type, cycleId = "", detail = "") => warnings.push({ taskId: task.id, type, cycleId, detail });
  if (changesRequestedRounds > 2) add("changes_requested_over_two", "", `${changesRequestedRounds}`);
  if (reviewWallToTaskRatio !== null && reviewWallToTaskRatio > 0.5) add("review_stage_ratio_high", "", `${reviewWallToTaskRatio}`);
  for (const cycle of cycles) {
    if (Number.isFinite(cycle.waitMs) && cycle.waitMs > numberOrZero(cycle.reviewElapsedMs) + numberOrZero(cycle.fixElapsedMs)) add("wait_exceeds_review_and_fix", cycle.cycleId);
    if (cycle.wallClockDistorted) add("wall_clock_distorted", cycle.cycleId, cycle.distortionReason);
  }
  const fullBySubject = groupCount(cycles.filter((item) => item.reviewScope === "full"), (item) => item.subjectKey);
  for (const [subjectKey, count] of fullBySubject) if (subjectKey && count > 1) add("repeated_full_review_same_subject", "", subjectKey);
  const fingerprints = reviews.flatMap((item) => item.findings || []).map((item) => item.fingerprint).filter(Boolean);
  for (const [fingerprint, count] of groupCount(fingerprints, (item) => item)) if (count > 1) add("repeated_finding", "", fingerprint);
  for (const review of (task.reviewAttestations || []).filter((item) => item.effective_review === false && item.duplicate_of_attestation_id)) add("duplicate_approved", review.cycle_id || "", review.id);
  return [{
    taskId: task.id, reviewRounds: reviews.length, firstPass: reviews.length > 0 && reviews[0].verdict === "approved",
    changesRequestedRounds, fullRounds: cycles.filter((item) => item.reviewScope === "full").length,
    incrementalRounds: cycles.filter((item) => item.reviewScope === "incremental").length,
    reviewWallMs, taskWallMs: Number.isFinite(taskWallMs) ? taskWallMs : null, reviewWallToTaskRatio, cycles, warnings,
  }];
}

function summarizeCycle(cycle) {
  const span = (start, end) => timestampSpan(cycle[start], cycle[end]);
  const wallEnd = cycle.verification_finished_at || cycle.fix_finished_at || cycle.review_finished_at;
  const activeValues = [cycle.review_active_ms, cycle.fix_active_ms, cycle.verification_active_ms];
  const activeMs = activeValues.some(Number.isFinite) ? activeValues.filter(Number.isFinite).reduce((sum, value) => sum + value, 0) : null;
  const rawWall = cycle.implementation_ready_at && wallEnd ? Math.max(0, Date.parse(wallEnd) - Date.parse(cycle.implementation_ready_at)) : null;
  const overnight = Number.isFinite(rawWall) && rawWall > 24 * 60 * 60_000;
  return {
    cycleId: cycle.cycle_id, cycleNumber: cycle.cycle_number, reviewScope: cycle.review_scope, phase: cycle.phase || "data_insufficient", outcome: cycle.outcome || "pending",
    subjectKey: subjectKey(cycle.subject_ref), waitReason: cycle.wait_reason || "",
    waitMs: span("review_requested_at", "review_started_at"), reviewElapsedMs: span("review_started_at", "review_finished_at"),
    fixElapsedMs: span("fix_started_at", "fix_finished_at"), verificationElapsedMs: cycle.verification_finished_at ? Math.max(0, Date.parse(cycle.verification_finished_at) - Date.parse(cycle.fix_finished_at || cycle.review_finished_at || "")) : null,
    wallMs: Number.isFinite(rawWall) ? rawWall : null, activeMs,
    wallClockDistorted: overnight || !["approved", "rejected", "cancelled"].includes(cycle.outcome || "pending"),
    distortionReason: overnight ? "overnight_over_24h" : !["approved", "rejected", "cancelled"].includes(cycle.outcome || "pending") ? "cycle_in_progress" : "",
  };
}

function buildAttributionCoverage(window) {
  const rows = Array.isArray(window?.byTask) ? window.byTask : [];
  const totalEvents = number(window?.totals?.count);
  const totalInputTokens = number(window?.totals?.usage?.input);
  const unattributed = rows.find((item) => item.id === "unattributed") || {};
  const unattributedEvents = number(unattributed.count);
  const unattributedInputTokens = number(unattributed.usage?.input);
  const attributedEvents = rows.length ? Math.max(0, totalEvents - unattributedEvents) : 0;
  const attributedInputTokens = rows.length ? Math.max(0, totalInputTokens - unattributedInputTokens) : 0;
  return {
    eventRatio: totalEvents ? attributedEvents / totalEvents : 0,
    inputTokenRatio: totalInputTokens ? attributedInputTokens / totalInputTokens : 0,
    attributedEvents,
    totalEvents,
    note: "仅反映 Token 事件能否唯一归属 TaskCenter task，不作为个人或模型绩效指标。",
  };
}

function buildDiagnosticMetrics(tasks, windowStart) {
  const observations = tasks.flatMap((task) => (task.diagnosticObservations || []).map((item) => ({ ...item, taskId: task.id })))
    .filter((item) => (Date.parse(item.observed_at || "") || -Infinity) >= windowStart);
  const resolved = observations.filter((item) => item.outcome === "resolved");
  const rootCauseDurations = resolved.map((item) => Date.parse(item.root_cause_at || "") - Date.parse(item.started_at || "")).filter((value) => Number.isFinite(value) && value >= 0);
  return {
    cases: observations.length,
    resolvedCases: resolved.length,
    medianTimeToRootCauseMs: distribution(rootCauseDurations).p50,
    averageHypotheses: average(observations.map((item) => number(item.hypothesis_count))),
    averageFailedFixes: average(observations.map((item) => number(item.failed_fix_count))),
    averageRollbacks: average(observations.map((item) => number(item.rollback_count))),
    freshVerificationPassRate: resolved.length ? resolved.filter((item) => item.fresh_verification === "passed").length / resolved.length : 0,
    note: "观察性诊断复盘指标，仅用于寻找流程瓶颈和检验改进，不参与绩效、门禁或自动路由。",
  };
}

function groupMetrics(tasks, events, keyOf) {
  const groups = new Map();
  for (const task of tasks) {
    const key = keyOf(task);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  return [...groups.entries()].map(([key, values]) => {
    const completed = values.filter(isCompleted);
    const taskIds = new Set(values.map((task) => task.id));
    return {
      key,
      tasks: values.length,
      completed: completed.length,
      taskCenterCallsPerTask: values.length ? events.filter((event) => taskIds.has(event.task_id)).length / values.length : 0,
      reworkRate: completed.length ? completed.filter(hasRework).length / completed.length : 0,
      durationMs: distribution(completed.map(durationMs).filter(Number.isFinite)),
    };
  }).sort((left, right) => right.tasks - left.tasks || left.key.localeCompare(right.key));
}

function buildMatchedComparisons(groups, windows) {
  const windowList = Array.isArray(windows) ? windows : Object.values(windows || {});
  return {
    strategy: "matched_task_type_or_alternating_windows",
    note: "优先按 workflow_profile、task_class、model 匹配；窗口比较使用全部可用交替窗口，不只比较相邻两个五小时窗口。",
    cohorts: Object.fromEntries(Object.entries(groups).map(([dimension, values]) => [dimension, values.filter((item) => item.tasks >= 1)])),
    windows: windowList.map((window) => ({ id: window.id || window.window, durationMs: window.durationMs, generatedAt: window.generatedAt })).filter((item) => item.id),
  };
}

function isCompleted(task) { return task.status === "verified" || task.acceptanceStatus === "accepted" || (task.acceptanceRecords || []).at(-1)?.outcome === "accepted"; }
function isIndependentReviewTask(task) { return ["ocr", "ocr_review", "independent_review"].includes(task.routing?.taskClass || task.taskClass); }
function hasRework(task) {
  return (task.requirementResults || []).some((item) => item.status === "failed")
    || (task.reviewAttestations || []).some((item) => ["changes_requested", "rejected"].includes(item.verdict));
}
function durationMs(task) {
  return Number.isFinite(Number(task.activeDurationMs)) && Number(task.activeDurationMs) > 0 ? Number(task.activeDurationMs) : NaN;
}
function completedDurationMs(task) {
  if (!isCompleted(task)) return NaN;
  const end = Date.parse(task.actualAt || task.acceptanceRecords?.at(-1)?.observed_at || "");
  const start = Date.parse(task.firstStartedAt || task.startedAt || task.createdAt || "");
  return Number.isFinite(end) && Number.isFinite(start) ? Math.max(0, end - start) : NaN;
}
function timestampOf(task) { return Date.parse(task.actualAt || task.updatedAt || task.createdAt || "") || -Infinity; }
function eventTimestamp(event) { return Date.parse(event.recorded_at || event.recordedAt || event.created_at || event.createdAt || "") || -Infinity; }
function distribution(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return { average: sorted.length ? average(sorted) : null, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), sampleCount: sorted.length, status: sorted.length ? "available" : "data_insufficient" };
}
function average(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function percentile(values, quantile) {
  if (!values.length) return null;
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1))];
}
function number(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function finiteOrNull(value) { return value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null; }
function numberOrZero(value) { return Number.isFinite(value) ? value : 0; }
function timestampSpan(start, end) {
  const from = Date.parse(start || ""), to = Date.parse(end || "");
  return Number.isFinite(from) && Number.isFinite(to) && to >= from ? to - from : null;
}
function sumKnown(values) { const known = values.filter(Number.isFinite); return known.length ? known.reduce((sum, value) => sum + value, 0) : null; }
function subjectKey(subject) { return subject ? `${subject.type}:${subject.value || ""}:${subject.repository || ""}:${subject.branch || ""}` : ""; }
function groupCount(values, keyOf) { const map = new Map(); for (const value of values) { const key = keyOf(value); map.set(key, (map.get(key) || 0) + 1); } return map; }
function countBy(values, field) { return Object.fromEntries([...groupCount(values, (item) => item[field] || "unknown").entries()].sort(([left], [right]) => left.localeCompare(right))); }
function ratioOf(values, field, expected) { return values.length ? values.filter((item) => item[field] === expected).length / values.length : null; }
