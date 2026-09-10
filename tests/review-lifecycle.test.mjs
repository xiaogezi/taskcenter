import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = await mkdtemp(join(tmpdir(), "review-lifecycle-"));
const statePath = join(dir, "routing.json");
const configPath = join(dir, "roles.json");
process.env.TASKCENTER_ROUTING_CONTROL_PATH = statePath;
process.env.TASKCENTER_MODEL_ROLE_CONFIG_PATH = configPath;
const config = { schema_version: "taskcenter-model-roles-v1", roles: {
  executor: { model: "executor-test", reasoning_effort: "low", fallback_models: [], concurrency_limit: 1 },
  reviewer: { model: "reviewer-test", reasoning_effort: "low", fallback_models: [], concurrency_limit: 1 },
}, retired_models: [] };
const { validateReviewRequest, routingSelect, routingResult, claimReview, reportReview, reviewSessionRecords, reviewTaskRecords } = await import("../scripts/routing-control.mjs");
const { applyCompletionEvent } = await import("../scripts/completion-state.mjs");
const now = "2026-09-10T08:00:00.000Z";
const subject = { type: "git_commit", value: "commit-a", repository: "repo", observed_at: now };
const task = { id: "task-review", sessionId: "owner", workspace: dir, status: "done_claimed", currentSubject: subject };
const registry = { owner: { workspace: dir, model: "main-test" }, reviewer: { workspace: dir, model: "reviewer-test" } };
const artifacts = { subject: { ref: subject.value }, bundle: { fingerprint: "sha256:bundle" }, rules: { fingerprint: "sha256:rules" } };
const input = { session_id: "owner", task_id: task.id, task_class: "ocr_review", channel: "native", orchestrator_model: "main-test", review_artifacts: artifacts };
const canonical = (id) => id;
const code = (expected) => (error) => { assert.equal(error.code, expected); return true; };
const select = (target = task, request = input) => routingSelect({ ...request, review_context: validateReviewRequest(request, target, registry) }, now).route;
const claim = (route, target = task, overrides = {}) => claimReview({ route_id: route.route_id, claim_token: route.review_record.claim_token, session_id: "reviewer", sandbox: "read-only", ...overrides }, target, registry, canonical, now);
function report(route, target = task, overrides = {}) {
  const event = { type: "review.reported", task_id: target.id, session_id: "reviewer", occurred_at: now, review_attestation: {
    id: "attestation", route_id: route.route_id, reviewer: { type: "agent", id: "reviewer", session_id: "reviewer" }, subject_ref: subject,
    review_artifacts: artifacts, scope: "all", review_contract_version: "v2", spec_verdict: "compliant", quality_verdict: "approved", verdict: "approved", unresolved_findings: 0, observed_at: now,
    ...overrides,
  } };
  return reportReview(event, target, () => ({ task: applyCompletionEvent(target, event) }), canonical, now);
}
test.beforeEach(async () => { await rm(statePath, { force: true }); await writeFile(configPath, JSON.stringify(config)); });
test.after(async () => rm(dir, { recursive: true, force: true }));

for (const status of ["done_claimed", "in_progress", "blocked"]) {
  test(`${status} Task 无需 active task 即可路由且保持业务状态`, () => {
    const target = { ...task, status };
    const route = select(target);
    assert.equal(route.available, true);
    assert.equal(route.requires_new_session, false);
    assert.equal(route.review_record.status, "pending");
    assert.equal(route.review_record.issues_only, status === "blocked");
    assert.equal(target.status, status);
  });
}
test("blocked 可报告问题，但不能批准，包括路由之后重新阻塞", () => {
  const blocked = { ...task, status: "blocked" };
  const route = select(blocked); claim(route, blocked);
  assert.throws(() => report(route, blocked), code("TASK_NOT_REVIEWABLE"));
  assert.throws(() => report(route, task), code("TASK_NOT_REVIEWABLE"));
  report(route, blocked, { verdict: "changes_requested", spec_verdict: "issues_found", quality_verdict: "needs_fixes", unresolved_findings: 1 });
  assert.equal(reviewTaskRecords(task.id)[0].status, "changes_requested");
});
for (const status of ["cancelled", "planned", "verified"]) test(`${status} 拒绝 Review`, () => {
  assert.throws(() => select({ ...task, status }), code("TASK_NOT_REVIEWABLE"));
});
test("未登记、不存在及越权有独立错误码", () => {
  assert.throws(() => validateReviewRequest({ ...input, session_id: "unknown" }, task, registry), code("SESSION_NOT_REGISTERED"));
  assert.throws(() => validateReviewRequest(input, null, registry), code("TASK_NOT_FOUND"));
  assert.throws(() => validateReviewRequest({ ...input, session_id: "reviewer" }, task, registry), code("REVIEW_PERMISSION_DENIED"));
});
for (const missing of ["subject", "bundle", "rules"]) test(`缺 ${missing} 拒绝`, () => {
  const incomplete = { ...artifacts }; delete incomplete[missing];
  assert.throws(() => select(task, { ...input, review_artifacts: incomplete }), code("REVIEW_ARTIFACTS_INCOMPLETE"));
});
test("缺当前 Subject 与 Subject 不匹配分别诊断", () => {
  assert.throws(() => select({ ...task, currentSubject: null }), code("REVIEW_ARTIFACTS_INCOMPLETE"));
  assert.throws(() => select(task, { ...input, review_artifacts: { ...artifacts, subject: { ref: "old" } } }), code("SUBJECT_MISMATCH"));
});
test("Reviewer 容量与模型不可用有明确码，不能回退普通执行器", () => {
  const first = select();
  assert.equal(select().error_code, "REVIEWER_LEASE_UNAVAILABLE");
  routingResult({ route_id: first.route_id, outcome: "unavailable", error_type: "model_unavailable" }, now);
  const unavailable = select();
  assert.equal(unavailable.error_code, "REVIEWER_UNAVAILABLE");
  assert.equal(unavailable.selected_model, null);
});
test("缺 Reviewer 配置返回 REVIEWER_UNAVAILABLE", async () => {
  await writeFile(configPath, JSON.stringify({ ...config, roles: { executor: config.roles.executor } }));
  assert.throws(() => select(), code("REVIEWER_UNAVAILABLE"));
});
test("Reviewer 独立、注册、模型、只读与 capability 校验", () => {
  const route = select();
  assert.throws(() => claim(route, task, { session_id: "owner" }), code("REVIEWER_NOT_INDEPENDENT"));
  assert.throws(() => claim(route, task, { session_id: "unknown" }), code("SESSION_NOT_REGISTERED"));
  assert.throws(() => claim(route, task, { sandbox: "workspace-write" }), code("REVIEW_PERMISSION_DENIED"));
  assert.throws(() => claim(route, task, { claim_token: "wrong" }), code("REVIEW_PERMISSION_DENIED"));
  assert.throws(() => claim(route, { ...task, sessionHistory: ["reviewer"] }), code("REVIEWER_NOT_INDEPENDENT"));
  assert.throws(() => claim(route, { ...task, workspace: "/different" }), code("REVIEW_PERMISSION_DENIED"));
  claim(route);
  assert.equal(reviewSessionRecords("reviewer")[0].reviewer_session_id, "reviewer");
});
test("领取后 Subject、Bundle、Rules 必须精确匹配", () => {
  const route = select(); claim(route);
  assert.throws(() => report(route, { ...task, currentSubject: { ...subject, value: "new" } }), code("SUBJECT_MISMATCH"));
  for (const key of ["bundle", "rules"]) assert.throws(() => report(route, task, { review_artifacts: { ...artifacts, [key]: { ref: "changed" } } }), code("REVIEW_ARTIFACTS_MISMATCH"));
  assert.throws(() => report(route, task, { reviewer: { type: "agent", id: "owner" } }), code("REVIEW_PERMISSION_DENIED"));
});
test("完整报告和释放不创建 Task，同一 Reviewer 可审查另一个 Task", () => {
  const route = select(); claim(route); report(route);
  assert.equal(reviewTaskRecords(task.id)[0].status, "approved");
  const result = routingResult({ route_id: route.route_id, outcome: "succeeded" }, now);
  assert.equal(result.health.find((item) => item.model === "reviewer-test").active_executors, 0);
  const other = { ...task, id: "task-other" };
  const next = select(other, { ...input, task_id: other.id }); claim(next, other);
  assert.equal(reviewSessionRecords("reviewer").length, 2);
  assert.equal(task.status, "done_claimed");
});
test("没有 Reviewer 报告时 succeeded 只释放 lease，不能产生 approved", () => {
  const route = select(); claim(route);
  const result = routingResult({ route_id: route.route_id, outcome: "succeeded" }, now);
  assert.equal(result.route.review_record.status, "failed");
  assert.equal(result.route.review_record.verdict, null);
  assert.throws(() => report(route), code("REVIEWER_LEASE_UNAVAILABLE"));
});
