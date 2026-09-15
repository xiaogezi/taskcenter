#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { resolveTrustedMcpSession } from "./mcp-session-context.mjs";
import { TASKCENTER_VERSION } from "./version.mjs";
import { recommendTaskClose } from "./session-lifecycle.mjs";
import { boundedResponse } from "./bounded-response.mjs";
import { buildManagedReviewReport } from "./review-workflow.mjs";

const controlServerUrl = process.env.TASKCENTER_CONTROL_URL || "http://127.0.0.1:3001";
const acceptanceToken = process.env.TASKCENTER_ACCEPTANCE_TOKEN || "";
const localMcpTokenPath = resolve(process.env.TASKCENTER_MCP_TOKEN_PATH || join(import.meta.dirname, "..", ".local", "runtime", "mcp-token"));
const server = new McpServer({ name: "taskcenter-task-server", version: TASKCENTER_VERSION });
let managedReviewContext;
const verificationKind = z.enum(["test", "build", "lint", "static_check", "device", "manual", "security", "performance", "other"]);
const taskReuseDecision = z.enum(["reuse", "create_new", "uncertain"]);
const responseMode = z.enum(["summary", "full"]).default("summary");
// 路由和 delegation 的调用方必须消费 route_id、selected_model 或 claim_token；
// 默认压成任务摘要会破坏旧执行器，因此控制面接口保留 full 默认值。
const operationalResponseMode = z.enum(["summary", "full"]).default("full");
const actorIdentity = z.object({ type: z.enum(["human", "agent", "ci", "review_platform", "task_platform", "other"]), id: z.string().min(1).max(200), display_name: z.string().max(200).optional(), provider: z.string().max(200).optional(), session_id: z.string().max(200).optional() }).strict();
const subjectReference = z.object({ type: z.enum(["git_commit", "git_worktree_snapshot", "pull_request_head", "artifact", "document_version", "external", "none"]), value: z.string().max(500).optional(), repository: z.string().max(300).optional(), branch: z.string().max(300).optional(), observed_at: z.string().datetime({ offset: true }) }).strict();
const routingReviewArtifact = z.object({ ref: z.string().max(1_000).optional(), fingerprint: z.string().max(300).optional() }).strict()
  .refine((value) => Boolean(value.ref?.trim() || value.fingerprint?.trim()), { message: "ref 或 fingerprint 至少提供一个" });
const routingReviewArtifacts = z.object({
  subject: routingReviewArtifact,
  bundle: routingReviewArtifact,
  rules: routingReviewArtifact,
}).strict();
const acceptanceCriterion = z.union([z.string().min(1).max(500), z.object({ id: z.string().min(1).max(120), description: z.string().min(1).max(500), required: z.boolean() }).strict()]);
const verificationRequirement = z.object({
  id: z.string().min(1).max(120),
  title: z.string().min(1).max(300),
  kind: verificationKind,
  required: z.boolean(),
  suggested_command: z.string().max(500).optional(),
}).strict();
const unverifiedRequirement = z.object({
  requirement_id: z.string().min(1).max(120),
  reason: z.string().min(1).max(1_000),
  required_evidence: z.string().max(500).optional(),
}).strict();
const reviewFinding = z.object({
  finding_id: z.string().min(1).max(160), fingerprint: z.string().min(1).max(200), category: z.string().max(120).default("unknown"),
  severity: z.enum(["p0", "p1", "p2", "p3", "unknown"]).default("unknown"),
  validity: z.enum(["valid", "duplicate", "false_positive", "unknown"]).default("unknown"),
  status: z.enum(["resolved", "unresolved"]).default("unresolved"),
}).strict();
const reviewCycleFields = {
  cycle_id: z.string().min(1).max(120), cycle_number: z.number().int().positive().optional(), subject_ref: subjectReference,
  reviewer: actorIdentity, model: z.string().min(1).max(120), review_scope: z.enum(["full", "incremental"]),
  base_attestation_id: z.string().max(120).optional(), phase: z.enum(["pending_review", "reviewing", "fixing", "verifying", "completed"]).optional(),
  implementation_ready_at: z.string().datetime({ offset: true }).optional(), review_requested_at: z.string().datetime({ offset: true }).optional(),
  review_started_at: z.string().datetime({ offset: true }).optional(), review_finished_at: z.string().datetime({ offset: true }).optional(),
  fix_started_at: z.string().datetime({ offset: true }).optional(), fix_finished_at: z.string().datetime({ offset: true }).optional(),
  verification_finished_at: z.string().datetime({ offset: true }).optional(), review_active_ms: z.number().int().nonnegative().optional(),
  fix_active_ms: z.number().int().nonnegative().optional(), verification_active_ms: z.number().int().nonnegative().optional(),
  wait_reason: z.string().max(500).optional(), outcome: z.enum(["pending", "changes_requested", "approved", "rejected", "cancelled"]).optional(),
  occurred_at: z.string().datetime({ offset: true }).optional(),
};
const taskFields = {
  bug: z.object(Object.fromEntries(["source", "version", "preconditions", "steps", "actual", "expected", "acceptanceSteps", "testArtifact", "targetBranch"].map(key => [key, z.string().min(1).max(3000)]))).strict().optional(),
  response_mode: responseMode,
  session_id: z.string().min(1).max(200).optional(),
  agent: z.enum(["codex", "claude", "workbuddy", "unknown"]).optional(),
  provider: z.string().max(80).optional(),
  model: z.string().max(120).optional(),
  workspace: z.string().max(4_096).optional(),
  task_id: z.string().max(200).optional(),
  session_switch_id: z.string().uuid().optional(),
  context_task_id: z.string().max(200).optional(),
  requirement_id: z.string().max(200).optional(),
  event_id: z.string().max(200).optional(),
  title: z.string().max(200).optional(),
  goal: z.string().max(1_000).optional(),
  // 会话侧不能把任务直接标为已验收：verified 不在此枚举内，验收由 TaskCenter 基于证据判定。
  status: z.enum(["planned", "in_progress", "blocked", "done_claimed", "cancelled"]).optional(),
  priority: z.string().max(20).optional(),
  plan: z.array(z.string().max(500)).max(20).optional(),
  current_step: z.string().max(500).optional(),
  next_action: z.string().max(500).optional(),
  blocker: z.string().max(1_000).optional(),
  acceptance_criteria: z.array(acceptanceCriterion).max(50).optional(),
  changed_files: z.array(z.string().max(500)).max(50).optional(),
  tests: z.array(z.string().max(500)).max(30).optional(),
  evidence: z.array(z.string().max(1_000)).max(30).optional(),
  assumptions: z.array(z.string().max(500)).max(20).optional(),
  risks: z.array(z.string().max(500)).max(20).optional(),
  tradeoffs: z.array(z.string().max(500)).max(20).optional(),
  open_questions: z.array(z.string().max(500)).max(20).optional(),
  retrospective: z.string().max(2_000).optional(),
  expected_at: z.string().datetime({ offset: true }).optional().describe("旧预计完成时间兼容字段，仅用于历史估时校准，不触发交付逾期"),
  due_at: z.string().datetime({ offset: true }).optional().describe("交付截止时间，用于计算 schedule overdue"),
  estimated_effort_ms: z.number().int().positive().optional().describe("预计有效执行工时（毫秒），用于历史估时校准"),
  estimate_reason: z.string().max(1_000).optional().describe("新增或调整截止时间/预计工时的原因"),
  contract_version: z.enum(["legacy", "v2"]).optional(),
  scope: z.array(z.string().min(1).max(500)).max(50).optional(),
  non_goals: z.array(z.string().max(500)).max(50).optional(),
  workflow_profile: z.enum(["fast", "standard", "strict"]).optional(),
  review_policy: z.enum(["not_required", "recommended", "required"]).optional(),
  execution_environment: z.enum(["local", "worktree", "ci", "remote", "other"]).optional(),
  execution_model_policy: z.object({
    mode: z.enum(["auto", "quota_preferred"]),
    preferred_model: z.string().min(1).max(120).optional(),
    quota_limit_id: z.string().min(1).max(120).optional(),
    fallback_on_exhaustion: z.boolean().optional(),
    authorization_reason: z.string().max(500).optional(),
  }).strict().optional(),
  verification_plan: z.array(verificationRequirement).max(30).optional(),
  revision: z.string().max(200).optional().describe("Git revision 或明确的工作区快照标识"),
  subject_ref: subjectReference.optional(),
  actor: actorIdentity.optional(),
  occurred_at: z.string().datetime({ offset: true }).optional(),
  workspace_policy: z.object({ version: z.string().max(80).optional(), require_independent_review: z.boolean().optional(), allowed_acceptance_sources: z.array(z.enum(["human", "pull_request", "ci", "task_platform", "context_agent", "manual", "other"])).optional(), allowed_acceptance_actors: z.array(z.string().max(200)).optional() }).strict().optional(),
};

server.registerTool("taskcenter_session_register", {
  title: "注册 TaskCenter Session",
  description: "开始任务前登记当前 Session、工作目录和任务协议。",
  inputSchema: z.object({ session_id: z.string().min(1).max(200), agent: z.enum(["codex", "claude", "workbuddy", "unknown"]).optional(), provider: z.string().max(80).optional(), model: z.string().max(120).optional(), workspace: z.string().min(1).max(4_096), project_id: z.string().max(200).optional(), event_id: z.string().max(200).optional(), rationale: z.string().max(1_000).optional(), response_mode: responseMode }).strict(),
}, async (input) => report("session.register", input));

server.registerTool("taskcenter_task_begin", {
  title: "开始 TaskCenter 任务",
  description: "一次完成 Session 登记和 v2 任务创建；同一 Session 可在上一任务关闭后继续创建下一任务。默认返回紧凑状态。",
  inputSchema: z.object({
    session_id: z.string().min(1).max(200),
    workspace: z.string().min(1).max(4_096),
    event_id: z.string().min(1).max(180),
    task_id: z.string().max(200).optional(),
    title: z.string().min(1).max(200),
    goal: z.string().min(1).max(1_000),
    scope: z.array(z.string().min(1).max(500)).min(1).max(50),
    non_goals: z.array(z.string().max(500)).max(50).default([]),
    acceptance_criteria: z.array(acceptanceCriterion).min(1).max(50),
    plan: z.array(z.string().min(1).max(500)).min(1).max(20),
    workflow_profile: z.enum(["fast", "standard", "strict"]).default("fast"),
    review_policy: z.enum(["not_required", "recommended", "required"]).default("recommended"),
    execution_environment: z.enum(["local", "worktree", "ci", "remote", "other"]).optional(),
    verification_plan: z.array(verificationRequirement).max(30).default([]),
    agent: z.enum(["codex", "claude", "workbuddy", "unknown"]).default("unknown"),
    provider: z.string().max(80).optional(),
    model: z.string().max(120).optional(),
    project_id: z.string().max(200).optional(),
  }).strict(),
}, async (input) => {
  const common = {
    session_id: input.session_id, workspace: input.workspace, agent: input.agent,
    provider: input.provider, model: input.model, project_id: input.project_id,
  };
  try {
    const registration = await requestTaskEvent("session.register", { ...common, event_id: `${input.event_id}:session` });
    if (!registration.accepted) return result(registration);
    const task = await requestTaskEvent("task.create", {
      ...common, event_id: `${input.event_id}:task`, task_id: input.task_id,
      title: input.title, goal: input.goal, scope: input.scope, non_goals: input.non_goals,
      acceptance_criteria: input.acceptance_criteria, plan: input.plan,
      contract_version: "v2", workflow_profile: input.workflow_profile,
      review_policy: input.review_policy, execution_environment: input.execution_environment,
      verification_plan: input.verification_plan,
    });
    if (!task.accepted) return result(task);
    const compact = compactResult(task);
    return result({ ...compact, next: "implement", context_ref: `task:${compact.task_id}` });
  } catch (error) {
    return result({ error: error.code || "TASKCENTER_REQUEST_FAILED", message: error.message });
  }
});

server.registerTool("taskcenter_task_create", {
  title: "创建 TaskCenter 任务",
  description: "在修改代码前创建正式任务。新客户端应使用 contract_version=v2 并填写 scope、non_goals、workflow_profile；standard/strict 还必须提供 verification_plan。旧调用保持 legacy 兼容。",
  inputSchema: z.object({ ...taskFields, title: z.string().min(1).max(200), goal: z.string().min(1).max(1_000), acceptance_criteria: z.array(acceptanceCriterion).min(1).max(50), plan: z.array(z.string().min(1).max(500)).min(1).max(20) }).strict(),
}, async (input) => report("task.create", input));

server.registerTool("taskcenter_task_update", {
  title: "更新 TaskCenter 任务",
  description: "更新当前步骤、下一步、假设、风险、取舍和阻塞信息。",
  inputSchema: z.object(taskFields).extend({ task_id: z.string().min(1).max(200) }).strict(),
}, async (input) => report("task.update", input));

server.registerTool("taskcenter_task_report", {
  title: "上报 TaskCenter 任务结果",
  description: "上报任务过程结果、变更文件、测试、证据和复盘；v2 正式完成必须使用 taskcenter_task_close。",
  inputSchema: z.object(taskFields).extend({ task_id: z.string().min(1).max(200), status: z.enum(["in_progress", "blocked", "done_claimed"]).optional() }).strict(),
}, async (input) => reportTaskProgress(input));

server.registerTool("taskcenter_task_close", {
  title: "原子关闭 TaskCenter 任务",
  description: "一次提交最终报告、验收条件结果与验证证据，并返回完成就绪度；同一 event_id 重试不会产生重复记录。completion_claim_allowed=false 时只能报告执行已声明完成，不得向用户宣称任务真正完成。",
  inputSchema: z.object(taskFields).extend({
    task_id: z.string().min(1).max(200),
    tests: z.array(z.string().min(1).max(500)).min(1).max(30),
    evidence: z.array(z.string().min(1).max(1_000)).min(1).max(30),
    continuation: z.object({ new_independent_goal: z.boolean().optional(), context_large: z.boolean().optional(), expected_more_rounds: z.boolean().optional() }).strict().optional(),
    close_requirements: z.array(z.object({
      requirement_id: z.string().min(1).max(120), status: z.enum(["pending", "passed", "failed", "not_applicable"]),
      evidence_refs: z.array(z.string().min(1).max(500)).max(30).default([]), checked_at: z.string().datetime({ offset: true }).optional(),
      checked_by: z.union([actorIdentity, z.string().max(200)]).optional(), subject_ref: subjectReference.optional(), revision: z.string().max(200).optional(), note: z.string().max(1_000).optional(),
    }).strict()).max(50).default([]),
    close_verifications: z.array(z.object({
      id: z.string().min(1).max(120), requirement_id: z.string().max(120).optional(), kind: verificationKind,
      command_or_probe: z.string().max(1_000).optional(), status: z.enum(["passed", "failed", "skipped"]), exit_code: z.number().int().optional(),
      revision: z.string().max(200).optional(), subject_ref: subjectReference.optional(), observed_at: z.string().datetime({ offset: true }),
      producer: z.union([actorIdentity, z.string().min(1).max(200)]), producer_session_id: z.string().max(200).optional(),
      evidence_ref: z.string().max(500).optional(), artifact_refs: z.array(z.string().max(500)).max(30).optional(), summary: z.string().max(1_000).optional(),
    }).strict()).max(30).default([]),
  }).strict(),
}, async ({ continuation, ...input }) => report("task.close", { ...input, status: "done_claimed" }, recommendTaskClose(continuation)));

server.registerTool("taskcenter_task_requirement_report", {
  title: "上报 TaskCenter 验收条件结果",
  description: "追加一条验收条件结果；passed/failed 必须引用证据，not_applicable 必须说明原因。",
  inputSchema: z.object({
    session_id: z.string().min(1).max(200).optional(), task_id: z.string().min(1).max(200), event_id: z.string().max(200).optional(),
    requirement_id: z.string().min(1).max(120), status: z.enum(["pending", "passed", "failed", "not_applicable"]),
    evidence_refs: z.array(z.string().min(1).max(500)).max(30).default([]), checked_at: z.string().datetime({ offset: true }).optional(), response_mode: responseMode,
    checked_by: z.union([actorIdentity, z.string().max(200)]).optional(), subject_ref: subjectReference.optional(), revision: z.string().max(200).optional(), note: z.string().max(1_000).optional(), occurred_at: z.string().datetime({ offset: true }).optional(),
  }).strict(),
}, async ({ session_id, task_id, event_id, response_mode, ...requirement_result }) => report("requirement.reported", { session_id, task_id, event_id, response_mode, requirement_result }));

server.registerTool("taskcenter_task_verification_report", {
  title: "上报 TaskCenter 验证证据",
  description: "追加 Verification Claim；TaskCenter 保存证据并计算新鲜度，但不会执行命令。",
  inputSchema: z.object({
    session_id: z.string().min(1).max(200).optional(), task_id: z.string().min(1).max(200), event_id: z.string().max(200).optional(),
    id: z.string().min(1).max(120), requirement_id: z.string().max(120).optional(), kind: verificationKind,
    command_or_probe: z.string().max(1_000).optional(), status: z.enum(["passed", "failed", "skipped"]), exit_code: z.number().int().optional(),
    revision: z.string().max(200).optional(), subject_ref: subjectReference.optional(), observed_at: z.string().datetime({ offset: true }), producer: z.union([actorIdentity, z.string().min(1).max(200)]),
    producer_session_id: z.string().max(200).optional(), evidence_ref: z.string().max(500).optional(),
    artifact_refs: z.array(z.string().max(500)).max(30).optional(), summary: z.string().max(1_000).optional(), response_mode: responseMode,
  }).strict(),
}, async ({ session_id, task_id, event_id, response_mode, ...verification_claim }) => report("verification.reported", { session_id, task_id, event_id, response_mode, revision: verification_claim.revision, verification_claim }));

server.registerTool("taskcenter_task_review_report", {
  title: "上报 TaskCenter 独立审查",
  description: "追加 Review Attestation；同一 reviewer 先给出规格符合性、再给出代码质量结论，总体 verdict 必须与两个分项及未决项一致。是否要求 reviewer 与实现者独立由版本化 Workspace Policy 决定。",
  inputSchema: z.object({
    session_id: z.string().min(1).max(200).optional(), task_id: z.string().min(1).max(200), event_id: z.string().max(200).optional(),
    id: z.string().min(1).max(120), reviewer: z.union([actorIdentity, z.string().min(1).max(200)]), reviewer_session_id: z.string().max(200).optional(),
    revision: z.string().max(200).optional(), subject_ref: subjectReference.optional(), scope: z.string().min(1).max(1_000), review_contract_version: z.enum(["v2", "v3"]).default("v2"),
    spec_verdict: z.enum(["compliant", "issues_found", "not_evaluated"]), quality_verdict: z.enum(["approved", "needs_fixes", "not_evaluated"]), verdict: z.enum(["approved", "changes_requested", "rejected"]),
    unverified_requirements: z.array(unverifiedRequirement).max(50).default([]),
    unresolved_findings: z.number().int().min(0), observed_at: z.string().datetime({ offset: true }), authorization_id: z.string().max(200).optional(),
    finding_refs: z.array(z.string().max(500)).max(50).optional(), summary: z.string().max(1_000).optional(), response_mode: responseMode,
    cycle_id: z.string().max(120).optional(), cycle_number: z.number().int().positive().optional(), review_scope: z.enum(["full", "incremental"]).optional(),
    base_attestation_id: z.string().max(120).optional(), reviewed_files: z.array(z.string().max(500)).max(500).optional(),
    changed_files_since_previous_review: z.array(z.string().max(500)).max(500).optional(), findings: z.array(reviewFinding).max(500).optional(),
    route_id: z.string().max(200).optional(), review_artifacts: routingReviewArtifacts.optional(),
  }).strict(),
}, async ({ session_id, task_id, event_id, response_mode, ...review_attestation }, extra) => {
  if (review_attestation.route_id) {
    const context = resolveTrustedMcpSession(extra);
    if (!context.sessionId) return result({ ...context, code: "SESSION_NOT_REGISTERED" });
    return postLocal("/task-events", { type: "review.reported", session_id: context.sessionId, task_id, event_id, response_mode, revision: review_attestation.revision, review_attestation });
  }
  return report("review.reported", { session_id, task_id, event_id, response_mode, revision: review_attestation.revision, review_attestation });
});

server.registerTool("taskcenter_review_cycle_report", {
  title: "上报 TaskCenter Review Cycle",
  description: "按 cycle_id 增量记录 Review 阶段、墙钟时间与调用方提供的 active time；仅用于流程诊断，不替 reviewer 作技术判断。",
  inputSchema: z.object({ session_id: z.string().min(1).max(200).optional(), task_id: z.string().min(1).max(200), event_id: z.string().max(200).optional(), response_mode: responseMode, ...reviewCycleFields }).strict(),
}, async ({ session_id, task_id, event_id, response_mode, occurred_at, ...review_cycle }) => report("review_cycle.reported", { session_id, task_id, event_id, response_mode, occurred_at, review_cycle }));

server.registerTool("taskcenter_task_phase_report", {
  title: "上报 TaskCenter 任务阶段事件",
  description: "追加可审计的阶段边界事件并返回更新后的任务；仅用于流程归因，不参与绩效、任务门禁或验收。跨 Session 续接需提供稳定 activity_id，delegated_executor 与 Review Cycle 必须引用已有授权记录。",
  inputSchema: z.object({
    task_id: z.string().min(1).max(200),
    session_id: z.string().min(1).max(200),
    event_id: z.string().min(1).max(200),
    phase: z.enum(["planning", "implementing", "verifying", "reviewing", "reworking", "waiting_external"]),
    transition: z.enum(["started", "paused", "resumed", "finished"]),
    occurred_at: z.string().datetime({ offset: true }),
    subject_ref: subjectReference,
    reason: z.string().min(1).max(1_000),
    activity_source: z.enum(["agent", "delegated_executor", "review_cycle", "build_wait", "external_wait", "other"]),
    activity_id: z.string().min(1).max(200).optional(),
    delegation_id: z.string().min(1).max(200).optional(),
    review_cycle_id: z.string().min(1).max(120).optional(),
    response_mode: responseMode,
  }).strict(),
}, async (input) => report("phase.reported", input));

server.registerTool("taskcenter_task_diagnostic_report", {
  title: "上报 TaskCenter 调试案例观察",
  description: "追加观察性 Diagnostic Observation，用于复盘根因定位过程；不参与绩效、门禁或任务验收。",
  inputSchema: z.object({
    session_id: z.string().min(1).max(200).optional(), task_id: z.string().min(1).max(200), event_id: z.string().max(200).optional(),
    case_id: z.string().min(1).max(120), observed_at: z.string().datetime({ offset: true }), started_at: z.string().datetime({ offset: true }), root_cause_at: z.string().datetime({ offset: true }).optional(),
    outcome: z.enum(["resolved", "unresolved"]), hypothesis_count: z.number().int().min(0), failed_fix_count: z.number().int().min(0), rollback_count: z.number().int().min(0),
    fresh_verification: z.enum(["passed", "failed", "not_run"]), evidence_refs: z.array(z.string().max(500)).max(30).default([]), note: z.string().max(1_000).optional(), response_mode: responseMode,
  }).strict(),
}, async ({ session_id, task_id, event_id, response_mode, ...diagnostic_observation }) => report("diagnostic.reported", { session_id, task_id, event_id, response_mode, diagnostic_observation }));

server.registerTool("taskcenter_task_completion_readiness", {
  title: "查询 TaskCenter 完成就绪度",
  description: "返回任务是否 ready、completionClaim.allowed，以及缺失、失败或过期的证据；allowed=false 时不得宣称任务真正完成。",
  inputSchema: z.object({ task_id: z.string().min(1).max(200), revision: z.string().max(200).optional() }).strict(),
}, async ({ task_id, revision }) => queryEndpoint(`/tasks/${encodeURIComponent(task_id)}/completion-readiness${revision ? `?revision=${encodeURIComponent(revision)}` : ""}`));

server.registerTool("taskcenter_task_completion_packet", {
  title: "获取 TaskCenter Completion Packet",
  description: "汇总任务契约、验收结果、验证证据、独立审查与完成就绪度，供可信 Context 完成流程使用。",
  inputSchema: z.object({ task_id: z.string().min(1).max(200) }).strict(),
}, async ({ task_id }) => queryEndpoint(`/tasks/${encodeURIComponent(task_id)}/completion-packet`));

server.registerTool("taskcenter_task_subject_update", {
  title: "更新 TaskCenter 工作对象",
  description: "把任务当前工作对象更新为通用 SubjectReference；新对象会使旧验证、审查和验收自动过期。",
  inputSchema: z.object({ task_id: z.string().min(1).max(200), session_id: z.string().min(1).max(200).optional(), event_id: z.string().max(200).optional(), subject_ref: subjectReference, actor: actorIdentity.optional(), occurred_at: z.string().datetime({ offset: true }).optional(), response_mode: responseMode }).strict(),
}, async (input) => report("subject.updated", input));

server.registerTool("taskcenter_task_export", {
  title: "导出 TaskCenter 完成包",
  description: "以 JSON 或可读 Markdown 导出任务契约、证据、审查、验收和就绪度。",
  inputSchema: z.object({ task_id: z.string().min(1).max(200), format: z.enum(["json", "markdown"]).default("json") }).strict(),
}, async ({ task_id, format }) => format === "markdown" ? queryText(`/tasks/${encodeURIComponent(task_id)}/export?format=markdown`) : queryEndpoint(`/tasks/${encodeURIComponent(task_id)}/export?format=json`));

server.registerTool("taskcenter_task_import_evidence", {
  title: "导入 TaskCenter 外部证据",
  description: "导入 PR、CI、人工或其他平台产生的 Subject、Requirement、Verification、Review 事件；保留 occurred_at 与 recorded_at。",
  inputSchema: z.object({ task_id: z.string().min(1).max(200), events: z.array(z.record(z.string(), z.unknown())).min(1).max(100), response_mode: responseMode }).strict(),
}, async (input) => postCore("/tasks/import-evidence", input));

server.registerTool("taskcenter_task_acceptance_report", {
  title: "独立上报 TaskCenter 验收",
  description: "供已配置独立验收凭据的人工、CI、PR 或任务平台适配器上报 AcceptanceRecord；普通执行 Agent 不应配置该凭据。",
  inputSchema: z.object({ task_id: z.string().min(1).max(200), event_id: z.string().max(200).optional(), outcome: z.enum(["accepted", "rejected"]), occurred_at: z.string().datetime({ offset: true }).optional(), acceptance_record: z.object({ id: z.string().min(1).max(120), source: z.enum(["human", "pull_request", "ci", "task_platform", "context_agent", "manual", "other"]), actor: actorIdentity, subject_ref: subjectReference.optional(), observed_at: z.string().datetime({ offset: true }), authorization_id: z.string().max(200).optional(), evidence_refs: z.array(z.string().max(500)).max(30).optional(), reason: z.string().max(1_000).optional() }).strict(), response_mode: responseMode }).strict(),
}, async (input) => postAcceptance(input));

server.registerTool("taskcenter_routing_record", {
  title: "记录 TaskCenter 模型路由",
  description: "记录直接执行、原生派发、CLI 兜底或有理由偏离的模型路由决定。该记录仅用于审计，不改变任务状态，也不作为执行门禁。",
  inputSchema: z.object({
    session_id: z.string().min(1).max(200),
    task_id: z.string().min(1).max(200),
    event_id: z.string().max(200).optional(),
    routing_action: z.enum(["direct_execute", "delegate_native", "fallback_cli", "reasoned_override"]),
    orchestrator_model: z.string().min(1).max(120),
    preferred_executor_model: z.string().min(1).max(120),
    selected_executor_model: z.string().min(1).max(120),
    task_class: z.enum(["general", "search", "mechanical", "implementation", "test", "documentation", "architecture", "security", "migration", "data_migration", "complex_diagnosis", "high_risk", "ocr", "ocr_review", "independent_review"]).default("general"),
    dispatch_channel: z.enum(["direct", "native", "cli", "other"]),
    routing_reason: z.string().min(1).max(1_000),
    fallback_from: z.string().max(120).optional(),
    fallback_reason: z.string().max(200).optional(),
    retry_after_at: z.string().datetime({ offset: true }).optional(),
    review_artifacts: routingReviewArtifacts.optional(),
    routing_outcome: z.enum(["selected", "started", "succeeded", "failed"]).optional(),
    policy_version: z.string().min(1).max(80).optional(), response_mode: responseMode,
  }).strict(),
}, async (input) => report("routing.decision", input));

server.registerTool("taskcenter_routing_select", {
  title: "选择 TaskCenter 执行模型",
  description: "按集中模型角色配置原子检查熔断、并发和 Half-Open 探测租约，返回强建议路由；TaskCenter 不会启动执行器。普通执行使用 executor 角色，OCR 使用 fail-closed reviewer 角色并保留同一 Subject、Bundle 和规则证据。",
  inputSchema: z.object({
    task_id: z.string().min(1).max(200),
    preferred_model: z.string().min(1).max(120).optional().describe("兼容单次执行覆盖；任务配置 quota_preferred 时由持久化策略接管"),
    task_class: z.enum(["general", "search", "mechanical", "implementation", "test", "documentation", "architecture", "security", "migration", "data_migration", "complex_diagnosis", "high_risk", "ocr", "ocr_review", "independent_review"]),
    channel: z.enum(["direct", "native", "cli", "other"]),
    event_id: z.string().max(200).optional(),
    route_id: z.string().max(200).optional(),
    review_artifacts: routingReviewArtifacts.optional().describe("OCR 路由必填；Subject、OCR Bundle 与规则各提供 ref 或 fingerprint"),
    lease_ttl_ms: z.number().int().min(60_000).max(28_800_000).optional(), response_mode: operationalResponseMode,
  }).strict(),
}, async (input, extra) => {
  if (!["ocr", "ocr_review", "independent_review"].includes(input.task_class)) return postLocal("/routing/select", input);
  const context = resolveTrustedMcpSession(extra);
  return context.sessionId ? postLocal("/routing/select", { ...input, session_id: context.sessionId }) : result({ ...context, code: "SESSION_NOT_REGISTERED" });
});

server.registerTool("taskcenter_routing_result", {
  title: "上报 TaskCenter 路由结果",
  description: "释放模型并发租约并更新 Closed/Open/Half-Open 健康状态；只记录执行事实，不授予任务验收或 OCR 审查权。",
  inputSchema: z.object({
    route_id: z.string().min(1).max(200),
    outcome: z.enum(["succeeded", "failed", "cancelled", "unavailable", "overloaded"]),
    http_status: z.number().int().min(0).max(599).optional(),
    error_type: z.string().max(120).optional(),
    error_code: z.string().max(160).optional(),
    request_id: z.string().max(300).optional(),
    quota_limit_id: z.string().max(120).optional(),
    quota_retry_after_at: z.string().datetime({ offset: true }).optional(),
    event_id: z.string().max(200).optional(), response_mode: operationalResponseMode,
  }).strict(),
}, async (input, extra) => {
  const context = resolveTrustedMcpSession(extra);
  return postLocal("/routing/result", { ...input, ...(context.sessionId ? { session_id: context.sessionId } : {}) });
});

server.registerTool("taskcenter_review_start", {
  description: "统一只读 Reviewer 入口：由宿主绑定真实身份与路由，登记、领取并准备报告周期；无需填写 Session UUID。",
  inputSchema: z.object({}).strict(),
}, async (_input, extra) => {
  const identity = resolveTrustedMcpSession(extra);
  if (!identity.sessionId) return result(identity);
  try {
    if (!process.env.TASKCENTER_MANAGED_REVIEW) throw new Error("REVIEW_LAUNCHER_REQUIRED");
    const launch = JSON.parse(process.env.TASKCENTER_MANAGED_REVIEW);
    const response = await fetch(`${controlServerUrl}/reviews/start`, { method: "POST", headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "mcp", "X-TaskCenter-MCP-Token": readLocalMcpToken() }, body: JSON.stringify({ ...launch, session_id: identity.sessionId }) });
    const payload = await readJson(response);
    managedReviewContext = payload.context;
    return result(payload);
  } catch (error) { return result({ error: "REVIEW_START_FAILED", message: error.message }); }
});

server.registerTool("taskcenter_review_finish", {
  description: "提交实际逐文件覆盖与规格/质量结论；程序绑定身份、Subject、OCR证据及cycle，成功落账后释放租约。未覆盖全部文件不能批准。",
  inputSchema: z.object({
    reviewed_files: z.array(z.string().min(1)).max(500), findings: z.array(reviewFinding).max(500),
    spec_verdict: z.enum(["compliant", "issues_found", "not_evaluated"]), quality_verdict: z.enum(["approved", "needs_fixes", "not_evaluated"]), verdict: z.enum(["approved", "changes_requested", "rejected"]),
    unverified_requirements: z.array(unverifiedRequirement).max(50).default([]), summary: z.string().min(1).max(1000),
  }).strict(),
}, async (input, extra) => {
  const identity = resolveTrustedMcpSession(extra);
  try {
    if (!managedReviewContext || identity.sessionId !== managedReviewContext.reviewer.session_id) throw new Error("REVIEW_START_REQUIRED");
    const review = buildManagedReviewReport(managedReviewContext, input);
    const headers = { "Content-Type": "application/json", "X-TaskCenter-Task": "mcp", "X-TaskCenter-MCP-Token": readLocalMcpToken() };
    const report = await readJson(await fetch(`${controlServerUrl}/task-events`, { method: "POST", headers, body: JSON.stringify({ type: "review.reported", task_id: managedReviewContext.task_id, session_id: identity.sessionId, event_id: review.id, review_attestation: review }) }));
    if (report.accepted !== true) throw new Error("REVIEW_REPORT_NOT_ACCEPTED");
    const release = await readJson(await fetch(`${controlServerUrl}/routing/result`, { method: "POST", headers, body: JSON.stringify({ route_id: managedReviewContext.route_id, session_id: identity.sessionId, outcome: "succeeded" }) }));
    return result({ accepted: report.accepted, attestation_id: review.id, verdict: review.verdict, covered_files: input.reviewed_files.length, lease_released: release.accepted });
  } catch (error) { return result({ error: "REVIEW_FINISH_FAILED", message: error.message }); }
});

server.registerTool("taskcenter_review_claim", {
  title: "领取独立只读 Review",
  description: "已登记的独立 Reviewer 领取已有业务任务的 Review lease，不创建 Task。执行宿主必须使用 read-only 沙箱。",
  inputSchema: z.object({ route_id: z.string().min(1), claim_token: z.string().min(1), sandbox: z.literal("read-only"), response_mode: operationalResponseMode }).strict(),
}, async (input, extra) => {
  const context = resolveTrustedMcpSession(extra);
  return context.sessionId ? postLocal("/reviews/claim", { ...input, session_id: context.sessionId }) : result({ ...context, code: "SESSION_NOT_REGISTERED" });
});

server.registerTool("taskcenter_delegation_grant", {
  title: "创建 CLI Delegation",
  description: "由主任务 Session 创建一次受 TTL、workspace 和 scope 限制的 CLI 执行授权；普通 CLI Run 不需要另建正式任务。",
  inputSchema: z.object({
    parent_session_id: z.string().min(1).max(200), task_id: z.string().min(1).max(200), event_id: z.string().max(200).optional(), delegation_id: z.string().max(200).optional(),
    workspace: z.string().min(1).max(4_096), scope: z.array(z.string().min(1).max(500)).min(1).max(50), allowed_tools: z.array(z.string().min(1).max(120)).max(40).optional(),
    executor_model: z.string().min(1).max(120), channel: z.enum(["cli", "native", "other"]).default("cli"), purpose: z.string().max(1_000).optional(), ttl_seconds: z.number().int().min(60).max(28_800).default(3_600), response_mode: operationalResponseMode,
  }).strict(),
}, async (input) => postLocal("/delegations/grant", input));

server.registerTool("taskcenter_delegation_claim", {
  title: "领取 CLI Delegation",
  description: "CLI 使用自身已登记 Session 和一次性 claim token 附着主任务，不创建正式子任务。",
  inputSchema: z.object({ delegation_id: z.string().min(1).max(200), claim_token: z.string().min(1).max(200), session_id: z.string().min(1).max(200), workspace: z.string().min(1).max(4_096), event_id: z.string().max(200).optional(), response_mode: operationalResponseMode }).strict(),
}, async (input) => postLocal("/delegations/claim", input));

server.registerTool("taskcenter_cli_run_report", {
  title: "上报 CLI Run",
  description: "上报附着主任务的 CLI 执行状态和证据；不会改变主任务状态或形成独立验收。",
  inputSchema: z.object({
    delegation_id: z.string().min(1).max(200), session_id: z.string().min(1).max(200), workspace: z.string().min(1).max(4_096), event_id: z.string().max(200).optional(),
    status: z.enum(["started", "running", "succeeded", "failed", "cancelled"]), summary: z.string().max(1_000).optional(), changed_files: z.array(z.string().max(500)).max(100).optional(),
    tests: z.array(z.string().max(500)).max(50).optional(), evidence: z.array(z.string().max(1_000)).max(50).optional(), error: z.string().max(1_000).optional(), response_mode: operationalResponseMode,
  }).strict(),
}, async (input) => postLocal("/delegations/report", input));

server.registerTool("taskcenter_delegation_revoke", {
  title: "撤销 CLI Delegation",
  description: "由主任务 Session 撤销尚未结束的 CLI delegation。",
  inputSchema: z.object({ delegation_id: z.string().min(1).max(200), parent_session_id: z.string().min(1).max(200), event_id: z.string().max(200).optional(), response_mode: operationalResponseMode }).strict(),
}, async (input) => postLocal("/delegations/revoke", input));

server.registerTool("taskcenter_task_query", {
  title: "查询 TaskCenter 任务",
  description: "查询任务账本；Codex 适配器可按 Session 过滤，通用客户端可省略 Session。",
  inputSchema: z.object({ session_id: z.string().min(1).max(200).optional(), task_id: z.string().max(200).optional() }).strict(),
}, async ({ session_id, task_id }) => {
  let response;
  try {
    response = await fetch(`${controlServerUrl}/tasks`);
  } catch (e) {
    return result({ error: "TASKCENTER_UNAVAILABLE", message: `TaskCenter 控制服务不可用（${controlServerUrl}）。请先运行 npm run dev:live 启动 TaskCenter。`, detail: e.message });
  }
  const payload = await readJson(response);
  const tasks = (payload.tasks || []).filter((task) => (!session_id || task.sessionId === session_id) && (!task_id || task.id === task_id));
  return result({ tasks });
});

server.registerTool("taskcenter_task_reuse_check", {
  title: "检查 TaskCenter 活跃任务复用候选",
  description: "在创建正式任务前只读查询同一业务目标的活跃候选，返回可解释的 reuse/create_new/uncertain 建议；不会创建、合并、阻断或修改任务。",
  inputSchema: z.object({
    workspace: z.string().min(1).max(4_096),
    project_id: z.string().min(1).max(200),
    session_id: z.string().min(1).max(200),
    context_task_id: z.string().max(200).optional(),
    title: z.string().min(1).max(200),
    goal: z.string().min(1).max(1_000),
    scope: z.array(z.string().min(1).max(500)).max(50),
    response_mode: operationalResponseMode,
  }).strict(),
}, async (input) => postCore("/task-reuse/check", input));

server.registerTool("taskcenter_task_reuse_decision_report", {
  title: "记录 TaskCenter 任务复用最终选择",
  description: "把 Advisor 建议、最终选择和 force_new_reason 写入独立 append-only 审计账本；不会修改任何任务状态或合同。",
  inputSchema: z.object({
    event_id: z.string().min(1).max(200),
    check_id: z.string().min(1).max(200),
    session_id: z.string().min(1).max(200),
    workspace: z.string().min(1).max(4_096),
    project_id: z.string().min(1).max(200),
    context_task_id: z.string().max(200).optional(),
    title: z.string().max(200).optional(),
    advisor_version: z.string().max(80).optional(),
    recommendation: taskReuseDecision,
    confidence: z.number().min(0).max(1),
    candidate_task_ids: z.array(z.string().min(1).max(200)).max(50),
    match_reasons: z.array(z.string().min(1).max(120)).max(50),
    final_decision: taskReuseDecision,
    selected_task_id: z.string().min(1).max(200).optional(),
    force_new_reason: z.string().min(1).max(1_000).optional(),
    occurred_at: z.string().datetime({ offset: true }),
    response_mode: operationalResponseMode,
  }).strict(),
}, async (input) => postCore("/task-reuse/decisions", input));

server.registerTool("taskcenter_task_reuse_decision_query", {
  title: "查询 TaskCenter 任务复用决策审计",
  description: "只读查询独立的任务复用决策记录，用于 advisory 试点评估。",
  inputSchema: z.object({
    workspace: z.string().max(4_096).optional(),
    project_id: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }).strict(),
}, async ({ workspace, project_id, limit }) => {
  const params = new URLSearchParams();
  if (workspace) params.set("workspace", workspace);
  if (project_id) params.set("project_id", project_id);
  if (limit) params.set("limit", String(limit));
  return queryLocalEndpoint(`/task-reuse/decisions${params.size ? `?${params}` : ""}`);
});

server.registerTool("taskcenter_usage_report", {
  title: "查询 TaskCenter 用量报告",
  description: "读取有界用量摘要；支持 project(路径或项目 ID)、session、task、window 组合过滤。默认 summary_only=true、top_n=10、4KB 上限；fields 选择顶层字段，超限按 cursor 显式续读。",
  inputSchema: z.object({
    project: z.string().max(4096).optional(), session: z.string().max(200).optional(), task: z.string().max(200).optional(),
    window: z.enum(["5h", "24h", "7d", "lifetime"]).optional(), fields: z.array(z.string().max(100)).max(20).optional(),
    top_n: z.number().int().min(1).max(100).optional(), summary_only: z.boolean().optional(), cursor: z.string().max(200).optional(),
  }).strict(),
}, async (input) => queryEndpoint(`/usage-report?${new URLSearchParams(Object.entries(input).map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : String(value)]))}`));

server.registerTool("taskcenter_response_continue", {
  title: "显式续读有界响应",
  description: "读取 MCP 响应 continuation_cursor 的下一片 JSON 文本；usage_report 的 cursor 应通过 usage_report 续读。游标五分钟过期。",
  inputSchema: z.object({ cursor: z.string().min(1).max(200) }).strict(),
}, async ({ cursor }) => {
  const page = boundedResponse(null, { cursor });
  return page.error === "CURSOR_EXPIRED" ? queryEndpoint(`/response-continue?cursor=${encodeURIComponent(cursor)}`) : result(page);
});

server.registerTool("taskcenter_task_prepare", {
  title: "准备或恢复当前目标",
  description: "一次返回当前合同、Session/task 绑定、实时请求预算、压缩次数、handoff 和允许操作；不创建新目标。",
  inputSchema: z.object({ session_id: z.string().min(1).max(200) }).strict(),
}, async ({ session_id }) => queryEndpoint(`/task-prepare?session_id=${encodeURIComponent(session_id)}`));

for (const operation of ["prepare", "confirm"]) {
  server.registerTool(`taskcenter_session_switch_${operation}`, {
    description: operation === "prepare"
      ? "关闭且证据闭环、Git 干净后持久化完整恢复检查点并读回校验；准备不执行压缩或授权重绑。"
      : "由已配置的本机 App Server 适配器异步执行恢复预检、真实压缩和压缩后恢复。pending 不授权重绑；结束当前 Turn 后宿主才执行，后续调用可查询结果。无宿主或恢复失败则拒绝。",
    inputSchema: operation === "prepare"
      ? z.object({ task_id: z.string().min(1).max(200), next_task_id: z.string().min(1).max(200), next_goal: z.string().trim().min(1).max(1000), event_id: z.string().min(1).max(200) }).strict()
      : z.object({ switch_id: z.string().uuid() }).strict(),
  }, async (input, extra) => {
    const context = resolveTrustedMcpSession(extra);
    if (context.error) return result(context);
    return postLocal(`/session-switch/${operation}`, { ...input, session_id: context.sessionId, response_mode: "full" });
  });
}

server.registerTool("taskcenter_task_resume", {
  title: "接续原任务",
  description: "同一交付提交后继续合并或验证时复用原 task_id，无时间限制。校验原绑定、workspace 与单活跃任务约束；支持当前或新 Session，将 done_claimed/verified 恢复为 in_progress，保留合同与原 Subject 证据。取消任务不自动重新激活；不启动执行器或执行 Git 合并。返回 prepare 结果。",
  inputSchema: z.object({ session_id: z.string().min(1).max(200), task_id: z.string().min(1).max(200), expected_session_id: z.string().min(1).max(200), event_id: z.string().max(200).optional() }).strict(),
}, async (input) => postCore("/task-resume", { ...input, response_mode: "full" }));

server.registerTool("taskcenter_session_lifecycle", {
  title: "查询 Codex Session 生命周期建议",
  description: "返回继续、建议换 Session 或要求先交接；建议不会强行中断，且新建 Codex Session 不等于新建 TaskCenter task。",
  inputSchema: z.object({ session_id: z.string().min(1).max(200).optional() }).strict(),
}, async ({ session_id }) => queryEndpoint(`/session-lifecycle${session_id ? `?session_id=${encodeURIComponent(session_id)}` : ""}`));

server.registerTool("taskcenter_governance_metrics", {
  title: "查询 TaskCenter 治理试点指标",
  description: "返回 Credits 等价值、续调、输入分位数、归属覆盖率、往返、返工率、耗时和观察性调试指标，并按 profile、任务类别与模型分组。指标不用于绩效或门禁。",
  inputSchema: z.object({}).strict(),
}, async () => queryEndpoint("/governance-metrics"));

server.registerTool("taskcenter_session_status", {
  title: "查询 TaskCenter Session 状态",
  description: "查询当前 Session 是否已登记、执行器身份和任务数量。",
  inputSchema: z.object({ session_id: z.string().min(1).max(200) }).strict(),
}, async ({ session_id }) => {
  try {
    const response = await fetch(`${controlServerUrl}/session-status`);
    const payload = await readJson(response);
    return result({ sessions: (payload.sessions || []).filter((session) => session.sessionId === session_id) });
  } catch (e) {
    return result({ error: "TASKCENTER_UNAVAILABLE", message: `TaskCenter 控制服务不可用（${controlServerUrl}）。请先运行 npm run dev:live 启动 TaskCenter。`, detail: e.message });
  }
});

server.registerTool("taskcenter_bug_dispatch_host", {
  title: "领取可见 Bug 派发并上报真实宿主回执",
  description: "事件驱动宿主协议。snapshot 读取队列；claim 原子占用两路之一，resumed=true 时不得重复创建；receipt 必须基于真实桌面工具与已登记独立 worktree。控制回执 sent 仅表示发送，不能证明停止。merge_lease 仅串行化外部合入，不授权或执行合并。身份取当前运行时 Session。",
  inputSchema: z.object({
    operation: z.enum(["snapshot", "claim", "receipt", "control_receipt", "merge_lease"]),
    id: z.string().uuid().optional(), eventId: z.string().min(1).max(160).optional(),
    claimToken: z.string().uuid().optional(), clientThreadId: z.string().min(1).max(200).optional(), threadId: z.string().uuid().optional(), projectId: z.string().min(1).max(300).optional(), visible: z.boolean().optional(),
    status: z.enum(["creating", "running", "blocked", "unknown", "awaiting_acceptance", "done_claimed"]).optional(),
    evidence: z.string().min(1).max(2000).optional(), outcome: z.enum(["sent", "unavailable"]).optional(), release: z.boolean().optional(),
  }).strict(),
}, async (input, extra) => {
  const context = resolveTrustedMcpSession(extra);
  return context.sessionId ? postLocal("/bug-dispatches/host", { ...input, session_id: context.sessionId, response_mode: "full" }) : result(context);
});

server.registerTool("taskcenter_session_gate_exemption_status", {
  title: "查询当前 Session 门禁豁免",
  description: "查询运行时绑定的当前 Codex Session 是否免除 active task 前置条件；不接受目标 Session 参数，也不修改白名单。",
  inputSchema: z.object({}).strict(),
}, async (_input, extra) => {
  const context = resolveTrustedMcpSession(extra);
  return context.sessionId
    ? postLocal("/gate-session-exemption/status", { session_id: context.sessionId, response_mode: "full" })
    : result(context);
});

server.registerTool("taskcenter_session_gate_exemption_set", {
  title: "切换当前 Session 门禁豁免",
  description: "仅为运行时绑定的当前已登记 Codex Session 加入或退出 active task 门禁豁免；不接受目标 Session 参数，不创建任务、不批量修改，命令安全检查仍然有效。",
  inputSchema: z.object({ enabled: z.boolean() }).strict(),
}, async ({ enabled }, extra) => {
  const context = resolveTrustedMcpSession(extra);
  return context.sessionId
    ? postLocal("/gate-session-exemption/set", { session_id: context.sessionId, enabled, response_mode: "full" })
    : result(context);
});

server.registerTool("taskcenter_scheduled_readonly_scan_exemption_status", {
  title: "查询 scheduled_readonly 扫描豁免",
  description: "查询当前 scheduled_readonly Session 是否已扩大到确定性项目只读扫描。session_id 必须是当前 Hook payload 中的真实 Session，Hook 会拒绝跨 Session 调用。",
  inputSchema: z.object({ session_id: z.string().uuid() }).strict(),
}, async ({ session_id: sessionId }) => postLocal("/scheduled-readonly-scan-exemption/status", { session_id: sessionId, response_mode: "full" }));

server.registerTool("taskcenter_scheduled_readonly_scan_exemption_set", {
  title: "切换 scheduled_readonly 扫描豁免",
  description: "仅为当前 Hook payload 绑定的 scheduled_readonly Session 开启或关闭确定性项目只读扫描；Hook 会拒绝跨 Session 调用，且不授予写入、网络、脚本、管道、复合命令或跨项目能力。",
  inputSchema: z.object({ session_id: z.string().uuid(), enabled: z.boolean() }).strict(),
}, async ({ session_id: sessionId, enabled }) => postLocal("/scheduled-readonly-scan-exemption/set", { session_id: sessionId, enabled, response_mode: "full" }));

async function report(type, input, lifecycle) {
  const { response_mode: responseModeValue = "summary", ...event } = input;
  try {
    const payload = await requestTaskEvent(type, event);
    if (payload.accepted && lifecycle) payload.session_lifecycle = lifecycle;
    return writeResult(payload, responseModeValue);
  } catch (e) {
    return result({ error: e.code || "TASKCENTER_REQUEST_FAILED", message: e.message });
  }
}

async function requestTaskEvent(type, event) {
  let response;
  try {
    response = await fetch(`${controlServerUrl}${event.session_id ? "/task-events" : "/core/task-events"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "mcp" },
      body: JSON.stringify({ type, ...event }),
    });
  } catch (error) {
    const unavailable = new Error(`TaskCenter 控制服务不可用（${controlServerUrl}）。请先运行 npm run dev:live 启动 TaskCenter。${error.message ? ` ${error.message}` : ""}`);
    unavailable.code = "TASKCENTER_UNAVAILABLE";
    throw unavailable;
  }
  return readJson(response);
}

async function reportTaskProgress(input) {
  if (input.status !== "done_claimed") return report("task.report", input);
  try {
    const response = await fetch(`${controlServerUrl}/tasks`);
    const payload = await readJson(response);
    const task = (payload.tasks || []).find((item) => item.id === input.task_id);
    if (task?.contractVersion === "v2") {
      return result({
        error: "TASKCENTER_ATOMIC_CLOSE_REQUIRED",
        message: "v2 任务不能通过 taskcenter_task_report 声明完成；请调用 taskcenter_task_close 一次提交验收条件、验证证据并读取 completionReadiness。",
        task_id: task.id,
        completionReadiness: task.completionReadiness,
      });
    }
  } catch (error) {
    return result({ error: "TASKCENTER_REQUEST_FAILED", message: error.message });
  }
  return report("task.report", input);
}

async function postCore(path, input) {
  const { response_mode: responseModeValue = "summary", ...body } = input;
  try {
    const response = await fetch(`${controlServerUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "mcp" }, body: JSON.stringify(body) });
    return writeResult(await readJson(response), responseModeValue);
  } catch (e) {
    return result({ error: "TASKCENTER_REQUEST_FAILED", message: e.message });
  }
}

async function postLocal(path, input) {
  const { response_mode: responseModeValue = "summary", ...body } = input;
  try {
    const response = await fetch(`${controlServerUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "mcp", "X-TaskCenter-MCP-Token": readLocalMcpToken() }, body: JSON.stringify(body) });
    return writeResult(await readJson(response), responseModeValue);
  } catch (e) {
    return result({ error: "TASKCENTER_REQUEST_FAILED", message: e.message });
  }
}

function readLocalMcpToken() {
  try {
    return readFileSync(localMcpTokenPath, "utf8").trim();
  } catch {
    return "";
  }
}

async function postAcceptance(input) {
  const { response_mode: responseModeValue = "summary", ...body } = input;
  if (!acceptanceToken) return result({ error: "TASKCENTER_ACCEPTANCE_UNAVAILABLE", message: "当前 MCP 进程未配置独立验收凭据。" });
  try {
    const response = await fetch(`${controlServerUrl}/task-acceptance-report`, { method: "POST", headers: { "Content-Type": "application/json", "X-TaskCenter-Acceptance-Token": acceptanceToken }, body: JSON.stringify(body) });
    return writeResult(await readJson(response), responseModeValue);
  } catch (e) {
    return result({ error: "TASKCENTER_REQUEST_FAILED", message: e.message });
  }
}

function writeResult(payload, responseModeValue) {
  if (responseModeValue === "full" || payload?.error) return result(payload);
  return result(compactResult(payload));
}

function compactResult(payload) {
  const task = payload?.task || {};
  const readiness = task.completionReadiness || payload?.completionReadiness || {};
  const missing = [
    ...(readiness.missingRequirements || []),
    ...(readiness.failedRequirements || []),
    ...(readiness.staleEvidence || []),
    ...(readiness.unresolvedFindings || []),
  ];
  const compact = {
    accepted: Boolean(payload?.accepted),
    task_id: task.id || payload?.task_id || payload?.taskId || "",
    status: task.status || payload?.status || "",
    verification_status: task.verificationStatus || readiness.verificationStatus || "not_required",
    review_status: task.reviewStatus || readiness.reviewStatus || "not_required",
    missing_count: missing.length || [...new Set(readiness.reasons || [])].length,
    completion_claim_allowed: readiness.completionClaim?.allowed === true,
  };
  if (payload?.session_lifecycle) compact.session_lifecycle = payload.session_lifecycle;
  // 通知属于账本写入后的可补偿副作用；摘要回包也必须让调用方看见失败警告。
  if (Array.isArray(payload?.warnings) && payload.warnings.length) compact.warnings = payload.warnings;
  return compact;
}

async function queryEndpoint(path) {
  try {
    const response = await fetch(`${controlServerUrl}${path}`);
    return result(await readJson(response));
  } catch (e) {
    return result({ error: "TASKCENTER_REQUEST_FAILED", message: e.message });
  }
}

async function queryLocalEndpoint(path) {
  try {
    const response = await fetch(`${controlServerUrl}${path}`, {
      headers: {
        "Content-Type": "application/json",
        "X-TaskCenter-Task": "mcp",
        "X-TaskCenter-MCP-Token": readLocalMcpToken(),
      },
    });
    return result(await readJson(response));
  } catch (e) {
    return result({ error: "TASKCENTER_REQUEST_FAILED", message: e.message });
  }
}

async function queryText(path) {
  try {
    const response = await fetch(`${controlServerUrl}${path}`);
    if (!response.ok) throw new Error(`TaskCenter 请求失败（${response.status}）。`);
    const text = await response.text();
    return Buffer.byteLength(text) <= 4096 ? { content: [{ type: "text", text }] } : result({ format: "text", text });
  } catch (e) {
    return result({ error: "TASKCENTER_REQUEST_FAILED", message: e.message });
  }
}

async function readJson(response) {
  const payload = await response.json().catch(() => ({ error: "TaskCenter 返回了无效 JSON。" }));
  if (!response.ok) throw new Error(payload.error || `TaskCenter 请求失败（${response.status}）。`);
  return payload;
}

function result(payload) {
  return { content: [{ type: "text", text: JSON.stringify(boundedResponse(payload)) }] };
}

await server.connect(new StdioServerTransport());
