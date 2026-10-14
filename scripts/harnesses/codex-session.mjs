import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

const terminalEvents = new Set([
  "task_complete",
  "task_failed",
  "turn_aborted",
  "turn_failed",
]);

function sessionAccumulator(sessionPath) {
  const activeTurns = new Map();
  let lastTerminal = null;
  return { consume(line) {
    if (!line) return;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      return;
    }
    if (item.type !== "event_msg") return;
    const event = item.payload || {};
    const turnId = String(event.turn_id || "");
    if (!turnId) return;
    if (event.type === "task_started") {
      activeTurns.set(turnId, item.timestamp || "");
    } else if (terminalEvents.has(event.type)) {
      activeTurns.delete(turnId);
      if (Number.isFinite(Date.parse(item.timestamp))) lastTerminal = { type: event.type, at: item.timestamp, turn_id: turnId };
    }
  }, result() {
    const pending = [...activeTurns.entries()]
      .map(([turnId, startedAt]) => ({ turnId, startedAt }))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    return { sessionPath, busy: pending.length > 0, activeTurns: pending, lastTerminal };
  } };
}

export function inspectSessionState(threadId, sessionsRoot = defaultSessionsRoot()) {
  readdirSync(sessionsRoot);
  const sessionPath = findSessionPath(threadId, sessionsRoot);
  if (!sessionPath) throw Object.assign(new Error("找不到目标 Session 的本地会话文件"), { code: "CODEX_SESSION_NOT_FOUND" });
  const state = sessionAccumulator(sessionPath);
  for (const line of readFileSync(sessionPath, "utf8").split(/\r?\n/)) state.consume(line);
  return state.result();
}

export async function inspectSessionStateAsync(threadId, sessionsRoot = defaultSessionsRoot(), { presenceOnly = false } = {}) {
  readdirSync(sessionsRoot);
  const sessionPath = findSessionPath(threadId, sessionsRoot);
  if (!sessionPath) throw Object.assign(new Error("找不到目标 Session 的本地会话文件"), { code: "CODEX_SESSION_NOT_FOUND" });
  if (presenceOnly) return { sessionPath };
  const state = sessionAccumulator(sessionPath);
  const stream = createReadStream(sessionPath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  stream.on("error", error => lines.emit("error", error));
  try {
    for await (const line of lines) state.consume(line);
    return state.result();
  } finally { lines.close(); stream.destroy(); }
}

export function defaultSessionsRoot() {
  return process.env.TASKCENTER_SESSIONS_ROOT || join(homedir(), ".codex", "sessions");
}

export function isSubagentSession(sessionId, agent, event = {}) {
  // Claude provides agent_id on subagent hook events; Codex records its origin in session_meta.
  if (agent === "claude") return typeof event.agent_id === "string" && Boolean(event.agent_id.trim());
  if (agent !== "codex" || !sessionId) return false;
  const path = findSessionPath(sessionId);
  if (!path) return false;
  let descriptor;
  try {
    descriptor = openSync(path, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytes).toString("utf8").split("\n", 1)[0];
    const item = JSON.parse(firstLine);
    return item.type === "session_meta" && item.payload?.id === sessionId
      && (item.payload.thread_source === "subagent" || Boolean(item.payload.source?.subagent));
  } catch { return false; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function findSessionPath(threadId, root = defaultSessionsRoot()) {
  const matches = collectFiles(
    root,
    (path) => path.endsWith(".jsonl") && path.includes(threadId),
  );
  return matches.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0] || "";
}

function collectFiles(root, predicate) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(path, predicate));
    else if (predicate(path)) files.push(path);
  }
  return files;
}
