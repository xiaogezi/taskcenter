import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
export const taskReuseDecisionsPath = resolve(
  process.env.TASKCENTER_TASK_REUSE_DECISIONS_PATH
    || resolve(projectRoot, "data", "task-reuse-decisions.jsonl"),
);
export const taskReuseDecisionIndexPath = `${taskReuseDecisionsPath}.event-index`;

export const TASK_REUSE_ADVISOR_VERSION = "task-reuse-advisor-v1";
const UNKNOWN_PROJECT_ID = "unknown";
const decisionLockPath = `${taskReuseDecisionsPath}.lock`;
const decisionLockOwnerPath = join(decisionLockPath, "owner.json");
const decisionIndexStatePath = join(taskReuseDecisionIndexPath, "state.json");
const decisionLockWaiter = new Int32Array(new SharedArrayBuffer(4));
const decisionLockTimeoutMs = 5_000;
const decisionLockStaleMs = 30_000;
const candidateStatuses = new Set(["planned", "in_progress", "blocked", "done_claimed"]);
const decisions = new Set(["reuse", "create_new", "uncertain"]);
const ignoredTokens = new Set([
  "add", "code", "feature", "implement", "project", "support", "task", "test",
  "业务", "代码", "功能", "进行", "实现", "项目", "新增", "增加", "任务", "完成", "相关", "需求", "支持", "测试", "验证", "正式", "处理",
]);

export class TaskReuseAdvisorError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function taskReuseCheck(input, options = {}) {
  const request = normalizeCheckInput(input);
  const tasks = Array.isArray(options.tasks) ? options.tasks : [];
  const registry = options.sessionRegistry && typeof options.sessionRegistry === "object"
    ? options.sessionRegistry
    : {};
  const delegations = Array.isArray(options.delegations) ? options.delegations : [];
  const canonicalizeSession = typeof options.canonicalSessionId === "function"
    ? options.canonicalSessionId
    : (value) => String(value || "");
  const checkedAt = validNow(options.now);
  const requestSessionId = canonicalizeSession(request.session_id);
  const requestWorkspace = workspaceKey(request.workspace);
  const requesterOwners = new Set(tasks
    .filter((task) => canonicalizeSession(task.sessionId) === requestSessionId)
    .filter((task) => workspaceKey(task.workspace) === requestWorkspace)
    .map((task) => actorKey(task.ownerActor))
    .filter(Boolean));

  const candidates = tasks
    .filter(isEligibleCandidate)
    .map((task) => candidateFor(task, {
      request,
      registry,
      delegations,
      canonicalizeSession,
      requestSessionId,
      requestWorkspace,
      requesterOwners,
    }))
    .filter(Boolean)
    .sort(compareCandidates)
    .slice(0, 10);

  const recommendation = recommendationFor(candidates);
  const publicCandidates = candidates.map((candidate) => {
    const publicCandidate = { ...candidate };
    delete publicCandidate.strong_reuse;
    return publicCandidate;
  });
  const fingerprint = {
    advisor_version: TASK_REUSE_ADVISOR_VERSION,
    request,
    candidates: publicCandidates.map((candidate) => ({
      task_id: candidate.task_id,
      status: candidate.status,
      confidence: candidate.confidence,
      match_reasons: candidate.match_reasons,
      conflicts: candidate.conflicts,
    })),
    recommendation: recommendation.recommendation,
  };

  return {
    schema_version: "taskcenter-task-reuse-check-v1",
    advisor_version: TASK_REUSE_ADVISOR_VERSION,
    check_id: `reuse-check-${hashOf(fingerprint).slice(0, 24)}`,
    checked_at: checkedAt,
    recommendation: recommendation.recommendation,
    candidates: publicCandidates,
    match_reasons: publicCandidates[0]?.match_reasons || [],
    confidence: recommendation.confidence,
    advisory_only: true,
    project_identity: options.projectIdentity || {
      status: request.project_id === UNKNOWN_PROJECT_ID ? "unknown" : "caller_provided",
      project_id: request.project_id,
    },
  };
}

export function recordTaskReuseDecision(input, options = {}) {
  const record = normalizeDecision(input, validNow(options.now));
  const releaseLock = acquireDecisionLock();
  try {
    ensureDecisionEventIndex();
    const existing = readIndexedDecision(record.event_id);
    if (existing) {
      if (decisionSignature(existing) !== decisionSignature(record)) {
        throw new TaskReuseAdvisorError(409, "event_id 已被不同复用决策使用，拒绝重放。");
      }
      return { record: existing, idempotent: true };
    }
    appendDecisionRecord(record);
    writeDecisionIndexEntry(record);
    writeDecisionIndexState(sourceIdentity());
    return { record, idempotent: false };
  } finally {
    releaseLock();
  }
}

export function loadTaskReuseDecisions(filters = {}) {
  const workspace = optionalText(filters.workspace, 4_096);
  const projectId = optionalText(filters.project_id ?? filters.projectId, 200);
  const limit = Math.min(500, Math.max(1, Number.parseInt(filters.limit || "100", 10) || 100));
  return readTaskReuseDecisionRecords()
    .filter((item) => !workspace || workspaceKey(item.workspace) === workspaceKey(workspace))
    .filter((item) => !projectId || normalizedId(item.project_id) === normalizedId(projectId))
    .slice(-limit)
    .reverse();
}

export function summarizeTaskReuseDecisions(records) {
  const values = Array.isArray(records) ? records : [];
  const recommendations = { reuse: 0, create_new: 0, uncertain: 0 };
  const finalDecisions = { reuse: 0, create_new: 0, uncertain: 0 };
  let agreements = 0;
  let forcedNew = 0;
  for (const record of values) {
    if (decisions.has(record.recommendation)) recommendations[record.recommendation] += 1;
    if (decisions.has(record.final_decision)) finalDecisions[record.final_decision] += 1;
    if (record.recommendation === record.final_decision) agreements += 1;
    if (record.final_decision === "create_new" && record.force_new_reason) forcedNew += 1;
  }
  return {
    schema_version: "taskcenter-task-reuse-decision-summary-v1",
    decision_count: values.length,
    project_count: new Set(values
      .map((record) => normalizedId(record.project_id))
      .filter((projectId) => projectId && projectId !== UNKNOWN_PROJECT_ID)).size,
    recommendations,
    final_decisions: finalDecisions,
    agreement_count: agreements,
    agreement_rate: values.length ? rounded(agreements / values.length) : null,
    force_new_reason_count: forcedNew,
    automatic_block_count: 0,
    automatic_merge_count: 0,
  };
}

function readTaskReuseDecisionRecords() {
  if (!existsSync(taskReuseDecisionsPath)) return [];
  return readFileSync(taskReuseDecisionsPath, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const value = JSON.parse(line);
        return value && typeof value === "object" ? [value] : [];
      } catch {
        return [];
      }
    });
}

function acquireDecisionLock() {
  mkdirSync(dirname(taskReuseDecisionsPath), { recursive: true });
  const deadline = Date.now() + decisionLockTimeoutMs;
  const owner = {
    pid: process.pid,
    nonce: randomUUID(),
    acquired_at: new Date().toISOString(),
  };
  while (true) {
    try {
      mkdirSync(decisionLockPath, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (clearStaleDecisionLock()) continue;
      if (Date.now() >= deadline) {
        throw new TaskReuseAdvisorError(503, "复用决策审计正由另一进程写入，请稍后重试。");
      }
      Atomics.wait(decisionLockWaiter, 0, 0, 10);
      continue;
    }
    try {
      writeFileSync(decisionLockOwnerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
      return () => releaseDecisionLock(owner.nonce);
    } catch (error) {
      rmSync(decisionLockPath, { recursive: true, force: true });
      throw error;
    }
  }
}

function clearStaleDecisionLock() {
  let lockAge = 0;
  try {
    lockAge = Date.now() - statSync(decisionLockPath).mtimeMs;
  } catch (error) {
    return error?.code === "ENOENT";
  }
  try {
    const owner = JSON.parse(readFileSync(decisionLockOwnerPath, "utf8"));
    if (Number.isInteger(owner?.pid) && processIsAlive(owner.pid)) return false;
    rmSync(decisionLockPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.name !== "SyntaxError") throw error;
    if (lockAge < decisionLockStaleMs) return false;
    rmSync(decisionLockPath, { recursive: true, force: true });
    return true;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function releaseDecisionLock(nonce) {
  try {
    const owner = JSON.parse(readFileSync(decisionLockOwnerPath, "utf8"));
    if (owner?.nonce !== nonce) return;
    rmSync(decisionLockPath, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function ensureDecisionEventIndex() {
  const source = sourceIdentity();
  if (decisionIndexMatchesSource(source)) return;
  const records = readTaskReuseDecisionRecords();
  const indexed = new Map();
  for (const record of records) {
    const eventId = optionalText(record.event_id, 200);
    if (!eventId) continue;
    const previous = indexed.get(eventId);
    if (previous && decisionSignature(previous) !== decisionSignature(record)) {
      throw new TaskReuseAdvisorError(409, `复用决策账本包含冲突 event_id：${eventId}`);
    }
    if (!previous) indexed.set(eventId, record);
  }
  rmSync(taskReuseDecisionIndexPath, { recursive: true, force: true });
  mkdirSync(taskReuseDecisionIndexPath, { recursive: true, mode: 0o700 });
  for (const record of indexed.values()) writeDecisionIndexEntry(record);
  writeDecisionIndexState(source);
}

function decisionIndexMatchesSource(source) {
  if (!existsSync(decisionIndexStatePath)) return false;
  try {
    const state = JSON.parse(readFileSync(decisionIndexStatePath, "utf8"));
    return state?.schema_version === "taskcenter-task-reuse-event-index-v1"
      && state.source?.size === source.size
      && state.source?.mtime_ms === source.mtime_ms
      && state.source?.inode === source.inode
      && state.source?.device === source.device;
  } catch {
    return false;
  }
}

function readIndexedDecision(eventId) {
  const path = decisionIndexEntryPath(eventId);
  if (!existsSync(path)) return null;
  try {
    const entry = JSON.parse(readFileSync(path, "utf8"));
    if (entry?.event_id !== eventId || !entry.record || decisionSignature(entry.record) !== entry.signature) {
      throw new Error("index entry mismatch");
    }
    return entry.record;
  } catch {
    rmSync(decisionIndexStatePath, { force: true });
    ensureDecisionEventIndex();
    if (!existsSync(path)) return null;
    const recovered = JSON.parse(readFileSync(path, "utf8"));
    if (recovered?.event_id !== eventId || !recovered.record || decisionSignature(recovered.record) !== recovered.signature) {
      throw new TaskReuseAdvisorError(500, "复用决策幂等索引无法从审计账本恢复。");
    }
    return recovered.record;
  }
}

function appendDecisionRecord(record) {
  mkdirSync(dirname(taskReuseDecisionsPath), { recursive: true });
  const descriptor = openSync(taskReuseDecisionsPath, "a", 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify(record)}\n`, null, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeDecisionIndexEntry(record) {
  mkdirSync(taskReuseDecisionIndexPath, { recursive: true, mode: 0o700 });
  const path = decisionIndexEntryPath(record.event_id);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const entry = {
    schema_version: "taskcenter-task-reuse-event-index-entry-v1",
    event_id: record.event_id,
    signature: decisionSignature(record),
    record,
  };
  writeFileSync(temporaryPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

function writeDecisionIndexState(source) {
  mkdirSync(taskReuseDecisionIndexPath, { recursive: true, mode: 0o700 });
  const temporaryPath = `${decisionIndexStatePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify({
    schema_version: "taskcenter-task-reuse-event-index-v1",
    source,
    updated_at: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  renameSync(temporaryPath, decisionIndexStatePath);
}

function decisionIndexEntryPath(eventId) {
  return join(taskReuseDecisionIndexPath, `${hashOf(String(eventId))}.json`);
}

function sourceIdentity() {
  if (!existsSync(taskReuseDecisionsPath)) {
    return { size: 0, mtime_ms: 0, inode: "", device: "" };
  }
  const metadata = statSync(taskReuseDecisionsPath);
  if (!metadata.isFile()) throw new TaskReuseAdvisorError(500, "复用决策审计路径必须是普通文件。");
  return {
    size: metadata.size,
    mtime_ms: metadata.mtimeMs,
    inode: String(metadata.ino),
    device: String(metadata.dev),
  };
}

function normalizeCheckInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TaskReuseAdvisorError(400, "复用检查输入必须是 JSON 对象。");
  }
  return {
    workspace: requiredText(input.workspace, 4_096, "workspace"),
    project_id: requiredText(input.project_id, 200, "project_id"),
    session_id: requiredText(input.session_id, 200, "session_id"),
    context_task_id: optionalText(input.context_task_id, 200),
    title: requiredText(input.title, 200, "title"),
    goal: requiredText(input.goal, 1_000, "goal"),
    scope: stringList(input.scope, 50, 500, "scope"),
  };
}

function normalizeDecision(input, recordedAt) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TaskReuseAdvisorError(400, "复用决策必须是 JSON 对象。");
  }
  const recommendation = requiredText(input.recommendation, 40, "recommendation");
  const finalDecision = requiredText(input.final_decision, 40, "final_decision");
  if (!decisions.has(recommendation) || !decisions.has(finalDecision)) {
    throw new TaskReuseAdvisorError(400, "recommendation 或 final_decision 无效。");
  }
  const confidence = Number(input.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new TaskReuseAdvisorError(400, "confidence 必须是 0 到 1 之间的数字。");
  }
  const occurredAt = requiredText(input.occurred_at, 80, "occurred_at");
  if (!Number.isFinite(Date.parse(occurredAt))) {
    throw new TaskReuseAdvisorError(400, "occurred_at 必须是有效 ISO 时间。");
  }
  const candidateTaskIds = uniqueList(input.candidate_task_ids, 50, 200, "candidate_task_ids");
  const selectedTaskId = optionalText(input.selected_task_id, 200);
  const forceNewReason = optionalText(input.force_new_reason, 1_000);
  if (finalDecision === "reuse" && (!selectedTaskId || !candidateTaskIds.includes(selectedTaskId))) {
    throw new TaskReuseAdvisorError(400, "reuse 决策必须选择候选任务中的 selected_task_id。");
  }
  if (finalDecision === "create_new" && recommendation !== "create_new" && !forceNewReason) {
    throw new TaskReuseAdvisorError(400, "覆盖 reuse/uncertain 建议新建任务时必须提供 force_new_reason。");
  }
  if (forceNewReason && finalDecision !== "create_new") {
    throw new TaskReuseAdvisorError(400, "force_new_reason 只能用于 create_new 决策。");
  }
  return {
    schema_version: "taskcenter-task-reuse-decision-v1",
    advisor_version: optionalText(input.advisor_version, 80) || TASK_REUSE_ADVISOR_VERSION,
    event_id: requiredText(input.event_id, 200, "event_id"),
    check_id: requiredText(input.check_id, 200, "check_id"),
    session_id: requiredText(input.session_id, 200, "session_id"),
    workspace: requiredText(input.workspace, 4_096, "workspace"),
    project_id: requiredText(input.project_id, 200, "project_id"),
    context_task_id: optionalText(input.context_task_id, 200),
    title: optionalText(input.title, 200),
    recommendation,
    confidence: rounded(confidence),
    candidate_task_ids: candidateTaskIds,
    match_reasons: uniqueList(input.match_reasons, 50, 120, "match_reasons"),
    final_decision: finalDecision,
    selected_task_id: selectedTaskId,
    force_new_reason: forceNewReason,
    advisory_only: true,
    occurred_at: occurredAt,
    recorded_at: recordedAt,
  };
}

function candidateFor(task, context) {
  const {
    request,
    registry,
    delegations,
    canonicalizeSession,
    requestSessionId,
    requestWorkspace,
    requesterOwners,
  } = context;
  const candidateSessionId = canonicalizeSession(task.sessionId);
  const candidateWorkspace = workspaceKey(task.workspace);
  const candidateProjectId = projectIdFor(task, registry, candidateSessionId);
  const sameContext = Boolean(request.context_task_id && task.contextTaskId === request.context_task_id);
  const differentContext = Boolean(request.context_task_id && task.contextTaskId && task.contextTaskId !== request.context_task_id);
  const sameWorkspace = Boolean(requestWorkspace && candidateWorkspace === requestWorkspace);
  const differentWorkspace = Boolean(requestWorkspace && candidateWorkspace && candidateWorkspace !== requestWorkspace);
  const sameProject = Boolean(candidateProjectId && normalizedId(candidateProjectId) === normalizedId(request.project_id));
  const differentProject = Boolean(candidateProjectId && normalizedId(candidateProjectId) !== normalizedId(request.project_id));
  const sameSession = Boolean(requestSessionId && candidateSessionId === requestSessionId);
  const relatedDelegation = delegations.some((delegation) =>
    (delegation.taskId || delegation.task_id) === task.id
      && canonicalizeSession(delegation.delegateSessionId || delegation.delegate_session_id) === requestSessionId
      && delegation.expired !== true
      && !["expired", "revoked"].includes(delegation.status));
  const candidateOwner = actorKey(task.ownerActor);
  const sameOwner = Boolean(candidateOwner && requesterOwners.has(candidateOwner));
  const differentOwner = Boolean(candidateOwner && requesterOwners.size && !sameOwner);
  const semanticSimilarity = semanticScore(request, task);
  const reasons = [];
  const conflicts = [];
  if (sameContext) reasons.push("same_context_task_id");
  if (sameWorkspace) reasons.push("same_workspace");
  if (sameProject) reasons.push("same_project_id");
  if (sameSession) reasons.push("same_session");
  if (relatedDelegation) reasons.push("related_delegation");
  if (sameOwner) reasons.push("same_owner");
  if (semanticSimilarity >= 0.6) reasons.push("semantic_similarity_high");
  else if (semanticSimilarity >= 0.3) reasons.push("semantic_similarity_moderate");
  if (task.status === "done_claimed") reasons.push("done_claimed_pending_acceptance");
  if (differentContext) conflicts.push("different_context_task_id");
  if (differentWorkspace) conflicts.push(task.executionEnvironment === "worktree" ? "different_worktree" : "different_workspace");
  if (differentProject) conflicts.push("different_project_id");
  if (differentOwner) conflicts.push("different_owner");

  const anchored = sameContext || sameWorkspace || sameProject || sameSession || relatedDelegation;
  if (!anchored) return null;
  let confidence = 0;
  if (sameContext) confidence += 0.55;
  if (sameWorkspace) confidence += 0.2;
  if (sameProject) confidence += 0.08;
  if (sameSession || relatedDelegation) confidence += 0.14;
  if (sameOwner) confidence += 0.04;
  confidence += semanticSimilarity * 0.2;
  if (task.status === "done_claimed") confidence -= 0.03;
  if (differentContext) confidence -= 0.25;
  if (differentWorkspace) confidence -= 0.28;
  if (differentProject) confidence -= 0.18;
  if (differentOwner) confidence -= 0.22;
  confidence = rounded(Math.max(0, Math.min(0.99, confidence)));
  if (confidence < 0.15) return null;
  const hasBoundaryConflict = differentContext || differentWorkspace || differentProject || differentOwner;
  const identityAligned = sameSession || relatedDelegation || sameOwner;
  const strongReuse = !hasBoundaryConflict && identityAligned && (
    (sameContext && sameWorkspace)
      || (sameWorkspace && (sameSession || relatedDelegation) && semanticSimilarity >= 0.55)
  );
  return {
    task_id: task.id,
    title: task.title || "",
    status: task.status,
    goal: task.goal || "",
    session_id: task.sessionId || "",
    workspace: task.workspace || "",
    project_id: candidateProjectId,
    owner: task.ownerActor || null,
    worktree: {
      workspace: task.workspace || "",
      execution_environment: task.executionEnvironment || "",
      subject_ref: task.currentSubject || null,
    },
    match_reasons: reasons,
    conflicts,
    semantic_similarity: rounded(semanticSimilarity),
    confidence,
    updated_at: task.updatedAt || task.createdAt || "",
    strong_reuse: strongReuse,
  };
}

function recommendationFor(candidates) {
  if (!candidates.length) return { recommendation: "create_new", confidence: 0.95 };
  const [first, second] = candidates;
  const competingStrongCandidate = Boolean(second?.strong_reuse && first.confidence - second.confidence < 0.12);
  if (first.strong_reuse && !competingStrongCandidate) {
    return { recommendation: "reuse", confidence: first.confidence };
  }
  if (first.strong_reuse || first.confidence >= 0.38) {
    return { recommendation: "uncertain", confidence: first.confidence };
  }
  return { recommendation: "create_new", confidence: rounded(Math.max(0.5, 1 - first.confidence)) };
}

function compareCandidates(left, right) {
  if (right.confidence !== left.confidence) return right.confidence - left.confidence;
  const updated = Date.parse(right.updated_at || "") - Date.parse(left.updated_at || "");
  if (Number.isFinite(updated) && updated !== 0) return updated;
  return left.task_id.localeCompare(right.task_id);
}

function isEligibleCandidate(task) {
  return Boolean(
    task
      && candidateStatuses.has(task.status)
      && !task.archivedAt
      && !task.archived_at
      && !task.supersededBy
      && !task.superseded_by
      && !task.supersededAt
      && !/^context-[0-9a-f]{24}$/i.test(String(task.id || "")),
  );
}

function projectIdFor(task, registry, sessionId) {
  const session = registry[sessionId] || registry[task.sessionId] || {};
  return optionalText(
    task.projectId
      || task.project_id
      || session.projectId
      || session.project_id
      || session.scheduledReadonly?.projectId
      || session.scheduledReadonly?.project_id,
    200,
  );
}

function semanticScore(request, task) {
  const fields = [
    [request.title, task.title, 0.4],
    [request.goal, task.goal, 0.4],
    [request.scope.join(" "), (task.scope || []).join(" "), 0.2],
  ];
  let total = 0;
  let weight = 0;
  for (const [left, right, fieldWeight] of fields) {
    if (!String(left || "").trim() || !String(right || "").trim()) continue;
    total += tokenDice(tokensOf(left), tokensOf(right)) * fieldWeight;
    weight += fieldWeight;
  }
  const weighted = weight ? total / weight : 0;
  const combined = tokenDice(
    tokensOf([request.title, request.goal, ...request.scope].join(" ")),
    tokensOf([task.title, task.goal, ...(task.scope || [])].join(" ")),
  );
  return Math.max(weighted, combined * 0.9);
}

function tokensOf(value) {
  const normalized = String(value || "").normalize("NFKC").toLowerCase();
  const tokens = new Set();
  for (const word of normalized.match(/[a-z0-9]+(?:[._-][a-z0-9]+)*/g) || []) {
    if (!ignoredTokens.has(word)) tokens.add(word);
  }
  for (const run of normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) || []) {
    const characters = Array.from(run);
    if (characters.length === 1 && !ignoredTokens.has(run)) tokens.add(run);
    for (let index = 0; index < characters.length - 1; index += 1) {
      const token = `${characters[index]}${characters[index + 1]}`;
      if (!ignoredTokens.has(token)) tokens.add(token);
    }
  }
  return tokens;
}

function tokenDice(left, right) {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return (2 * overlap) / (left.size + right.size);
}

function workspaceKey(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const normalized = resolve(text).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function actorKey(actor) {
  if (!actor || typeof actor !== "object") return "";
  const id = optionalText(actor.id, 200);
  if (!id) return "";
  return `${optionalText(actor.type, 40)}:${optionalText(actor.provider, 80)}:${id}`;
}

function decisionSignature(record) {
  const stable = { ...record };
  delete stable.recorded_at;
  return hashOf(stable);
}

function hashOf(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizedId(value) {
  return String(value || "").normalize("NFKC").trim().toLowerCase();
}

function validNow(value) {
  const now = value instanceof Date ? value.toISOString() : String(value || new Date().toISOString());
  if (!Number.isFinite(Date.parse(now))) throw new TaskReuseAdvisorError(400, "now 必须是有效 ISO 时间。");
  return now;
}

function requiredText(value, limit, field) {
  const text = optionalText(value, limit);
  if (!text) throw new TaskReuseAdvisorError(400, `${field} 不能为空。`);
  return text;
}

function optionalText(value, limit) {
  return String(value ?? "").trim().slice(0, limit);
}

function stringList(value, count, limit, field) {
  if (!Array.isArray(value)) throw new TaskReuseAdvisorError(400, `${field} 必须是数组。`);
  return value.slice(0, count).map((item) => requiredText(item, limit, field));
}

function uniqueList(value, count, limit, field) {
  return [...new Set(stringList(value, count, limit, field))];
}

function rounded(value) {
  return Math.round(value * 1_000) / 1_000;
}
