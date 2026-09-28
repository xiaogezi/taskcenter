import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isAutomaticEligible, loadModelRoleConfig, nativeRuntimeModel, publicModelRoleConfig } from "./model-role-config.mjs";
import { sameSubject } from "./completion-state.mjs";
import { cliProfile, cliProfileForModel } from "./cli-profile.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
export const routingControlPath = resolve(process.env.TASKCENTER_ROUTING_CONTROL_PATH || resolve(projectRoot, "data", "routing-control.json"));

const defaultFailureThreshold = integerEnv("TASKCENTER_ROUTING_FAILURE_THRESHOLD", 3, 1, 20);
const defaultCooldownMs = integerEnv("TASKCENTER_ROUTING_COOLDOWN_MS", 300_000, 1_000, 86_400_000);
const defaultLeaseTtlMs = integerEnv("TASKCENTER_ROUTING_LEASE_TTL_MS", 3_600_000, 60_000, 28_800_000);
const quotaSnapshotMaxAgeMs = integerEnv("TASKCENTER_QUOTA_SNAPSHOT_MAX_AGE_MS", 120_000, 10_000, 3_600_000);
const terminalOutcomes = new Set(["succeeded", "failed", "cancelled", "unavailable", "overloaded"]);
const circuitFailureTypes = new Set(["server_overloaded", "capacity", "model_unavailable", "rate_limit", "timeout"]);
const immediateOpenFailureTypes = new Set(["server_overloaded", "capacity", "model_unavailable", "rate_limit"]);
const ocrTaskClasses = new Set(["ocr", "ocr_review", "independent_review"]);
const knownTaskClasses = new Set(["general", "search", "mechanical", "implementation", "test", "documentation", "architecture", "security", "migration", "data_migration", "complex_diagnosis", "high_risk", ...ocrTaskClasses]);

export class RoutingControlError extends Error {
  constructor(statusCode, message, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.legacyCode = code ? "ACTIVE_FORMAL_TASK_REQUIRED" : undefined;
  }
}

export function isReviewTaskClass(value) { return ocrTaskClasses.has(value); }

// This gate is about the requested Task, never the caller's active Task.
export function validateReviewRequest(input, task, registry, canonical = (id) => id) {
  const sessionId = canonical(input.session_id || "");
  const session = registry[sessionId];
  if (!session) throw new RoutingControlError(409, "当前 Session 尚未登记。", "SESSION_NOT_REGISTERED");
  if (!task) throw new RoutingControlError(404, "审查任务不存在。", "TASK_NOT_FOUND");
  if (canonical(task.sessionId) !== sessionId) throw new RoutingControlError(403, "当前 Session 无权为该任务发起审查。", "REVIEW_PERMISSION_DENIED");
  if (!["in_progress", "done_claimed", "blocked"].includes(task.status)) throw new RoutingControlError(409, "任务状态不允许审查。", "TASK_NOT_REVIEWABLE");
  const artifacts = normalizeReviewArtifacts(input.review_artifacts, true);
  const subject = task.currentSubject;
  if (!subject?.value || subject.type === "none") throw new RoutingControlError(400, "任务缺少当前 Subject。", "REVIEW_ARTIFACTS_INCOMPLETE");
  if ((artifacts.subject.ref && artifacts.subject.ref !== subject.value) || (artifacts.subject.fingerprint && artifacts.subject.fingerprint !== subject.value)) throw new RoutingControlError(409, "审查 Subject 与当前 Subject 不一致。", "SUBJECT_MISMATCH");
  return { sessionId, subject, issuesOnly: task.status === "blocked" };
}

export function reviewTaskRecords(taskId) {
  return readState().routes.filter((route) => route.reviewRecord && (!taskId || route.reviewRecord.task_id === taskId))
    .map((route) => publicReviewRecord(route));
}

export function withReviewStatus(tasks) {
  const latest = new Map();
  const subjects = new Map(tasks.map((task) => [task.id, task.currentSubject]));
  for (const record of reviewTaskRecords()) if (sameSubject(record.subject_ref, subjects.get(record.task_id))) latest.set(record.task_id, record);
  return tasks.map((task) => {
    const record = latest.get(task.id);
    const review_status = !record ? "not_started" : ["approved", "changes_requested"].includes(record.status) ? record.status : "pending";
    return { ...task, review_status };
  });
}

function publicReviewRecord(route, now = new Date().toISOString()) {
  const record = { ...route.reviewRecord, claim_token: undefined };
  if (["pending", "running"].includes(record.status) && Date.parse(route.expiresAt) <= Date.parse(now)) {
    record.status = "failed";
    record.finished_at = route.expiresAt;
  }
  return record;
}

export function reviewSessionRecords(sessionId) {
  return readState().routes.filter((route) => route.reviewRecord?.reviewer_session_id === sessionId)
    .map((route) => publicReviewRecord(route));
}

export function claimReview(input, task, registry, canonical = (id) => id, now = new Date().toISOString()) {
  const state = readState();
  const route = state.routes.find((item) => item.id === input.route_id);
  const record = route?.reviewRecord;
  const sessionId = canonical(input.session_id || "");
  const session = registry[sessionId];
  if (!session) throw new RoutingControlError(409, "Reviewer Session 尚未登记。", "SESSION_NOT_REGISTERED");
  if (!record || route.status !== "leased" || Date.parse(route.expiresAt) <= Date.parse(now)) throw new RoutingControlError(409, "Reviewer lease 不可用。", "REVIEWER_LEASE_UNAVAILABLE");
  if (!task || task.id !== record.task_id) throw new RoutingControlError(404, "审查任务不存在。", "TASK_NOT_FOUND");
  if (!["in_progress", "done_claimed", "blocked"].includes(task.status)) throw new RoutingControlError(409, "任务不可审查。", "TASK_NOT_REVIEWABLE");
  if (!sameSubject(task.currentSubject, record.subject_ref)) throw new RoutingControlError(409, "当前 Subject 已变化。", "SUBJECT_MISMATCH");
  if (input.claim_token !== record.claim_token || (record.reviewer_session_id && record.reviewer_session_id !== sessionId)) throw new RoutingControlError(403, "Reviewer lease 领取身份不匹配。", "REVIEW_PERMISSION_DENIED");
  if (sessionId === canonical(task.sessionId) || (task.sessionHistory || []).some((id) => canonical(id) === sessionId)) throw new RoutingControlError(403, "Reviewer 必须独立于实现 Session。", "REVIEWER_NOT_INDEPENDENT");
  if (!session.workspace || resolve(session.workspace) !== resolve(task.workspace || "") || session.model !== route.selectedModel || input.sandbox !== "read-only") throw new RoutingControlError(403, "Reviewer 工作区、模型或只读沙箱不匹配。", "REVIEW_PERMISSION_DENIED");
  if (!["pending", "running"].includes(record.status)) throw new RoutingControlError(409, "Review 已结束。", "REVIEWER_LEASE_UNAVAILABLE");
  record.reviewer_session_id = sessionId;
  record.status = "running";
  record.started_at ||= now;
  persistState(state, now);
  return { ...record, claim_token: undefined };
}

export function reportReview(input, task, commit, canonical = (id) => id, now = new Date().toISOString()) {
  const state = readState();
  const route = state.routes.find((item) => item.id === input.review_attestation?.route_id);
  const record = route?.reviewRecord;
  const review = input.review_attestation;
  if (!record || !record.reviewer_session_id || record.reviewer_session_id !== canonical(input.session_id || "")) throw new RoutingControlError(403, "未领取独立 Reviewer lease。", "REVIEW_PERMISSION_DENIED");
  if (!task || task.id !== record.task_id || input.task_id !== record.task_id) throw new RoutingControlError(404, "审查任务不存在。", "TASK_NOT_FOUND");
  if (!["in_progress", "done_claimed", "blocked"].includes(task.status) || ((task.status === "blocked" || record.issues_only) && review.verdict === "approved")) throw new RoutingControlError(409, "当前任务只允许报告问题，不能批准。", "TASK_NOT_REVIEWABLE");
  if (!sameSubject(task.currentSubject, record.subject_ref) || !sameSubject(review.subject_ref, record.subject_ref)) throw new RoutingControlError(409, "Review Subject 不匹配。", "SUBJECT_MISMATCH");
  const artifacts = normalizeReviewArtifacts(review.review_artifacts, true);
  if (JSON.stringify(artifacts) !== JSON.stringify(route.reviewArtifacts)) throw new RoutingControlError(409, "OCR Bundle 或 Rules 与路由不匹配。", "REVIEW_ARTIFACTS_MISMATCH");
  if (canonical(review.reviewer?.session_id || review.reviewer?.id || "") !== record.reviewer_session_id) throw new RoutingControlError(403, "Reviewer 身份不匹配。", "REVIEW_PERMISSION_DENIED");
  if (record.attestation_id && record.attestation_id !== review.id) throw new RoutingControlError(409, "Review 已有结果。", "REVIEWER_LEASE_UNAVAILABLE");
  if (!record.attestation_id && (route.status !== "leased" || Date.parse(route.expiresAt) <= Date.parse(now))) throw new RoutingControlError(409, "Reviewer lease 已失效。", "REVIEWER_LEASE_UNAVAILABLE");
  // Persist the authoritative ledger first; a same-event retry repairs this projection.
  const result = commit();
  record.status = review.verdict === "rejected" ? "failed" : review.verdict;
  record.verdict = review.verdict;
  record.unresolved_findings = result.task.reviewAttestations.find((item) => item.id === review.id).unresolved_findings;
  record.attestation_id = review.id;
  record.finished_at ||= now;
  persistState(state, now);
  return result;
}

export function routeForId(id) { return readState().routes.find((route) => route.id === id); }

export function activeExecutionRoute(taskId, now = new Date().toISOString()) {
  const routes = readState().routes.filter((route) => route.taskId === taskId
    && !route.reviewRecord && route.status === "leased" && route.available
    && Date.parse(route.expiresAt) > Date.parse(now));
  return {
    direct: routes.some((route) => route.channel === "direct"),
    cli: routes.some((route) => route.channel === "cli"),
  };
}

// 仅保留结构化决策与调用用量；签名单独排除 latency/usage，不存原文。
export function sanitizeJevDecision(value) {
  if (!value || typeof value !== "object") return null;
  return {
    usage: value.usage && Number.isSafeInteger(value.usage.input_tokens) && value.usage.input_tokens >= 0 && Number.isSafeInteger(value.usage.output_tokens) && value.usage.output_tokens >= 0
      ? { input_tokens: value.usage.input_tokens, output_tokens: value.usage.output_tokens } : null,
    latency_ms: Number.isFinite(value.latency_ms) && value.latency_ms >= 0 ? value.latency_ms : null,
    phase_id: clean(String(value.phase_id ?? ""), 120) || null,
    input_hash: clean(String(value.input_hash ?? ""), 120) || null,
    phase_summary_hash: clean(String(value.phase_summary_hash ?? ""), 120) || null,
    phase_summary_excerpt: clean(String(value.phase_summary_excerpt ?? ""), 500) || null,
    requested_task_class: clean(String(value.requested_task_class ?? ""), 80) || null,
    requested_channel: clean(String(value.requested_channel ?? ""), 40) || null,
    task_class_choice: clean(String(value.task_class_choice ?? ""), 80) || null,
    task_class_confidence: Number.isFinite(value.task_class_confidence) ? value.task_class_confidence : null,
    execution_choice: clean(String(value.execution_choice ?? ""), 40) || null,
    execution_confidence: Number.isFinite(value.execution_confidence) ? value.execution_confidence : null,
    execution_applied: value.execution_applied === true,
    execution_override_reason: clean(String(value.execution_override_reason ?? ""), 1000) || null,
    direct_exception_kind: clean(String(value.direct_exception_kind ?? ""), 80) || null,
    direct_exception_evidence: clean(String(value.direct_exception_evidence ?? ""), 500) || null,
    executor_model_choice: clean(String(value.executor_model_choice ?? ""), 120) || null,
    executor_model_confidence: Number.isFinite(value.executor_model_confidence) ? value.executor_model_confidence : null,
    model_applied: value.model_applied === true,
    candidate_models: Array.isArray(value.candidate_models)
      ? value.candidate_models.map((model) => clean(String(model ?? ""), 120)).filter(Boolean).slice(0, 16)
      : null,
    model: clean(String(value.model ?? ""), 120) || null,
    status: clean(String(value.status ?? ""), 40) || null,
    error: clean(String(value.error ?? ""), 120) || null,
  };
}

// jevDecision 是服务端生成的可信内部参数；HTTP body 的同名字段不会被消费。
export function routingSelect(input, now = new Date().toISOString(), jevDecision = null) {
  const jev = sanitizeJevDecision(jevDecision);
  let config;
  try { config = loadModelRoleConfig(); }
  catch (error) {
    if (isReviewTaskClass(input.task_class)) throw new RoutingControlError(503, error.message, "REVIEWER_UNAVAILABLE");
    throw error;
  }
  const profile = input.cli_profile ? cliProfile(input.cli_profile) : null;
  if (profile && (input.channel !== "cli" || isReviewTaskClass(input.task_class) || input.execution_model_policy?.mode === "quota_preferred" || (input.preferred_model && input.preferred_model !== profile.model))) throw new RoutingControlError(400, "CLI profile 仅用于显式普通执行，不改变正式 Reviewer 或额度策略。");
  const requestedPreferredModel = profile?.model || clean(input.preferred_model, 120);
  const executionModelPolicy = normalizeExecutionModelPolicy(input.execution_model_policy);
  const taskId = clean(input.task_id, 200);
  const taskClass = clean(input.task_class, 80) || "general";
  if (!knownTaskClasses.has(taskClass)) throw new RoutingControlError(400, `未知 task_class：${taskClass}。`);
  const orchestratorModel = clean(input.orchestrator_model, 120);
  const roleName = ocrTaskClasses.has(taskClass) ? "reviewer" : "executor";
  const role = config.roles[roleName];
  let selectedReasoningEffort = profile?.effort || role.taskClassReasoningEfforts?.[taskClass] || role.reasoningEffort;
  const configuredModel = optionalAstraModel(taskClass, role, config) || role.taskClassModels?.[taskClass] || role.model;
  // 自动路径上过期的 automatic_until 模型回落到角色默认模型；显式 preferred_model 语义不变。
  const mappedModel = roleName === "executor" && !requestedPreferredModel && !isAutomaticEligible(config, configuredModel, now)
    ? role.model
    : configuredModel;
  const quotaPreferred = roleName === "executor" && executionModelPolicy.mode === "quota_preferred";
  if (quotaPreferred && !config.manualOnlyModels.includes(executionModelPolicy.preferredModel)) {
    throw new RoutingControlError(409, `额度优先模型未配置为 manual_only: ${executionModelPolicy.preferredModel}`);
  }
  let preferredModel = roleName === "reviewer"
    ? role.model
    : quotaPreferred
      ? executionModelPolicy.preferredModel
      : normalizePreferredModel(requestedPreferredModel || mappedModel, config);
  const channel = clean(input.channel, 40) || "cli";
  const availableNativeModels = normalizeAvailableNativeModels(input.available_native_models);
  const eventId = clean(input.event_id, 200) || `routing-select-${randomUUID()}`;
  if (!taskId || !orchestratorModel) throw new RoutingControlError(400, "routing_select 缺少 task_id 或 orchestrator_model。");
  if (!["direct", "native", "cli", "other"].includes(channel)) throw new RoutingControlError(400, "routing_select channel 无效。");
  const reviewArtifacts = normalizeReviewArtifacts(input.review_artifacts, ocrTaskClasses.has(taskClass));

  const state = readState();
  expireRoutes(state, now);
  const directReason = clean(input.direct_reason, 1000);
  const signatureInput = { taskId, orchestratorModel, requestedPreferredModel, executionModelPolicy, taskClass, channel };
  if (availableNativeModels.length) signatureInput.availableNativeModels = availableNativeModels;
  if (input.direct_authorization_fingerprint) signatureInput.directAuthorizationFingerprint = input.direct_authorization_fingerprint;
  if (profile) signatureInput.cliProfile = input.cli_profile;
  if (input.review_context) signatureInput.reviewContext = input.review_context;
  if (reviewArtifacts) signatureInput.reviewArtifacts = reviewArtifacts;
  if (directReason) signatureInput.directReason = directReason;
  if (input.direct_exception_kind) signatureInput.directExceptionKind = clean(input.direct_exception_kind, 80);
  if (input.direct_exception_evidence) signatureInput.directExceptionEvidence = clean(input.direct_exception_evidence, 500);
  if (jev) signatureInput.jev = {
    phase_id: jev.phase_id, input_hash: jev.input_hash,
    requested_task_class: jev.requested_task_class, requested_channel: jev.requested_channel,
    task_class_choice: jev.task_class_choice, execution_choice: jev.execution_choice,
    executor_model_choice: jev.executor_model_choice, executor_model_confidence: jev.executor_model_confidence,
    model_applied: jev.model_applied,
    candidate_models: jev.candidate_models,
  };
  const signature = signatureOf(signatureInput);
  const replay = state.routes.find((route) => route.selectEventId === eventId);
  if (replay) {
    const legacySignature = signatureOf({
      taskId,
      orchestratorModel,
      preferredModel: requestedPreferredModel || replay.preferredModel,
      taskClass,
      channel,
      configVersion: replay.configVersion || config.schemaVersion,
      ...(reviewArtifacts ? { reviewArtifacts } : {}),
    });
    if (replay.selectSignature !== signature && replay.selectSignature !== legacySignature) {
      throw new RoutingControlError(409, "event_id 已被不同 routing_select 请求使用。");
    }
    const auditEvents = replayAuditEvents(state, replay, "select", now, config);
    persistState(state, now);
    return { route: publicRoute(replay), health: healthSnapshot(state, now, config), roles: publicModelRoleConfig(config), idempotent: true, auditEvents };
  }

  if (channel === "direct" && roleName === "executor") {
    if (input.direct_authorization_fingerprint) {
      if (!/^[a-f0-9]{64}$/.test(input.direct_authorization_fingerprint)) throw new RoutingControlError(403, "一次性主模型直接执行授权指纹无效。", "DIRECT_AUTHORIZATION_INVALID");
      const expiresAt = Date.parse(input.direct_authorization_expires_at);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(now) || expiresAt > Date.parse(now) + 7_200_000) throw new RoutingControlError(403, "一次性主模型直接执行授权已过期。", "DIRECT_AUTHORIZATION_INVALID");
      state.directAuthorizations ||= {};
      const record = state.directAuthorizations[input.direct_authorization_fingerprint];
      if (record) throw new RoutingControlError(403, "一次性主模型直接执行授权已使用。", "DIRECT_AUTHORIZATION_INVALID");
      state.directAuthorizations[input.direct_authorization_fingerprint] = { taskId, sessionId: clean(input.session_id, 200), expiresAt: input.direct_authorization_expires_at, consumedAt: now };
    }
    const health = ensureHealth(state, orchestratorModel, now, config);
    const route = {
      id: clean(input.route_id, 200) || `route_${randomUUID()}`,
      selectEventId: eventId, selectSignature: signature, taskId, orchestratorModel,
      preferredModel: orchestratorModel, selectedModel: orchestratorModel,
      selectedReasoningEffort: "unknown", taskClass, channel,
      circuitState: health.state, reason: jev?.execution_applied ? "jev_direct" : "direct_reasoned_override",
      fallbackFrom: "", fallbackReason: "", retryAfterAt: "", reviewArtifacts: null,
      preferenceMode: executionModelPolicy.mode, quotaLimitId: "", quotaSnapshotObservedAt: "",
      quotaUsedPercent: undefined, quotaResetAt: "", directReason, jevDecision: jev,
      configVersion: config.contentHash, policyVersion: config.schemaVersion,
      matchedRule: "direct_main_model", requiresNewSession: false,
      available: true, probe: false, status: "leased", createdAt: now,
      expiresAt: new Date(Date.parse(now) + normalizeTtlMs(input.lease_ttl_ms)).toISOString(),
      completedAt: "", resultEventId: "", resultSignature: "", result: null,
    };
    if (state.routes.some((item) => item.id === route.id)) throw new RoutingControlError(409, "route_id 已存在。");
    state.routes.push(route);
    route.selectAuditEvents = auditEventsFor(route, health, "direct_selected", "select");
    persistState(state, now);
    return { route: publicRoute(route), health: healthSnapshot(state, now, config), roles: publicModelRoleConfig(config), idempotent: false, auditEvents: route.selectAuditEvents };
  }

  const automaticChannel = channel === "other" || (channel === "cli" && !profile && jev?.requested_channel === "other");
  const configuredPreferredModel = preferredModel;
  const protectedModel = mappedModel !== role.model || (requestedPreferredModel && !jev?.model_applied);
  // Prefer a runnable native candidate before leasing. A CLI-only default must not
  // hide a configured native fallback; explicit model and task-class choices stay pinned.
  if (roleName === "executor" && !quotaPreferred && (automaticChannel || channel === "native") && availableNativeModels.length) {
    const candidates = protectedModel ? [preferredModel] : [...new Set([preferredModel, role.model, ...role.fallbackModels])];
    const nativePreferred = candidates.find((model) => {
      if (!isAutomaticEligible(config, model, now) || !nativeRuntimeModel(config, model, availableNativeModels, selectedReasoningEffort)) return false;
      const health = ensureHealth(state, model, now, config);
      advanceCircuit(health, now);
      return canLease(state, health, now, config);
    });
    if (nativePreferred) preferredModel = nativePreferred;
  }
  const preferred = ensureHealth(state, preferredModel, now, config);
  advanceCircuit(preferred, now);
  const quota = quotaPreferred
    ? quotaDecision(input.quota_snapshot, executionModelPolicy.quotaLimitId, preferred, now)
    : null;
  let selectedModel = preferredModel;
  let reason = roleName === "reviewer"
    ? "reviewer_model_from_config"
    : quotaPreferred
      ? quota.status === "available" ? "quota_preferred_model_available" : "quota_snapshot_unknown_probe"
    : !requestedPreferredModel && role.taskClassModels?.[taskClass]
      ? `executor_model_from_task_class:${taskClass}`
      : !requestedPreferredModel
        ? "executor_model_from_config"
      : requestedPreferredModel === preferredModel
        ? "preferred_model_available"
        : config.manualOnlyModels.includes(requestedPreferredModel)
          ? "manual_only_preference_requires_task_policy"
          : "retired_preference_normalized_to_executor";
  let fallbackFrom = preferredModel !== configuredPreferredModel ? configuredPreferredModel : "";
  let fallbackReason = fallbackFrom ? "native_capability_preferred" : "";
  if (fallbackFrom) reason = "native_capability_preferred";
  let retryAfterAt = "";
  let probe = preferred.state === "half_open" || quota?.status === "unknown";

  if (quota?.status === "exhausted") {
    fallbackFrom = preferredModel;
    fallbackReason = "preferred_model_quota_exhausted";
    retryAfterAt = quota.retryAfterAt;
    const fallback = ensureHealth(state, mappedModel, now, config);
    advanceCircuit(fallback, now);
    if (!canLease(state, fallback, now, config)) {
      const route = buildUnavailableRoute({
        eventId, signature, taskId, orchestratorModel, preferredModel, taskClass, channel, preferred: fallback, now,
        reason: "quota_fallback_model_unavailable", fallbackFrom, fallbackReason, retryAfterAt, reviewArtifacts,
        configVersion: config.contentHash, policyVersion: config.schemaVersion,
        matchedRule: "task.execution_model_policy.quota_preferred",
        preferenceMode: executionModelPolicy.mode, quota, selectedReasoningEffort, jevDecision: jev, directReason,
      });
      state.routes.push(route);
      route.selectAuditEvents = auditEventsFor(route, fallback, "selection_unavailable");
      persistState(state, now);
      return { route: publicRoute(route), health: healthSnapshot(state, now, config), roles: publicModelRoleConfig(config), idempotent: false, auditEvents: route.selectAuditEvents };
    }
    selectedModel = mappedModel;
    reason = `quota_exhausted_fallback_to_${modelSlug(mappedModel)}`;
    probe = fallback.state === "half_open";
  }

  if (quota?.status !== "exhausted" && !canLease(state, preferred, now, config)) {
    fallbackFrom = preferredModel;
    fallbackReason = fallbackReasonFor(preferred);
    retryAfterAt = preferred.retryAfterAt;
    const protectedTaskClass = roleName === "executor" && (
      mappedModel !== role.model || (Boolean(requestedPreferredModel) && !jev?.model_applied)
    );
    let fallback = protectedTaskClass ? null : chooseFallback(state, role, preferredModel, now, config);
    const ordinaryModels = [role.model, ...role.fallbackModels];
    if (!fallback && roleName === "executor" && role.capacityFallbackModel
      && ordinaryModels.every((model) => {
        const health = ensureHealth(state, model, now, config);
        if (canLease(state, health, now, config)) return false;
        return health.state === "closed" || /server_overloaded|capacity|rate.?limit|quota|429/i.test(health.lastErrorCode);
      })) {
      const lastResort = ensureHealth(state, role.capacityFallbackModel, now, config);
      if (canLease(state, lastResort, now, config)) {
        fallback = lastResort;
        fallbackReason = "ordinary_executor_capacity_exhausted";
      }
    }
    if (!fallback) {
      const route = buildUnavailableRoute({
        eventId, signature, taskId, orchestratorModel, preferredModel, taskClass, channel, preferred, now,
        reason: role.failClosed ? "reviewer_model_unavailable" : "no_model_capacity_available",
        fallbackFrom, fallbackReason, retryAfterAt, reviewArtifacts,
        configVersion: config.contentHash,
        policyVersion: config.schemaVersion,
        matchedRule: matchedRule(roleName, requestedPreferredModel, role, taskClass, quotaPreferred),
        preferenceMode: executionModelPolicy.mode, quota, selectedReasoningEffort, jevDecision: jev, directReason,
      });
      state.routes.push(route);
      route.selectAuditEvents = auditEventsFor(route, preferred, "selection_unavailable");
      persistState(state, now);
      return { route: publicRoute(route), health: healthSnapshot(state, now, config), roles: publicModelRoleConfig(config), idempotent: false, auditEvents: route.selectAuditEvents };
    }
    selectedModel = fallback.model;
    reason = fallbackReason === "ordinary_executor_capacity_exhausted"
      ? "executor_capacity_fallback_to_last_resort"
      : detailedFallbackReason(preferredModel, preferred);
    probe = fallback.state === "half_open";
  }

  const selected = ensureHealth(state, selectedModel, now, config);
  // A default route must report the client that will actually run the selection, so a
  // later delegation claim cannot bind the leased model to a different harness. When the
  // caller's spawn tool can natively run a configured non-Codex model (auto path or explicit
  // native), the route stays native and reports the runtime model id; explicit native without
  // that capability is an actionable unavailable, never a silent CLI conversion. Explicit
  // Codex native and explicit cli keep their existing semantics.
  let effectiveChannel = channel;
  let resolvedProfile = profile?.model === selectedModel ? { name: input.cli_profile, harness: profile.harness, effort: profile.effort } : null;
  let nativeModel = "";
  if (roleName === "executor" && !resolvedProfile) {
    const codexModels = new Set((config.quotaPools || []).filter((pool) => pool.provider === "codex").flatMap((pool) => pool.models));
    // 显式 Codex native：canonical 模型 id 即 runtime id，能力列表声明即可原生派发。
    const isCodexModel = codexModels.has(selectedModel);
    const runtime = isCodexModel
      ? (availableNativeModels.includes(selectedModel) ? selectedModel : "")
      : nativeRuntimeModel(config, selectedModel, availableNativeModels, selectedReasoningEffort);
    if (runtime && (automaticChannel || channel === "native")) {
      effectiveChannel = "native";
      nativeModel = runtime;
    } else if (channel === "native") {
      const mapping = config.nativeModels?.[selectedModel];
      const unavailableReason = isCodexModel
        ? `native_model_not_available:${selectedModel}`
        : !mapping
          ? `native_model_not_configured:${selectedModel}`
          : !mapping.reasoningEfforts.includes(selectedReasoningEffort)
            ? `native_effort_not_supported:${selectedReasoningEffort}`
            : `native_model_not_available:${mapping.runtimeModel}`;
      const route = buildUnavailableRoute({
        eventId, signature, taskId, orchestratorModel, preferredModel, taskClass, channel, preferred: selected, now,
        reason: unavailableReason, reviewArtifacts,
        configVersion: config.contentHash, policyVersion: config.schemaVersion,
        matchedRule: "explicit_native_capability", preferenceMode: executionModelPolicy.mode,
        selectedReasoningEffort, jevDecision: jev, directReason,
      });
      state.routes.push(route);
      route.selectAuditEvents = auditEventsFor(route, selected, "selection_unavailable");
      persistState(state, now);
      return { route: publicRoute(route), health: healthSnapshot(state, now, config), roles: publicModelRoleConfig(config), idempotent: false, auditEvents: route.selectAuditEvents };
    }
  }
  if (!resolvedProfile && !nativeModel && roleName === "executor" && (channel === "cli" || channel === "other")) {
    resolvedProfile = cliProfileForModel(selectedModel);
    if (resolvedProfile && channel !== "cli") effectiveChannel = "cli";
  }
  if (resolvedProfile) {
    // 路由报告档位必须与 runDelegatedCli 实际使用的 profile 档位一致。
    selectedReasoningEffort = resolvedProfile.effort;
  }
  const route = {
    id: clean(input.route_id, 200) || `route_${randomUUID()}`,
    selectEventId: eventId,
    selectSignature: signature,
    taskId,
    orchestratorModel,
    preferredModel,
    selectedModel,
    selectedReasoningEffort,
    taskClass,
    channel: effectiveChannel,
    ...(nativeModel ? { nativeModel } : {}),
    ...(resolvedProfile ? { cliProfile: resolvedProfile.name, harness: resolvedProfile.harness } : {}),
    circuitState: selected.state,
    reason,
    fallbackFrom,
    fallbackReason,
    retryAfterAt,
    reviewArtifacts,
    preferenceMode: executionModelPolicy.mode,
    quotaLimitId: quota?.limitId || "",
    quotaSnapshotObservedAt: quota?.observedAt || "",
    quotaUsedPercent: quota?.usedPercent,
    quotaResetAt: quota?.retryAfterAt || "",
    directReason,
    jevDecision: jev,
    configVersion: config.contentHash,
    policyVersion: config.schemaVersion,
    matchedRule: matchedRule(roleName, requestedPreferredModel, role, taskClass, quotaPreferred),
    requiresNewSession: roleName === "reviewer" ? false : selectedModel !== preferredModel || effectiveChannel === "cli" || effectiveChannel === "native",
    available: true,
    probe,
    status: "leased",
    createdAt: now,
    expiresAt: new Date(Date.parse(now) + normalizeTtlMs(input.lease_ttl_ms)).toISOString(),
    completedAt: "",
    resultEventId: "",
    resultSignature: "",
    result: null,
    ...(input.review_context ? { reviewRecord: {
      id: `review_${randomUUID()}`, task_id: taskId,
      requester_session_id: input.review_context.sessionId,
      reviewer_session_id: "", subject_ref: input.review_context.subject,
      bundle_ref: reviewArtifacts.bundle, rules_ref: reviewArtifacts.rules,
      status: "pending", verdict: null, unresolved_findings: 0,
      started_at: null, finished_at: null, issues_only: input.review_context.issuesOnly,
      claim_token: randomUUID(),
    } } : {}),
  };
  if (state.routes.some((item) => item.id === route.id)) throw new RoutingControlError(409, "route_id 已存在。");
  state.routes.push(route);
  if (probe) selected.halfOpenLease = route.id;
  refreshActiveExecutors(state, now);
  selected.updatedAt = now;
  route.selectAuditEvents = auditEventsFor(route, selected, "lease_acquired", "select");
  persistState(state, now);
  return { route: publicRoute(route), health: healthSnapshot(state, now, config), roles: publicModelRoleConfig(config), idempotent: false, auditEvents: route.selectAuditEvents };
}

export function routingResult(input, now = new Date().toISOString()) {
  const config = loadModelRoleConfig();
  const routeId = clean(input.route_id, 200);
  const requestedOutcome = clean(input.outcome, 40);
  const eventId = clean(input.event_id, 200) || `routing-result-${randomUUID()}`;
  if (!routeId || !terminalOutcomes.has(requestedOutcome)) throw new RoutingControlError(400, "routing_result 缺少 route_id 或 outcome 无效。");
  const state = readState();
  expireRoutes(state, now);
  const route = state.routes.find((item) => item.id === routeId);
  if (!route) throw new RoutingControlError(404, "route_id 不存在。");
  if (!route.available) throw new RoutingControlError(409, "未发放执行租约的路由不能上报执行结果。");
  const reviewNotCompleted = Boolean(route.reviewRecord && requestedOutcome === "succeeded" && !route.reviewRecord.attestation_id);
  const outcome = reviewNotCompleted ? "failed" : requestedOutcome;

  const result = {
    outcome,
    httpStatus: normalizeHttpStatus(input.http_status),
    errorType: clean(input.error_type, 120) || (reviewNotCompleted ? "review_workflow" : ""),
    errorCode: clean(input.error_code, 160) || (reviewNotCompleted ? "REVIEW_NOT_COMPLETED" : ""),
    requestId: clean(input.request_id, 300),
    quotaLimitId: clean(input.quota_limit_id, 120) || route.quotaLimitId || "",
    quotaRetryAfterAt: clean(input.quota_retry_after_at, 80) || route.quotaResetAt || "",
  };
  const signature = signatureOf(result);
  if (route.result) {
    if (route.resultEventId !== eventId && route.resultSignature !== signature) throw new RoutingControlError(409, "route 已上报不同结果。");
    if (route.resultSignature !== signature) throw new RoutingControlError(409, "event_id 已被不同 routing_result 使用。");
    const auditEvents = replayAuditEvents(state, route, "result", now, config);
    persistState(state, now);
    return { route: publicRoute(route), health: healthSnapshot(state, now, config), roles: publicModelRoleConfig(config), idempotent: true, auditEvents };
  }
  if (route.status !== "leased") throw new RoutingControlError(409, "route 租约已过期或不可用。");

  const health = ensureHealth(state, route.selectedModel, now, config);
  const previousState = health.state;
  route.status = outcome;
  route.completedAt = now;
  route.resultEventId = eventId;
  route.resultSignature = signature;
  route.result = result;
  if (route.reviewRecord && ["pending", "running"].includes(route.reviewRecord.status)) {
    route.reviewRecord.status = "failed";
    route.reviewRecord.finished_at = now;
  }
  if (health.halfOpenLease === route.id) health.halfOpenLease = "";

  if (route.channel === "direct") {
    // Direct work uses the already-running main Session; its task result is not executor-model health.
  } else if (outcome === "succeeded") {
    health.state = "closed";
    health.consecutiveFailures = 0;
    health.openedAt = "";
    health.retryAfterAt = "";
    health.lastSuccessAt = now;
    health.quotaRetryAfterAt = "";
    health.quotaLimitId = "";
  } else if (isQuotaFailure(result) && config.manualOnlyModels.includes(route.selectedModel)) {
    health.lastErrorCode = result.errorCode || result.errorType || String(result.httpStatus || "");
    health.lastRequestId = result.requestId;
    health.quotaLimitId = result.quotaLimitId;
    health.quotaRetryAfterAt = validFutureTime(result.quotaRetryAfterAt, now)
      || new Date(Date.parse(now) + defaultCooldownMs).toISOString();
  } else if (isCircuitFailure(result)) {
    health.consecutiveFailures += 1;
    health.lastErrorCode = result.errorCode || result.errorType || String(result.httpStatus || "");
    health.lastRequestId = result.requestId;
    if (previousState === "half_open" || immediateOpenFailureTypes.has(result.errorType) || health.consecutiveFailures >= health.failureThreshold) openCircuit(health, now);
  }
  health.updatedAt = now;
  refreshActiveExecutors(state, now);
  const transition = previousState === health.state ? "result_recorded" : `${previousState}_to_${health.state}`;
  route.resultAuditEvents = auditEventsFor(route, health, transition, "result");
  persistState(state, now);
  return { route: publicRoute(route), health: healthSnapshot(state, now, config), roles: publicModelRoleConfig(config), idempotent: false, auditEvents: route.resultAuditEvents };
}

export function routingHealth(now = new Date().toISOString()) {
  const config = loadModelRoleConfig();
  const state = readState();
  expireRoutes(state, now);
  for (const health of Object.values(state.models)) advanceCircuit(health, now);
  persistState(state, now);
  return healthSnapshot(state, now, config);
}

export function routingRoles() {
  return publicModelRoleConfig(loadModelRoleConfig());
}

function chooseFallback(state, role, preferredModel, now, config) {
  return [...new Set([role.model, ...role.fallbackModels])]
    .filter((model) => model !== preferredModel && isAutomaticEligible(config, model, now))
    .map((model) => ensureHealth(state, model, now, config))
    .find((health) => {
      advanceCircuit(health, now);
      return canLease(state, health, now, config);
    }) || null;
}

function canLease(state, health, now, config = null) {
  advanceCircuit(health, now);
  if (health.state === "open") return false;
  if (health.state === "half_open" && health.halfOpenLease) return false;
  if (activeRoutes(state, health.model, now).length >= health.concurrencyLimit) return false;
  // Executor 候选模型的集中上限：角色全局并发与共享 quota pool 并发；Reviewer 与其他模型不受影响。
  const executorRole = config?.roles?.executor;
  if (!executorRole) return true;
  const candidates = [executorRole.model, ...executorRole.fallbackModels];
  if (!candidates.includes(health.model)) return true;
  const activeExecutorLeases = state.routes.filter((route) =>
    route.status === "leased" && candidates.includes(route.selectedModel) && Date.parse(route.expiresAt || "") > Date.parse(now));
  if (executorRole.globalConcurrencyLimit && activeExecutorLeases.length >= executorRole.globalConcurrencyLimit) return false;
  const pool = (config.quotaPools || []).find((item) => item.concurrency_limit && item.models.includes(health.model));
  if (!pool) return true;
  const poolActive = activeExecutorLeases.filter((route) => pool.models.includes(route.selectedModel)).length;
  return poolActive < pool.concurrency_limit;
}

function advanceCircuit(health, now) {
  if (health.quotaRetryAfterAt && Date.parse(health.quotaRetryAfterAt) <= Date.parse(now)) {
    health.quotaRetryAfterAt = "";
    health.quotaLimitId = "";
    health.updatedAt = now;
  }
  if (health.state === "open" && Date.parse(health.retryAfterAt || "") <= Date.parse(now)) {
    health.state = "half_open";
    health.halfOpenLease = "";
    health.updatedAt = now;
  }
}

function openCircuit(health, now) {
  health.state = "open";
  health.openedAt = now;
  health.retryAfterAt = new Date(Date.parse(now) + health.cooldownMs).toISOString();
  health.halfOpenLease = "";
}

function isCircuitFailure(result) {
  return [429, 500, 502, 503, 504].includes(result.httpStatus)
    || circuitFailureTypes.has(result.errorType)
    || /overload|capacity|unavailable|rate.?limit|timeout/i.test(`${result.errorType} ${result.errorCode}`);
}

function isQuotaFailure(result) {
  return result.httpStatus === 429 || result.errorType === "rate_limit" || /quota|rate.?limit/i.test(`${result.errorType} ${result.errorCode}`);
}

function buildUnavailableRoute({
  eventId, signature, taskId, orchestratorModel, preferredModel, taskClass, channel, preferred, now, reason,
  fallbackFrom = "", fallbackReason = "", retryAfterAt = "", reviewArtifacts = null,
  configVersion = "", policyVersion = "", matchedRule = "", preferenceMode = "auto", quota = null,
  selectedReasoningEffort = "low", jevDecision = null, directReason = "",
}) {
  return {
    id: `route_${randomUUID()}`,
    selectEventId: eventId,
    selectSignature: signature,
    taskId,
    orchestratorModel,
    preferredModel,
    selectedModel: "",
    selectedReasoningEffort,
    taskClass,
    channel,
    circuitState: preferred.state,
    reason: reason || "no_model_capacity_available",
    fallbackFrom,
    fallbackReason,
    retryAfterAt,
    reviewArtifacts,
    jevDecision,
    directReason,
    configVersion,
    policyVersion,
    matchedRule,
    preferenceMode,
    quotaLimitId: quota?.limitId || "",
    quotaSnapshotObservedAt: quota?.observedAt || "",
    quotaUsedPercent: quota?.usedPercent,
    quotaResetAt: quota?.retryAfterAt || "",
    requiresNewSession: false,
    available: false,
    probe: false,
    status: "unavailable",
    createdAt: now,
    expiresAt: now,
    completedAt: now,
    resultEventId: "",
    resultSignature: "",
    result: null,
  };
}

function ensureHealth(state, model, now, config) {
  state.models[model] ||= {
    model,
    state: "closed",
    consecutiveFailures: 0,
    openedAt: "",
    retryAfterAt: "",
    halfOpenLease: "",
    activeExecutors: 0,
    concurrencyLimit: concurrencyLimit(model, config),
    failureThreshold: defaultFailureThreshold,
    cooldownMs: defaultCooldownMs,
    lastErrorCode: "",
    lastRequestId: "",
    lastSuccessAt: "",
    quotaLimitId: "",
    quotaRetryAfterAt: "",
    updatedAt: now,
  };
  state.models[model].concurrencyLimit = concurrencyLimit(model, config);
  return state.models[model];
}

function expireRoutes(state, now) {
  let changed = false;
  for (const route of state.routes) {
    if (route.status !== "leased" || Date.parse(route.expiresAt || "") > Date.parse(now)) continue;
    route.status = "expired";
    route.completedAt = now;
    const health = state.models[route.selectedModel];
    if (health?.halfOpenLease === route.id) health.halfOpenLease = "";
    changed = true;
  }
  refreshActiveExecutors(state, now);
  return changed;
}

function refreshActiveExecutors(state, now) {
  for (const health of Object.values(state.models)) health.activeExecutors = activeRoutes(state, health.model, now).length;
}

function activeRoutes(state, model, now) {
  return state.routes.filter((route) => route.selectedModel === model && route.status === "leased" && Date.parse(route.expiresAt || "") > Date.parse(now));
}

function healthSnapshot(state, now, config) {
  refreshActiveExecutors(state, now);
  return Object.values(state.models).filter((health) => !config.retiredModels.includes(health.model)).map((health) => ({
    model: health.model,
    state: health.state,
    consecutive_failures: health.consecutiveFailures,
    opened_at: health.openedAt || null,
    retry_after_at: health.retryAfterAt || null,
    half_open_lease: health.halfOpenLease || null,
    active_executors: health.activeExecutors,
    concurrency_limit: health.concurrencyLimit,
    last_error_code: health.lastErrorCode || null,
    last_request_id: health.lastRequestId || null,
    last_success_at: health.lastSuccessAt || null,
    quota_limit_id: health.quotaLimitId || null,
    quota_retry_after_at: health.quotaRetryAfterAt || null,
    updated_at: health.updatedAt,
  })).sort((left, right) => left.model.localeCompare(right.model));
}

function publicRoute(route) {
  return {
    route_id: route.id,
    task_id: route.taskId,
    orchestrator_model: route.orchestratorModel || "unknown",
    preferred_model: route.preferredModel,
    selected_model: route.selectedModel || null,
    native_model: route.nativeModel || null,
    ...(route.cliProfile ? { cli_profile: route.cliProfile, harness: route.harness, role: "executor" } : {}),
    reasoning_effort: route.selectedReasoningEffort || "low",
    task_class: route.taskClass,
    channel: route.channel,
    circuit_state: route.circuitState,
    reason: route.reason,
    ...(!route.available && route.reason?.startsWith("native_") ? {
      next_action: "核对当前原生派发工具支持的型号与档位，传入真实 available_native_models；宿主不支持时可在主对话切换模型，或显式选择 channel=cli。",
    } : {}),
    fallback_from: route.fallbackFrom || null,
    fallback_reason: route.fallbackReason || null,
    retry_after_at: route.retryAfterAt || null,
    review_artifacts: route.reviewArtifacts || null,
    review_record: route.reviewRecord || null,
    error_code: !route.available && isReviewTaskClass(route.taskClass)
      ? (route.fallbackReason?.includes("concurrency") || route.fallbackReason?.includes("leased") ? "REVIEWER_LEASE_UNAVAILABLE" : "REVIEWER_UNAVAILABLE") : null,
    config_version: route.configVersion || null,
    policy_version: route.policyVersion || null,
    matched_rule: route.matchedRule || null,
    preference_mode: route.preferenceMode || "auto",
    direct_reason: route.directReason || null,
    jev_decision: route.jevDecision || null,
    quota_limit_id: route.quotaLimitId || null,
    quota_snapshot_observed_at: route.quotaSnapshotObservedAt || null,
    quota_used_percent: Number.isFinite(route.quotaUsedPercent) ? route.quotaUsedPercent : null,
    quota_reset_at: route.quotaResetAt || null,
    requires_new_session: route.requiresNewSession,
    available: route.available,
    probe: route.probe,
    status: route.status,
    created_at: route.createdAt,
    expires_at: route.expiresAt,
    completed_at: route.completedAt || null,
    result: route.result ? {
      outcome: route.result.outcome,
      http_status: route.result.httpStatus || null,
      error_type: route.result.errorType || null,
      error_code: route.result.errorCode || null,
      request_id: route.result.requestId || null,
      quota_limit_id: route.result.quotaLimitId || null,
      quota_retry_after_at: route.result.quotaRetryAfterAt || null,
    } : null,
  };
}

function auditEventsFor(route, health, transition, phase = "select") {
  const selected = route.selectedModel || route.preferredModel;
  return [
    phase === "select" ? {
      type: "routing.decision",
      event_id: `routing-decision-${route.id}-${route.status}`,
      task_id: route.taskId,
      routing_action: route.selectedModel === route.preferredModel
        ? route.channel === "native"
          ? "delegate_native"
          : route.channel === "cli"
            ? "fallback_cli"
            : route.channel === "direct" && selected === route.orchestratorModel
              ? "direct_execute"
              : "reasoned_override"
        : "reasoned_override",
      orchestrator_model: route.orchestratorModel || "unknown",
      preferred_executor_model: route.preferredModel,
      selected_executor_model: selected,
      reasoning_effort: route.selectedReasoningEffort || "low",
      dispatch_channel: route.channel,
      routing_reason: route.reason,
      fallback_from: route.fallbackFrom,
      fallback_reason: route.fallbackReason,
      retry_after_at: route.retryAfterAt,
      preference_mode: route.preferenceMode,
      quota_limit_id: route.quotaLimitId,
      quota_snapshot_observed_at: route.quotaSnapshotObservedAt,
      ...(Number.isFinite(route.quotaUsedPercent) ? { quota_used_percent: route.quotaUsedPercent } : {}),
      quota_reset_at: route.quotaResetAt,
      review_artifacts: route.reviewArtifacts,
      direct_reason: route.directReason || null,
      jev_decision: route.jevDecision || null,
      routing_outcome: route.status === "succeeded" ? "succeeded" : ["failed", "overloaded", "unavailable"].includes(route.status) ? "failed" : "selected",
      policy_version: "routing-control-v5",
      route_id: route.id,
      task_class: route.taskClass,
      circuit_state: route.circuitState,
    } : {
      type: "routing.result",
      event_id: `routing-result-${route.id}-${route.status}`,
      task_id: route.taskId,
      route_id: route.id,
      routing_outcome: route.status,
    },
    {
      type: "routing.health",
      event_id: `routing-health-${route.id}-${route.status}`,
      task_id: route.taskId,
      route_id: route.id,
      health_model: health.model,
      circuit_state: health.state,
      health_transition: transition,
      consecutive_failures: health.consecutiveFailures,
      active_executors: health.activeExecutors,
      retry_after_at: health.retryAfterAt,
    },
  ];
}

function replayAuditEvents(state, route, phase, now, config) {
  const key = phase === "select" ? "selectAuditEvents" : "resultAuditEvents";
  if (Array.isArray(route[key]) && route[key].length) return route[key];
  const health = ensureHealth(state, route.selectedModel || route.preferredModel, now, config);
  const transition = phase === "select"
    ? route.available ? "lease_acquired" : "selection_unavailable"
    : "result_recorded";
  route[key] = auditEventsFor(route, health, transition, phase);
  return route[key];
}

function readState() {
  if (!existsSync(routingControlPath)) return { version: 3, models: {}, routes: [], directAuthorizations: {}, updatedAt: "" };
  try {
    const value = JSON.parse(readFileSync(routingControlPath, "utf8"));
    if (!value?.models || typeof value.models !== "object" || Array.isArray(value.models) || !Array.isArray(value.routes)) throw new Error("invalid state");
    const state = { version: Number(value.version) || 1, models: value.models, routes: value.routes, directAuthorizations: value.directAuthorizations || {}, updatedAt: clean(value.updatedAt, 80) };
    migrateState(state);
    return state;
  } catch {
    throw new RoutingControlError(500, "路由控制状态损坏，已拒绝覆盖；请先修复或移走该运行态文件。");
  }
}

function persistState(state, now) {
  state.version = 3;
  state.directAuthorizations ||= {};
  state.updatedAt = now;
  // Review identity remains read-only after its lease ends; do not evict it with routing telemetry.
  const retained = new Set(state.routes.slice(-5_000));
  state.routes = state.routes.filter((route) => route.reviewRecord || retained.has(route));
  mkdirSync(dirname(routingControlPath), { recursive: true });
  const temporary = `${routingControlPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, routingControlPath);
}

function migrateState(state) {
  if (state.version < 2) {
    for (const health of Object.values(state.models)) {
      const latest = state.routes
        .filter((route) => route.selectedModel === health.model && route.result)
        .sort((left, right) => Date.parse(right.completedAt || "") - Date.parse(left.completedAt || ""))[0];
      if (!latest || latest.result.outcome === "succeeded" || !immediateOpenFailureTypes.has(latest.result.errorType)) continue;
      health.consecutiveFailures = Math.max(1, Number(health.consecutiveFailures) || 0);
      health.lastErrorCode = latest.result.errorCode || latest.result.errorType;
      health.lastRequestId = latest.result.requestId || "";
      openCircuit(health, latest.completedAt || latest.createdAt);
      health.updatedAt = latest.completedAt || latest.createdAt;
    }
  }
  state.version = 3;
  state.directAuthorizations ||= {};
}

function concurrencyLimit(model, config) {
  const envKey = `TASKCENTER_ROUTING_CONCURRENCY_${model.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
  const roleLimit = Object.values(config.roles).find((role) => [role.model, ...role.fallbackModels].includes(model))?.concurrencyLimit || 1;
  return integerEnv(envKey, roleLimit, 1, 64);
}

function normalizeTtlMs(value) {
  const number = Number(value ?? defaultLeaseTtlMs);
  if (!Number.isInteger(number) || number < 60_000 || number > 28_800_000) throw new RoutingControlError(400, "lease_ttl_ms 必须在 60000 到 28800000 之间。");
  return number;
}

function normalizeHttpStatus(value) {
  if (value === undefined || value === null) return 0;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 599) throw new RoutingControlError(400, "http_status 无效。");
  return number;
}

function integerEnv(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function clean(value, limit) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

function normalizeAvailableNativeModels(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 32 || value.some((item) => typeof item !== "string" || item.length > 120)) throw new RoutingControlError(400, "available_native_models 必须是不超过 32 项的模型 ID 字符串数组。");
  const models = value.map((item) => clean(item, 120)).filter(Boolean);
  if (models.length !== value.length) throw new RoutingControlError(400, "available_native_models 含无效模型 ID。");
  return [...new Set(models)].sort();
}

function normalizePreferredModel(model, config) {
  return config.retiredModels.includes(model) || config.manualOnlyModels.includes(model) ? config.roles.executor.model : model;
}

function normalizeExecutionModelPolicy(value) {
  if (!value || value.mode !== "quota_preferred") return { mode: "auto", preferredModel: "", quotaLimitId: "" };
  const preferredModel = clean(value.preferred_model, 120);
  const quotaLimitId = clean(value.quota_limit_id, 120);
  if (!preferredModel || !quotaLimitId || value.fallback_on_exhaustion !== true) {
    throw new RoutingControlError(400, "任务 quota_preferred 策略不完整。");
  }
  return { mode: "quota_preferred", preferredModel, quotaLimitId };
}

function quotaDecision(snapshot, limitId, health, now) {
  if (health.quotaRetryAfterAt && Date.parse(health.quotaRetryAfterAt) > Date.parse(now)) {
    return { status: "exhausted", limitId, observedAt: "", usedPercent: 100, retryAfterAt: health.quotaRetryAfterAt };
  }
  if (!snapshot || snapshot.limit_id !== limitId) return { status: "unknown", limitId, observedAt: "", usedPercent: undefined, retryAfterAt: "" };
  const observedAt = clean(snapshot.observed_at, 80);
  const observedMs = Date.parse(observedAt);
  const nowMs = Date.parse(now);
  const windows = [snapshot.primary, snapshot.secondary].filter(Boolean);
  const exhausted = windows.find((window) => Number(window.used_percent) >= 100 && futureTime(window.resets_at, now));
  const reached = clean(snapshot.rate_limit_reached_type, 80);
  if (exhausted || reached) {
    const retryAfterAt = windows.map((window) => futureTime(window.resets_at, now)).filter(Boolean).sort().at(-1) || "";
    return { status: "exhausted", limitId, observedAt, usedPercent: Math.max(...windows.map((window) => Number(window.used_percent) || 0)), retryAfterAt };
  }
  if (!Number.isFinite(observedMs) || !Number.isFinite(nowMs) || nowMs - observedMs > quotaSnapshotMaxAgeMs) {
    return { status: "unknown", limitId, observedAt, usedPercent: Number(snapshot.primary?.used_percent), retryAfterAt: "" };
  }
  return { status: "available", limitId, observedAt, usedPercent: Number(snapshot.primary?.used_percent), retryAfterAt: "" };
}

function futureTime(value, now) {
  const parsed = typeof value === "number" ? value * 1_000 : Date.parse(String(value || ""));
  return Number.isFinite(parsed) && parsed > Date.parse(now) ? new Date(parsed).toISOString() : "";
}

function validFutureTime(value, now) {
  return futureTime(value, now);
}

function optionalAstraModel(taskClass, role, config) {
  if (!["architecture", "migration", "complex_diagnosis"].includes(taskClass)) return "";
  const candidate = role.fallbackModels.at(-1);
  if (!candidate) return "";
  const reportPath = resolve(process.env.TASKCENTER_RUNTIME_DIR || resolve(projectRoot, ".local", "runtime"), "usage-report.json");
  let usage = NaN;
  try { usage = Number(JSON.parse(readFileSync(reportPath, "utf8")).rate_limits?.primary?.used_percent); } catch {}
  return Number.isFinite(usage) && usage <= config.optionalAstraPolicy.threshold_percent ? candidate : "";
}

function matchedRule(roleName, requestedPreferredModel, role, taskClass, quotaPreferred = false) {
  if (roleName === "reviewer") return "reviewer_model_from_config";
  if (quotaPreferred) return "task.execution_model_policy.quota_preferred";
  if (requestedPreferredModel) return "preferred_model";
  return role.taskClassModels?.[taskClass] ? `task_class_models.${taskClass}` : "executor_model_from_config";
}

function normalizeReviewArtifacts(value, required) {
  if (!value && !required) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RoutingControlError(400, "OCR routing_select 必须提供 review_artifacts。", "REVIEW_ARTIFACTS_INCOMPLETE");
  }
  const normalized = {
    subject: normalizeReviewArtifact(value.subject, "subject"),
    bundle: normalizeReviewArtifact(value.bundle, "bundle"),
    rules: normalizeReviewArtifact(value.rules, "rules"),
  };
  return normalized;
}

function normalizeReviewArtifact(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RoutingControlError(400, `review_artifacts.${name} 必须提供 ref 或 fingerprint。`, "REVIEW_ARTIFACTS_INCOMPLETE");
  }
  const ref = clean(value.ref, 1_000);
  const fingerprint = clean(value.fingerprint, 300);
  if (!ref && !fingerprint) throw new RoutingControlError(400, `review_artifacts.${name} 必须提供 ref 或 fingerprint。`, "REVIEW_ARTIFACTS_INCOMPLETE");
  return { ref: ref || null, fingerprint: fingerprint || null };
}

function fallbackReasonFor(health) {
  if (health.state === "open") return "preferred_model_circuit_open";
  if (health.state === "half_open") return "preferred_model_half_open_probe_leased";
  return "preferred_model_concurrency_limit_reached";
}

function detailedFallbackReason(preferredModel, health) {
  if (health.state === "open") return `${modelSlug(preferredModel)}_circuit_open_until_${health.retryAfterAt}`;
  if (health.state === "half_open") return `${modelSlug(preferredModel)}_half_open_probe_leased`;
  return `${modelSlug(preferredModel)}_concurrency_limit_reached`;
}

function signatureOf(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function modelSlug(model) {
  return model.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
}
