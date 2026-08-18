export const STALE_TASK_MS = 24 * 60 * 60 * 1000;

export function taskTimeState(task, now = Date.now()) {
  const updated = parseTime(task.updatedAt);
  const due = parseTime(task.dueAt);
  const finished = parseTime(task.actualAt || task.updatedAt);
  const created = parseTime(task.createdAt);
  const firstStarted = parseTime(task.firstStartedAt);
  const legacyWallStart = parseTime(!task.timingModelVersion ? task.startedAt : "");
  const activeStarted = parseTime(task.activeStartedAt);
  const blockedStarted = parseTime(task.blockedStartedAt);
  const active = ["planned", "in_progress", "blocked"].includes(task.status);
  const end = active ? now : finished;
  const wallStart = Number.isFinite(created) ? created : Number.isFinite(firstStarted) ? firstStarted : legacyWallStart;
  const wallElapsedMs = Number.isFinite(wallStart) && Number.isFinite(end) ? Math.max(0, end - wallStart) : 0;
  const historyDurations = durationsFromHistory(task.statusHistory, end);
  const hasSegmentData = task.timingModelVersion === "estimate-calibration-v1"
    || Number.isFinite(Number(task.activeElapsedMs))
    || Number.isFinite(Number(task.activeDurationMs))
    || Number.isFinite(Number(task.blockedDurationMs))
    || historyDurations !== null
    || Number.isFinite(firstStarted);
  const activeElapsedMs = hasSegmentData
    ? explicitOrDerivedDuration(task.activeElapsedMs, task.activeDurationMs, historyDurations?.activeMs)
      + (historyDurations === null && task.status === "in_progress" && Number.isFinite(activeStarted) ? Math.max(0, now - activeStarted) : 0)
      + (historyDurations === null && !Number.isFinite(activeStarted) && task.status === "in_progress" && Number.isFinite(firstStarted) ? Math.max(0, now - firstStarted) : 0)
    : null;
  const blockedElapsedMs = hasSegmentData
    ? explicitOrDerivedDuration(task.blockedElapsedMs, task.blockedDurationMs, historyDurations?.blockedMs)
      + (historyDurations === null && task.status === "blocked" && Number.isFinite(blockedStarted) ? Math.max(0, now - blockedStarted) : 0)
    : null;
  const estimatedEffortMs = positiveDuration(task.estimatedEffortMs);
  const scheduleOverdueMs = Number.isFinite(due) && Number.isFinite(end) ? Math.max(0, end - due) : 0;
  const effortVarianceMs = activeElapsedMs !== null && estimatedEffortMs !== null
    ? activeElapsedMs - estimatedEffortMs
    : null;
  const trackedElapsedMs = (activeElapsedMs || 0) + (blockedElapsedMs || 0);
  return {
    stale: active && Number.isFinite(updated) && now - updated > STALE_TASK_MS,
    overdue: scheduleOverdueMs > 0,
    scheduleOverdueMs,
    wallElapsedMs,
    activeElapsedMs,
    blockedElapsedMs,
    activeElapsedKnown: activeElapsedMs !== null,
    blockedRatio: trackedElapsedMs > 0 && blockedElapsedMs !== null ? blockedElapsedMs / trackedElapsedMs : null,
    estimatedEffortMs,
    effortVarianceMs,
    effortOverrun: effortVarianceMs !== null && effortVarianceMs > 0,
    estimateHistory: Array.isArray(task.estimateHistory) ? task.estimateHistory : [],
    expectedAtHistory: Array.isArray(task.expectedAtHistory) ? task.expectedAtHistory : Array.isArray(task.estimateHistory) ? task.estimateHistory : [],
    elapsedMs: wallElapsedMs,
  };
}

function parseTime(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function positiveDuration(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function explicitOrDerivedDuration(explicit, accumulated, derived) {
  if (Number.isFinite(Number(explicit)) && Number(explicit) >= 0) return Number(explicit);
  if (Number.isFinite(Number(accumulated)) && Number(accumulated) >= 0) return Number(accumulated);
  return Number.isFinite(derived) ? derived : 0;
}

function durationsFromHistory(history, end) {
  if (!Array.isArray(history) || !history.length || !Number.isFinite(end)) return null;
  const entries = history
    .map((item) => ({ status: item?.status, at: parseTime(item?.at || item?.occurredAt || item?.recordedAt) }))
    .filter((item) => Number.isFinite(item.at))
    .sort((left, right) => left.at - right.at);
  if (!entries.length) return null;
  let activeMs = 0;
  let blockedMs = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const current = entries[index];
    const intervalEnd = Math.min(end, entries[index + 1]?.at ?? end);
    const duration = Math.max(0, intervalEnd - current.at);
    if (current.status === "in_progress") activeMs += duration;
    if (current.status === "blocked") blockedMs += duration;
  }
  return { activeMs, blockedMs };
}
