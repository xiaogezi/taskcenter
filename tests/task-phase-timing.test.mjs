import assert from "node:assert/strict";
import test from "node:test";

import {
  PHASES,
  appendPhaseEvent,
  applyTaskPhaseEvent,
  buildTaskPhaseReport,
  buildTaskPhaseTiming,
} from "../scripts/task-phase-timing.mjs";

const subjectRef = {
  type: "artifact",
  value: "snapshot-1",
  observed_at: "2026-09-02T00:00:00.000Z",
};

function event(id, phase, transition, at, extra = {}) {
  return {
    task_id: "task-1",
    session_id: "session-1",
    phase,
    transition,
    occurred_at: at,
    event_id: id,
    subject_ref: subjectRef,
    reason: "test boundary",
    activity_source: "agent",
    ...extra,
  };
}

test("状态机接受重复阶段并按语义字段保证 event_id 幂等", () => {
  let events = [];
  for (const item of [
    event("a", "planning", "started", "2026-09-02T00:00:00.000Z"),
    event("b", "planning", "finished", "2026-09-02T00:10:00.000Z"),
    event("c", "planning", "started", "2026-09-02T00:20:00.000Z"),
    event("d", "planning", "finished", "2026-09-02T00:30:00.000Z"),
  ]) events = appendPhaseEvent(events, item, { taskId: "task-1" });

  assert.equal(events.length, 4);
  const reorderedSubject = { observed_at: subjectRef.observed_at, value: subjectRef.value, type: subjectRef.type };
  assert.equal(appendPhaseEvent(events, { ...events[0], subject_ref: reorderedSubject }).length, 4);
  assert.throws(() => appendPhaseEvent(events, { ...events[0], reason: "different" }), /幂等冲突/);
});

test("拒绝乱序、非法跳转、跨任务和生命周期字段漂移", () => {
  const start = event("start", "implementing", "started", "2026-09-02T00:10:00.000Z");
  const missingReason = { ...start };
  delete missingReason.reason;
  assert.throws(() => appendPhaseEvent([], missingReason), /缺少 reason/);
  assert.throws(() => appendPhaseEvent([], event("resume", "implementing", "resumed", "2026-09-02T00:11:00.000Z")), /恢复/);
  assert.throws(() => appendPhaseEvent([start], event("again", "implementing", "started", "2026-09-02T00:12:00.000Z")), /已经开始/);
  assert.throws(() => appendPhaseEvent([start], event("early", "implementing", "finished", "2026-09-02T00:09:00.000Z")), /时间顺序/);
  assert.throws(() => appendPhaseEvent([], { ...start, task_id: "other" }, { taskId: "task-1" }), /跨任务/);
  assert.throws(() => appendPhaseEvent([start], event("wrong-phase", "verifying", "finished", "2026-09-02T00:20:00.000Z")), /phase 不可变更/);
});

test("暂停和恢复分别计算 wall、active、wait，开放暂停区间标记 partial", () => {
  const events = [
    event("a", "implementing", "started", "2026-09-02T00:00:00.000Z"),
    event("b", "implementing", "paused", "2026-09-02T00:10:00.000Z"),
    event("c", "implementing", "resumed", "2026-09-02T00:20:00.000Z"),
    event("d", "implementing", "finished", "2026-09-02T00:30:00.000Z"),
  ];
  const report = buildTaskPhaseReport({ task_id: "task-1", phaseEvents: events, as_of: "2026-09-02T00:40:00.000Z" });
  assert.equal(report.status, "complete");
  assert.equal(report.phases.implementing.phase_wall_ms, 1_800_000);
  assert.equal(report.phases.implementing.phase_active_ms, 1_200_000);
  assert.equal(report.phases.implementing.phase_wait_ms, 600_000);
  assert.equal(report.executor_active_ms["session:session-1"], 1_200_000);
  assert.equal(report.wait_breakdown_ms.paused, 600_000);

  const paused = buildTaskPhaseReport({ task_id: "task-1", phaseEvents: events.slice(0, 2), as_of: "2026-09-02T00:30:00.000Z" });
  assert.equal(paused.status, "partial");
  assert.equal(paused.phases.implementing.phase_wait_ms, 1_200_000);
});

test("并行 executor 的任务墙钟去重，executor active 分别累计", () => {
  const first = [
    event("a1", "implementing", "started", "2026-09-02T00:00:00.000Z", { activity_id: "job-1" }),
    event("a2", "implementing", "finished", "2026-09-02T00:10:00.000Z", { activity_id: "job-1" }),
  ];
  const second = [
    event("b1", "implementing", "started", "2026-09-02T00:05:00.000Z", { activity_id: "job-2", session_id: "session-2" }),
    event("b2", "implementing", "finished", "2026-09-02T00:15:00.000Z", { activity_id: "job-2", session_id: "session-2" }),
  ];
  const report = buildTaskPhaseReport({ task_id: "task-1", phaseEvents: [...first, ...second] });
  assert.equal(report.task_wall_ms, 900_000);
  assert.equal(report.executor_active_ms["session:session-1"], 600_000);
  assert.equal(report.executor_active_ms["session:session-2"], 600_000);
});

test("activity_id 支持 Session 重启续接，并保留各 Session 的 active 归因", () => {
  const events = [
    event("a", "verifying", "started", "2026-09-02T00:00:00.000Z", { activity_id: "verification-1" }),
    event("b", "verifying", "paused", "2026-09-02T00:10:00.000Z", { activity_id: "verification-1" }),
    event("c", "verifying", "resumed", "2026-09-02T00:20:00.000Z", { activity_id: "verification-1", session_id: "session-2" }),
    event("d", "verifying", "finished", "2026-09-02T00:30:00.000Z", { activity_id: "verification-1", session_id: "session-2" }),
  ];
  const report = buildTaskPhaseReport({ task_id: "task-1", phaseEvents: events });
  assert.equal(report.phases.verifying.phase_active_ms, 1_200_000);
  assert.equal(report.executor_active_ms["session:session-1"], 600_000);
  assert.equal(report.executor_active_ms["session:session-2"], 600_000);
  assert.throws(() => appendPhaseEvent([events[0]], { ...events[1], session_id: "session-2", activity_id: undefined }), /暂停/);
});

test("构建等待、外部等待和旧任务缺失数据保持不同语义", () => {
  const waits = [
    event("build-start", "verifying", "started", "2026-09-02T00:00:00.000Z", { activity_id: "build", activity_source: "build_wait" }),
    event("build-end", "verifying", "finished", "2026-09-02T00:05:00.000Z", { activity_id: "build", activity_source: "build_wait" }),
    event("external-start", "waiting_external", "started", "2026-09-02T00:05:00.000Z", { activity_id: "external", activity_source: "external_wait" }),
    event("external-end", "waiting_external", "finished", "2026-09-02T00:15:00.000Z", { activity_id: "external", activity_source: "external_wait" }),
  ];
  const report = buildTaskPhaseReport({ task_id: "task-1", phaseEvents: waits });
  assert.equal(report.phases.verifying.phase_active_ms, 0);
  assert.equal(report.wait_breakdown_ms.build, 300_000);
  assert.equal(report.wait_breakdown_ms.external, 600_000);

  const openExternal = buildTaskPhaseReport({
    task_id: "task-1",
    phaseEvents: [event("open-external", "waiting_external", "started", "2026-09-02T00:00:00.000Z", { activity_id: "open-external", activity_source: "external_wait" })],
    as_of: "2026-09-02T00:10:00.000Z",
  });
  assert.equal(openExternal.status, "partial");
  assert.equal(openExternal.phases.waiting_external.phase_active_ms, 0);
  assert.equal(openExternal.phases.waiting_external.phase_wait_ms, 600_000);

  const old = buildTaskPhaseReport({ task_id: "old" });
  assert.equal(old.status, "unknown");
  assert.equal(old.task_wall_ms, null);
  assert.equal(old.phases.planning.phase_active_ms, null);
  assert.equal(old.wait_breakdown_ms.external, null);
});

test("Review Cycle 是 review、rework、verification 的权威时间源", () => {
  const cycle = {
    cycle_id: "cycle-1",
    subject_ref: subjectRef,
    reviewer: { type: "agent", id: "reviewer", session_id: "review-session" },
    phase: "completed",
    outcome: "approved",
    implementation_ready_at: "2026-09-02T00:00:00.000Z",
    review_requested_at: "2026-09-02T00:01:00.000Z",
    review_started_at: "2026-09-02T00:05:00.000Z",
    review_finished_at: "2026-09-02T00:15:00.000Z",
    fix_started_at: "2026-09-02T00:16:00.000Z",
    fix_finished_at: "2026-09-02T00:20:00.000Z",
    verification_finished_at: "2026-09-02T00:25:00.000Z",
    review_active_ms: 120_000,
    fix_active_ms: 180_000,
    verification_active_ms: 60_000,
  };
  const phaseEvents = [
    event("review-start", "reviewing", "started", "2026-09-02T00:05:00.000Z", { session_id: "review-session", review_cycle_id: "cycle-1", activity_source: "review_cycle" }),
    event("review-end", "reviewing", "finished", "2026-09-02T00:15:00.000Z", { session_id: "review-session", review_cycle_id: "cycle-1", activity_source: "review_cycle" }),
  ];
  const report = buildTaskPhaseReport({ task_id: "task-1", phaseEvents, reviewCycles: [cycle] });
  assert.equal(report.status, "complete");
  assert.equal(report.phases.reviewing.phase_wall_ms, 840_000);
  assert.equal(report.phases.reviewing.phase_active_ms, 120_000);
  assert.equal(report.phases.reviewing.phase_wait_ms, 240_000);
  assert.equal(report.phases.reworking.phase_active_ms, 180_000);
  assert.equal(report.phases.verifying.phase_active_ms, 60_000);
  assert.equal(report.executor_active_ms["session:review-session"], 120_000);
  assert.equal(report.unattributed_active_ms, 240_000);
  assert.equal(report.review_cycle_reconciliation.wait_ms, 240_000);
  assert.equal(report.review_cycle_reconciliation.review_elapsed_ms, 600_000);
  assert.equal(report.review_cycle_reconciliation.active_ms, 360_000);
  assert.deepEqual(report.warnings, []);
});

test("Review Cycle 缺少 active 时不从墙钟推算，并拒绝跨任务归入", () => {
  const cycle = {
    task_id: "task-1",
    cycle_id: "cycle-1",
    subject_ref: subjectRef,
    phase: "completed",
    outcome: "approved",
    review_requested_at: "2026-09-02T00:00:00.000Z",
    review_started_at: "2026-09-02T00:01:00.000Z",
    review_finished_at: "2026-09-02T00:02:00.000Z",
  };
  const missing = buildTaskPhaseReport({ task_id: "task-1", reviewCycles: [cycle] });
  assert.equal(missing.status, "partial");
  assert.equal(missing.phases.reviewing.phase_active_ms, null);
  assert.equal(missing.phases.reviewing.active_time_source, "review_cycle");
  assert.equal(missing.unattributed_active_ms, null);

  const crossTask = buildTaskPhaseReport({ task_id: "task-2", reviewCycles: [cycle] });
  assert.equal(crossTask.status, "unknown");
  assert.equal(crossTask.task_wall_ms, null);
  assert.equal(crossTask.warnings[0].code, "CROSS_TASK_REVIEW_CYCLE");
});

test("task wrapper 保存事件并输出 phaseTiming", () => {
  const task = applyTaskPhaseEvent(
    { id: "task-1", phaseEvents: [event("a", "planning", "started", "2026-09-02T00:00:00.000Z")] },
    event("b", "planning", "finished", "2026-09-02T00:10:00.000Z"),
  );
  assert.equal(task.phaseTiming.phases.planning.phase_wall_ms, 600_000);
  assert.equal(buildTaskPhaseTiming(task).status, "complete");
  assert.equal(PHASES.length, 6);
  assert.throws(() => buildTaskPhaseReport({ task_id: "task-1", as_of: "not-a-time" }), /as_of/);
});

test("as_of 排除未来事件并把跨截止时间的阶段与 Review Cycle 截断为 partial", () => {
  const phaseEvents = [
    event("as-of-start", "implementing", "started", "2026-09-02T00:00:00.000Z"),
    event("as-of-finish", "implementing", "finished", "2026-09-02T01:00:00.000Z"),
  ];
  const phaseReport = buildTaskPhaseReport({ task_id: "task-1", phaseEvents, as_of: "2026-09-02T00:10:00.000Z" });
  assert.equal(phaseReport.status, "partial");
  assert.equal(phaseReport.phases.implementing.phase_wall_ms, 600_000);
  assert.equal(phaseReport.phases.implementing.phase_active_ms, 600_000);
  assert.equal(phaseReport.coverage.phase_event_count, 1);
  assert.equal(buildTaskPhaseReport({ task_id: "task-1", phaseEvents, as_of: "2026-09-01T23:00:00.000Z" }).status, "unknown");
  const futureInvalidTransition = [
    phaseEvents[0],
    event("future-wrong-phase", "verifying", "finished", "2026-09-02T01:00:00.000Z"),
  ];
  const historical = buildTaskPhaseReport({ task_id: "task-1", phaseEvents: futureInvalidTransition, as_of: "2026-09-02T00:10:00.000Z" });
  assert.equal(historical.status, "partial");
  assert.equal(historical.phases.implementing.phase_wall_ms, 600_000);
  assert.throws(() => buildTaskPhaseReport({ task_id: "task-1", phaseEvents: [{ ...phaseEvents[0], occurred_at: "invalid" }] }), /occurred_at/);

  const cycle = {
    task_id: "task-1",
    cycle_id: "as-of-cycle",
    phase: "completed",
    outcome: "approved",
    review_requested_at: "2026-09-02T00:00:00.000Z",
    review_started_at: "2026-09-02T00:05:00.000Z",
    review_finished_at: "2026-09-02T00:15:00.000Z",
    review_active_ms: 120_000,
  };
  const cycleReport = buildTaskPhaseReport({ task_id: "task-1", reviewCycles: [cycle], as_of: "2026-09-02T00:10:00.000Z" });
  assert.equal(cycleReport.status, "partial");
  assert.equal(cycleReport.phases.reviewing.phase_wall_ms, 600_000);
  assert.equal(cycleReport.phases.reviewing.phase_active_ms, null);
  assert.equal(cycleReport.phases.reviewing.phase_wait_ms, 300_000);
});
