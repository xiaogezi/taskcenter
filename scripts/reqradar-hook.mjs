#!/usr/bin/env node

const controlUrl = (process.env.REQRADAR_CONTROL_URL || "http://127.0.0.1:3001").replace(/\/$/, "");
const input = await readStdin();
const event = parseInput(input);
const action = process.argv[2] || "";
const agent = readArg("--agent") || process.env.REQRADAR_AGENT || "unknown";
const provider = process.env.REQRADAR_PROVIDER || (agent === "claude" ? "anthropic" : agent === "codex" ? "openai" : "unknown");
const model = process.env.REQRADAR_MODEL || event.model || "unknown";
const sessionId = String(event.session_id || process.env.CLAUDE_SESSION_ID || process.env.CODEX_SESSION_ID || "").trim();
const workspace = String(event.cwd || process.env.CLAUDE_PROJECT_DIR || process.env.PWD || "").trim();

try {
  if (!sessionId) throw new Error("Hook 输入缺少真实 session_id，拒绝猜测会话身份。");
  if (action === "session-start") {
    await registerSession();
    console.log(`ReqRadar Session 已登记: ${sessionId}`);
  } else if (action === "pre-tool-use") {
    await requireTask();
    console.log("ReqRadar 任务门禁通过");
  } else {
    throw new Error(`未知 Hook 操作: ${action}`);
  }
} catch (error) {
  console.error(`ReqRadar Hook: ${error.message}`);
  process.exitCode = action === "pre-tool-use" ? 2 : 1;
}

async function registerSession() {
  const result = await request("POST", "/task-events", {
    type: "session.register",
    event_id: `hook-session-register-${sessionId}`,
    session_id: sessionId,
    workspace,
    agent,
    provider,
    model,
  });
  if (!result.accepted) throw new Error("ReqRadar 未接受 Session 登记。");
}

async function requireTask() {
  const result = await request("GET", "/session-status");
  const current = Array.isArray(result.sessions)
    ? result.sessions.find((session) => session.sessionId === sessionId)
    : null;
  if (!current || current.status !== "registered") {
    throw new Error("当前 Session 尚未登记，请先完成 SessionStart 登记。");
  }
  if (current.taskCount < 1) {
    throw new Error("当前 Session 尚未创建 ReqRadar 任务，请先调用 reqradar_task_create。");
  }
}

async function request(method, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${controlUrl}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json", "X-ReqRadar-Task": "hook" } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let value;
    try {
      value = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`ReqRadar 返回非 JSON (${response.status})`);
    }
    if (!response.ok) throw new Error(value.error || `ReqRadar 请求失败 (${response.status})`);
    return value;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("ReqRadar 请求超时，写操作已阻断。");
    if (error instanceof TypeError) throw new Error("ReqRadar 控制服务不可用，写操作已阻断。");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function parseInput(raw) {
  if (!raw.trim()) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : {};
  } catch {
    throw new Error("Hook 输入不是合法 JSON。");
  }
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}
