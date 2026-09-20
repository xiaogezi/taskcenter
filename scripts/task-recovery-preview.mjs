import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { consumeJsonl } from "./jsonl-stream.mjs";

const activeStatuses = new Set(["planned", "in_progress", "blocked"]);
const statuses = new Set([...activeStatuses, "done_claimed", "verified", "cancelled", "removed"]);

// Evidence preview only: event payloads are not complete task snapshots.
export async function previewTaskRecovery({ ledgerPath, eventsPath }) {
  const ledgerRaw = await readFile(ledgerPath, "utf8");
  const ledger = JSON.parse(ledgerRaw);
  if (!Array.isArray(ledger) || ledger.some((task) => !task || typeof task.id !== "string")) throw new Error("账本必须是带任务 ID 的数组。");
  const current = new Map(ledger.map((task) => [task.id, task]));
  if (current.size !== ledger.length) throw new Error("账本包含重复任务 ID，请先人工核对。");
  const source = await stat(eventsPath);
  const candidates = new Map(ledger.filter((task) => task.status === "removed").map((task) => [task.id, candidate(task.id, "removed")]));
  let malformedLines = 0;
  let eventLine = 0;
  const scanned = await consumeJsonl(eventsPath, {
    end: source.size - 1,
    onLine(line) {
      eventLine += 1;
      let event;
      try { event = JSON.parse(line.toString("utf8")); } catch { malformedLines += 1; return; }
      if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") { malformedLines += 1; return; }
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
  const changed = source.dev !== after.dev || source.ino !== after.ino || source.size !== after.size || source.mtimeMs !== after.mtimeMs
    || ledgerRaw !== await readFile(ledgerPath, "utf8");
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
    tasks,
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
