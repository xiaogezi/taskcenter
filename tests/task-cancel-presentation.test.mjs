import assert from "node:assert/strict";
import test from "node:test";
import { actionReasons, taskViewBuckets, executionDisplayStatus, executionStopPresentation, managementCancelConfirmation, managementCancelNotice, taskActions, taskAxes } from "../lib/task-workspace.mjs";

test("管理取消不代表宿主停止，旧账本即使 Run ended 也保持未知", () => {
  for (const task of [
    { status: "cancelled" },
    { status: "cancelled", runs: [{ ended_at: "2026-11-17T00:00:00Z", ended_reason: "cancelled" }] },
    { status: "cancelled", executionControl: { managementStatus: "cancelled", stopRequestStatus: "not_requested", executionStatus: "unknown" } },
  ]) {
    assert.equal(executionDisplayStatus(task), "stop_unknown");
    assert.equal(executionStopPresentation(task).requestLabel, "未请求停止");
    assert.equal(executionStopPresentation(task).executionLabel, "停止状态未知");
    assert.match(executionStopPresentation(task).detail, /管理取消不会停止执行/);
    assert.deepEqual(taskAxes(task).slice(0, 2), [["管理", "cancelled"], ["执行", "stop_unknown"]]);
  }
});

test("已请求、已确认、未知互不混淆，不从不识别的状态推断成功", () => {
  const task = { status: "cancelled", executionControl: { stopRequestStatus: "requested", executionStatus: "unknown" } };
  assert.equal(executionStopPresentation(task).status, "stop_requested");
  assert.equal(executionStopPresentation(task).executionLabel, "停止状态未知");
  assert.match(executionStopPresentation(task).detail, /等待宿主确认/);
  assert.equal(executionStopPresentation({ ...task, executionControl: { ...task.executionControl, executionStatus: "confirmed_stopped" } }).status, "execution_stopped");
  assert.equal(executionStopPresentation({ status: "cancelled", executionControl: { stopRequestStatus: "success", executionStatus: "success" } }).status, "stop_unknown");
  assert.equal(executionStopPresentation({ status: "in_progress" }), null);
});

test("取消按钮、确认和回执说明只管理取消，未提供假停止按钮", () => {
  for (const status of ["planned", "in_progress", "blocked"]) {
    assert.equal(taskActions({ status }).find(row => row.action === "cancel").label, "取消管理（不会停止执行）");
    assert.equal(taskActions({ status }).some(row => row.action === "stop"), false);
  }
  assert.match(managementCancelConfirmation("任务甲"), /不会停止执行，也不会发送停止请求/);
  assert.match(managementCancelNotice, /未请求停止执行，也未确认执行已停止/);
});

test("管理取消只将有执行线索且停止未确认的任务留在需处理", () => {
  const base = { status: "cancelled", runs: [{ ended_at: "" }] };
  const started = { ...base, firstStartedAt: "2026-11-20T00:00:00Z" };
  for (const task of [started, { ...base, cliRuns: [{ status: "active" }] }]) {
    assert.equal(taskViewBuckets(task).attention, true);
    assert.equal(taskViewBuckets(task).completed, false);
    assert.equal(actionReasons(task)[0].code, "cancelled_execution_unconfirmed");
    assert.equal(executionStopPresentation(task).status, "stop_unknown");
  }
  for (const task of [
    base,
    { ...started, runs: [{ ended_at: "2026-11-20T00:01:00Z" }] },
    { ...started, sessionDetachedAt: "2026-11-20T00:01:00Z" },
    { ...started, executionControl: { executionStatus: "confirmed_stopped" } },
  ]) {
    assert.equal(taskViewBuckets(task).attention, false);
    assert.equal(taskViewBuckets(task).completed, true);
  }
  assert.equal(actionReasons({ ...started, status: "in_progress" }).length, 0);
});
