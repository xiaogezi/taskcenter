import assert from "node:assert/strict";
import test from "node:test";
import { matchesTaskLifecycleFilter, taskClosureReasonLabels, taskLifecycleFilterCounts } from "../app/task-lifecycle-filter.mjs";

const now = Date.parse("2026-08-25T12:00:00.000Z");
const active = {
  id: "active",
  status: "in_progress",
  updatedAt: "2026-08-23T12:00:00.000Z",
  verificationStatus: "stale",
  reviewStatus: "pending",
  acceptanceStatus: "pending",
  completionReadiness: { reasons: ["execution_not_done_claimed", "verification_stale", "required_review_missing"] },
};

test("顶部生命周期筛选区分未完成阶段与终态", () => {
  const tasks = [
    active,
    { id: "planned", status: "planned", updatedAt: "2026-08-25T11:00:00.000Z", verificationStatus: "pending", completionReadiness: { reasons: ["required_verification_missing"] } },
    { id: "blocked", status: "blocked", updatedAt: "2026-08-25T10:00:00.000Z", reviewStatus: "not_required", completionReadiness: { reasons: [] } },
    { id: "done", status: "done_claimed", updatedAt: "2026-08-25T09:00:00.000Z", completionReadiness: { reasons: [] } },
    { id: "archived", status: "in_progress", archivedAt: "2026-08-25T08:00:00.000Z", completionReadiness: { reasons: ["required_verification_missing"] } },
  ];
  const counts = taskLifecycleFilterCounts(tasks, now);
  assert.equal(counts.all, 4);
  assert.equal(counts.unfinished, 3);
  assert.equal(counts.planned, 1);
  assert.equal(counts.in_progress, 1);
  assert.equal(counts.blocked, 1);
  assert.equal(counts.stale, 1);
  assert.equal(counts.needs_verification, 1);
  assert.equal(counts.needs_review, 1);
  assert.equal(counts.stale_evidence, 1);
});

test("证据与 Review 筛选只包含未完成且未归档任务", () => {
  assert.equal(matchesTaskLifecycleFilter(active, "stale_evidence", now), true);
  assert.equal(matchesTaskLifecycleFilter({ ...active, status: "done_claimed" }, "stale_evidence", now), false);
  assert.equal(matchesTaskLifecycleFilter({ ...active, archivedAt: "2026-08-25T10:00:00.000Z" }, "needs_review", now), false);
});

test("未闭环原因转换为可读标签并去重", () => {
  assert.deepEqual(taskClosureReasonLabels({
    ...active,
    completionReadiness: { reasons: ["execution_not_done_claimed", "verification_stale", "verification_stale", "unknown"] },
  }), ["未声明完成", "验证已过期"]);
  assert.deepEqual(taskClosureReasonLabels({ ...active, status: "done_claimed" }), []);
});
