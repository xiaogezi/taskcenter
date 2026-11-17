import test from "node:test";
import assert from "node:assert/strict";
import { queryUsageReport } from "../scripts/usage-query.mjs";
import { boundedResponse } from "../scripts/bounded-response.mjs";

test("报告组合过滤先筛事件再聚合，summary/fields/top_n 生效", () => {
  const now = "2026-09-09T12:00:00Z";
  const tasks = [{ id: "a", sessionId: "s1", projectId: "p", createdAt: "2026-09-09T00:00:00Z" }, { id: "b", sessionId: "s2", projectId: "q", createdAt: "2026-09-09T00:00:00Z" }];
  const index = { updatedAt: now, files: Object.fromEntries(tasks.map((task, i) => [task.id, { sessionId: task.sessionId, cwd: `/${task.projectId}`, events: [[Date.parse(now), "model", (i + 1) * 10, 0, 1]], lifetimeByTask: { [task.id]: { input: (i + 1) * 10, output: 1, count: 1, total: (i + 1) * 10 + 1 } } }])) };
  const query = (value) => queryUsageReport({ report: { generatedAt: now }, index, tasks, params: new URLSearchParams(value) });
  const result = query({ project: "p", session: "s1", task: "a", window: "24h", summary_only: "false", top_n: "1" });
  assert.equal(result.windows["24h"].totals.usage.input, 10);
  assert.equal(result.windows["24h"].byTask[0].id, "a");
  assert.equal(query({ project: "p", session: "s2", window: "24h" }).windows["24h"].totals.usage.input, 0);
  assert.equal(query({ project: "/p", window: "24h" }).windows["24h"].byTask, undefined);
  assert.deepEqual(Object.keys(query({ session: "s1", fields: "windows" })), ["windows"]);
  assert.equal(query({ session: "s1", window: "lifetime" }).lifetime.totals.usage.input, 10);
  assert.equal(query({ top_n: "0" }).error, "INVALID_TOP_N");
});

test("默认响应和每一页不超过 4KB，多字节/转义内容可无损重建", () => {
  const payload = { rows: Array.from({ length: 50 }, (_, i) => ({ id: i, value: "中文😀\n\"".repeat(50) })) };
  let page = boundedResponse(payload);
  assert.equal(page.truncated, true);
  let encoded = "";
  while (page.continuation_cursor) {
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4096);
    page = boundedResponse(null, { cursor: page.continuation_cursor });
    encoded += page.fragment;
  }
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4096);
  assert.deepEqual(JSON.parse(encoded), payload);
  assert.equal(boundedResponse(null, { cursor: "invalid:0" }).error, "CURSOR_EXPIRED");
});

test("任务过滤同时限制后台响应代理值和工具回执", () => {
  const start = Date.parse("2026-11-17T00:00:00Z");
  const tasks = [
    { id: "first", sessionId: "shared", status: "done_claimed", firstStartedAt: new Date(start).toISOString(), actualAt: new Date(start + 5_000).toISOString() },
    { id: "second", sessionId: "shared", status: "in_progress", firstStartedAt: new Date(start + 5_001).toISOString() },
  ];
  const state = { sessionId: "shared", cwd: "/work", events: [], responseInputs: [[start, "user"], [start + 10_000, "user"]],
    responseGaps: [[start, 100, "user"], [start + 10_000, 900, "user"]],
    toolSamples: [[start, "custom", 1, 0], [start + 10_000, "custom", 0, 1]] };
  const result = queryUsageReport({ report: { generatedAt: new Date(start + 20_000).toISOString() },
    index: { files: { shared: state }, updatedAt: new Date(start + 20_000).toISOString() }, tasks,
    params: new URLSearchParams({ task: "first", window: "24h" }) });
  assert.equal(result.windows["24h"].responseGapProxy.sampleCount, 1);
  assert.equal(result.windows["24h"].responseGapProxy.durationMs.p50, 100);
  assert.equal(result.windows["24h"].toolSignals.calls, 1);
  assert.equal(result.windows["24h"].toolSignals.receiptsObserved, 1);
  assert.equal(result.windows["24h"].toolSignals.duplicateCallIds, 0);
});
