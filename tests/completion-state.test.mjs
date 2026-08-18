import assert from "node:assert/strict";
import test from "node:test";
import { applyCompletionEvent, buildCompletionPacket, withCompletionState } from "../scripts/completion-state.mjs";

const revisionA = "workspace:sha256:aaaa";
const revisionB = "workspace:sha256:bbbb";

function standardTask(overrides = {}) {
  return withCompletionState({
    id: "task-completion",
    sessionId: "implementer-session",
    contextTaskId: "context-completion",
    status: "done_claimed",
    blocker: "",
    goal: "实现完成闭环",
    contractVersion: "v2",
    scope: ["scripts/"],
    nonGoals: [],
    acceptanceCriteria: ["功能通过"],
    acceptanceRequirements: [{ id: "acceptance-1", title: "功能通过", required: true }],
    workflowProfile: "standard",
    reviewPolicy: "not_required",
    executionEnvironment: "local",
    verificationPlan: [{ id: "tests", title: "单元测试", kind: "test", required: true }],
    currentRevision: revisionA,
    requirementResults: [{ requirement_id: "acceptance-1", status: "passed", evidence_refs: ["verification:tests"], checked_at: "2026-08-17T00:00:00.000Z" }],
    verificationClaims: [],
    reviewAttestations: [],
    ...overrides,
  });
}

function verification(revision = revisionA) {
  return {
    type: "verification.reported",
    created_at: "2026-08-17T00:01:00.000Z",
    revision,
    verification_claim: {
      id: `claim-${revision}`,
      requirement_id: "tests",
      kind: "test",
      status: "passed",
      exit_code: 0,
      revision,
      observed_at: "2026-08-17T00:01:00.000Z",
      producer: "codex",
      producer_session_id: "implementer-session",
      evidence_ref: "test-output:137-passed",
      artifact_refs: [],
      summary: "tests passed",
    },
  };
}

test("standard done_claimed 缺少 required verification 时保持 pending", () => {
  const task = standardTask();
  assert.equal(task.verificationStatus, "pending");
  assert.equal(task.acceptanceStatus, "pending");
  assert.equal(task.completionReadiness.ready, false);
  assert.ok(task.completionReadiness.reasons.includes("required_verification_missing"));
});

test("当前 revision 的成功验证使 standard 任务进入 ready", () => {
  const task = applyCompletionEvent(standardTask(), verification());
  assert.equal(task.verificationStatus, "passed");
  assert.equal(task.acceptanceStatus, "ready");
  assert.equal(task.completionReadiness.ready, true);
  assert.equal(buildCompletionPacket(task).currentRevision, revisionA);
});

test("验证后 revision 变化会自动变 stale", () => {
  const verified = applyCompletionEvent(standardTask(), verification());
  const changed = applyCompletionEvent(verified, { type: "task.update", created_at: "2026-08-17T00:02:00.000Z", revision: revisionB });
  assert.equal(changed.verificationStatus, "stale");
  assert.equal(changed.acceptanceStatus, "pending");
  assert.ok(changed.completionReadiness.reasons.includes("verification_stale"));
});

test("验证证据绑定的 legacy revision 不得改写当前结构化 SubjectReference", () => {
  const subject = { type: "git_worktree_snapshot", value: "snapshot:structured", observed_at: "2026-08-17T00:00:00.000Z" };
  const task = standardTask({ currentSubject: subject, currentRevision: "legacy-revision" });
  const verified = applyCompletionEvent(task, {
    type: "verification.reported",
    created_at: "2026-08-17T00:01:00.000Z",
    revision: "legacy-revision",
    subject_ref: { type: "external", value: "legacy-revision", observed_at: "2026-08-17T00:01:00.000Z" },
    verification_claim: {
      id: "claim-structured-subject",
      requirement_id: "tests",
      kind: "test",
      status: "passed",
      subject_ref: subject,
      observed_at: "2026-08-17T00:01:00.000Z",
      producer: "codex",
      evidence_ref: "test-output:passed",
    },
  });
  assert.deepEqual(verified.currentSubject, subject);
  assert.equal(verified.verificationStatus, "passed");
});

test("required review 缺失、有 findings 或旧 revision 时均不得 ready", () => {
  const required = applyCompletionEvent(standardTask({ reviewPolicy: "required" }), verification());
  assert.ok(required.completionReadiness.reasons.includes("required_review_missing"));
  assert.throws(() => applyCompletionEvent(required, {
    type: "review.reported",
    created_at: "2026-08-17T00:03:00.000Z",
    review_attestation: {
      id: "review-findings", reviewer: "reviewer", reviewer_session_id: "review-session", revision: revisionA,
      scope: "scripts/", verdict: "approved", unresolved_findings: 1, observed_at: "2026-08-17T00:03:00.000Z", finding_refs: [],
    },
  }), /未解决 findings/);
  const reviewed = applyCompletionEvent(required, {
    type: "review.reported",
    created_at: "2026-08-17T00:03:00.000Z",
    review_attestation: {
      id: "review-approved", reviewer: "reviewer", reviewer_session_id: "review-session", revision: revisionA,
      scope: "scripts/", verdict: "approved", unresolved_findings: 0, observed_at: "2026-08-17T00:03:00.000Z", finding_refs: [],
    },
  });
  assert.equal(reviewed.reviewStatus, "passed");
  assert.equal(reviewed.completionReadiness.ready, true);
  const changed = applyCompletionEvent(reviewed, { type: "task.update", created_at: "2026-08-17T00:04:00.000Z", revision: revisionB });
  assert.equal(changed.reviewStatus, "stale");
  assert.ok(changed.completionReadiness.reasons.includes("review_stale"));
});

test("老任务查询迁移为 legacy 且不会误标 accepted", () => {
  const legacy = withCompletionState({ id: "legacy", status: "verified", acceptanceCriteria: ["旧验收"] });
  assert.equal(legacy.contractVersion, "legacy");
  assert.notEqual(legacy.acceptanceStatus, "accepted");
  assert.equal(legacy.completionReadiness.ready, false);
});
