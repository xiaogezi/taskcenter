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
  appendFileSync(switchJournalPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}
export function switchTaskFingerprint(task) {
  const { phaseTiming, ...persisted } = task;
  void phaseTiming;
  return digest(persisted);
}

export function switchCheckpoint(task, tasks, registry, delegations = []) {
  if (!task || !registry || registry.workspace !== task.workspace || registry.agent !== "codex") fail("SWITCH_SESSION_WORKSPACE_MISMATCH");
  const related = tasks.filter((item) => item.sessionId === task.sessionId || item.sessionHistory?.includes(task.sessionId));
  if (related.some((item) => !["done_claimed", "verified", "cancelled"].includes(item.status))) fail("SWITCH_ACTIVE_TASK");
  if (related.some((item) => item.previousTaskId === task.id)) fail("SWITCH_ALREADY_CONSUMED");
  if (task.status === "cancelled") {
    if (!task.evidence?.length || !task.retrospective) fail("SWITCH_CANCELLATION_EVIDENCE_REQUIRED");
  } else if (!task.completionReadiness?.completionClaim?.allowed) fail("SWITCH_COMPLETION_NOT_READY");
  if (delegations.some((item) => !["succeeded", "failed", "cancelled", "revoked", "expired"].includes(item.status) && !item.expired)) fail("SWITCH_DELEGATION_ACTIVE");
  const git = (...args) => execFileSync("git", ["-C", task.workspace, ...args], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (git("status", "--porcelain", "--untracked-files=all")) fail("SWITCH_WORKSPACE_DIRTY");
  const revision = git("rev-parse", "HEAD");
  if (task.currentSubject?.type !== "git_commit" || task.currentSubject.value !== revision) fail("SWITCH_REVISION_MISMATCH");
  return { workspace: task.workspace, revision, task_fingerprint: switchTaskFingerprint(task) };
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
    return existing;
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
    return raced;
  }
  requireNoPending();
  return append({ protocol: "taskcenter-session-switch/v1", kind: "prepared", ...input, ...current,
    signature, switch_id: randomUUID(), prepared_at: new Date().toISOString(), expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    baseline_fingerprint: baseline?.fingerprint || null,
    host_action: { method: "thread/compact/start", thread_id: input.session_id, executed: false,
      capability: "external_host_required", completion: "contextCompaction item/completed; then confirm persisted Session compaction" },
  });
}
function requestFor(id, sessionId) {
  const request = journal().find((item) => item.kind === "prepared" && item.switch_id === id);
  if (!request || request.session_id !== sessionId) fail("SWITCH_REQUEST_MISMATCH");
  if (Date.parse(request.expires_at) <= Date.now()) fail("SWITCH_EXPIRED");
  return request;
}
function matchCheckpoint(request, actual) {
  if (request.task_fingerprint !== actual.task_fingerprint || request.revision !== actual.revision || request.workspace !== actual.workspace) fail("SWITCH_CHECKPOINT_CHANGED");
}
export async function confirmSessionSwitch(input, root, checkpoint) {
  const request = requestFor(input.switch_id, input.session_id);
  const actual = checkpoint(request.task_id);
  matchCheckpoint(request, actual);
  const evidence = await compactionEvidence(input.session_id, root, request.prepared_at);
  if (!evidence || evidence.fingerprint === request.baseline_fingerprint) fail("HOST_COMPACTION_REQUIRED: host must complete compaction; an acknowledgement or Agent assertion is insufficient");
  requestFor(input.switch_id, input.session_id);
  matchCheckpoint(request, checkpoint(request.task_id));
  const existing = journal().find((item) => item.kind === "receipt" && item.switch_id === input.switch_id);
  if (existing) return existing;
  return append({ protocol: request.protocol, kind: "receipt", switch_id: input.switch_id, session_id: input.session_id,
    task_id: request.task_id, evidence, recorded_at: new Date().toISOString() });
}
export function validateSessionSwitch(event, tasks, checkpoint) {
  const request = requestFor(event.session_switch_id, event.session_id);
  if (event.task_id !== request.next_task_id || event.goal !== request.next_goal || event.workspace !== request.workspace) fail("SWITCH_TARGET_MISMATCH");
  if (tasks.some((task) => task.sessionSwitchId === request.switch_id || task.previousTaskId === request.task_id)) fail("SWITCH_ALREADY_CONSUMED");
  if (!journal().some((item) => item.kind === "receipt" && item.switch_id === request.switch_id)) fail("HOST_COMPACTION_REQUIRED");
  matchCheckpoint(request, checkpoint(request.task_id));
  return request.task_id;
}
