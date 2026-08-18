import assert from "node:assert/strict";
import test from "node:test";

import { detectSparkRoutingAdvisory, hasTaskEventDetails, taskEventStatus, taskEventSummary } from "../app/task-event-display.mjs";

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

test("估时提醒在时间线显示校准动作", () => {
  const event = { type: "task.reminder", next_action: "复盘估时偏差并更新时间或拆分任务。" };
  assert.equal(taskEventStatus(event), "估时提醒");
  assert.equal(taskEventSummary(event), event.next_action);
});

test("完成闭环事件显示验证、审查与最终验收摘要", () => {
  assert.equal(taskEventStatus({ type: "verification.reported" }), "验证证据");
  assert.match(taskEventSummary({ type: "verification.reported", verification_claim: { kind: "test", status: "passed", revision: "rev-a", summary: "144 passed" } }), /test · passed · rev-a · 144 passed/);
  assert.equal(taskEventStatus({ type: "review.staled" }), "审查过期");
  assert.equal(taskEventSummary({ type: "review.staled", reason: "revision changed" }), "revision changed");
  assert.equal(taskEventStatus({ type: "acceptance.accepted" }), "已最终验收");
});

test("仅有路由记录的任务仍可打开事件详情", () => {
  assert.equal(hasTaskEventDetails({ routingRecordedAt: "2026-08-14T00:00:00.000Z" }), true);
  assert.equal(hasTaskEventDetails({}, true), true);
  assert.equal(hasTaskEventDetails({}, false), false);
});

test("代码文件≥3 且未启动 5.3 时给出路由偏离建议", () => {
  assert.deepEqual(
    detectSparkRoutingAdvisory({
      routingHistory: [
        { selectedExecutorModel: "gpt-5.6-sol", preferredExecutorModel: "gpt-5.6-sol", dispatch_channel: "direct", outcome: "selected", reason: "任务边界清晰" },
        { selectedExecutorModel: "gpt-5.6-sol", preferredExecutorModel: "gpt-5.6-sol", dispatch_channel: "direct", outcome: "selected", reason: "继续采用 Sol 直接执行" },
      ],
      changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts", "README.md"],
    }),
    { triggered: true, title: "模型路由偏离提醒", message: "当前任务为实质性代码改动，但未形成 gpt-5.3-codex-spark 的 started/succeeded 路由记录。", suggestion: "请确认现有偏离理由是否具体且仍成立；若存在可安全隔离的搜索、实现、测试或审查阶段，优先派发 Spark。" },
  );
});

test("5.3 派发已启动或成功时不发出建议", () => {
  assert.equal(
    detectSparkRoutingAdvisory({
      routingHistory: [
        { selectedExecutorModel: "gpt-5.3-codex-spark", preferredExecutorModel: "gpt-5.3-codex-spark", dispatch_channel: "native", outcome: "succeeded", reason: "独立子代理执行" },
      ],
      changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
    }),
    null,
  );
});

test("无效偏离原因即使改动较少也给出建议", () => {
  assert.equal(
    detectSparkRoutingAdvisory({
      routingHistory: [{ selectedExecutorModel: "gpt-5.6-sol", outcome: "selected", reason: "用户未要求子代理" }],
      changedFiles: ["README.md"],
    })?.triggered,
    true,
  );
});

test("非实质改动且无无效偏离原因不建议", () => {
  assert.equal(
    detectSparkRoutingAdvisory({
      routingHistory: [{ selectedExecutorModel: "gpt-5.6-sol", outcome: "selected", reason: "仅执行本地修订" }],
      changedFiles: ["README.md", "assets/logo.svg", "docs/index.md"],
    }),
    null,
  );
});
