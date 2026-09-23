import test from "node:test";
import assert from "node:assert/strict";
import { buildCliRunMetrics, buildGovernanceMetrics, buildRoutingFunnel } from "../scripts/governance-metrics.mjs";

test("治理看板按 profile、任务类别和模型输出稳健统计", () => {
  const tasks = [
    { id: "a", channel: "cli", status: "verified", workflowProfile: "fast", model: "luna", activeDurationMs: 600_000, createdAt: "2026-08-20T00:00:00Z", actualAt: "2026-08-20T00:10:00Z", requirementResults: [], diagnosticObservations: [{ case_id: "d1", observed_at: "2026-08-20T00:09:00Z", started_at: "2026-08-20T00:01:00Z", root_cause_at: "2026-08-20T00:06:00Z", outcome: "resolved", hypothesis_count: 2, failed_fix_count: 1, rollback_count: 1, fresh_verification: "passed" }] },
    { id: "b", channel: "cli", status: "verified", workflowProfile: "strict", model: "terra", activeDurationMs: 1_800_000, createdAt: "2026-08-20T00:00:00Z", actualAt: "2026-08-20T00:30:00Z", requirementResults: [{ status: "failed" }] },
    { id: "c", channel: "cli", status: "in_progress", workflowProfile: "fast", model: "luna" },
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

test("CLI 执行器聚合统计运行状态分布与回执 Token", () => {
  const metrics = buildCliRunMetrics([
    { id: "a", channel: "cli", status: "succeeded", executorModel: "k3", evidence: [JSON.stringify({ delegation_id: "a", usage: { input_tokens: 100, output_tokens: 20 } })] },
    { id: "b", channel: "cli", status: "failed", executorModel: "k3", evidence: ["plain"] },
    { id: "c", channel: "cli", status: "active", executorModel: "mimo", evidence: [JSON.stringify({ delegation_id: "c", usage: { prompt_tokens: 50 } })] },
    { id: "d", channel: "cli", status: "cancelled", executorModel: "k3" },
    { id: "e", channel: "cli", status: "succeeded", executorModel: "k3", evidence: [JSON.stringify({ delegation_id: "wrong", usage: { input_tokens: 999 } })] },
  ]);
  assert.equal(metrics.runs, 5);
  assert.equal(metrics.succeeded, 2);
  assert.equal(metrics.failed, 1);
  assert.equal(metrics.active, 1);
  assert.equal(metrics.cancelled, 1);
  assert.equal(metrics.byModel.k3.runs, 4);
  assert.equal(metrics.byModel.k3.succeeded, 2);
  assert.equal(metrics.byModel.mimo.active, 1);
  assert.equal(metrics.tokens.input, 150);
  assert.equal(metrics.tokens.output, 20);
  assert.equal(metrics.tokens.total, 170);
  assert.equal(metrics.tokens.reported, 2);
});

test("治理指标聚合携带 CLI 执行器数据", () => {
  const report = buildGovernanceMetrics({
    tasks: [],
    events: [],
    delegations: [{ id: "a", channel: "cli", status: "succeeded", executorModel: "k3", evidence: [JSON.stringify({ delegation_id: "a", usage: { input_tokens: 10 } })] }],
  });
  assert.equal(report.cliRuns.runs, 1);
  assert.equal(report.cliRuns.tokens.input, 10);
});


test("CLI 统计排除 native 和未知通道，保留未领取、过期与撤销证据", () => {
  const rows = [
    { id: "native", channel: "native", status: "active" },
    { id: "legacy", status: "succeeded" },
    { id: "issued", channel: "cli", status: "issued", createdAt: "2026-09-22T01:00:00Z" },
    { id: "expired", channel: "cli", status: "expired", createdAt: "2026-09-21T01:00:00Z", completedAt: "2026-09-22T01:00:00Z" },
    { id: "revoked", channel: "cli", status: "revoked", claimedAt: "2026-09-22T00:00:00Z", lastObservedAt: "2026-09-22T00:01:00Z" },
  ];
  const result = buildCliRunMetrics(rows);
  assert.equal(result.runs, 3);
  assert.equal(result.claimed, 1);
  assert.equal(result.excluded, 2);
  assert.deepEqual(result.statusCounts, { issued: 1, expired: 1, revoked: 1 });
  assert.equal(result.duration.count, 0);
  assert.equal(result.recentRuns[0].id, "issued");
  assert.equal(result.recentRuns.find((row) => row.id === "revoked").lastObservedAt, "2026-09-22T00:01:00Z");
});

test("24h 路由漏斗区分 Jev 评估、delegate 建议、CLI 路由与 direct 覆盖类型", () => {
  const now = Date.parse("2026-09-23T12:00:00Z");
  const recent = "2026-09-23T06:00:00Z";
  const stale = "2026-09-21T06:00:00Z";
  const routes = [
    { id: "r1", channel: "cli", createdAt: recent, jevDecision: { execution_choice: "delegate", execution_applied: true } },
    { id: "r2", channel: "direct", createdAt: recent, reason: "direct_reasoned_override", directReason: "真机安装", jevDecision: { execution_choice: "delegate", execution_applied: false, direct_exception_kind: "device_interaction" } },
    { id: "r3", channel: "direct", createdAt: recent, reason: "direct_reasoned_override", jevDecision: { execution_choice: "delegate", execution_applied: false } },
    { id: "r4", channel: "direct", createdAt: recent, reason: "jev_direct", jevDecision: { execution_choice: "direct", execution_applied: true } },
    { id: "r5", channel: "cli", createdAt: recent },
    { id: "r6", channel: "cli", createdAt: stale, jevDecision: { execution_choice: "delegate", execution_applied: true } },
  ];
  const delegations = [
    { id: "d1", channel: "cli", createdAt: recent, claimedAt: recent, runStatus: "started" },
    { id: "d2", channel: "cli", createdAt: recent },
    { id: "d3", channel: "native", createdAt: recent },
    { id: "d4", channel: "cli", createdAt: stale, claimedAt: stale },
  ];
  const funnel = buildRoutingFunnel(routes, delegations, now);
  assert.equal(funnel.window, "24h");
  assert.equal(funnel.jevEvaluatedDecisions, 4);
  assert.equal(funnel.jevDelegateRecommendations, 3);
  assert.equal(funnel.actualCliRoutes, 2);
  assert.equal(funnel.jevDelegateDirectOverrides.total, 2);
  assert.deepEqual(funnel.jevDelegateDirectOverrides.byKind, { device_interaction: 1, legacy_generic: 1 });
  assert.deepEqual(funnel.jevDelegateDirectOverrides.legacyGenericReasons, { direct_reasoned_override: 1 });
  assert.equal(funnel.cliGrants, 2);
  assert.equal(funnel.cliClaimedRuns, 1);
  assert.equal(funnel.cliStartedRuns, 1);
});

test("治理指标聚合携带 24h 路由漏斗，且不暴露 phase summary", () => {
  const now = Date.parse("2026-09-23T12:00:00Z");
  const report = buildGovernanceMetrics({
    tasks: [], events: [],
    usageReport: { generatedAt: "2026-09-23T12:00:00Z" },
    routes: [{ id: "r1", channel: "cli", createdAt: "2026-09-23T06:00:00Z", jevDecision: { execution_choice: "delegate", phase_summary_excerpt: "secret-ish summary" } }],
    delegations: [{ id: "d1", channel: "cli", createdAt: "2026-09-23T06:00:00Z" }],
  });
  assert.equal(now, Date.parse(report.routingFunnel24h.windowEnd));
  assert.equal(report.routingFunnel24h.jevEvaluatedDecisions, 1);
  assert.equal(report.routingFunnel24h.jevDelegateRecommendations, 1);
  assert.equal(report.routingFunnel24h.actualCliRoutes, 1);
  assert.equal(report.routingFunnel24h.cliGrants, 1);
  assert.ok(!JSON.stringify(report.routingFunnel24h).includes("secret-ish summary"));
});
