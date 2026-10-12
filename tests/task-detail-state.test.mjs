import assert from "node:assert/strict";
import test from "node:test";
import {
  describeActivityEvent,
  fetchInFlight,
  isValidEventsResponse,
  isValidTaskResponse,
  lastSuccessText,
  reduceDetailFailure,
  reduceDetailSuccess,
  reduceEventsFailure,
  reduceEventsSuccess,
} from "../lib/task-detail.mjs";

const initialDetail = { taskId: "", tick: -1, error: "", lastSuccessAt: 0, value: null };
const initialEvents = { taskId: "", tick: -1, error: "", lastSuccessAt: 0, values: [] };

test("任务响应校验：HTTP200 但结构无效或 id 缺失时拒绝", () => {
  assert.equal(isValidTaskResponse(null), null);
  assert.equal(isValidTaskResponse({}), null);
  assert.equal(isValidTaskResponse({ task: { id: 1 } }), null);
  assert.equal(isValidTaskResponse({ task: { id: "" } }), null);
  const task = { id: "a", title: "任务甲" };
  assert.deepEqual(isValidTaskResponse({ task }), task);
});

test("活动响应校验：events 每项必须是非 null 对象", () => {
  assert.equal(isValidEventsResponse({}), null);
  assert.equal(isValidEventsResponse({ events: "x" }), null);
  assert.equal(isValidEventsResponse({ events: [null] }), null);
  assert.equal(isValidEventsResponse({ events: [{ type: "tool.call" }, 42] }), null);
  assert.deepEqual(isValidEventsResponse({ events: [] }), []);
  assert.deepEqual(isValidEventsResponse({ events: [{ type: "tool.call" }] }), [{ type: "tool.call" }]);
});

test("详情成功：task.id 必须匹配请求，否则按失败处理并保留同任务旧数据", () => {
  const ok = reduceDetailSuccess(initialDetail, { task: { id: "a", goal: "目标甲" } }, "a", 0, 1000);
  assert.equal(ok.error, "");
  assert.equal(ok.lastSuccessAt, 1000);
  assert.equal(ok.value.goal, "目标甲");

  const wrongId = reduceDetailSuccess(ok, { task: { id: "b", goal: "目标乙" } }, "a", 1, 2000);
  assert.equal(wrongId.error, "服务返回无效任务数据");
  assert.equal(wrongId.value.goal, "目标甲");
  assert.equal(wrongId.lastSuccessAt, 1000);

  const malformed = reduceDetailSuccess(ok, {}, "a", 1, 2000);
  assert.equal(malformed.value.goal, "目标甲");
  assert.equal(malformed.error, "服务返回无效任务数据");
});

test("详情失败：同任务保留旧数据与上次成功时间，切换任务不保留", () => {
  const ok = reduceDetailSuccess(initialDetail, { task: { id: "a" } }, "a", 0, 1000);
  const failed = reduceDetailFailure(ok, "模拟读取失败", "a", 1);
  assert.equal(failed.value.id, "a");
  assert.equal(failed.lastSuccessAt, 1000);
  assert.equal(failed.error, "模拟读取失败");

  const switched = reduceDetailFailure(ok, "模拟读取失败", "b", 0);
  assert.equal(switched.value, null);
  assert.equal(switched.lastSuccessAt, 0);

  const firstFailure = reduceDetailFailure(initialDetail, "模拟读取失败", "a", 0);
  assert.equal(firstFailure.value, null);
  assert.equal(lastSuccessText(firstFailure.lastSuccessAt), "");
});

test("活动成功/失败归并与详情对称，显式空数组是成功", () => {
  const ok = reduceEventsSuccess(initialEvents, { events: [{ type: "tool.call" }] }, "a", 0, 1000);
  assert.equal(ok.values.length, 1);
  const failed = reduceEventsFailure(ok, "活动加载失败", "a", 1);
  assert.equal(failed.values.length, 1);
  assert.equal(failed.lastSuccessAt, 1000);
  const invalid = reduceEventsSuccess(ok, { events: [null] }, "a", 1, 2000);
  assert.equal(invalid.values.length, 1);
  assert.equal(invalid.error, "服务返回无效活动数据");
  const empty = reduceEventsSuccess(ok, { events: [] }, "a", 1, 2000);
  assert.equal(empty.error, "");
  assert.deepEqual(empty.values, []);
  assert.equal(empty.lastSuccessAt, 2000);
  assert.equal(reduceEventsFailure(empty, "failed", "a", 2).lastSuccessAt, 2000);
  const switched = reduceEventsFailure(ok, "活动加载失败", "b", 0);
  assert.deepEqual(switched.values, []);
  assert.equal(switched.lastSuccessAt, 0);
});

test("loading 由响应 tick 与请求 tick 派生", () => {
  assert.equal(fetchInFlight(initialDetail, "a", 0), true);
  const ok = reduceDetailSuccess(initialDetail, { task: { id: "a" } }, "a", 0, 1000);
  assert.equal(fetchInFlight(ok, "a", 0), false);
  assert.equal(fetchInFlight(ok, "a", 1), true);
  assert.equal(fetchInFlight(ok, "b", 1), true);
  assert.equal(fetchInFlight(ok, "", 0), false);
});

test("lastSuccessText 不产生 1970", () => {
  assert.equal(lastSuccessText(0), "");
  assert.equal(lastSuccessText(Number.NaN), "");
  assert.equal(lastSuccessText(60_000, 120_000), "上次成功：1 分钟前");
});

test("活动白名单：tool.call 只暴露工具名、调用 ID、时间并注明结果未记录", () => {
  const item = describeActivityEvent({ type: "tool.call", tool_name: "Bash", tool_use_id: "tu-1", command: "SECRET_COMMAND", tool_input: { token: "SECRET_TOKEN" }, output: "SECRET_OUTPUT", recorded_at: "2026-09-20T00:00:00Z" });
  assert.equal(item.type, "tool.call");
  assert.equal(item.time, "2026-09-20T00:00:00Z");
  assert.deepEqual(item.lines, ["工具：Bash", "调用 ID：tu-1"]);
  assert.equal(item.note, "调用已记录，执行结果未记录");
  const rendered = JSON.stringify(item);
  assert.doesNotMatch(rendered, /SECRET_/);
  assert.doesNotMatch(rendered, /command|tool_input|output/);
});

test("活动白名单：routing.decision 仅模型/动作/结果，其他事件仅类型与时间", () => {
  const decision = describeActivityEvent({ type: "routing.decision", selected_executor_model: "k3", routing_action: "direct_execute", routing_outcome: "selected", prompt: "SECRET_PROMPT", extra: "x", occurred_at: "2026-09-20T01:00:00Z" });
  assert.deepEqual(decision.lines, []);
  assert.doesNotMatch(JSON.stringify(decision), /SECRET_PROMPT/);

  const other = describeActivityEvent({ type: "note", payload: "SECRET_PAYLOAD", recorded_at: "2026-09-20T02:00:00Z" });
  assert.deepEqual(other.lines, []);
  assert.equal(other.note, null);
  assert.equal(other.time, "2026-09-20T02:00:00Z");
  assert.doesNotMatch(JSON.stringify(other), /SECRET_PAYLOAD/);

  assert.equal(describeActivityEvent(null), null);
  assert.equal(describeActivityEvent("x"), null);
  assert.equal(describeActivityEvent({}).type, "未知事件");
});
