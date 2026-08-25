import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCompletionEvent,
  buildCompletionPacket,
  completionPacketMarkdown,
  normalizeActorIdentity,
  normalizeCompletionEvent,
  normalizeSubjectReference,
  normalizeTaskContract,
  withCompletionState,
} from "../scripts/completion-state.mjs";

const at = "2026-08-17T01:00:00.000Z";
const subject = (value = "artifact:v1", type = "artifact") => ({ type, value, observed_at: at });
const actor = (id = "agent-a", type = "agent") => ({ type, id });

function base(overrides = {}) {
  return withCompletionState({
    id: "v2-task", title: "Portable task", goal: "portable completion", status: "done_claimed", blocker: "",
    contractVersion: "v2", scope: ["core"], nonGoals: [], acceptanceRequirements: [{ id: "ac-1", description: "works", required: true }],
    workflowProfile: "standard", reviewPolicy: "not_required", executionEnvironment: "ci",
    verificationPlan: [{ id: "verify-1", title: "tests", kind: "test", required: true }],
    currentSubject: subject(), ownerActor: actor(), workspacePolicy: { version: "policy-test", requireIndependentReview: false, allowedAcceptanceSources: [], allowedAcceptanceActors: [] },
    requirementResults: [{ requirement_id: "ac-1", status: "passed", evidence_refs: ["claim-1"], checked_at: at, subject_ref: subject() }],
    verificationClaims: [{ id: "claim-1", requirement_id: "verify-1", kind: "test", status: "passed", observed_at: at, producer: actor(), subject_ref: subject(), evidence_ref: "ci://run/1", artifact_refs: [] }],
    reviewAttestations: [], acceptanceRecords: [], ...overrides,
  });
}

test("V2-01 核心任务不依赖 Codex、Context、OCR 或 Session 元数据", () => {
  const task = base();
  assert.equal(task.completionReadiness.ready, true);
  assert.equal(task.sessionId, undefined);
  assert.equal(task.contextTaskId, undefined);
});

test("V2-02 AcceptanceCriterion 使用稳定 id、description、required", () => {
  const contract = normalizeTaskContract({ contract_version: "v2", goal: "g", scope: ["s"], non_goals: [], acceptance_criteria: [{ id: "ac", description: "done", required: false }], workflow_profile: "fast" });
  assert.deepEqual(contract.acceptanceRequirements[0], { id: "ac", description: "done", title: "done", required: false });
});

test("V2-03 execution_environment 可省略并支持 local/worktree/ci/remote/other", () => {
  for (const value of [undefined, "local", "worktree", "ci", "remote", "other"]) {
    const contract = normalizeTaskContract({ contract_version: "v2", goal: "g", scope: ["s"], non_goals: [], acceptance_criteria: ["done"], workflow_profile: "fast", ...(value ? { execution_environment: value } : {}) });
    assert.equal(contract.executionEnvironment, value || "");
  }
});

test("V2-04 VerificationPlan 支持 security 与 performance", () => {
  const contract = normalizeTaskContract({ contract_version: "v2", goal: "g", scope: ["s"], non_goals: [], acceptance_criteria: ["done"], workflow_profile: "standard", verification_plan: [{ id: "s", title: "security", kind: "security", required: true }, { id: "p", title: "perf", kind: "performance", required: true }] });
  assert.deepEqual(contract.verificationPlan.map((item) => item.kind), ["security", "performance"]);
});

test("V2-04a L1/L2/L3 默认契约按风险分层", () => {
  const common = { contract_version: "v2", goal: "g", scope: ["s"], non_goals: [], acceptance_criteria: ["done"] };
  assert.equal(normalizeTaskContract({ ...common, workflow_profile: "fast" }).reviewPolicy, "not_required");
  assert.equal(normalizeTaskContract({ ...common, workflow_profile: "standard", verification_plan: [{ id: "t", title: "tests", kind: "test", required: true }] }).reviewPolicy, "not_required");
  const strict = normalizeTaskContract({ ...common, workflow_profile: "strict", verification_plan: [{ id: "t", title: "tests", kind: "test", required: true }] });
  assert.equal(strict.reviewPolicy, "required");
  assert.throws(() => normalizeTaskContract({ ...common, workflow_profile: "standard" }), /verification_plan/);
  assert.throws(() => normalizeTaskContract({ ...common, workflow_profile: "strict" }), /verification_plan/);
});

test("V2-05 SubjectReference 覆盖 Git、PR、产物、文档、外部和 none", () => {
  for (const type of ["git_commit", "git_worktree_snapshot", "pull_request_head", "artifact", "document_version", "external", "none"]) assert.ok(normalizeSubjectReference({ type, ...(type === "none" ? {} : { value: "v" }), observed_at: at }));
});

test("V2-06 ActorIdentity 覆盖 human/agent/ci/review/task/other", () => {
  for (const type of ["human", "agent", "ci", "review_platform", "task_platform", "other"]) assert.deepEqual(normalizeActorIdentity({ type, id: type }), { type, id: type });
});

test("V2-07 RequirementResult failed 进入 failed_requirements", () => {
  const task = base({ requirementResults: [{ requirement_id: "ac-1", status: "failed", evidence_refs: ["ci://run/2"], checked_at: at, subject_ref: subject() }] });
  assert.deepEqual(task.completionReadiness.failedRequirements, ["ac-1"]);
});

test("V2-08 Subject 更新使旧 VerificationClaim 过期", () => {
  const task = applyCompletionEvent(base(), { type: "subject.updated", subject_ref: subject("artifact:v2") });
  assert.equal(task.verificationStatus, "stale");
  assert.ok(task.completionReadiness.reasons.includes("verification_stale"));
});

test("V2-09 ReviewAttestation 区分 rejected 与 changes_requested", () => {
  const reviewed = base({ reviewPolicy: "required", workspacePolicy: { version: "p", requireIndependentReview: false }, reviewAttestations: [{ id: "r", reviewer: actor("reviewer"), subject_ref: subject(), scope: "all", verdict: "rejected", unresolved_findings: 0, observed_at: at }] });
  assert.equal(reviewed.reviewStatus, "rejected");
  assert.ok(reviewed.completionReadiness.reasons.includes("review_rejected"));
});

test("V2-10 Reviewer 独立性由 Workspace Policy 控制", () => {
  const review = { id: "r", reviewer: actor(), subject_ref: subject(), scope: "all", verdict: "approved", unresolved_findings: 0, observed_at: at };
  assert.equal(base({ reviewPolicy: "required", reviewAttestations: [review], workspacePolicy: { version: "p", requireIndependentReview: false } }).reviewStatus, "passed");
  assert.ok(base({ reviewPolicy: "required", reviewAttestations: [review], workspacePolicy: { version: "p", requireIndependentReview: true } }).completionReadiness.reasons.includes("reviewer_not_independent"));
});

test("V2-11 AcceptanceRecord 支持全部通用来源", () => {
  for (const source of ["human", "pull_request", "ci", "task_platform", "context_agent", "manual", "other"]) {
    const task = applyCompletionEvent(base(), { type: "acceptance.accepted", event_id: `a-${source}`, created_at: at, acceptance_record: { id: `a-${source}`, source, actor: actor("acceptor", source === "ci" ? "ci" : "human"), subject_ref: subject(), observed_at: at } });
    assert.equal(task.acceptanceStatus, "accepted");
  }
});

test("V2-12 最终验收不要求 Context complete_task", () => {
  const task = applyCompletionEvent(base(), { type: "acceptance.accepted", event_id: "human-a", created_at: at, acceptance_record: { id: "human-a", source: "human", actor: actor("owner", "human"), subject_ref: subject(), observed_at: at } });
  assert.equal(task.acceptanceStatus, "accepted");
  assert.equal(task.contextTaskId, undefined);
});

test("V2-13 CompletionReadiness 返回完整机器字段", () => {
  const readiness = base().completionReadiness;
  for (const field of ["executionStatus", "verificationStatus", "reviewStatus", "acceptanceStatus", "currentSubject", "reasons", "missingRequirements", "failedRequirements", "staleEvidence", "unresolvedFindings"]) assert.ok(Object.hasOwn(readiness, field));
  assert.deepEqual(readiness.completionClaim, { allowed: true, status: "ready", blockingReasons: [] });
});

test("V2-14 Completion Packet 带 policy_version", () => assert.equal(buildCompletionPacket(base()).policyVersion, "policy-test"));

test("V2-15 离线补录保留 occurred_at，记录时间由账本另记", () => {
  const event = normalizeCompletionEvent({ occurred_at: "2026-01-01T00:00:00.000Z", verification_claim: { id: "offline", kind: "manual", status: "passed", observed_at: "2026-01-01T00:00:00.000Z", producer: actor(), subject_ref: subject(), evidence_ref: "manual://record" } });
  assert.equal(event.occurred_at, "2026-01-01T00:00:00.000Z");
  assert.equal(event.verification_claim.observed_at, "2026-01-01T00:00:00.000Z");
});

test("V2-16 JSON 与 Markdown 导出都可读", () => {
  assert.equal(buildCompletionPacket(base()).schemaVersion, "taskcenter-completion-v2");
  assert.match(completionPacketMarkdown(base()), /TaskCenter Completion Packet/);
});

test("V2-17 绝对本地路径不能作为 standard 唯一跨团队证据", () => {
  const claim = { ...base().verificationClaims[0], evidence_ref: "/tmp/result.txt" };
  assert.ok(base({ verificationClaims: [claim] }).completionReadiness.reasons.includes("portable_evidence_missing"));
});

test("V2-18 legacy revision 可迁移为 external SubjectReference", () => {
  const task = withCompletionState({ id: "legacy", status: "done_claimed", currentRevision: "rev-a", updatedAt: at, acceptanceCriteria: ["done"] });
  assert.equal(task.currentSubject.type, "external");
  assert.ok(task.completionReadiness.reasons.includes("legacy_contract"));
});

test("V2-19 Review v2 同时校验规格、质量、未验证要求与总体结论", () => {
  const task = base({ reviewPolicy: "required", workspacePolicy: { version: "p", requireIndependentReview: false } });
  const common = { id: "r-v2", reviewer: actor("reviewer"), subject_ref: subject(), scope: "all", review_contract_version: "v2", observed_at: at, unresolved_findings: 0 };
  assert.throws(() => applyCompletionEvent(task, { type: "review.reported", review_attestation: { ...common, spec_verdict: "issues_found", quality_verdict: "approved", verdict: "approved", unverified_requirements: [] } }), /approved 要求/);
  const reviewed = applyCompletionEvent(task, { type: "review.reported", review_attestation: { ...common, spec_verdict: "compliant", quality_verdict: "approved", verdict: "approved", unverified_requirements: [] } });
  assert.equal(reviewed.reviewStatus, "passed");
  assert.equal(reviewed.completionReadiness.ready, true);
});

test("V2-20 未验证要求阻止 Review v2 通过并进入机器可读缺口", () => {
  const task = base({ reviewPolicy: "required", workspacePolicy: { version: "p", requireIndependentReview: false }, reviewAttestations: [{ id: "r", reviewer: actor("reviewer"), subject_ref: subject(), scope: "all", review_contract_version: "v2", spec_verdict: "compliant", quality_verdict: "approved", verdict: "changes_requested", unverified_requirements: [{ requirement_id: "runtime", reason: "需要真机" }], unresolved_findings: 0, observed_at: at }] });
  assert.ok(task.completionReadiness.reasons.includes("review_requirements_unverified"));
  assert.ok(task.completionReadiness.missingRequirements.includes("runtime"));
  assert.equal(task.completionReadiness.completionClaim.allowed, false);
});

test("V2-21 Diagnostic Observation 只记录观察数据且 resolved 要求根因时间和新鲜验证", () => {
  assert.throws(() => applyCompletionEvent(base(), { type: "diagnostic.reported", diagnostic_observation: { case_id: "d1", observed_at: at, started_at: at, outcome: "resolved", fresh_verification: "not_run" } }), /新鲜验证/);
  const task = applyCompletionEvent(base(), { type: "diagnostic.reported", diagnostic_observation: { case_id: "d1", observed_at: at, started_at: "2026-08-17T00:00:00.000Z", root_cause_at: at, outcome: "resolved", hypothesis_count: 2, failed_fix_count: 1, rollback_count: 1, fresh_verification: "passed", evidence_refs: ["log://case/d1"] } });
  assert.equal(task.diagnosticObservations.length, 1);
  assert.equal(task.completionReadiness.ready, true);
});

test("Review legacy 迁移不补造 cycle 字段", () => {
  const legacy = withCompletionState({ id: "legacy-review", status: "done_claimed", currentRevision: "rev", updatedAt: at, acceptanceCriteria: ["done"], reviewAttestations: [{ id: "legacy-a", reviewer: "reviewer", revision: "rev", scope: "all", verdict: "approved", observed_at: at }] });
  const review = legacy.reviewAttestations[0];
  assert.equal(review.review_contract_version, "legacy");
  assert.equal(Object.hasOwn(review, "cycle_id"), false);
  assert.equal(Object.hasOwn(review, "review_scope"), false);
});

test("Review Cycle 支持增量阶段并拒绝逆序时间", () => {
  const common = { cycle_id: "cycle-1", subject_ref: subject(), reviewer: actor("reviewer"), model: "gpt-review", review_scope: "full" };
  let task = applyCompletionEvent(base(), { type: "review_cycle.reported", review_cycle: { ...common, phase: "pending_review", implementation_ready_at: "2026-08-17T00:00:00.000Z", review_requested_at: "2026-08-17T00:10:00.000Z" } });
  task = applyCompletionEvent(task, { type: "review_cycle.reported", review_cycle: { ...common, phase: "reviewing", review_started_at: "2026-08-17T00:15:00.000Z" } });
  assert.equal(task.reviewCycles.length, 1);
  assert.equal(task.reviewCycles[0].cycle_number, 1);
  assert.equal(task.reviewCycles[0].review_started_at, "2026-08-17T00:15:00.000Z");
  assert.throws(() => applyCompletionEvent(task, { type: "review_cycle.reported", review_cycle: { ...common, phase: "pending_review" } }), /phase 不能回退/);
  assert.throws(() => applyCompletionEvent(task, { type: "review_cycle.reported", review_cycle: { ...common, review_finished_at: "2026-08-17T00:05:00.000Z" } }), /时间顺序/);
});

test("Review v3 修复后 Subject 更新仍可关联上一轮基础 Attestation", () => {
  const task = base({ reviewPolicy: "required", workspacePolicy: { version: "p", requireIndependentReview: false } });
  const fullCycle = { cycle_id: "cycle-full", subject_ref: subject(), reviewer: actor("reviewer"), model: "spark", review_scope: "full", phase: "completed", implementation_ready_at: "2026-08-17T00:00:00.000Z", review_requested_at: "2026-08-17T00:01:00.000Z", review_started_at: "2026-08-17T00:02:00.000Z", review_finished_at: "2026-08-17T00:03:00.000Z", outcome: "changes_requested" };
  let reviewed = applyCompletionEvent(task, { type: "review_cycle.reported", review_cycle: fullCycle });
  reviewed = applyCompletionEvent(reviewed, { type: "review.reported", review_attestation: { id: "att-full", reviewer: actor("reviewer"), subject_ref: subject(), scope: "all", review_contract_version: "v3", cycle_id: "cycle-full", cycle_number: 1, review_scope: "full", reviewed_files: ["a.mjs"], changed_files_since_previous_review: [], findings: [{ finding_id: "f1", fingerprint: "fp1", category: "correctness", severity: "p1", validity: "valid", status: "unresolved" }], spec_verdict: "issues_found", quality_verdict: "needs_fixes", verdict: "changes_requested", unresolved_findings: 1, unverified_requirements: [], observed_at: at } });
  const fixedSubject = { ...subject(), value: "artifact:v2" };
  reviewed = withCompletionState({ ...reviewed, currentSubject: fixedSubject });
  assert.equal(reviewed.reviewStatus, "stale");
  assert.ok(reviewed.completionReadiness.staleEvidence.includes("att-full"));
  reviewed = applyCompletionEvent(reviewed, { type: "review_cycle.reported", review_cycle: { cycle_id: "cycle-inc", subject_ref: fixedSubject, reviewer: actor("reviewer"), model: "luna", review_scope: "incremental", base_attestation_id: "att-full", phase: "completed", implementation_ready_at: "2026-08-17T01:10:00.000Z", review_requested_at: "2026-08-17T01:11:00.000Z", review_started_at: "2026-08-17T01:12:00.000Z", review_finished_at: "2026-08-17T01:13:00.000Z", outcome: "approved" } });
  reviewed = applyCompletionEvent(reviewed, { type: "review.reported", review_attestation: { id: "att-inc", reviewer: actor("reviewer"), subject_ref: fixedSubject, scope: "a.mjs", review_contract_version: "v3", cycle_id: "cycle-inc", cycle_number: 2, review_scope: "incremental", base_attestation_id: "att-full", reviewed_files: ["a.mjs"], changed_files_since_previous_review: ["a.mjs"], findings: [], spec_verdict: "compliant", quality_verdict: "approved", verdict: "approved", unresolved_findings: 0, unverified_requirements: [], observed_at: at } });
  assert.equal(reviewed.reviewAttestations[1].base_attestation_id, "att-full");
  assert.equal(reviewed.reviewAttestations[0].subject_ref.value, "artifact:v1");
  assert.equal(reviewed.reviewStatus, "passed");
});

test("相同 Subject 的重复 approved Attestation 保留审计但不计为有效 Review", () => {
  const task = base({ reviewPolicy: "required", workspacePolicy: { version: "p", requireIndependentReview: false } });
  const cycle = (id) => ({ cycle_id: id, subject_ref: subject(), reviewer: actor("reviewer"), model: "luna", review_scope: "full", phase: "completed", implementation_ready_at: "2026-08-17T00:00:00.000Z", review_requested_at: "2026-08-17T00:01:00.000Z", review_started_at: "2026-08-17T00:02:00.000Z", review_finished_at: "2026-08-17T00:03:00.000Z", outcome: "approved" });
  const attestation = (id, cycleId, number) => ({ id, reviewer: actor("reviewer"), subject_ref: subject(), scope: "all", review_contract_version: "v3", cycle_id: cycleId, cycle_number: number, review_scope: "full", reviewed_files: ["a.mjs"], changed_files_since_previous_review: [], findings: [], spec_verdict: "compliant", quality_verdict: "approved", verdict: "approved", unresolved_findings: 0, unverified_requirements: [], observed_at: at });
  let reviewed = applyCompletionEvent(task, { type: "review_cycle.reported", review_cycle: cycle("cycle-a") });
  reviewed = applyCompletionEvent(reviewed, { type: "review.reported", review_attestation: attestation("att-a", "cycle-a", 1) });
  reviewed = applyCompletionEvent(reviewed, { type: "review_cycle.reported", review_cycle: cycle("cycle-b") });
  reviewed = applyCompletionEvent(reviewed, { type: "review.reported", review_attestation: attestation("att-b", "cycle-b", 2) });
  assert.equal(reviewed.reviewAttestations.length, 2);
  assert.equal(reviewed.reviewAttestations[1].effective_review, false);
  assert.equal(reviewed.reviewAttestations[1].duplicate_of_attestation_id, "att-a");
  assert.equal(reviewed.reviewStatus, "passed");
});

test("Completion Packet 增加 Review 过程但不改变 completionClaim", () => {
  const task = base({
    reviewCycles: [{ cycle_id: "packet-cycle", cycle_number: 1, subject_ref: subject(), reviewer: actor("reviewer"), model: "luna", review_scope: "full", phase: "completed", outcome: "approved", observed_at: at }],
    reviewAttestations: [{ id: "packet-att", reviewer: actor("reviewer"), subject_ref: subject(), scope: "all", review_contract_version: "v3", cycle_id: "packet-cycle", cycle_number: 1, review_scope: "full", reviewed_files: ["a.mjs"], changed_files_since_previous_review: [], findings: [], finding_summary: { total: 0, resolved: 0, unresolved: 0 }, spec_verdict: "compliant", quality_verdict: "approved", verdict: "approved", unverified_requirements: [], unresolved_findings: 0, observed_at: at, effective_review: true }],
    routingHistory: [{ preferredExecutorModel: "spark", selectedExecutorModel: "luna", fallbackFrom: "spark", fallbackReason: "capacity" }],
  });
  const before = task.completionReadiness.completionClaim;
  const packet = buildCompletionPacket(task);
  assert.deepEqual(packet.completionReadiness.completionClaim, before);
  assert.equal(packet.reviewProcess.totalCycles, 1);
  assert.equal(packet.reviewProcess.cycles[0].model, "luna");
  assert.equal(packet.reviewProcess.fallbackOccurred, true);
  assert.equal(packet.reviewProcess.finalApprovedSubject.value, "artifact:v1");
  assert.match(completionPacketMarkdown(task), /Effective cycles: 1/);
});

test("Completion Packet 汇总 Review 长尾告警且不把告警作为完成阻断", () => {
  const task = base({
    reviewCycles: [
      { cycle_id: "slow-a", cycle_number: 1, subject_ref: subject(), reviewer: actor("reviewer"), model: "luna", review_scope: "full", phase: "completed", implementation_ready_at: "2026-08-15T00:00:00.000Z", review_requested_at: "2026-08-15T00:01:00.000Z", review_started_at: "2026-08-17T00:00:00.000Z", review_finished_at: "2026-08-17T00:05:00.000Z", outcome: "changes_requested" },
      { cycle_id: "slow-b", cycle_number: 2, subject_ref: subject(), reviewer: actor("reviewer"), model: "luna", review_scope: "full", phase: "reviewing", implementation_ready_at: "2026-08-17T01:00:00.000Z", review_requested_at: "2026-08-17T01:01:00.000Z", review_started_at: "2026-08-17T01:02:00.000Z", outcome: "pending" },
    ],
  });
  const packet = buildCompletionPacket(task);
  assert.ok(packet.reviewProcess.reviewLoopWarnings.includes("review_wait_dominates"));
  assert.ok(packet.reviewProcess.reviewLoopWarnings.includes("overnight_wall_clock_distortion"));
  assert.ok(packet.reviewProcess.reviewLoopWarnings.includes("repeated_full_review_same_subject"));
  assert.ok(packet.reviewProcess.reviewLoopWarnings.includes("review_cycle_in_progress"));
  assert.deepEqual(packet.completionReadiness.completionClaim, task.completionReadiness.completionClaim);
});
