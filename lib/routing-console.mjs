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

export function rateLimitPools(report = {}, poolDefs = []) {
  const byLimitId = report.rate_limits?.by_limit_id || {};
  const defsById = new Map((poolDefs || []).map((pool) => [pool?.id, pool]).filter(([id]) => id));
  const pools = Object.entries(byLimitId).map(([limitId, pool]) => {
    const def = defsById.get(pool.limit_id || limitId) || {};
    return { ...pool, limit_id: pool.limit_id || limitId, provider: def.provider || null, source: def.source || "official-api", models: def.models || [], notes: def.notes || "" };
  });
  for (const def of poolDefs || []) {
    if (!def || typeof def !== "object" || typeof def.id !== "string" || !def.id || byLimitId[def.id]) continue;
    pools.push({ limit_id: def.id, limit_name: null, provider: def.provider || null, source: def.source || "unknown", models: def.models || [], notes: def.notes || "", primary: null, secondary: null, observed_at: null });
  }
  if (pools.length) return pools;
  return report.rate_limits?.primary ? [{ limit_id: "default", limit_name: null, provider: null, source: "official-api", models: [], notes: "", primary: report.rate_limits.primary, secondary: null, observed_at: report.rate_limits.primary.observed_at || null }] : [];
}

// 今日用量：24 小时窗口主代理 Token 与成本估算，缺失不推断为 0。
export function usageToday(report = {}) {
  const window = report.windows?.["24h"];
  if (!window || typeof window !== "object") return null;
  const totals = window.totals || {};
  const usage = totals.usage || {};
  const statistics = totals.statistics || {};
  const byModel = Array.isArray(window.byModel) ? window.byModel : [];
  const modelRows = byModel.map((row) => {
    const rowUsage = row.usage || {};
    const input = Number(rowUsage.input) || 0;
    const cachedInput = Number(rowUsage.cachedInput) || 0;
    const output = Number(rowUsage.output) || 0;
    return { model: row.model || "未知", input, cachedInput, output, totalTokens: input + cachedInput + output };
  }).sort((left, right) => right.totalTokens - left.totalTokens);
  const input = Number(usage.input) || 0;
  const cachedInput = Number(usage.cachedInput) || 0;
  const output = Number(usage.output) || 0;
  return {
    input, cachedInput, output, totalTokens: input + cachedInput + output,
    averageTokens: Number(statistics.average) || null,
    p50: Number(statistics.p50) || null,
    p95: Number(statistics.p95) || null,
    cost: totals.cost ?? null,
    costEstimation: totals.costEstimation || "unestimable",
    modelContinuations: Number(window.modelContinuations) || 0,
    count: Number(totals.count) || 0,
    byModel: modelRows,
  };
}

export function isExpiredRateWindow(window, now = Date.now()) {
  return Number.isFinite(Number(window?.resets_at)) && Number(window.resets_at) * 1000 <= now;
}
