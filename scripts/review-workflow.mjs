// Fixed report envelope comes from the claimed lease; the reviewer supplies only
// coverage and technical conclusions. Existing ledger validation remains final.
export function buildManagedReviewReport(context, result, observedAt = new Date().toISOString()) {
  const expected = [...new Set(context.files)];
  const covered = result.reviewed_files || [];
  if (covered.length !== new Set(covered).size || covered.some((file) => !expected.includes(file))) throw new Error("REVIEW_COVERAGE_INVALID");
  const missing = expected.filter((file) => !covered.includes(file));
  if (result.verdict === "approved" && missing.length) throw new Error("REVIEW_COVERAGE_INCOMPLETE");
  return {
    ...result,
    id: `managed-${context.route_id}`,
    route_id: context.route_id,
    reviewer: context.reviewer,
    reviewer_session_id: context.reviewer.session_id,
    subject_ref: context.subject_ref,
    review_artifacts: context.review_artifacts,
    cycle_id: context.cycle_id,
    cycle_number: context.cycle_number,
    review_contract_version: "v3",
    review_scope: "full",
    scope: "Managed OCR full review",
    observed_at: observedAt,
    unresolved_findings: (result.findings || []).filter((finding) => finding.status !== "resolved" && finding.validity !== "false_positive" && finding.validity !== "duplicate").length,
    unverified_requirements: [...(result.unverified_requirements || []), ...missing.map((file) => ({ requirement_id: file, reason: "File not reviewed" }))],
  };
}
