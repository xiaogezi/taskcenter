import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
export const delegationsPath = resolve(process.env.TASKCENTER_DELEGATIONS_PATH || resolve(projectRoot, "data", "delegations.json"));
const activeTaskStatuses = new Set(["planned", "in_progress", "blocked"]);
const terminalRunStatuses = new Set(["succeeded", "failed", "cancelled", "revoked"]);

export class DelegationError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function grantDelegation(input, task, now = new Date().toISOString()) {
  if (!task || !activeTaskStatuses.has(task.status)) throw new DelegationError(409, "主任务不存在或已结束，不能创建 delegation。");
  if (task.sessionId !== input.parent_session_id) throw new DelegationError(403, "只有主任务登记 Session 可以创建 delegation。");
  const workspace = normalizeWorkspace(input.workspace);
  if (!workspace || workspace !== normalizeWorkspace(task.workspace)) throw new DelegationError(409, "delegation workspace 必须与主任务一致。");
  const scope = normalizeScope(input.scope);
  const ttlSeconds = normalizeTtl(input.ttl_seconds);
  const eventId = clean(input.event_id, 200) || `delegation-grant-${randomUUID()}`;
  const state = readState();
  const existing = state.grants.find((item) => item.grantEventId === eventId);
  const allowedTools = normalizeList(input.allowed_tools, 40, 120);
  const purpose = clean(input.purpose, 1_000);
  const signature = signatureOf({ taskId: task.id, parentSessionId: input.parent_session_id, workspace, scope, allowedTools, executorModel: input.executor_model, channel: input.channel, purpose, ttlSeconds });
  if (existing) {
    if (existing.signature !== signature) throw new DelegationError(409, "event_id 已被不同 delegation 使用。");
    return { delegation: publicGrant(existing, now), claimToken: existing.claimToken || "", idempotent: true };
  }
  const claimToken = randomBytes(24).toString("base64url");
  const grant = {
    id: clean(input.delegation_id, 200) || `delegation-${randomUUID()}`,
    grantEventId: eventId,
    signature,
    taskId: task.id,
    parentSessionId: input.parent_session_id,
    delegateSessionId: "",
    workspace,
    scope,
    allowedTools,
    executorModel: clean(input.executor_model, 120) || "unknown",
    channel: clean(input.channel, 40) || "cli",
    purpose,
    status: "issued",
    createdAt: now,
    expiresAt: new Date(Date.parse(now) + ttlSeconds * 1_000).toISOString(),
    claimedAt: "",
    completedAt: "",
    claimToken,
    claimTokenHash: hash(claimToken),
    toolCalls: {},
    changedFiles: [],
    tests: [],
    evidence: [],
    error: "",
    events: [{ eventId, type: "delegation.granted", status: "issued", recordedAt: now }],
  };
  if (state.grants.some((item) => item.id === grant.id)) throw new DelegationError(409, "delegation_id 已存在。");
  state.grants.push(grant);
  persistState(state);
  return { delegation: publicGrant(grant, now), claimToken, idempotent: false };
}

export function claimDelegation(input, session, now = new Date().toISOString()) {
  const state = readState();
  const grant = requireGrant(state, input.delegation_id);
  const workspace = normalizeWorkspace(input.workspace);
  if (!session || session.status !== "registered" || session.sessionId !== input.session_id) throw new DelegationError(409, "CLI Session 必须先登记。");
  if (normalizeWorkspace(session.workspace) !== workspace || grant.workspace !== workspace) throw new DelegationError(403, "CLI Session workspace 与 delegation 不一致。");
  if (isExpired(grant, now)) {
    expireGrant(grant, now);
    persistState(state);
    throw new DelegationError(410, "delegation 已过期。");
  }
  if (grant.delegateSessionId) {
    if (grant.delegateSessionId !== input.session_id) throw new DelegationError(409, "delegation 已被其他 Session 领取。");
    return { delegation: publicGrant(grant, now), idempotent: true };
  }
  if (grant.status !== "issued" || !secureEqual(hash(input.claim_token), grant.claimTokenHash)) throw new DelegationError(403, "delegation claim token 无效。");
  grant.delegateSessionId = input.session_id;
  grant.status = "active";
  grant.claimedAt = now;
  grant.claimToken = "";
  grant.events.push({ eventId: clean(input.event_id, 200) || `delegation-claim-${randomUUID()}`, type: "delegation.claimed", status: "active", recordedAt: now });
  persistState(state);
  return { delegation: publicGrant(grant, now), idempotent: false };
}

export function reportDelegation(input, now = new Date().toISOString()) {
  const state = readState();
  const grant = requireGrant(state, input.delegation_id);
  const eventId = clean(input.event_id, 200) || `cli-run-${randomUUID()}`;
  const existing = grant.events.find((item) => item.eventId === eventId);
  const status = normalizeRunStatus(input.status);
  const eventSignature = signatureOf({
    status,
    summary: clean(input.summary, 1_000),
    changedFiles: normalizeList(input.changed_files, 100, 500),
    tests: normalizeList(input.tests, 50, 500),
    evidence: normalizeList(input.evidence, 50, 1_000),
    error: clean(input.error, 1_000),
  });
  assertDelegateIdentity(grant, input.session_id, input.workspace);
  if (existing) {
    if (existing.status !== status || (existing.signature && existing.signature !== eventSignature)) throw new DelegationError(409, "event_id 已被不同 CLI Run 结果使用。");
    return { delegation: publicGrant(grant, now), idempotent: true };
  }
  assertDelegate(grant, input.session_id, input.workspace, now);
  grant.status = terminalRunStatuses.has(status) ? status : "active";
  grant.changedFiles = normalizeList(input.changed_files, 100, 500);
  grant.tests = normalizeList(input.tests, 50, 500);
  grant.evidence = normalizeList(input.evidence, 50, 1_000);
  grant.error = clean(input.error, 1_000);
  if (terminalRunStatuses.has(status)) grant.completedAt = now;
  grant.events.push({ eventId, type: "cli_run.reported", status, signature: eventSignature, summary: clean(input.summary, 1_000), recordedAt: now });
  persistState(state);
  return { delegation: publicGrant(grant, now), idempotent: false };
}

export function touchDelegation(input, now = new Date().toISOString()) {
  const state = readState();
  const grant = requireGrant(state, input.delegation_id);
  assertDelegate(grant, input.session_id, input.workspace, now);
  const tool = clean(input.tool_name, 120);
  if (grant.allowedTools.length && (!tool || !grant.allowedTools.some((allowed) => sameToolFamily(allowed, tool)))) throw new DelegationError(403, `工具 ${tool || "unknown"} 不在 delegation 允许范围内。`);
  assertScope(grant, tool, input.paths);
  if (tool) grant.toolCalls[tool] = (grant.toolCalls[tool] || 0) + 1;
  grant.lastUsedAt = now;
  persistState(state);
  return { delegation: publicGrant(grant, now) };
}

export function revokeDelegation(input, now = new Date().toISOString()) {
  const state = readState();
  const grant = requireGrant(state, input.delegation_id);
  if (grant.parentSessionId !== input.parent_session_id) throw new DelegationError(403, "只有主任务 Session 可以撤销 delegation。");
  if (!terminalRunStatuses.has(grant.status)) {
    grant.status = "revoked";
    grant.completedAt = now;
    grant.events.push({ eventId: clean(input.event_id, 200) || `delegation-revoke-${randomUUID()}`, type: "delegation.revoked", status: "revoked", recordedAt: now });
    persistState(state);
  }
  return { delegation: publicGrant(grant, now) };
}

export function resolveDelegation(sessionId, workspace, now = new Date().toISOString()) {
  const state = readState();
  let changed = false;
  for (const grant of state.grants) {
    if (["issued", "active"].includes(grant.status) && isExpired(grant, now)) {
      expireGrant(grant, now);
      changed = true;
    }
  }
  if (changed) persistState(state);
  const normalizedWorkspace = normalizeWorkspace(workspace);
  const grant = state.grants
    .filter((item) => item.status === "active" && item.delegateSessionId === sessionId && item.workspace === normalizedWorkspace)
    .sort((left, right) => Date.parse(right.claimedAt) - Date.parse(left.claimedAt))[0];
  return grant ? publicGrant(grant, now) : null;
}

export function listDelegations(taskId = "", now = new Date().toISOString()) {
  return readState().grants.filter((item) => !taskId || item.taskId === taskId).map((item) => publicGrant(item, now));
}

function assertDelegate(grant, sessionId, workspace, now) {
  if (isExpired(grant, now)) throw new DelegationError(410, "delegation 已过期。");
  if (grant.status !== "active") throw new DelegationError(409, "delegation 当前不可用。");
  assertDelegateIdentity(grant, sessionId, workspace);
}

function assertDelegateIdentity(grant, sessionId, workspace) {
  if (grant.delegateSessionId !== sessionId || grant.workspace !== normalizeWorkspace(workspace)) throw new DelegationError(403, "CLI Session 或 workspace 与 delegation 不匹配。");
}

function publicGrant(grant, now) {
  const safe = { ...grant };
  delete safe.claimToken;
  delete safe.claimTokenHash;
  delete safe.signature;
  return {
    ...safe,
    events: (safe.events || []).map((event) => {
      const publicEvent = { ...event };
      delete publicEvent.signature;
      return publicEvent;
    }),
    expired: isExpired(grant, now),
  };
}

function readState() {
  if (!existsSync(delegationsPath)) return { version: 1, grants: [] };
  try {
    const value = JSON.parse(readFileSync(delegationsPath, "utf8"));
    if (!Array.isArray(value?.grants)) throw new Error("grants 不是数组");
    return { version: 1, grants: value.grants };
  } catch {
    throw new DelegationError(500, "delegation 账本损坏，已拒绝覆盖；请先修复或移走该运行态文件。");
  }
}

function persistState(state) {
  mkdirSync(dirname(delegationsPath), { recursive: true });
  const temporary = `${delegationsPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, delegationsPath);
}

function requireGrant(state, id) {
  const grant = state.grants.find((item) => item.id === id);
  if (!grant) throw new DelegationError(404, "delegation 不存在。");
  return grant;
}

function expireGrant(grant, now) {
  grant.status = "expired";
  grant.completedAt ||= now;
  grant.events.push({ eventId: `delegation-expired-${grant.id}`, type: "delegation.expired", status: "expired", recordedAt: now });
}

function isExpired(grant, now) {
  return Date.parse(grant.expiresAt || "") <= Date.parse(now);
}

function normalizeWorkspace(value) {
  const text = clean(value, 4_096);
  return text ? resolve(text) : "";
}

function normalizeScope(value) {
  const scope = normalizeList(value, 50, 500).map(normalizeRelativePath);
  if (!scope.length) throw new DelegationError(400, "delegation scope 不能为空。");
  for (const item of scope) {
    if (!item || item.startsWith("/") || item.startsWith("\\") || isAbsolute(item) || item.split(/[\\/]+/).includes("..")) throw new DelegationError(400, "delegation scope 必须是 workspace 内相对路径。");
  }
  return [...new Set(scope)];
}

function assertScope(grant, tool, value) {
  const paths = normalizeList(value, 100, 4_096).map((item) => pathWithinWorkspace(grant.workspace, item));
  const fullWorkspace = grant.scope.includes(".");
  const shellLike = sameToolFamily("Bash", tool);
  if (shellLike && !fullWorkspace) {
    throw new DelegationError(403, "Shell 命令无法可靠静态证明写入路径；delegation 必须显式授权 workspace scope '.'，或改用可识别路径的文件工具。");
  }
  if (!fullWorkspace && !paths.length) throw new DelegationError(403, "工具调用未提供可验证文件路径，不能在受限 delegation scope 下放行。");
  for (const path of paths) {
    if (!fullWorkspace && !grant.scope.some((scope) => path === scope || path.startsWith(`${scope}/`))) {
      throw new DelegationError(403, `路径 ${path} 超出 delegation scope。`);
    }
  }
}

function pathWithinWorkspace(workspace, value) {
  const raw = String(value || "").trim();
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(workspace, raw);
  const path = normalizeRelativePath(relative(workspace, absolute));
  if (!path || path === ".." || path.startsWith("../") || isAbsolute(path)) throw new DelegationError(403, "delegation 路径超出 workspace。");
  return path;
}

function normalizeRelativePath(value) {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return normalized || ".";
}

function sameToolFamily(left, right) {
  const canonical = (value) => ["Bash", "exec_command"].includes(String(value || "")) ? "shell" : String(value || "");
  return canonical(left) === canonical(right);
}

function normalizeTtl(value) {
  const seconds = Number(value ?? 3_600);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 28_800) throw new DelegationError(400, "delegation TTL 必须在 60 到 28800 秒之间。");
  return seconds;
}

function normalizeRunStatus(value) {
  const status = clean(value, 40);
  if (!["started", "running", "succeeded", "failed", "cancelled"].includes(status)) throw new DelegationError(400, "CLI Run 状态无效。");
  return status;
}

function normalizeList(value, maxItems, maxLength) {
  return Array.isArray(value) ? [...new Set(value.map((item) => clean(item, maxLength)).filter(Boolean))].slice(0, maxItems) : [];
}

function clean(value, limit) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

function hash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function signatureOf(value) {
  return hash(JSON.stringify(value));
}
