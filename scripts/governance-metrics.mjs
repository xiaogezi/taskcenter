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
  return {
    schemaVersion: "taskcenter-governance-metrics-v1",
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
    groups,
    comparisons: buildMatchedComparisons(groups, usageReport?.windows || []),
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

function isCompleted(task) { return ["done_claimed", "verified"].includes(task.status); }
function hasRework(task) {
  return (task.requirementResults || []).some((item) => item.status === "failed")
    || (task.reviewAttestations || []).some((item) => ["changes_requested", "rejected"].includes(item.verdict));
}
function durationMs(task) {
  if (Number.isFinite(Number(task.activeDurationMs)) && Number(task.activeDurationMs) > 0) return Number(task.activeDurationMs);
  const end = Date.parse(task.actualAt || task.updatedAt || "");
  const start = Date.parse(task.firstStartedAt || task.startedAt || task.createdAt || "");
  return Number.isFinite(end) && Number.isFinite(start) ? Math.max(0, end - start) : NaN;
}
function timestampOf(task) { return Date.parse(task.actualAt || task.updatedAt || task.createdAt || "") || -Infinity; }
function eventTimestamp(event) { return Date.parse(event.recorded_at || event.recordedAt || event.created_at || event.createdAt || "") || -Infinity; }
function distribution(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return { average: average(sorted), p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) };
}
function average(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function percentile(values, quantile) {
  if (!values.length) return 0;
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1))];
}
function number(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function finiteOrNull(value) { return value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null; }
