import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { consumeJsonl } from "./jsonl-stream.mjs";
import { findSessionPath } from "./session-cli.mjs";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class SessionSwitchError extends Error {
  constructor(message) { super(message); this.statusCode = 409; }
}
const fail = (message) => { throw new SessionSwitchError(message); };
export const switchJournalPath = process.env.TASKCENTER_SESSION_SWITCH_PATH || join(process.env.TASKCENTER_TASK_LEDGER_PATH ? dirname(process.env.TASKCENTER_TASK_LEDGER_PATH) : join(import.meta.dirname, "..", "data"), "session-switch.jsonl");

function journal() {
  if (!existsSync(switchJournalPath)) return [];
  // Corrupt or partial audit records must never reopen a consumed permission.
  return readFileSync(switchJournalPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
function append(record) {
  mkdirSync(dirname(switchJournalPath), { recursive: true });
  appendFileSync(switchJournalPath, `${JSON.stringify(record)}\n`, { mode: 0o600, flush: true });
  return record;
}
export function switchTaskFingerprint(task) {
  const { phaseTiming, ...persisted } = task;
  void phaseTiming;
  return digest(persisted);
}

export function switchCheckpoint(task, tasks, registry) {
  if (!task || !registry || registry.workspace !== task.workspace || registry.agent !== "codex") fail("SWITCH_SESSION_WORKSPACE_MISMATCH");
  const related = tasks.filter((item) => item.sessionId === task.sessionId || item.sessionHistory?.includes(task.sessionId));
  if (related.some((item) => !["done_claimed", "verified", "cancelled"].includes(item.status))) fail("SWITCH_ACTIVE_TASK");
  if (related.some((item) => item.previousTaskId === task.id)) fail("SWITCH_ALREADY_CONSUMED");
  if (task.status === "cancelled") {
    if (!task.evidence?.length || !task.retrospective) fail("SWITCH_CANCELLATION_EVIDENCE_REQUIRED");
  } else if (!task.completionReadiness?.completionClaim?.allowed) fail("SWITCH_COMPLETION_NOT_READY");
  const git = (...args) => execFileSync("git", ["-C", task.workspace, ...args], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (git("status", "--porcelain", "--untracked-files=all")) fail("SWITCH_WORKSPACE_DIRTY");
  const revision = git("rev-parse", "HEAD");
  if (task.currentSubject?.type !== "git_commit" || task.currentSubject.value !== revision) fail("SWITCH_REVISION_MISMATCH");
  const { phaseTiming, ...recovery_task } = task;
  void phaseTiming;
  return { workspace: task.workspace, revision, task_fingerprint: switchTaskFingerprint(task), recovery_task };
}

async function compactionEvidence(sessionId, root, after = "") {
  const path = findSessionPath(sessionId, root);
  if (!path) fail("HOST_COMPACTION_EVIDENCE_UNAVAILABLE");
  const inside = relative(realpathSync(root), realpathSync(path));
  if (inside.startsWith("..") || inside.startsWith("/")) fail("HOST_COMPACTION_EVIDENCE_UNAVAILABLE");
  let identity = "", evidence = null;
  await consumeJsonl(path, { onLine(line) {
    let item;
    try { item = JSON.parse(line); } catch { return; }
    if (item.type === "session_meta") identity = item.payload?.id || "";
    if (item.type !== "compacted" && !(item.type === "event_msg" && item.payload?.type === "context_compacted")) return;
    const at = Date.parse(item.timestamp);
    if (!Number.isFinite(at) || at > Date.now() || (after && at <= Date.parse(after))) return;
    evidence = { source: "codex_session_jsonl", fingerprint: digest(item), occurred_at: item.timestamp };
  } });
  if (identity !== sessionId) fail("HOST_COMPACTION_SESSION_MISMATCH");
  return evidence;
}

// The control server is the single writer. Each await is followed by a fresh
// checkpoint; validation and journal append / ledger mutation are synchronous.
export async function prepareSessionSwitch(input, root, checkpoint) {
  if (!input.event_id || !input.next_task_id || !input.next_goal?.trim() || input.next_task_id === input.task_id) fail("SWITCH_TARGET_REQUIRED");
  const signature = digest(input);
  const existing = journal().find((item) => item.event_id === input.event_id);
  if (existing) {
    if (existing.signature !== signature) fail("SWITCH_EVENT_CONFLICT");
    return requestFor(existing.switch_id, input.session_id);
  }
  const requireNoPending = () => {
    if (journal().some((item) => item.kind === "prepared" && item.task_id === input.task_id && Date.parse(item.expires_at) > Date.now())) fail("SWITCH_PENDING_REQUEST_EXISTS");
  };
  requireNoPending();
  const before = checkpoint();
  const baseline = await compactionEvidence(input.session_id, root);
  const current = checkpoint();
  if (digest(before) !== digest(current)) fail("SWITCH_CHECKPOINT_CHANGED");
  const raced = journal().find((item) => item.event_id === input.event_id);
  if (raced) {
    if (raced.signature !== signature) fail("SWITCH_EVENT_CONFLICT");
    return requestFor(raced.switch_id, input.session_id);
  }
  requireNoPending();
  const prepared_at = new Date().toISOString(), expires_at = new Date(Date.now() + 15 * 60_000).toISOString();
  const generation = 1 + Math.max(0, ...journal().filter((item) => item.kind === "prepared" && item.session_id === input.session_id).map((item) => item.generation || 0));
  const recovery = { protocol: "taskcenter-recovery/v1", task_id: input.task_id, client_session_id: input.session_id,
    generation, subject: current.recovery_task.currentSubject, revision: current.revision, workspace: current.workspace,
    state: "prepared", prepared_at, expires_at, task: current.recovery_task,
    next_task_id: input.next_task_id, next_goal: input.next_goal };
  const checkpoint_digest = digest(recovery);
  const prepared = append({ protocol: "taskcenter-session-switch/v2", kind: "prepared", ...input,
    workspace: current.workspace, revision: current.revision, task_fingerprint: current.task_fingerprint,
    signature, switch_id: randomUUID(), prepared_at, expires_at, generation, recovery, checkpoint_digest,
    baseline_fingerprint: baseline?.fingerprint || null,
    host_action: { method: "thread/compact/start", thread_id: input.session_id, executed: false,
      capability: "configured_local_app_server_required", completion: "durable readback, compaction completion, durable readback and same-thread restore" },
  });
  // A successful write is not evidence that the recovery path can read it.
  readRecoveryCheckpoint(prepared.switch_id, input.session_id, checkpoint);
  return requestFor(prepared.switch_id, input.session_id);
}
function requestFor(id, sessionId) {
  const request = journal().find((item) => item.kind === "prepared" && item.switch_id === id);
  if (!request || request.session_id !== sessionId) fail("SWITCH_REQUEST_MISMATCH");
  const expires = Date.parse(request.expires_at), prepared = Date.parse(request.prepared_at);
  if (!Number.isFinite(expires) || !Number.isFinite(prepared) || prepared > Date.now() || expires <= Date.now() || expires <= prepared || expires - prepared > 15 * 60_000) fail("SWITCH_EXPIRED");
  const recovery = request.recovery;
  if (request.protocol !== "taskcenter-session-switch/v2" || !recovery || !Number.isSafeInteger(request.generation) || request.generation < 1
    || digest(recovery) !== request.checkpoint_digest || recovery.protocol !== "taskcenter-recovery/v1" || recovery.state !== "prepared"
    || recovery.task_id !== request.task_id || recovery.client_session_id !== request.session_id || recovery.generation !== request.generation
    || recovery.workspace !== request.workspace || recovery.revision !== request.revision || recovery.subject?.type !== "git_commit" || recovery.subject.value !== request.revision
    || recovery.prepared_at !== request.prepared_at || recovery.expires_at !== request.expires_at
    || recovery.next_task_id !== request.next_task_id || recovery.next_goal !== request.next_goal
    || recovery.task?.id !== request.task_id || recovery.task.sessionId !== request.session_id
    || digest(recovery.task) !== request.task_fingerprint) fail("SWITCH_RECOVERY_INTEGRITY_FAILED");
  return request;
}
function matchCheckpoint(request, actual) {
  if (request.task_fingerprint !== actual.task_fingerprint || request.revision !== actual.revision || request.workspace !== actual.workspace) fail("SWITCH_CHECKPOINT_CHANGED");
}
export function readRecoveryCheckpoint(id, sessionId, checkpoint) {
  const request = requestFor(id, sessionId);
  matchCheckpoint(request, checkpoint(request.task_id));
  return { ...request.recovery, digest: request.checkpoint_digest };
}

function receiptFor(request) {
  const records = journal().filter((item) => item.switch_id === request.switch_id);
  if (records.some((item) => item.kind === "failed")) fail("SWITCH_RECOVERY_FAILED");
  const receipt = records.find((item) => item.kind === "receipt");
  if (!receipt) return null;
  const { integrity_hash, ...receiptContent } = receipt;
  const started = records.find((item) => item.kind === "started");
  if (digest(receiptContent) !== integrity_hash || !started || receipt.protocol !== request.protocol || receipt.task_id !== request.task_id || receipt.session_id !== request.session_id
    || receipt.checkpoint_digest !== request.checkpoint_digest || receipt.generation !== request.generation
    || started.checkpoint_digest !== receipt.checkpoint_digest || started.generation !== receipt.generation
    || receipt.preflight?.digest !== receipt.checkpoint_digest || receipt.preflight.generation !== receipt.generation
    || receipt.restored?.digest !== receipt.checkpoint_digest || receipt.restored.generation !== receipt.generation
    || receipt.host_completion?.thread_id !== request.session_id || !receipt.host_completion.item_id || !receipt.host_completion.turn_id
    || !receipt.evidence?.fingerprint) fail("SWITCH_RECEIPT_INVALID");
  return receipt;
}

// host is supplied by the configured control-server adapter, never by MCP input.
export async function confirmSessionSwitch(input, root, checkpoint, host) {
  const request = requestFor(input.switch_id, input.session_id);
  const before = readRecoveryCheckpoint(input.switch_id, input.session_id, checkpoint);
  const existing = receiptFor(request);
  if (existing) return existing;
  if (!host || typeof host.compact !== "function" || typeof host.restore !== "function") fail("HOST_COMPACTION_CAPABILITY_UNAVAILABLE");
  if (journal().some((item) => item.kind === "started" && item.switch_id === request.switch_id)) fail("SWITCH_RECOVERY_REQUIRED");
  append({ kind: "started", switch_id: request.switch_id, generation: before.generation, checkpoint_digest: before.digest, recorded_at: new Date().toISOString() });
  try {
    const preflight = await host.restore(before);
    if (preflight?.digest !== before.digest || preflight.generation !== before.generation) fail("SWITCH_RECOVERY_FAILED");
    readRecoveryCheckpoint(input.switch_id, input.session_id, checkpoint);
    const compaction_started_at = new Date().toISOString();
    const host_completion = await host.compact();
    // First operation after actual host compaction: read the same durable record.
    const after = readRecoveryCheckpoint(input.switch_id, input.session_id, checkpoint);
    if (after.digest !== before.digest || after.generation !== before.generation) fail("SWITCH_RECOVERY_MISMATCH");
    const restored = await host.restore(after);
    if (restored?.digest !== before.digest || restored.generation !== before.generation) fail("SWITCH_RECOVERY_FAILED");
    if (host_completion?.thread_id !== input.session_id || !host_completion.item_id || !host_completion.turn_id) fail("HOST_COMPACTION_REQUIRED");
    const evidence = await compactionEvidence(input.session_id, root, compaction_started_at);
    if (!evidence || evidence.fingerprint === request.baseline_fingerprint) fail("HOST_COMPACTION_REQUIRED");
    readRecoveryCheckpoint(input.switch_id, input.session_id, checkpoint);
    const receipt = { protocol: request.protocol, kind: "receipt", switch_id: input.switch_id, session_id: input.session_id,
      task_id: request.task_id, checkpoint_digest: before.digest, generation: before.generation,
      preflight, compaction_started_at, host_completion, restored, evidence, recorded_at: new Date().toISOString() };
    return append({ ...receipt, integrity_hash: digest(receipt) });
  } catch (error) {
    append({ kind: "failed", switch_id: request.switch_id, reason: error.message, recorded_at: new Date().toISOString() });
    throw error;
  }
}
export function validateSessionSwitch(event, tasks, checkpoint) {
  const request = requestFor(event.session_switch_id, event.session_id);
  if (event.task_id !== request.next_task_id || event.goal !== request.next_goal || event.workspace !== request.workspace) fail("SWITCH_TARGET_MISMATCH");
  if (tasks.some((task) => task.sessionSwitchId === request.switch_id || task.previousTaskId === request.task_id)) fail("SWITCH_ALREADY_CONSUMED");
  if (!receiptFor(request)) fail("HOST_COMPACTION_REQUIRED");
  matchCheckpoint(request, checkpoint(request.task_id));
  return request.task_id;
}
