export const STALE_TASK_MS = 24 * 60 * 60 * 1000;

export function taskTimeState(task, now = Date.now()) {
  const updated = Date.parse(task.updatedAt || "");
  const expected = Date.parse(task.expectedAt || "");
  const finished = Date.parse(task.actualAt || task.updatedAt || "");
  const started = Date.parse(task.startedAt || "");
  const active = ["planned", "in_progress", "blocked"].includes(task.status);
  return {
    stale: active && Number.isFinite(updated) && now - updated > STALE_TASK_MS,
    overdue: Number.isFinite(expected) && (active ? now > expected : Number.isFinite(finished) && finished > expected),
    elapsedMs: Number.isFinite(started) && Number.isFinite(active ? now : finished) ? Math.max(0, (active ? now : finished) - started) : 0,
  };
}
