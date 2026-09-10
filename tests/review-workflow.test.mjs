import test from "node:test";
import assert from "node:assert/strict";
import { buildManagedReviewReport } from "../scripts/review-workflow.mjs";

test("managed report binds lease identity and refuses false full coverage", () => {
  const context = { files: ["a.mjs", "b.mjs"], route_id: "route-1", reviewer: { id: "real", session_id: "real" }, subject_ref: { value: "exact" }, review_artifacts: { bundle: "exact" }, cycle_id: "cycle", cycle_number: 4 };
  const result = { reviewed_files: ["a.mjs", "b.mjs"], findings: [], verdict: "approved", reviewer: { id: "fake" }, cycle_number: 1 };
  const report = buildManagedReviewReport(context, result);
  assert.equal(report.reviewer.id, "real");
  assert.equal(report.cycle_number, 4);
  assert.equal(report.subject_ref.value, "exact");
  assert.equal(report.unresolved_findings, 0);
  assert.throws(() => buildManagedReviewReport(context, { ...result, reviewed_files: ["a.mjs"] }), /COVERAGE_INCOMPLETE/);
  assert.throws(() => buildManagedReviewReport(context, { ...result, reviewed_files: ["a.mjs", "a.mjs"] }), /COVERAGE_INVALID/);
  assert.throws(() => buildManagedReviewReport(context, { ...result, reviewed_files: ["foreign"] }), /COVERAGE_INVALID/);
  const partial = buildManagedReviewReport(context, { ...result, verdict: "changes_requested", reviewed_files: ["a.mjs"] });
  assert.equal(partial.unverified_requirements[0].requirement_id, "b.mjs");
});
