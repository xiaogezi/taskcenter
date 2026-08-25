import test from "node:test";
import assert from "node:assert/strict";
import { buildGovernanceMetrics } from "../scripts/governance-metrics.mjs";

test("治理看板按 profile、任务类别和模型输出稳健统计", () => {
  const tasks = [
    { id: "a", status: "verified", workflowProfile: "fast", model: "luna", activeDurationMs: 600_000, createdAt: "2026-08-20T00:00:00Z", actualAt: "2026-08-20T00:10:00Z", requirementResults: [], diagnosticObservations: [{ case_id: "d1", observed_at: "2026-08-20T00:09:00Z", started_at: "2026-08-20T00:01:00Z", root_cause_at: "2026-08-20T00:06:00Z", outcome: "resolved", hypothesis_count: 2, failed_fix_count: 1, rollback_count: 1, fresh_verification: "passed" }] },
    { id: "b", status: "verified", workflowProfile: "strict", model: "terra", activeDurationMs: 1_800_000, createdAt: "2026-08-20T00:00:00Z", actualAt: "2026-08-20T00:30:00Z", requirementResults: [{ status: "failed" }] },
    { id: "c", status: "in_progress", workflowProfile: "fast", model: "luna" },
  ];
  const events = [{ task_id: "a" }, { task_id: "a" }, { task_id: "b" }, { task_id: "c" }];
  const report = buildGovernanceMetrics({
    tasks, events,
    usageReport: { generatedAt: "2026-08-20T02:00:00Z", overall: { estimatedCredits: 30, creditsEstimation: "complete", modelContinuations: 100, input: { average: 10, p50: 8, p95: 20 } }, windows: { "24h": { id: "24h", durationMs: 86_400_000, totals: { count: 10, usage: { input: 1_000 } }, byTask: [{ id: "unattributed", count: 2, usage: { input: 300 } }] } } },
  });
  assert.equal(report.completedTasks, 2);
  assert.equal(report.creditsPerCompletedTask, 15);
  assert.equal(report.modelContinuationsPerTask, 50);
  assert.equal(report.reworkRate, 0.5);
  assert.deepEqual(report.durationMs, { average: 1_200_000, p50: 600_000, p95: 1_800_000, sampleCount: 2, status: "available" });
  assert.equal(report.groups.workflow_profile.find((item) => item.key === "fast").tasks, 2);
  assert.equal(report.comparisons.strategy, "matched_task_type_or_alternating_windows");
  assert.equal(report.creditsEstimation, "complete");
  assert.equal(report.attributionCoverage.eventRatio, 0.8);
  assert.equal(report.attributionCoverage.inputTokenRatio, 0.7);
  assert.equal(report.diagnostics.cases, 1);
  assert.equal(report.diagnostics.medianTimeToRootCauseMs, 300_000);
  assert.equal(report.diagnostics.freshVerificationPassRate, 1);
});

test("缺少官方费率时 Credits 保持不可估算", () => {
  const report = buildGovernanceMetrics({ tasks: [{ id: "spark", status: "verified" }], usageReport: { overall: { estimatedCredits: null } } });
  assert.equal(report.creditsPerCompletedTask, null);
  assert.equal(report.creditsEstimation, "unestimable");
});

test("部分模型缺少费率时看板保留可估算部分并标明 partial", () => {
  const report = buildGovernanceMetrics({
    tasks: [{ id: "mixed", status: "verified", activeDurationMs: 3_600_000, createdAt: "2026-08-20T00:00:00Z", actualAt: "2026-08-20T01:00:00Z" }],
    usageReport: { generatedAt: "2026-08-20T02:00:00Z", overall: { estimatedCredits: 12, creditsEstimation: "partial" } },
  });
  assert.equal(report.creditsPerCompletedTask, 12);
  assert.equal(report.creditsEstimation, "partial");
});

test("Review 指标区分墙钟与 active time，并输出 P50/P95、finding 与长尾诊断", () => {
  const subject = { type: "git_commit", value: "abc", observed_at: "2026-08-20T00:00:00Z" };
  const task = {
    id: "implementation", status: "verified", taskClass: "feature", firstStartedAt: "2026-08-20T00:00:00Z", actualAt: "2026-08-20T02:00:00Z",
    reviewCycles: [
      { cycle_id: "c1", cycle_number: 1, subject_ref: subject, review_scope: "full", phase: "completed", outcome: "changes_requested", implementation_ready_at: "2026-08-20T00:10:00Z", review_requested_at: "2026-08-20T00:15:00Z", review_started_at: "2026-08-20T00:25:00Z", review_finished_at: "2026-08-20T00:35:00Z", fix_started_at: "2026-08-20T00:40:00Z", fix_finished_at: "2026-08-20T00:55:00Z", verification_finished_at: "2026-08-20T01:00:00Z", review_active_ms: 300_000, fix_active_ms: 600_000, verification_active_ms: 120_000, wait_reason: "reviewer_capacity" },
      { cycle_id: "c2", cycle_number: 2, subject_ref: subject, review_scope: "incremental", phase: "completed", outcome: "approved", implementation_ready_at: "2026-08-20T01:10:00Z", review_requested_at: "2026-08-20T01:12:00Z", review_started_at: "2026-08-20T01:15:00Z", review_finished_at: "2026-08-20T01:25:00Z", verification_finished_at: "2026-08-20T01:30:00Z", review_active_ms: 240_000, verification_active_ms: 60_000 },
    ],
    reviewAttestations: [
      { id: "a1", effective_review: true, verdict: "changes_requested", findings: [{ fingerprint: "same", category: "correctness", severity: "p1", validity: "valid", status: "unresolved" }] },
      { id: "a2", effective_review: true, verdict: "approved", findings: [{ fingerprint: "same", category: "correctness", severity: "p1", validity: "duplicate", status: "resolved" }] },
      { id: "a3", effective_review: false, duplicate_of_attestation_id: "a2", verdict: "approved", cycle_id: "c2" },
    ],
  };
  const report = buildGovernanceMetrics({ tasks: [task, { id: "ocr", status: "verified", taskClass: "ocr_review" }] });
  assert.equal(report.reviews.taskRoles.implementation, 1);
  assert.equal(report.reviews.taskRoles.independent_review, 1);
  assert.equal(report.reviews.rounds.perTask.p50, 2);
  assert.equal(report.reviews.rounds.perTask.p95, 2);
  assert.equal(report.reviews.rounds.firstPassRate, 0);
  assert.equal(report.reviews.rounds.full, 1);
  assert.equal(report.reviews.rounds.incremental, 1);
  assert.equal(report.reviews.timeMs.wait.p50, 180_000);
  assert.equal(report.reviews.timeMs.active.sampleCount, 2);
  assert.equal(report.reviews.findings.validRatio, 0.5);
  assert.equal(report.reviews.findings.duplicateRatio, 0.5);
  assert.equal(report.reviews.waitReasons.reviewer_capacity, 1);
  assert.ok(report.reviews.reviewLoopWarnings.some((item) => item.type === "repeated_finding"));
  assert.ok(report.reviews.reviewLoopWarnings.some((item) => item.type === "duplicate_approved"));
});

test("in-progress 与过夜 Review 不进入完成耗时占比，空样本明确 data_insufficient", () => {
  const report = buildGovernanceMetrics({ tasks: [{
    id: "overnight", status: "in_progress", reviewCycles: [{ cycle_id: "overnight-c", cycle_number: 1, review_scope: "full", phase: "reviewing", outcome: "pending", implementation_ready_at: "2026-08-20T00:00:00Z", review_requested_at: "2026-08-20T00:01:00Z", review_started_at: "2026-08-20T00:02:00Z", review_finished_at: "2026-08-21T02:00:00Z" }],
  }] });
  assert.equal(report.completedTasks, 0);
  assert.equal(report.durationMs.status, "data_insufficient");
  assert.equal(report.durationMs.p50, null);
  assert.equal(report.reviews.timeMs.wallToTaskRatio.sampleCount, 0);
  assert.ok(report.reviews.reviewLoopWarnings.some((item) => item.type === "wall_clock_distorted"));
});
