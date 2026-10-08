import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const terminalEvents = new Set([
  "task_complete",
  "task_failed",
  "turn_aborted",
  "turn_failed",
]);

export function inspectSessionState(threadId, sessionsRoot = defaultSessionsRoot()) {
  const sessionPath = findSessionPath(threadId, sessionsRoot);
  if (!sessionPath) {
    throw new Error("找不到目标 Session 的本地会话文件");
  }

  const activeTurns = new Map();
  for (const line of readFileSync(sessionPath, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    if (item.type !== "event_msg") continue;
    const event = item.payload || {};
    const turnId = String(event.turn_id || "");
    if (!turnId) continue;
    if (event.type === "task_started") {
      activeTurns.set(turnId, item.timestamp || "");
    } else if (terminalEvents.has(event.type)) {
      activeTurns.delete(turnId);
    }
  }

  const pending = [...activeTurns.entries()]
    .map(([turnId, startedAt]) => ({ turnId, startedAt }))
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  return {
    sessionPath,
    busy: pending.length > 0,
    activeTurns: pending,
  };
}

export function defaultSessionsRoot() {
  return process.env.TASKCENTER_SESSIONS_ROOT || join(homedir(), ".codex", "sessions");
}

export function findSessionPath(threadId, root = defaultSessionsRoot()) {
  const matches = collectFiles(
    root,
    (path) => path.endsWith(".jsonl") && path.includes(threadId),
  );
  return matches.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0] || "";
}

export function directUserAuthorization(sessionPath, taskId, sessionId, taskCreatedAt, now = new Date().toISOString()) {
  const ttlMs = 7_200_000;
  const created = Date.parse(taskCreatedAt);
  const current = Date.parse(now);
  if (!sessionPath || !Number.isFinite(created) || !Number.isFinite(current)) return null;
  let latest = null;
  for (const line of readFileSync(sessionPath, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    try {
      const item = JSON.parse(line);
      const timestamp = Date.parse(item.timestamp);
      if (!Number.isFinite(timestamp) || timestamp < created || timestamp > current || current - timestamp >= ttlMs) continue;
      const message = item.type === "event_msg" && item.payload?.type === "user_message" ? item.payload.message
        : item.type === "response_item" && item.payload?.type === "message" && item.payload.role === "user"
          ? (item.payload.content || []).map(part => part.text || "").join("") : "";
      if (!/^(?:主模型直接执行吧|允许主模型直接执行|授权主模型直接执行)(?:[\s，。！!]|$)/.test(String(message).trim())) continue;
      if (!latest || timestamp > latest.timestamp) latest = { timestamp, message: String(message) };
    } catch { /* Ignore a partially written JSONL line. */ }
  }
  return latest ? {
    fingerprint: createHash("sha256").update(`${taskId}:${sessionId}`).digest("hex"),
    expiresAt: new Date(latest.timestamp + ttlMs).toISOString(),
  } : null;
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
