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
