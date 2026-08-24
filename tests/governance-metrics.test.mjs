import test from "node:test";
import assert from "node:assert/strict";
import { buildGovernanceMetrics } from "../scripts/governance-metrics.mjs";

test("治理看板按 profile、任务类别和模型输出稳健统计", () => {
  const tasks = [
    { id: "a", status: "done_claimed", workflowProfile: "fast", model: "luna", createdAt: "2026-08-20T00:00:00Z", actualAt: "2026-08-20T00:10:00Z", requirementResults: [], diagnosticObservations: [{ case_id: "d1", observed_at: "2026-08-20T00:09:00Z", started_at: "2026-08-20T00:01:00Z", root_cause_at: "2026-08-20T00:06:00Z", outcome: "resolved", hypothesis_count: 2, failed_fix_count: 1, rollback_count: 1, fresh_verification: "passed" }] },
    { id: "b", status: "verified", workflowProfile: "strict", model: "terra", createdAt: "2026-08-20T00:00:00Z", actualAt: "2026-08-20T00:30:00Z", requirementResults: [{ status: "failed" }] },
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
  assert.deepEqual(report.durationMs, { average: 1_200_000, p50: 600_000, p95: 1_800_000 });
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
  const report = buildGovernanceMetrics({ tasks: [{ id: "spark", status: "done_claimed" }], usageReport: { overall: { estimatedCredits: null } } });
  assert.equal(report.creditsPerCompletedTask, null);
  assert.equal(report.creditsEstimation, "unestimable");
});

test("部分模型缺少费率时看板保留可估算部分并标明 partial", () => {
  const report = buildGovernanceMetrics({
    tasks: [{ id: "mixed", status: "done_claimed", createdAt: "2026-08-20T00:00:00Z", actualAt: "2026-08-20T01:00:00Z" }],
    usageReport: { generatedAt: "2026-08-20T02:00:00Z", overall: { estimatedCredits: 12, creditsEstimation: "partial" } },
  });
  assert.equal(report.creditsPerCompletedTask, 12);
  assert.equal(report.creditsEstimation, "partial");
});
