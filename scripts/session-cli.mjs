import { spawn } from "node:child_process";
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

export function resumeSession({
  threadId,
  prompt,
  workingDirectory,
  sessionsRoot = defaultSessionsRoot(),
  onStarted,
}) {
  return new Promise((resolve, reject) => {
    const command = process.env.TASKCENTER_CODEX_COMMAND || "codex";
    const prefixArgs = parsePrefixArgs(process.env.TASKCENTER_CODEX_PREFIX_ARGS);
    const args = [...prefixArgs, "exec", "resume", threadId, prompt, "--json"];
    const startedAt = new Date().toISOString();
    const child = spawn(command, args, {
      cwd: workingDirectory,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let threadStarted = false;
    let turnStarted = false;
    let startReported = false;

    const reportStarted = () => {
      if (!threadStarted || !turnStarted || startReported) return;
      startReported = true;
      onStarted?.();
    };

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === "thread.started" && event.thread_id === threadId) {
            threadStarted = true;
          }
          if (event.type === "turn.started") turnStarted = true;
          reportStarted();
        } catch {
          // Codex may print a non-JSON warning before the JSONL stream.
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(compactError(stderr || `Codex CLI 退出码 ${code ?? signal}`)));
        return;
      }
      if (!threadStarted || !turnStarted) {
        reject(new Error("Codex CLI 未确认 Session 和 turn 已启动"));
        return;
      }
      try {
        const state = inspectSessionState(threadId, sessionsRoot);
        if (!sessionContainsPrompt(state.sessionPath, prompt, startedAt)) {
          throw new Error("Codex CLI 已退出，但原 Session JSONL 中没有找到本次消息");
        }
        resolve({ threadId, sessionPath: state.sessionPath });
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function defaultSessionsRoot() {
  return process.env.TASKCENTER_SESSIONS_ROOT || join(homedir(), ".codex", "sessions");
}

function sessionContainsPrompt(sessionPath, prompt, startedAt) {
  for (const line of readFileSync(sessionPath, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    try {
      const item = JSON.parse(line);
      if (startedAt && item.timestamp && item.timestamp < startedAt) continue;
      if (item.type === "event_msg" && item.payload?.type === "user_message") {
        if (item.payload.message === prompt) return true;
      }
      if (item.type === "response_item" && item.payload?.type === "message" && item.payload.role === "user") {
        const text = (item.payload.content || []).map((part) => part.text || "").join("");
        if (text === prompt) return true;
      }
    } catch {
      // Ignore a partially written final JSONL line.
    }
  }
  return false;
}

function findSessionPath(threadId, root) {
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

function parsePrefixArgs(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
  } catch {
    // Fall through to the actionable configuration error.
  }
  throw new Error("TASKCENTER_CODEX_PREFIX_ARGS 必须是字符串数组 JSON");
}

function compactError(value) {
  return String(value || "未知错误").replace(/\s+/g, " ").trim().slice(0, 500);
}
