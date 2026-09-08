import assert from "node:assert/strict";
import test from "node:test";
import { rateLimitPools, recentRoutingRows } from "../lib/routing-console.mjs";

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
