import assert from "node:assert/strict";
import test from "node:test";

import { hasTaskEventDetails, taskEventStatus, taskEventSummary } from "../app/task-event-display.mjs";

test("路由事件时间线显示模型、通道、结果和原因", () => {
  const event = {
    type: "routing.decision",
    orchestrator_model: "gpt-5.6-sol",
    selected_executor_model: "gpt-5.3-codex-spark",
    dispatch_channel: "native",
    routing_outcome: "succeeded",
    routing_reason: "任务边界清晰。",
  };
  assert.equal(taskEventStatus(event), "仅审计");
  assert.equal(
    taskEventSummary(event),
    "gpt-5.6-sol → gpt-5.3-codex-spark · native · succeeded · 任务边界清晰。",
  );
});

test("普通任务事件沿用原有摘要和状态回退", () => {
  assert.equal(taskEventStatus({ type: "task.update", status: "in_progress" }), "in_progress");
  assert.equal(taskEventSummary({ type: "tool.call", tool_name: "exec_command" }), "exec_command");
  assert.equal(taskEventSummary({ type: "task.update" }), "无摘要");
});

test("仅有路由记录的任务仍可打开事件详情", () => {
  assert.equal(hasTaskEventDetails({ routingRecordedAt: "2026-08-14T00:00:00.000Z" }), true);
  assert.equal(hasTaskEventDetails({}, true), true);
  assert.equal(hasTaskEventDetails({}, false), false);
});
