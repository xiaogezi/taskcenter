export function recentRoutingRows(tasks = [], limit = 20) {
  return tasks.flatMap((task) => {
    const results = new Map((task.routingResultHistory || []).map((result) => [result.routeId, result]));
    if (task.routingResult?.routeId) results.set(task.routingResult.routeId, task.routingResult);
    return (task.routingHistory || []).map((route) => ({
      taskId: task.id,
      taskTitle: task.title || task.id,
      routeId: route.routeId || "",
      model: route.selectedExecutorModel || "未知",
      reason: route.reason || "未知",
      outcome: results.get(route.routeId)?.outcome || route.outcome || "未知",
      recordedAt: route.recordedAt || task.updatedAt || "",
    }));
  }).sort((left, right) => Date.parse(right.recordedAt || "") - Date.parse(left.recordedAt || "")).slice(0, limit);
}

export function rateLimitPools(report = {}) {
  const pools = Object.values(report.rate_limits?.by_limit_id || {});
  if (pools.length) return pools;
  return report.rate_limits?.primary ? [{ limit_id: "default", limit_name: null, primary: report.rate_limits.primary, secondary: null, observed_at: report.rate_limits.primary.observed_at || null }] : [];
}
