import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { consumeJsonl } from "./jsonl-stream.mjs";

const activeStatuses = new Set(["planned", "in_progress", "blocked"]);
const statuses = new Set([...activeStatuses, "done_claimed", "verified", "cancelled", "removed"]);
// Match ledger source events, not derived completion summaries or reminders.
const sourceTypes = new Set(["task.create", "task.resume", "task.update", "task.blocked", "task.done_claimed", "task.report", "task.close", "task.review",
  "tool.call", "requirement.reported", "verification.reported", "review.reported", "review_cycle.reported", "acceptance.accepted", "acceptance.rejected",
  "subject.updated", "diagnostic.reported", "phase.reported", "task.execution_reconciled"]);
const derivedTypes = new Set(["verification.staled", "review.staled", "acceptance.ready"]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
const digest = value => createHash("sha256").update(JSON.stringify(canonical(value ?? null))).digest("hex");
const changedFile = (before, after) => ["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(key => before[key] !== after[key]);

// Store only identity/audit digests and positions; never replay or retain task payloads.
function projectionDiagnostics(ledger) {
  const tracked = new Map(ledger.filter(task => task.status !== "removed").map(task => [task.id, { task, latest: null, reviewOrdinal: 0, issues: new Set() }]));
  const ids = new Map();
  let adjacentSource = null;
  return {
    breakChain() { adjacentSource = null; },
    observe(event, ordinal) {
      const item = tracked.get(event.task_id);
      if (typeof event.event_id !== "string" || !event.event_id) {
        item?.issues.add("unknown_event_semantics"); adjacentSource = null; return;
      }
      const hash = digest(event), previous = ids.get(event.event_id);
      if (previous) {
        if (previous.hash !== hash || previous.taskId !== event.task_id) {
          previous.ambiguous = true;
          item?.issues.add("ambiguous_event_identity");
          tracked.get(previous.taskId)?.issues.add("ambiguous_event_identity");
        } else item?.issues.add("duplicate_event");
        adjacentSource = null; return;
      }
      const record = { id: event.event_id, taskId: event.task_id, ordinal, hash, type: event.type };
      ids.set(record.id, record);
      if (event.type === "session.register" || typeof event.task_id !== "string" || !event.task_id) {
        adjacentSource = null; return;
      }
      const knownFormat = (event.text_format === undefined || event.text_format === "multiline-v1")
        && (event.storage_format === undefined || (event.type === "tool.call" && event.storage_format === "tool-facts-v1"
          && /^[a-f0-9]{64}$/.test(event.storage_fingerprint || "")));
      if (!knownFormat) {
        item?.issues.add("unknown_event_semantics"); adjacentSource = null; return;
      }
      if (derivedTypes.has(event.type)) {
        if (!adjacentSource || adjacentSource.taskId !== event.task_id || record.id !== `${adjacentSource.id}:${event.type}`
          || !event.previous_state || !event.new_state || digest(event.previous_state) !== adjacentSource.before || digest(event.new_state) !== adjacentSource.after) {
          item?.issues.add("unknown_derived_event"); adjacentSource = null;
        }
        return;
      }
      adjacentSource = null;
      if (event.type === "task.reminder") return;
      if (!sourceTypes.has(event.type) || (!statuses.has(event.new_state?.execution_status) && event.storage_format !== "tool-facts-v1")) {
        item?.issues.add("unknown_event_semantics"); return;
      }
      adjacentSource = { ...record, before: digest(event.previous_state), after: digest(event.new_state) };
      if (item) {
        item.latest = record;
        if (event.type === "review.reported") item.reviewOrdinal = ordinal;
      }
    },
    finish(complete, positionsReliable) {
      const result = [];
      for (const { task, latest, reviewOrdinal, issues } of tracked.values()) {
        const projectedEventId = typeof task.lastEventId === "string" && task.lastEventId ? task.lastEventId : null;
        const anchor = ids.get(projectedEventId);
        const anchored = anchor && anchor.taskId === task.id && !anchor.ambiguous;
        if (!anchored) issues.add(anchor ? "ambiguous_event_identity" : "projection_anchor_missing");
        else if (!sourceTypes.has(anchor.type)) issues.add("projection_anchor_not_source");
        if (reviewOrdinal > (anchored ? anchor.ordinal : 0)) issues.add("review_evidence_requires_check");
        if (!complete) issues.add("incomplete_or_changing_source");
        const unknown = [...issues].some(issue => issue !== "duplicate_event");
        const behind = anchored && latest && latest.ordinal > anchor.ordinal;
        if (!unknown && !behind) continue;
        if (!unknown && behind) issues.add("persisted_event_after_projection");
        result.push({ id: task.id, state: unknown ? "unknown" : "behind", projectedEventId,
          projectedOrdinal: anchored && positionsReliable ? anchor.ordinal : null,
          latestSourceEventId: latest?.id || null, latestSourceOrdinal: positionsReliable ? latest?.ordinal ?? null : null,
          issues: [...issues] });
      }
      return result;
    },
  };
}

// Evidence preview only: event payloads are not complete task snapshots.
export async function previewTaskRecovery({ ledgerPath, eventsPath }) {
  const ledgerSource = await stat(ledgerPath);
  const ledgerRaw = await readFile(ledgerPath, "utf8");
  const ledger = JSON.parse(ledgerRaw);
  if (!Array.isArray(ledger) || ledger.some((task) => !task || typeof task.id !== "string")) throw new Error("账本必须是带任务 ID 的数组。");
  const current = new Map(ledger.map((task) => [task.id, task]));
  if (current.size !== ledger.length) throw new Error("账本包含重复任务 ID，请先人工核对。");
  const source = await stat(eventsPath);
  const diagnostics = projectionDiagnostics(ledger);
  const candidates = new Map(ledger.filter((task) => task.status === "removed").map((task) => [task.id, candidate(task.id, "removed")]));
  let malformedLines = 0;
  let eventLine = 0;
  const scanned = await consumeJsonl(eventsPath, {
    end: source.size - 1,
    onLine(line) {
      eventLine += 1;
      let event;
      try { event = JSON.parse(line.toString("utf8")); } catch { malformedLines += 1; diagnostics.breakChain(); return; }
      if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") { malformedLines += 1; diagnostics.breakChain(); return; }
      diagnostics.observe(event, eventLine);
      if (typeof event.task_id !== "string" || !event.task_id || event.type === "session.register") return;
      if (current.has(event.task_id) && current.get(event.task_id).status !== "removed") return;
      const item = candidates.get(event.task_id) || candidate(event.task_id, "missing");
      candidates.set(item.id, item);
      item.eventCount += 1;
      item.lastEventId = event.event_id || null;
      item.lastEventOrdinal = eventLine;
      if (event.type === "task.create") {
        item.creationCount += 1;
        item.creationEventId = event.event_id || null;
        item.title = event.title || "";
        item.goal = event.goal || "";
      }
      if (["task.create", "task.resume"].includes(event.type)) item.sessionId = event.session_id || "";
      // Only use explicit audit state; never infer acceptance or completion from a missing field.
      if (event.new_state && statuses.has(event.new_state.execution_status)) {
        item.lastKnownStatus = event.new_state.execution_status;
      }
    },
  });
  const after = await stat(eventsPath);
  const changed = changedFile(source, after) || ledgerRaw !== await readFile(ledgerPath, "utf8")
    || changedFile(ledgerSource, await stat(ledgerPath));
  const complete = !changed && !malformedLines && !scanned.skippedOversizedLines && scanned.offset === source.size;
  const tasks = [...candidates.values()];
  for (const item of tasks) {
    if (item.creationCount !== 1) item.issues.push(item.creationCount ? "multiple_creation_events" : "missing_creation_event");
    if (!item.lastKnownStatus) item.issues.push("unknown_execution_status");
    if (item.lastKnownStatus === "removed") item.issues.push("explicitly_removed_in_history");
    if (!complete) item.issues.push("incomplete_or_changing_source");
    if (activeStatuses.has(item.lastKnownStatus)) {
      if (!item.sessionId) item.issues.push("unknown_session");
      else {
        item.conflictingTaskIds = [...ledger, ...tasks].filter((other) => other.id !== item.id
          && other.sessionId === item.sessionId && activeStatuses.has(other.status || other.lastKnownStatus)).map((other) => other.id);
        if (item.conflictingTaskIds.length) item.issues.push("active_session_conflict");
      }
    }
  }
  return {
    mode: "preview_only", complete, sourceChanged: changed, malformedLines,
    skippedOversizedLines: scanned.skippedOversizedLines, trailingBytes: source.size - scanned.offset,
    tasks, projectionDiagnostics: diagnostics.finish(complete, !scanned.skippedOversizedLines),
    limitations: ["仅提供恢复证据，不是可直接写回的完整任务投影。", "Session 别名、缺失事件、外部验收与合入证据仍需人工核对；不推断验收通过。"],
  };
}

function candidate(id, reason) {
  return { id, reason, eventCount: 0, creationCount: 0, creationEventId: null, lastEventId: null, lastEventOrdinal: null,
    title: "", goal: "", sessionId: "", lastKnownStatus: null, conflictingTaskIds: [], issues: [] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [ledgerPath, eventsPath, ...extra] = process.argv.slice(2);
  if (!ledgerPath || !eventsPath || extra.length) {
    console.error("用法：node scripts/task-recovery-preview.mjs <task-ledger.json> <task-events.jsonl>（只读）");
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await previewTaskRecovery({ ledgerPath, eventsPath }), null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
