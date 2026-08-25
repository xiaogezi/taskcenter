const workflowProfiles = new Set(["fast", "standard", "strict"]);
const reviewPolicies = new Set(["not_required", "recommended", "required"]);
const executionEnvironments = new Set(["local", "worktree", "ci", "remote", "other"]);
const verificationKinds = new Set(["test", "build", "lint", "static_check", "device", "manual", "security", "performance", "other"]);
const requirementStatuses = new Set(["pending", "passed", "failed", "not_applicable"]);
const claimStatuses = new Set(["passed", "failed", "skipped"]);
const reviewVerdicts = new Set(["approved", "changes_requested", "rejected"]);
const reviewContractVersions = new Set(["legacy", "v2", "v3"]);
const specVerdicts = new Set(["compliant", "issues_found", "not_evaluated"]);
const qualityVerdicts = new Set(["approved", "needs_fixes", "not_evaluated"]);
const reviewScopes = new Set(["full", "incremental"]);
const reviewCyclePhases = new Set(["pending_review", "reviewing", "fixing", "verifying", "completed"]);
const reviewCyclePhaseOrder = ["pending_review", "reviewing", "fixing", "verifying", "completed"];
const reviewCycleOutcomes = new Set(["pending", "changes_requested", "approved", "rejected", "cancelled"]);
const findingSeverities = new Set(["p0", "p1", "p2", "p3", "unknown"]);
const findingValidities = new Set(["valid", "duplicate", "false_positive", "unknown"]);
const findingStatuses = new Set(["resolved", "unresolved"]);
const diagnosticOutcomes = new Set(["resolved", "unresolved"]);
const freshVerificationStatuses = new Set(["passed", "failed", "not_run"]);
const subjectTypes = new Set(["git_commit", "git_worktree_snapshot", "pull_request_head", "artifact", "document_version", "external", "none"]);
const actorTypes = new Set(["human", "agent", "ci", "review_platform", "task_platform", "other"]);
const acceptanceSources = new Set(["human", "pull_request", "ci", "task_platform", "context_agent", "manual", "other"]);

export function normalizeTaskContract(input, current = null) {
  const requested = input.contract_version === "v2" || ["scope", "non_goals", "workflow_profile", "review_policy", "execution_environment", "verification_plan", "workspace_policy"].some((field) => input[field] !== undefined);
  if (!requested && current?.contractVersion !== "v2") return { contractVersion: "legacy" };
  const scope = strings(input.scope ?? current?.scope, 50, 500);
  const nonGoals = strings(input.non_goals ?? current?.nonGoals, 50, 500);
  const workflowProfile = enumeration(input.workflow_profile ?? current?.workflowProfile, workflowProfiles, "");
  // L1/L2 do not require review unless callers opt in; L3 always does.
  const reviewPolicy = enumeration(input.review_policy ?? current?.reviewPolicy, reviewPolicies, workflowProfile === "strict" ? "required" : "not_required");
  const environment = (input.execution_environment ?? current?.executionEnvironment) === "either" ? "other" : (input.execution_environment ?? current?.executionEnvironment);
  const executionEnvironment = enumeration(environment, executionEnvironments, "");
  const verificationPlan = normalizeVerificationPlan(input.verification_plan ?? current?.verificationPlan);
  const acceptanceInput = Array.isArray(input.acceptance_criteria) && input.acceptance_criteria.length ? input.acceptance_criteria : (current?.acceptanceRequirements ?? current?.acceptanceCriteria);
  const acceptanceRequirements = normalizeCriteria(acceptanceInput);
  if (!String(input.goal || current?.goal || "").trim() || !scope.length || !Array.isArray(input.non_goals ?? current?.nonGoals) || !acceptanceRequirements.length || !workflowProfile) throw failure("v2 任务必须填写 goal、scope、non_goals、acceptance_criteria 和 workflow_profile。");
  if (["standard", "strict"].includes(workflowProfile) && !verificationPlan.length) throw failure(`${workflowProfile} 任务必须至少声明一项 verification_plan。`);
  const workspacePolicy = normalizeWorkspacePolicy(input.workspace_policy ?? current?.workspacePolicy, workflowProfile, reviewPolicy);
  return { contractVersion: "v2", scope, nonGoals, workflowProfile, reviewPolicy, executionEnvironment, verificationPlan, acceptanceRequirements, workspacePolicy, policyVersion: workspacePolicy.version };
}

export function normalizeSubjectReference(value, fallbackObservedAt = "") {
  if (!value || typeof value !== "object") return null;
  const type = enumeration(value.type, subjectTypes, "");
  const observedAt = text(value.observed_at, 80) || fallbackObservedAt;
  if (!type || !observedAt || !Number.isFinite(Date.parse(observedAt))) return null;
  const result = { type, observed_at: observedAt };
  for (const field of ["value", "repository", "branch"]) if (text(value[field], 500)) result[field] = text(value[field], 500);
  return type !== "none" && !result.value ? null : result;
}

export function normalizeActorIdentity(value, fallback = {}) {
  if (typeof value === "string" && value.trim()) return { type: "other", id: text(value, 200), display_name: text(value, 200) };
  const actor = value && typeof value === "object" ? value : fallback;
  const id = text(actor?.id, 200) || text(fallback.id, 200);
  if (!id) return null;
  const result = { type: enumeration(actor?.type, actorTypes, fallback.type || "other"), id };
  for (const field of ["display_name", "provider", "session_id"]) if (text(actor?.[field] ?? fallback[field], 200)) result[field] = text(actor?.[field] ?? fallback[field], 200);
  return result;
}

export function normalizeCompletionEvent(input) {
  const occurredAt = text(input.occurred_at, 80);
  const subject = normalizeSubjectReference(input.subject_ref, occurredAt) || legacySubject(input.revision, occurredAt || input.created_at || "1970-01-01T00:00:00.000Z");
  return {
    ...(input.contract_version !== undefined ? { contract_version: text(input.contract_version, 20) } : {}),
    ...(input.scope !== undefined ? { scope: strings(input.scope, 50, 500) } : {}),
    ...(input.non_goals !== undefined ? { non_goals: strings(input.non_goals, 50, 500) } : {}),
    ...(input.workflow_profile !== undefined ? { workflow_profile: enumeration(input.workflow_profile, workflowProfiles, "") } : {}),
    ...(input.review_policy !== undefined ? { review_policy: enumeration(input.review_policy, reviewPolicies, "") } : {}),
    ...(input.execution_environment !== undefined ? { execution_environment: input.execution_environment } : {}),
    ...(input.verification_plan !== undefined ? { verification_plan: normalizeVerificationPlan(input.verification_plan) } : {}),
    ...(input.workspace_policy !== undefined ? { workspace_policy: input.workspace_policy } : {}),
    revision: text(input.revision, 500), subject_ref: subject,
    requirement_result: normalizeRequirementResult(input.requirement_result, occurredAt),
    verification_claim: normalizeVerificationClaim(input.verification_claim, occurredAt),
    close_requirements: Array.isArray(input.close_requirements)
      ? input.close_requirements.slice(0, 50).map((item) => normalizeRequirementResult(item, occurredAt))
      : [],
    close_verifications: Array.isArray(input.close_verifications)
      ? input.close_verifications.slice(0, 30).map((item) => normalizeVerificationClaim(item, occurredAt))
      : [],
    review_attestation: normalizeReview(input.review_attestation, occurredAt),
    review_cycle: normalizeReviewCycle(input.review_cycle, occurredAt),
    diagnostic_observation: normalizeDiagnosticObservation(input.diagnostic_observation, occurredAt),
    acceptance_record: normalizeAcceptance(input.acceptance_record, occurredAt),
    context_completion_id: text(input.context_completion_id, 200), authorization_id: text(input.authorization_id, 200), reason: text(input.reason, 1_000),
    actor: normalizeActorIdentity(input.actor, { type: input.agent && input.agent !== "unknown" ? "agent" : "other", id: input.session_id || (input.agent !== "unknown" ? input.agent : ""), provider: input.provider, session_id: input.session_id }),
    occurred_at: occurredAt,
  };
}

export function applyCompletionEvent(task, event) {
  let next = { ...task };
  const taskMutation = ["task.create", "task.update", "task.report", "task.close"].includes(event.type);
  if (taskMutation) next = { ...next, ...normalizeTaskContract(event, next) };
  if ((taskMutation || event.type === "subject.updated") && event.subject_ref) next.currentSubject = event.subject_ref;
  if (taskMutation && event.revision) {
    next.currentRevision = event.revision;
    if (!event.subject_ref) next.currentSubject = legacySubject(event.revision, event.occurred_at || event.created_at);
  }
  if (event.type === "subject.updated" && !event.subject_ref) throw failure("subject.updated 缺少有效 subject_ref。");
  if (event.type === "requirement.reported") {
    const result = event.requirement_result;
    if (!result.requirement_id || !result.status) throw failure("Requirement Result 缺少 requirement_id 或 status。");
    if (!criteria(next).some((item) => item.id === result.requirement_id)) throw failure("requirement_id 不属于该任务的 acceptance criteria。", 404);
    if (result.status === "not_applicable" && !result.note) throw failure("not_applicable 必须填写原因。");
    if (["passed", "failed"].includes(result.status) && !result.evidence_refs.length) throw failure("验收条件通过或失败时必须引用证据。");
    next.requirementResults = [...(next.requirementResults || []), { ...result, checked_at: result.checked_at || event.occurred_at || event.created_at }];
  }
  if (event.type === "verification.reported") {
    const claim = normalizeVerificationClaim(event.verification_claim, event.occurred_at || event.created_at);
    if (!claim.id || !claim.kind || !claim.status || !claim.observed_at || !claim.producer) throw failure("Verification Claim 字段不完整。");
    if (["standard", "strict"].includes(next.workflowProfile) && !claim.subject_ref) throw failure(`${next.workflowProfile} 验证证据必须绑定 SubjectReference。`);
    if ((next.verificationClaims || []).some((item) => item.id === claim.id)) throw failure("Verification Claim id 已存在；请使用新 id 追加证据。", 409);
    rejectSecrets([claim.command_or_probe, claim.evidence_ref, claim.summary, ...(claim.artifact_refs || [])]);
    next.verificationClaims = [...(next.verificationClaims || []), claim];
  }
  if (event.type === "task.close") {
    for (const requirementResult of event.close_requirements || []) {
      next = applyCompletionEvent(next, {
        ...event,
        type: "requirement.reported",
        requirement_result: requirementResult,
        close_requirements: [],
        close_verifications: [],
      });
    }
    for (const verificationClaim of event.close_verifications || []) {
      next = applyCompletionEvent(next, {
        ...event,
        type: "verification.reported",
        verification_claim: verificationClaim,
        close_requirements: [],
        close_verifications: [],
      });
    }
  }
  if (event.type === "review.reported") {
    const review = normalizeReview(event.review_attestation, event.occurred_at || event.created_at);
    if (!review.id || !review.reviewer || !review.subject_ref || !review.scope || !review.verdict || !review.observed_at) throw failure("Review Attestation 字段不完整。");
    if (review.verdict === "approved" && review.unresolved_findings > 0) throw failure("存在未解决 findings 时不能提交 approved 审查。", 409);
    validateReviewVerdicts(review);
    if ((next.reviewAttestations || []).some((item) => item.id === review.id)) throw failure("Review Attestation id 已存在；请使用新 id 追加复审。", 409);
    validateReviewCycleLink(next, review);
    const duplicate = review.verdict === "approved"
      ? (next.reviewAttestations || []).find((item) => item.effective_review !== false && item.verdict === "approved" && sameSubject(item.subject_ref, review.subject_ref))
      : null;
    next.reviewAttestations = [...(next.reviewAttestations || []), duplicate
      ? { ...review, effective_review: false, duplicate_of_attestation_id: duplicate.id }
      : { ...review, effective_review: true }];
  }
  if (event.type === "review_cycle.reported") {
    const cycle = normalizeReviewCycle(event.review_cycle, event.occurred_at || event.created_at);
    if (!cycle.cycle_id || !cycle.subject_ref || !cycle.reviewer || !cycle.model || !cycle.review_scope) throw failure("Review Cycle 字段不完整。");
    const cycles = next.reviewCycles || [];
    const existingIndex = cycles.findIndex((item) => item.cycle_id === cycle.cycle_id);
    const existing = existingIndex >= 0 ? cycles[existingIndex] : null;
    if (existing) validateCycleIdentity(existing, cycle);
    const merged = {
      ...(existing || {}),
      ...cycle,
      cycle_number: existing?.cycle_number || cycles.length + 1,
    };
    validateReviewCycle(merged);
    next.reviewCycles = existing
      ? cycles.map((item, index) => index === existingIndex ? merged : item)
      : [...cycles, merged];
  }
  if (event.type === "diagnostic.reported") {
    const observation = normalizeDiagnosticObservation(event.diagnostic_observation, event.occurred_at || event.created_at);
    if (!observation.case_id || !observation.observed_at || !observation.started_at || !observation.outcome) throw failure("Diagnostic Observation 字段不完整。");
    if (![observation.observed_at, observation.started_at, observation.root_cause_at].filter(Boolean).every((value) => Number.isFinite(Date.parse(value)))) throw failure("Diagnostic Observation 时间字段必须是可解析的 ISO 时间。");
    if ((next.diagnosticObservations || []).some((item) => item.case_id === observation.case_id)) throw failure("Diagnostic Observation case_id 已存在；请使用同一任务内唯一 id。", 409);
    if (observation.root_cause_at && Date.parse(observation.root_cause_at) < Date.parse(observation.started_at)) throw failure("root_cause_at 不能早于 started_at。");
    if (observation.outcome === "resolved" && (!observation.root_cause_at || observation.fresh_verification === "not_run" || !observation.evidence_refs.length)) throw failure("resolved 调试案例必须记录 root_cause_at、新鲜验证结果和证据引用。");
    next.diagnosticObservations = [...(next.diagnosticObservations || []), observation];
  }
  if (["acceptance.accepted", "acceptance.rejected"].includes(event.type)) {
    const outcome = event.type.endsWith("accepted") ? "accepted" : "rejected";
    const record = event.acceptance_record?.id ? event.acceptance_record : legacyAcceptance(next, event, outcome);
    validateAcceptance(next, record, outcome);
    if (outcome === "accepted") {
      const readiness = computeCompletionReadiness(next, record.subject_ref || next.currentSubject);
      if (!readiness.ready) throw failure(`任务尚未就绪：${readiness.reasons.join(", ")}`, 409);
    }
    next.acceptanceRecords = [...(next.acceptanceRecords || []), { ...record, outcome }];
    next.acceptanceRecord = outcome === "accepted" ? record : null;
    if (outcome === "rejected") { next.acceptanceRejectedAt = record.observed_at; next.acceptanceRejectionReason = record.reason || "rejected"; }
  }
  return withCompletionState(next);
}

export function withCompletionState(task) {
  const currentSubject = task.currentSubject || legacySubject(task.currentRevision, task.updatedAt || task.createdAt);
  const migrated = {
    ...task, contractVersion: task.contractVersion || "legacy", currentSubject,
    acceptanceRequirements: criteria(task),
    requirementResults: Array.isArray(task.requirementResults) ? task.requirementResults : [],
    verificationClaims: (task.verificationClaims || []).map((item) => item?.subject_ref && typeof item.producer === "object" ? item : normalizeVerificationClaim(item, item?.observed_at)),
    reviewAttestations: (task.reviewAttestations || []).map((item) => item?.subject_ref && typeof item.reviewer === "object" ? item : normalizeReview(item, item?.observed_at)),
    reviewCycles: Array.isArray(task.reviewCycles) ? task.reviewCycles.map((item) => normalizeReviewCycle(item, item?.observed_at)) : [],
    diagnosticObservations: Array.isArray(task.diagnosticObservations) ? task.diagnosticObservations.map((item) => normalizeDiagnosticObservation(item, item?.observed_at)) : [],
    acceptanceRecords: Array.isArray(task.acceptanceRecords) ? task.acceptanceRecords : task.acceptanceRecord ? [migrateAcceptance(task.acceptanceRecord, task)] : [],
  };
  migrated.workspacePolicy = normalizeWorkspacePolicy(task.workspacePolicy, task.workflowProfile, task.reviewPolicy);
  migrated.policyVersion = task.policyVersion || migrated.workspacePolicy.version;
  const readiness = computeCompletionReadiness(migrated);
  const latest = migrated.acceptanceRecords.at(-1);
  let acceptanceStatus = latest?.outcome || (readiness.ready ? "ready" : "pending");
  if (latest?.outcome === "accepted" && !sameSubject(latest.subject_ref, migrated.currentSubject)) acceptanceStatus = "stale";
  return { ...migrated, executionStatus: migrated.status, verificationStatus: verificationStatusOf(migrated), reviewStatus: reviewStatusOf(migrated), acceptanceStatus, completionReadiness: readiness };
}

export function computeCompletionReadiness(task, subject = task.currentSubject || null) {
  const currentSubject = typeof subject === "string" ? legacySubject(subject, task.updatedAt || task.createdAt) : subject;
  const reasons = [], missingRequirements = [], failedRequirements = [], staleEvidence = [], unresolvedFindings = [];
  if ((task.contractVersion || "legacy") !== "v2") reasons.push("legacy_contract");
  if (task.status !== "done_claimed") reasons.push("execution_not_done_claimed");
  if (task.blocker) reasons.push("task_blocked");
  if (["standard", "strict"].includes(task.workflowProfile) && !currentSubject) reasons.push("current_subject_missing");
  const results = latestBy(task.requirementResults || [], "requirement_id");
  for (const requirement of criteria(task)) {
    if (!requirement.required) continue;
    const result = results.get(requirement.id);
    if (!result || !["passed", "not_applicable"].includes(result.status)) {
      (result?.status === "failed" ? failedRequirements : missingRequirements).push(requirement.id);
      reasons.push(result?.status === "failed" ? "acceptance_criterion_failed" : "acceptance_criterion_pending");
    } else if (result.subject_ref && currentSubject && !sameSubject(result.subject_ref, currentSubject)) {
      staleEvidence.push(`requirement:${requirement.id}`);
      reasons.push("requirement_result_stale");
    }
  }
  for (const requirement of task.verificationPlan || []) {
    if (!requirement.required) continue;
    const claim = (task.verificationClaims || []).filter((item) => item.requirement_id === requirement.id || (!item.requirement_id && item.kind === requirement.kind)).at(-1);
    if (!claim || claim.status === "skipped") { missingRequirements.push(requirement.id); reasons.push("required_verification_missing"); }
    else if (claim.status !== "passed") { failedRequirements.push(requirement.id); reasons.push("verification_failed"); }
    else {
      if (currentSubject && !sameSubject(claim.subject_ref, currentSubject)) { staleEvidence.push(claim.id); reasons.push("verification_stale"); }
      if (["standard", "strict"].includes(task.workflowProfile) && !hasPortableEvidence(claim)) reasons.push("portable_evidence_missing");
    }
  }
  if (reviewRequired(task)) {
    const review = (task.reviewAttestations || []).filter((item) => item.effective_review !== false).at(-1);
    if (!review) reasons.push("required_review_missing");
    else {
      if (currentSubject && !sameSubject(review.subject_ref, currentSubject)) { staleEvidence.push(review.id); reasons.push("review_stale"); }
      if (review.unresolved_findings > 0) { unresolvedFindings.push(...(review.finding_refs?.length ? review.finding_refs : [review.id])); reasons.push("unresolved_findings_exist"); }
      if (["v2", "v3"].includes(review.review_contract_version)) {
        if (review.spec_verdict !== "compliant") reasons.push("review_spec_not_compliant");
        if (review.quality_verdict !== "approved") reasons.push("review_quality_not_approved");
        if (review.unverified_requirements.length) {
          missingRequirements.push(...review.unverified_requirements.map((item) => item.requirement_id));
          reasons.push("review_requirements_unverified");
        }
      }
      if (review.verdict === "rejected") reasons.push("review_rejected");
      else if (review.verdict !== "approved") reasons.push("review_changes_requested");
      if (task.workspacePolicy?.requireIndependentReview !== false && !independent(task.ownerActor, review.reviewer)) reasons.push("reviewer_not_independent");
    }
  }
  return {
    ready: reasons.length === 0,
    completionClaim: { allowed: reasons.length === 0, status: reasons.length === 0 ? "ready" : "blocked", blockingReasons: [...new Set(reasons)] },
    executionStatus: task.status || "planned", verificationStatus: verificationStatusOf({ ...task, currentSubject }), reviewStatus: reviewStatusOf({ ...task, currentSubject }), acceptanceStatus: task.acceptanceStatus || "pending",
    currentSubject: currentSubject || null, reasons: [...new Set(reasons)], missingRequirements: [...new Set(missingRequirements)], failedRequirements: [...new Set(failedRequirements)], staleEvidence: [...new Set(staleEvidence)], unresolvedFindings: [...new Set(unresolvedFindings)],
  };
}

export function buildCompletionPacket(task) {
  const value = withCompletionState(task);
  const reviewProcess = buildReviewProcess(value);
  const normalizedRevision = value.currentSubject?.value || value.currentRevision || "";
  return {
    schemaVersion: "taskcenter-completion-v2", policyVersion: value.policyVersion,
    taskId: value.id,
    taskContract: { contractVersion: value.contractVersion, goal: value.goal, scope: value.scope || [], nonGoals: value.nonGoals || [], acceptanceCriteria: value.acceptanceRequirements, workflowProfile: value.workflowProfile, reviewPolicy: value.reviewPolicy, executionEnvironment: value.executionEnvironment, verificationPlan: value.verificationPlan || [], workspacePolicy: value.workspacePolicy },
    currentSubject: value.currentSubject || null, requirementResults: value.requirementResults, verificationClaims: value.verificationClaims, reviewAttestations: value.reviewAttestations, reviewCycles: value.reviewCycles, reviewProcess, diagnosticObservations: value.diagnosticObservations, acceptanceRecords: value.acceptanceRecords, completionReadiness: value.completionReadiness,
    currentRevision: normalizedRevision,
    ...(value.currentRevision && value.currentRevision !== normalizedRevision ? { legacyCurrentRevision: value.currentRevision } : {}),
    verificationStatus: value.verificationStatus, reviewStatus: value.reviewStatus, acceptanceStatus: value.acceptanceStatus,
  };
}

export function completionPacketMarkdown(task) {
  const packet = buildCompletionPacket(task), readiness = packet.completionReadiness;
  return [`# TaskCenter Completion Packet: ${task.title || task.id}`, "", `- Task ID: ${task.id}`, `- Policy: ${packet.policyVersion}`, `- Ready: ${readiness.ready ? "yes" : "no"}`, `- Completion claim allowed: ${readiness.completionClaim.allowed ? "yes" : "no"}`, `- Subject: ${packet.currentSubject ? `${packet.currentSubject.type}:${packet.currentSubject.value || "none"}` : "none"}`, "", "## Readiness", "", ...(readiness.reasons.length ? readiness.reasons.map((item) => `- ${item}`) : ["- ready"]), "", "## Acceptance criteria", "", ...packet.taskContract.acceptanceCriteria.map((item) => `- [${item.required ? "x" : " "}] ${item.id}: ${item.description}`), "", "## Verification claims", "", ...(packet.verificationClaims.length ? packet.verificationClaims.map((item) => `- ${item.id}: ${item.kind} / ${item.status}`) : ["- none"]), "", "## Reviews", "", `- Effective cycles: ${packet.reviewProcess.totalCycles}`, `- Changes requested: ${packet.reviewProcess.changesRequestedCycles}`, `- Fallback occurred: ${packet.reviewProcess.fallbackOccurred ? "yes" : "no"}`, `- Long-tail warnings: ${packet.reviewProcess.reviewLoopWarnings.length}`, `- Final approved subject: ${packet.reviewProcess.finalApprovedSubject ? `${packet.reviewProcess.finalApprovedSubject.type}:${packet.reviewProcess.finalApprovedSubject.value || "none"}` : "none"}`, ...(packet.reviewProcess.cycles.length ? packet.reviewProcess.cycles.map((item) => `- cycle ${item.cycleNumber}: reviewer=${item.reviewer?.id || "unknown"} / model=${item.model || "unknown"} / scope=${item.reviewScope || "legacy"} / verdict=${item.verdict || item.outcome || "pending"}`) : ["- none"]), "", "## Acceptance records", "", ...(packet.acceptanceRecords.length ? packet.acceptanceRecords.map((item) => `- ${item.id}: ${item.outcome} via ${item.source}`) : ["- none"]), ""].join("\n");
}

function buildReviewProcess(task) {
  const attestations = (task.reviewAttestations || []).filter((item) => item.effective_review !== false);
  const attestationByCycle = new Map(attestations.filter((item) => item.cycle_id).map((item) => [item.cycle_id, item]));
  const cycles = (task.reviewCycles || []).map((cycle) => {
    const attestation = attestationByCycle.get(cycle.cycle_id);
    return {
      cycleId: cycle.cycle_id, cycleNumber: cycle.cycle_number, reviewer: cycle.reviewer || attestation?.reviewer || null,
      model: cycle.model || "", reviewScope: cycle.review_scope || attestation?.review_scope || "legacy", baseAttestationId: cycle.base_attestation_id || attestation?.base_attestation_id || "",
      subjectRef: cycle.subject_ref || attestation?.subject_ref || null, verdict: attestation?.verdict || "", outcome: cycle.outcome || "pending",
      findingSummary: attestation?.finding_summary || { total: 0, resolved: 0, unresolved: attestation?.unresolved_findings || 0 },
      fallback: Boolean(cycle.fallback_from || cycle.fallback_reason), fallbackFrom: cycle.fallback_from || "", fallbackReason: cycle.fallback_reason || "",
    };
  });
  const routingFallbacks = (task.routingHistory || []).filter((item) => item.fallbackFrom || (item.preferredExecutorModel && item.selectedExecutorModel && item.preferredExecutorModel !== item.selectedExecutorModel));
  const fingerprints = attestations.flatMap((item) => item.findings || []).map((item) => item.fingerprint).filter(Boolean);
  const reviewLoopWarnings = [];
  const span = (start, end) => start && end ? Math.max(0, Date.parse(end) - Date.parse(start)) : null;
  const subjectKey = (value) => value ? `${value.type || "artifact"}:${value.value || ""}` : "none";
  const cycleTiming = (task.reviewCycles || []).map((cycle) => {
    const wallEnd = cycle.verification_finished_at || cycle.fix_finished_at || cycle.review_finished_at;
    return {
      cycle,
      waitMs: span(cycle.review_requested_at, cycle.review_started_at),
      reviewMs: span(cycle.review_started_at, cycle.review_finished_at),
      fixMs: span(cycle.fix_started_at, cycle.fix_finished_at),
      wallMs: span(cycle.implementation_ready_at, wallEnd),
    };
  });
  if (attestations.filter((item) => item.verdict === "changes_requested").length > 2) reviewLoopWarnings.push("changes_requested_over_two");
  if ((task.reviewAttestations || []).some((item) => item.effective_review === false && item.duplicate_of_attestation_id)) reviewLoopWarnings.push("duplicate_approved");
  if ([...new Set(fingerprints)].some((fingerprint) => fingerprints.filter((item) => item === fingerprint).length > 1)) reviewLoopWarnings.push("repeated_finding");
  if (cycleTiming.some(({ waitMs, reviewMs, fixMs }) => Number.isFinite(waitMs) && waitMs > (reviewMs || 0) + (fixMs || 0))) reviewLoopWarnings.push("review_wait_dominates");
  if (cycleTiming.some(({ cycle }) => !["approved", "rejected", "cancelled"].includes(cycle.outcome || "pending"))) reviewLoopWarnings.push("review_cycle_in_progress");
  if (cycleTiming.some(({ wallMs }) => Number.isFinite(wallMs) && wallMs > 24 * 60 * 60_000)) reviewLoopWarnings.push("overnight_wall_clock_distortion");
  const fullSubjects = (task.reviewCycles || []).filter((item) => item.review_scope === "full").map((item) => subjectKey(item.subject_ref));
  if ([...new Set(fullSubjects)].some((subject) => fullSubjects.filter((item) => item === subject).length > 1)) reviewLoopWarnings.push("repeated_full_review_same_subject");
  const reviewWallMs = cycleTiming.reduce((sum, item) => sum + (item.wallMs || 0), 0);
  const taskStart = Date.parse(task.firstStartedAt || task.startedAt || task.createdAt || "");
  const taskEnd = Date.parse(task.acceptedAt || task.completedAt || task.updatedAt || "");
  if (["verified", "accepted"].includes(task.status) || task.acceptanceStatus === "accepted") {
    const taskWallMs = taskEnd - taskStart;
    if (Number.isFinite(taskWallMs) && taskWallMs > 0 && reviewWallMs / taskWallMs > 0.5) reviewLoopWarnings.push("review_stage_ratio_high");
  }
  const finalApproved = attestations.filter((item) => item.verdict === "approved").at(-1);
  return {
    totalCycles: attestations.length, changesRequestedCycles: attestations.filter((item) => item.verdict === "changes_requested").length,
    cycles, fallbackOccurred: routingFallbacks.length > 0 || cycles.some((item) => item.fallback),
    fallbacks: routingFallbacks.map((item) => ({ fallbackFrom: item.fallbackFrom || item.preferredExecutorModel || "", fallbackReason: item.fallbackReason || item.reason || "", selectedModel: item.selectedExecutorModel || "" })),
    reviewLoopWarnings: [...new Set(reviewLoopWarnings)], finalApprovedSubject: finalApproved?.subject_ref || null,
  };
}

function normalizeCriteria(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, 50).flatMap((item, index) => {
    const source = typeof item === "string" ? { id: `acceptance-${index + 1}`, description: item, required: true } : item;
    if (!source || typeof source !== "object") return [];
    const id = text(source.id, 120) || `acceptance-${index + 1}`, description = text(source.description ?? source.title, 500);
    if (!description || seen.has(id)) return [];
    seen.add(id);
    return [{ id, description, title: description, required: source.required !== false }];
  });
}

function criteria(task) { return normalizeCriteria(task.acceptanceRequirements?.length ? task.acceptanceRequirements : task.acceptanceCriteria); }

function normalizeVerificationPlan(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, 30).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const id = text(item.id, 120), title = text(item.title, 300), kind = enumeration(item.kind, verificationKinds, "");
    if (!id || !title || !kind || seen.has(id)) return [];
    seen.add(id);
    return [{ id, title, kind, required: item.required !== false, ...(text(item.suggested_command, 500) ? { suggested_command: text(item.suggested_command, 500) } : {}) }];
  });
}

function normalizeWorkspacePolicy(value, profile, reviewPolicy) {
  const source = value && typeof value === "object" ? value : {};
  return {
    version: text(source.version, 80) || "workspace-policy-v1",
    requireIndependentReview: source.require_independent_review ?? source.requireIndependentReview ?? (profile === "strict" || reviewPolicy === "required"),
    allowedAcceptanceSources: enums(source.allowed_acceptance_sources ?? source.allowedAcceptanceSources, acceptanceSources),
    allowedAcceptanceActors: strings(source.allowed_acceptance_actors ?? source.allowedAcceptanceActors, 100, 200),
  };
}

function normalizeRequirementResult(value, fallbackAt) {
  if (!value || typeof value !== "object") return {};
  return { requirement_id: text(value.requirement_id, 120), status: enumeration(value.status, requirementStatuses, ""), evidence_refs: strings(value.evidence_refs, 30, 500), checked_at: text(value.checked_at, 80) || fallbackAt, checked_by: normalizeActorIdentity(value.checked_by), subject_ref: normalizeSubjectReference(value.subject_ref, value.checked_at || fallbackAt), revision: text(value.revision, 500), note: text(value.note, 1_000) };
}

function normalizeVerificationClaim(value, fallbackAt) {
  if (!value || typeof value !== "object") return {};
  const observedAt = text(value.observed_at, 80) || fallbackAt;
  return { id: text(value.id, 120), requirement_id: text(value.requirement_id, 120), kind: enumeration(value.kind, verificationKinds, ""), command_or_probe: text(value.command_or_probe, 1_000), status: enumeration(value.status, claimStatuses, ""), ...(Number.isInteger(value.exit_code) ? { exit_code: value.exit_code } : {}), subject_ref: normalizeSubjectReference(value.subject_ref, observedAt) || legacySubject(value.revision, observedAt), revision: text(value.revision, 500), observed_at: observedAt, producer: normalizeActorIdentity(value.producer, { type: "agent", id: value.producer_session_id || "" }), evidence_ref: text(value.evidence_ref, 500), artifact_refs: strings(value.artifact_refs, 30, 500), summary: text(value.summary, 1_000) };
}

function normalizeReview(value, fallbackAt) {
  if (!value || typeof value !== "object") return {};
  const observedAt = text(value.observed_at, 80) || fallbackAt;
  const hasV2Fields = value.spec_verdict !== undefined || value.quality_verdict !== undefined || value.unverified_requirements !== undefined;
  const hasV3Fields = value.cycle_id !== undefined || value.review_scope !== undefined || value.findings !== undefined;
  const contractVersion = enumeration(value.review_contract_version, reviewContractVersions, hasV3Fields ? "v3" : hasV2Fields ? "v2" : "legacy");
  const findings = contractVersion === "v3" ? normalizeFindings(value.findings) : [];
  const unresolved = contractVersion === "v3" ? findings.filter((item) => item.status === "unresolved").length : Number.isInteger(value.unresolved_findings) && value.unresolved_findings >= 0 ? value.unresolved_findings : 0;
  return {
    id: text(value.id, 120), reviewer: normalizeActorIdentity(value.reviewer, { type: "agent", id: value.reviewer_session_id || "" }),
    subject_ref: normalizeSubjectReference(value.subject_ref, observedAt) || legacySubject(value.revision, observedAt), revision: text(value.revision, 500), scope: text(value.scope, 1_000),
    review_contract_version: contractVersion, spec_verdict: enumeration(value.spec_verdict, specVerdicts, hasV2Fields || hasV3Fields ? "not_evaluated" : ""), quality_verdict: enumeration(value.quality_verdict, qualityVerdicts, hasV2Fields || hasV3Fields ? "not_evaluated" : ""),
    verdict: enumeration(value.verdict, reviewVerdicts, ""), unverified_requirements: normalizeUnverifiedRequirements(value.unverified_requirements), unresolved_findings: unresolved,
    observed_at: observedAt, authorization_id: text(value.authorization_id, 200), finding_refs: strings(value.finding_refs, 50, 500), summary: text(value.summary, 1_000),
    ...(contractVersion === "v3" ? {
      cycle_id: text(value.cycle_id, 120), cycle_number: positiveInteger(value.cycle_number), review_scope: enumeration(value.review_scope, reviewScopes, ""),
      base_attestation_id: text(value.base_attestation_id, 120), reviewed_files: strings(value.reviewed_files, 500, 500),
      changed_files_since_previous_review: strings(value.changed_files_since_previous_review, 500, 500), findings, finding_summary: summarizeFindings(findings),
    } : {}),
  };
}

function normalizeReviewCycle(value, fallbackAt) {
  if (!value || typeof value !== "object") return {};
  const optionalTime = (field) => text(value[field], 80);
  return {
    cycle_id: text(value.cycle_id, 120),
    ...(positiveInteger(value.cycle_number) ? { cycle_number: positiveInteger(value.cycle_number) } : {}),
    ...(normalizeSubjectReference(value.subject_ref, fallbackAt) ? { subject_ref: normalizeSubjectReference(value.subject_ref, fallbackAt) } : {}),
    ...(normalizeActorIdentity(value.reviewer) ? { reviewer: normalizeActorIdentity(value.reviewer) } : {}),
    ...(text(value.model, 120) ? { model: text(value.model, 120) } : {}),
    ...(enumeration(value.review_scope, reviewScopes, "") ? { review_scope: value.review_scope } : {}),
    ...(text(value.base_attestation_id, 120) ? { base_attestation_id: text(value.base_attestation_id, 120) } : {}),
    ...(enumeration(value.phase, reviewCyclePhases, "") ? { phase: value.phase } : {}),
    ...(enumeration(value.outcome, reviewCycleOutcomes, "") ? { outcome: value.outcome } : {}),
    ...(text(value.wait_reason, 500) ? { wait_reason: text(value.wait_reason, 500) } : {}),
    ...Object.fromEntries(["implementation_ready_at", "review_requested_at", "review_started_at", "review_finished_at", "fix_started_at", "fix_finished_at", "verification_finished_at"].flatMap((field) => optionalTime(field) ? [[field, optionalTime(field)]] : [])),
    ...Object.fromEntries(["review_active_ms", "fix_active_ms", "verification_active_ms"].flatMap((field) => nonNegativeIntegerOrNull(value[field]) !== null ? [[field, nonNegativeIntegerOrNull(value[field])]] : [])),
    observed_at: text(value.observed_at, 80) || fallbackAt,
  };
}

function normalizeFindings(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 500).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const findingId = text(item.finding_id, 160), fingerprint = text(item.fingerprint, 200);
    if (!findingId || !fingerprint) return [];
    return [{ finding_id: findingId, fingerprint, category: text(item.category, 120) || "unknown", severity: enumeration(item.severity, findingSeverities, "unknown"), validity: enumeration(item.validity, findingValidities, "unknown"), status: enumeration(item.status, findingStatuses, "unresolved") }];
  });
}

function summarizeFindings(findings) {
  const countBy = (field) => Object.fromEntries([...new Set(findings.map((item) => item[field]))].sort().map((key) => [key, findings.filter((item) => item[field] === key).length]));
  return { total: findings.length, by_category: countBy("category"), by_severity: countBy("severity"), by_validity: countBy("validity"), resolved: findings.filter((item) => item.status === "resolved").length, unresolved: findings.filter((item) => item.status === "unresolved").length };
}

function normalizeUnverifiedRequirements(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const requirement_id = text(item.requirement_id, 120), reason = text(item.reason, 1_000), required_evidence = text(item.required_evidence, 500);
    return requirement_id && reason ? [{ requirement_id, reason, ...(required_evidence ? { required_evidence } : {}) }] : [];
  });
}

function validateReviewVerdicts(review) {
  if (review.review_contract_version === "legacy") return;
  const approved = review.spec_verdict === "compliant" && review.quality_verdict === "approved" && review.unverified_requirements.length === 0 && review.unresolved_findings === 0;
  if (review.verdict === "approved" && !approved) throw failure("approved 要求 spec_verdict=compliant、quality_verdict=approved，且不存在未验证要求或未解决 findings。", 409);
  if (review.verdict === "rejected" && (review.spec_verdict !== "not_evaluated" || review.quality_verdict !== "not_evaluated" || review.unverified_requirements.length || review.unresolved_findings)) throw failure("rejected 要求两个分项 verdict 均为 not_evaluated，且不携带未验证要求或 findings。", 409);
  const hasRequestedChanges = review.spec_verdict === "issues_found" || review.quality_verdict === "needs_fixes" || review.unverified_requirements.length > 0 || review.unresolved_findings > 0;
  if (review.verdict === "changes_requested" && !hasRequestedChanges) throw failure("changes_requested 必须至少包含规格问题、质量问题、未验证要求或未解决 finding。", 409);
}

function validateReviewCycleLink(task, review) {
  if (review.review_contract_version !== "v3") return;
  if (!review.cycle_id || !review.cycle_number || !review.review_scope || !Array.isArray(review.reviewed_files) || !Array.isArray(review.findings)) throw failure("Review Attestation v3 缺少 cycle、scope、files 或 findings。");
  const cycle = (task.reviewCycles || []).find((item) => item.cycle_id === review.cycle_id);
  if (!cycle) throw failure("Review Attestation v3 引用的 cycle_id 不存在。", 404);
  if (cycle.cycle_number !== review.cycle_number || cycle.review_scope !== review.review_scope || !sameSubject(cycle.subject_ref, review.subject_ref)) throw failure("Review Attestation v3 与 Review Cycle 不一致。", 409);
  if (review.review_scope === "incremental") {
    if (!review.base_attestation_id) throw failure("incremental Review 必须引用 base_attestation_id。");
    const base = (task.reviewAttestations || []).find((item) => item.id === review.base_attestation_id && item.effective_review !== false);
    if (!base) throw failure("incremental Review 的 base Attestation 不存在或已失效。", 409);
    if (Number.isFinite(base.cycle_number) && base.cycle_number >= review.cycle_number) throw failure("incremental Review 的 base Attestation 必须来自更早轮次。", 409);
  }
}

function validateCycleIdentity(existing, incoming) {
  for (const field of ["model", "review_scope"]) if (incoming[field] && existing[field] !== incoming[field]) throw failure(`Review Cycle ${field} 不可变更。`, 409);
  if (incoming.subject_ref && !sameSubject(existing.subject_ref, incoming.subject_ref)) throw failure("Review Cycle SubjectReference 不可变更。", 409);
  if (incoming.reviewer && `${existing.reviewer?.type}:${existing.reviewer?.id}` !== `${incoming.reviewer.type}:${incoming.reviewer.id}`) throw failure("Review Cycle reviewer 不可变更。", 409);
  if (incoming.phase && existing.phase && reviewCyclePhaseOrder.indexOf(incoming.phase) < reviewCyclePhaseOrder.indexOf(existing.phase)) throw failure("Review Cycle phase 不能回退。", 409);
  if (existing.outcome && existing.outcome !== "pending" && incoming.outcome && incoming.outcome !== existing.outcome) throw failure("Review Cycle 终态 outcome 不可变更。", 409);
}

function validateReviewCycle(cycle) {
  const ordered = ["implementation_ready_at", "review_requested_at", "review_started_at", "review_finished_at", "fix_started_at", "fix_finished_at", "verification_finished_at"];
  let previous = -Infinity;
  for (const field of ordered) {
    if (!cycle[field]) continue;
    const instant = Date.parse(cycle[field]);
    if (!Number.isFinite(instant)) throw failure(`Review Cycle ${field} 必须是有效 ISO 时间。`);
    if (instant < previous) throw failure("Review Cycle 时间顺序无效。", 409);
    previous = instant;
  }
  for (const [activeField, startField, finishField] of [
    ["review_active_ms", "review_started_at", "review_finished_at"],
    ["fix_active_ms", "fix_started_at", "fix_finished_at"],
    ["verification_active_ms", "fix_finished_at", "verification_finished_at"],
  ]) {
    if (cycle[activeField] === undefined) continue;
    if (!cycle[startField] || !cycle[finishField]) throw failure(`${activeField} 要求同时提供阶段开始与结束时间。`);
    if (cycle[activeField] > Date.parse(cycle[finishField]) - Date.parse(cycle[startField])) throw failure(`${activeField} 不能大于对应阶段墙钟时间。`, 409);
  }
  if (cycle.review_scope === "incremental" && !cycle.base_attestation_id) throw failure("incremental Review Cycle 必须引用 base_attestation_id。");
}

function normalizeDiagnosticObservation(value, fallbackAt) {
  if (!value || typeof value !== "object") return {};
  const observedAt = text(value.observed_at, 80) || fallbackAt;
  return {
    case_id: text(value.case_id, 120),
    observed_at: observedAt,
    started_at: text(value.started_at, 80),
    root_cause_at: text(value.root_cause_at, 80),
    outcome: enumeration(value.outcome, diagnosticOutcomes, ""),
    hypothesis_count: nonNegativeInteger(value.hypothesis_count),
    failed_fix_count: nonNegativeInteger(value.failed_fix_count),
    rollback_count: nonNegativeInteger(value.rollback_count),
    fresh_verification: enumeration(value.fresh_verification, freshVerificationStatuses, "not_run"),
    evidence_refs: strings(value.evidence_refs, 30, 500),
    note: text(value.note, 1_000),
  };
}

function normalizeAcceptance(value, fallbackAt) {
  if (!value || typeof value !== "object") return {};
  return { id: text(value.id, 120), source: enumeration(value.source, acceptanceSources, ""), actor: normalizeActorIdentity(value.actor), subject_ref: normalizeSubjectReference(value.subject_ref, value.observed_at || fallbackAt), outcome: value.outcome === "rejected" ? "rejected" : "accepted", observed_at: text(value.observed_at, 80) || fallbackAt, authorization_id: text(value.authorization_id, 200), evidence_refs: strings(value.evidence_refs, 30, 500), reason: text(value.reason, 1_000) };
}

function validateAcceptance(task, record, outcome) {
  if (!record.id || !record.source || !record.actor || !record.observed_at || !Number.isFinite(Date.parse(record.observed_at))) throw failure("AcceptanceRecord 字段不完整。");
  const policy = normalizeWorkspacePolicy(task.workspacePolicy, task.workflowProfile, task.reviewPolicy);
  if (policy.allowedAcceptanceSources.length && !policy.allowedAcceptanceSources.includes(record.source)) throw failure("Workspace Policy 不允许该验收来源。", 403);
  if (policy.allowedAcceptanceActors.length && !policy.allowedAcceptanceActors.includes(record.actor.id)) throw failure("Workspace Policy 不允许该验收身份。", 403);
  if (outcome === "accepted" && !record.subject_ref) throw failure("accepted 验收必须绑定 SubjectReference。");
}

function legacyAcceptance(task, event, outcome) {
  return { id: event.context_completion_id || event.event_id, source: event.context_task_id ? "context_agent" : "manual", actor: event.actor || { type: "task_platform", id: "taskcenter" }, subject_ref: event.subject_ref || task.currentSubject || legacySubject(event.revision, event.created_at), outcome, observed_at: event.occurred_at || event.created_at, authorization_id: event.authorization_id, evidence_refs: [], reason: event.reason };
}

function migrateAcceptance(value, task) {
  return { ...value, id: value.id || value.contextCompletionId || `legacy-${task.id}`, source: value.source || (value.contextTaskId ? "context_agent" : "manual"), actor: normalizeActorIdentity(value.actor, { type: "task_platform", id: "taskcenter" }), subject_ref: value.subject_ref || legacySubject(value.revision, value.acceptedAt), outcome: value.outcome || "accepted", observed_at: value.observed_at || value.acceptedAt || task.updatedAt };
}

function verificationStatusOf(task) {
  const required = (task.verificationPlan || []).filter((item) => item.required);
  if (!required.length) return "not_required";
  const claims = required.map((item) => (task.verificationClaims || []).filter((claim) => claim.requirement_id === item.id || (!claim.requirement_id && claim.kind === item.kind)).at(-1));
  if (claims.some((claim) => claim?.status === "failed")) return "failed";
  if (claims.some((claim) => claim?.status === "passed" && task.currentSubject && !sameSubject(claim.subject_ref, task.currentSubject))) return "stale";
  return claims.every((claim) => claim?.status === "passed") ? "passed" : "pending";
}

function reviewStatusOf(task) {
  if (!reviewRequired(task) && task.reviewPolicy !== "recommended") return "not_required";
  const review = (task.reviewAttestations || []).filter((item) => item.effective_review !== false).at(-1);
  if (!review) return "pending";
  if (task.currentSubject && !sameSubject(review.subject_ref, task.currentSubject)) return "stale";
  if (review.verdict === "rejected") return "rejected";
  const v2Approved = review.review_contract_version !== "v2" || (review.spec_verdict === "compliant" && review.quality_verdict === "approved" && review.unverified_requirements.length === 0);
  if (review.verdict === "approved" && review.unresolved_findings === 0 && v2Approved && (task.workspacePolicy?.requireIndependentReview === false || independent(task.ownerActor, review.reviewer))) return "passed";
  return "changes_requested";
}

function reviewRequired(task) { return task.workflowProfile === "strict" || task.reviewPolicy === "required"; }
function sameSubject(left, right) { return Boolean(left && right && left.type === right.type && (left.value || "") === (right.value || "") && (left.repository || "") === (right.repository || "") && (left.branch || "") === (right.branch || "")); }
function independent(left, right) { return !left || !right || `${left.type}:${left.id}` !== `${right.type}:${right.id}`; }
function legacySubject(revision, observedAt) { return revision ? { type: "external", value: text(revision, 500), observed_at: observedAt || new Date().toISOString() } : null; }
function hasPortableEvidence(claim) { return [claim.evidence_ref, ...(claim.artifact_refs || [])].filter(Boolean).some((ref) => !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(ref)); }
function latestBy(items, field) { const result = new Map(); for (const item of items) if (item?.[field]) result.set(item[field], item); return result; }
function text(value, limit) { return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : ""; }
function nonNegativeInteger(value) { return Number.isInteger(value) && value >= 0 ? value : 0; }
function nonNegativeIntegerOrNull(value) { return Number.isInteger(value) && value >= 0 ? value : null; }
function positiveInteger(value) { return Number.isInteger(value) && value > 0 ? value : 0; }
function strings(value, count, length) { return Array.isArray(value) ? value.filter((item) => typeof item === "string").map((item) => text(item, length)).filter(Boolean).slice(0, count) : []; }
function enumeration(value, allowed, fallback) { return allowed.has(value) ? value : fallback; }
function enums(value, allowed) { return Array.isArray(value) ? [...new Set(value.filter((item) => allowed.has(item)))] : []; }
function failure(message, statusCode = 400) { const error = new Error(message); error.statusCode = statusCode; return error; }
function rejectSecrets(values) { if (values.some((value) => /(?:api[_-]?key|access[_-]?token|secret|password|authorization)\s*[:=]\s*\S+/i.test(String(value || "")))) throw failure("证据中疑似包含密钥、Token 或完整认证信息，已拒绝保存。"); }
