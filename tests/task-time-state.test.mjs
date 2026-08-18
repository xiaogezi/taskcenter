import assert from "node:assert/strict";
import test from "node:test";
import { taskTimeState } from "../app/task-time-state.mjs";

test("任务时间模型应分离 createdAt 与 firstStartedAt", () => {
  const now = Date.parse("2026-08-16T12:00:00.000Z");
  const started = Date.parse("2026-08-16T09:30:00.000Z");
  const activeState = taskTimeState({
    status: "in_progress",
    createdAt: "2026-08-16T08:00:00.000Z",
    firstStartedAt: "2026-08-16T09:30:00.000Z",
    expectedAt: "2026-08-18T08:00:00.000Z",
  }, now);
  assert.equal(activeState.wallElapsedMs, now - Date.parse("2026-08-16T08:00:00.000Z"));
  assert.equal(activeState.activeElapsedMs, now - started);
});

test("in_progress 多段累计应累计到 activeElapsedMs", () => {
  const now = Date.parse("2026-08-16T06:00:00.000Z");
  const state = taskTimeState({
    status: "in_progress",
    createdAt: "2026-08-16T00:00:00.000Z",
    firstStartedAt: "2026-08-16T01:00:00.000Z",
    startedAt: "2026-08-16T01:00:00.000Z",
    statusHistory: [
      { status: "in_progress", at: "2026-08-16T01:00:00.000Z" },
      { status: "blocked", at: "2026-08-16T03:00:00.000Z" },
      { status: "in_progress", at: "2026-08-16T04:00:00.000Z" },
      { status: "done_claimed", at: "2026-08-16T06:00:00.000Z" },
    ],
    expectedAt: "2026-08-20T00:00:00.000Z",
    wallClockNow: now,
  }, now);
  assert.equal(state.activeElapsedMs, 14400000);
});

test("blocked 区间应累计 blockedElapsedMs 且不计入 activeElapsedMs", () => {
  const now = Date.parse("2026-08-16T06:00:00.000Z");
  const state = taskTimeState({
    status: "in_progress",
    createdAt: "2026-08-16T00:00:00.000Z",
    firstStartedAt: "2026-08-16T01:00:00.000Z",
    startedAt: "2026-08-16T01:00:00.000Z",
    statusHistory: [
      { status: "in_progress", at: "2026-08-16T01:00:00.000Z" },
      { status: "blocked", at: "2026-08-16T03:00:00.000Z" },
      { status: "in_progress", at: "2026-08-16T04:00:00.000Z" },
      { status: "done_claimed", at: "2026-08-16T06:00:00.000Z" },
    ],
    expectedAt: "2026-08-20T00:00:00.000Z",
    wallClockNow: now,
  }, now);
  assert.equal(state.activeElapsedMs, 14400000);
  assert.equal(state.blockedElapsedMs, 3600000);
});

test("wallElapsedMs 应覆盖整个生命周期而非仅活跃区间", () => {
  const now = Date.parse("2026-08-16T06:00:00.000Z");
  const state = taskTimeState({
    status: "in_progress",
    createdAt: "2026-08-16T00:00:00.000Z",
    firstStartedAt: "2026-08-16T01:00:00.000Z",
    startedAt: "2026-08-16T01:00:00.000Z",
    expectedAt: "2026-08-20T00:00:00.000Z",
    wallClockNow: now,
  }, now);
  assert.equal(state.wallElapsedMs, 21600000);
});

test("只有显式 dueAt 才应产生交付逾期", () => {
  const now = Date.parse("2026-08-16T02:00:00.000Z");
  const withExpected = taskTimeState({
    status: "in_progress",
    createdAt: "2026-08-16T00:00:00.000Z",
    firstStartedAt: "2026-08-16T00:30:00.000Z",
    expectedAt: "2026-08-16T01:00:00.000Z",
    wallClockNow: now,
  }, now);
  const withDue = taskTimeState({
    status: "in_progress",
    createdAt: "2026-08-16T00:00:00.000Z",
    firstStartedAt: "2026-08-16T00:30:00.000Z",
    dueAt: "2026-08-16T01:00:00.000Z",
    wallClockNow: now,
  }, now);
  assert.equal(withExpected.overdue, false);
  assert.equal(withExpected.scheduleOverdueMs, 0);
  assert.equal(withDue.overdue, true);
  assert.ok(withDue.scheduleOverdueMs > 0);
});

test("任务时间模型应导出 estimatedEffortMs 与 effortVarianceMs", () => {
  const now = Date.parse("2026-08-16T06:00:00.000Z");
  const state = taskTimeState({
    status: "in_progress",
    createdAt: "2026-08-16T00:00:00.000Z",
    firstStartedAt: "2026-08-16T01:00:00.000Z",
    startedAt: "2026-08-16T01:00:00.000Z",
    statusHistory: [
      { status: "in_progress", at: "2026-08-16T01:00:00.000Z" },
      { status: "blocked", at: "2026-08-16T03:00:00.000Z" },
      { status: "in_progress", at: "2026-08-16T04:00:00.000Z" },
      { status: "done_claimed", at: "2026-08-16T06:00:00.000Z" },
    ],
    expectedAt: "2026-08-20T00:00:00.000Z",
    estimatedEffortMs: 10800000,
    wallClockNow: now,
  }, now);
  assert.equal(state.estimatedEffortMs, 10800000);
  assert.equal(state.effortVarianceMs, Math.abs(state.activeElapsedMs - 10800000));
});

test("任务时间模型应保留预计调整历史", () => {
  const now = Date.parse("2026-08-16T06:00:00.000Z");
  const expectedAtHistory = [
    { from: "2026-08-16T01:00:00.000Z", to: "2026-08-16T03:00:00.000Z", reason: "拆分子任务" },
    { from: "2026-08-16T03:00:00.000Z", to: "2026-08-16T04:00:00.000Z", reason: "风险上浮" },
  ];
  const state = taskTimeState({
    status: "in_progress",
    createdAt: "2026-08-16T00:00:00.000Z",
    firstStartedAt: "2026-08-16T01:00:00.000Z",
    expectedAt: "2026-08-16T04:00:00.000Z",
    expectedAtHistory,
    wallClockNow: now,
  }, now);
  assert.equal(Array.isArray(state.expectedAtHistory), true);
  assert.deepEqual(state.expectedAtHistory, expectedAtHistory);
});
