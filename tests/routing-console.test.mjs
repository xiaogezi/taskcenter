import assert from "node:assert/strict";
import test from "node:test";
import { isExpiredRateWindow, rateLimitPools, recentRoutingRows, usageToday } from "../lib/routing-console.mjs";

test("模型调度页按最新时间聚合真实路由并关联执行结果", () => {
  const rows = recentRoutingRows([
    { id: "older", title: "旧任务", routingHistory: [{ routeId: "route-1", selectedExecutorModel: "luna", reason: "default", outcome: "selected", recordedAt: "2026-09-08T01:00:00Z" }], routingResultHistory: [{ routeId: "route-1", outcome: "succeeded" }] },
    { id: "newer", title: "新任务", routingHistory: [{ selectedExecutorModel: "astra", reason: "risk", outcome: "started", recordedAt: "2026-09-08T02:00:00Z" }] },
  ]);
  assert.deepEqual(rows.map(({ taskId, model, outcome }) => ({ taskId, model, outcome })), [
    { taskId: "newer", model: "astra", outcome: "started" },
    { taskId: "older", model: "luna", outcome: "succeeded" },
  ]);
});

test("额度池保留多窗口，缺少分池数据时回退主窗口", () => {
  assert.equal(rateLimitPools({ rate_limits: { by_limit_id: { codex: { limit_id: "codex", primary: { used_percent: 20 } } } } })[0].limit_id, "codex");
  assert.equal(rateLimitPools({ rate_limits: { primary: { used_percent: 30 } } })[0].limit_id, "default");
  assert.deepEqual(rateLimitPools({}), []);
});

test("重置时间已过的额度窗口只作为历史快照", () => {
  const now = Date.parse("2026-09-08T00:00:00Z");
  assert.equal(isExpiredRateWindow({ resets_at: Date.parse("2026-09-07T00:00:00Z") / 1000 }, now), true);
  assert.equal(isExpiredRateWindow({ resets_at: Date.parse("2026-09-09T00:00:00Z") / 1000 }, now), false);
  assert.equal(isExpiredRateWindow({}, now), false);
});

test("额度池合并配置定义：标注来源与覆盖模型，运行时信号池无窗口回显未知", () => {
  const defs = [{ id: "codex", provider: "codex", source: "official-api", models: ["luna"] }, { id: "kimi", provider: "moonshot", source: "runtime-signal", models: ["k3"] }];
  const pools = rateLimitPools({ rate_limits: { by_limit_id: { codex: { limit_id: "codex", primary: { used_percent: 20 } } } } }, defs);
  assert.equal(pools.length, 2);
  assert.equal(pools.find((pool) => pool.limit_id === "codex").source, "official-api");
  const kimi = pools.find((pool) => pool.limit_id === "kimi");
  assert.equal(kimi.source, "runtime-signal");
  assert.equal(kimi.primary, null);
  assert.deepEqual(kimi.models, ["k3"]);
  const defOnly = rateLimitPools({ rate_limits: { primary: { used_percent: 30 } } }, defs);
  assert.equal(defOnly.length, 2);
  assert.equal(defOnly[0].limit_id, "codex");
  assert.equal(rateLimitPools({ rate_limits: { primary: { used_percent: 30 } } })[0].limit_id, "default");
});

test("今日用量提取 24 小时窗口并排序模型行", () => {
  const today = usageToday({ windows: { "24h": { totals: { usage: { input: 10, cachedInput: 5, output: 2 }, statistics: { average: 3, p50: 4, p95: 9 } }, byModel: [{ model: "luna", usage: { input: 8, output: 1 } }, { model: "astra", usage: { input: 100 } }], modelContinuations: 3 } } });
  assert.equal(today.totalTokens, 17);
  assert.equal(today.averageTokens, 3);
  assert.equal(today.byModel[0].model, "astra");
  assert.equal(today.byModel[1].model, "luna");
  assert.equal(usageToday({}), null);
  assert.equal(usageToday({ windows: {} }), null);
});