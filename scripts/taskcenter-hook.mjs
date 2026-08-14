#!/usr/bin/env node

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

class ControlUnavailableError extends Error {}

const defaultControlUrl = "http://127.0.0.1:3001";
const controlUrl = (process.env.TASKCENTER_CONTROL_URL || defaultControlUrl).replace(/\/$/, "");
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
let recoveryAttempted = false;
const input = await readStdin();
const event = parseInput(input);
const action = process.argv[2] || "";
const agent = readArg("--agent") || process.env.TASKCENTER_AGENT || "unknown";
const provider = process.env.TASKCENTER_PROVIDER || (agent === "claude" ? "anthropic" : agent === "codex" ? "openai" : "unknown");
const model = process.env.TASKCENTER_MODEL || event.model || "unknown";
const sessionId = String(event.session_id || process.env.CLAUDE_SESSION_ID || process.env.CODEX_SESSION_ID || "").trim();
const workspace = String(event.cwd || process.env.CLAUDE_PROJECT_DIR || process.env.PWD || "").trim();

try {
  if (action === "pre-tool-use" && isTrustedRecoveryCommand(event)) {
    console.log("TaskCenter 固定恢复命令放行");
    process.exit(0);
  }
  if (!sessionId) throw new Error("Hook 输入缺少真实 session_id，拒绝猜测会话身份。");
  if (action === "session-start") {
    await registerSession();
    console.log(`TaskCenter Session 已登记: ${sessionId}`);
  } else if (action === "pre-tool-use") {
    if (isInteractiveExec(event)) {
      throw new Error("TaskCenter 不允许启动可由 write_stdin 续写的交互式命令；请使用一次性命令。Hook 是生命周期守卫，不是进程级安全沙箱。");
    }
    if (isReadOnlyInspection(event)) {
      console.log("TaskCenter 只读检查放行");
      process.exit(0);
    }
    const task = await requireTask();
    await recordToolCall(task);
    console.log("TaskCenter 任务门禁通过");
  } else {
    throw new Error(`未知 Hook 操作: ${action}`);
  }
} catch (error) {
  console.error(`TaskCenter Hook: ${error.message}`);
  process.exitCode = action === "pre-tool-use" ? 2 : 1;
}

function isTrustedRecoveryCommand(payload) {
  if (payload.tool_name !== "Bash") return false;
  if (typeof payload.cwd !== "string" || !payload.cwd) return false;
  if (resolve(payload.cwd) !== projectRoot) return false;
  const toolInput = payload.tool_input;
  if (!toolInput || typeof toolInput !== "object" || typeof toolInput.command !== "string") return false;
  return new Set([
    "/bin/bash scripts/taskcenter-control.sh start",
    "/bin/bash scripts/taskcenter-control.sh status",
  ]).has(toolInput.command);
}

function isReadOnlyInspection(payload) {
  const toolName = String(payload.tool_name || payload.tool || payload.name || "");
  if (!["Bash", "exec_command"].includes(toolName)) return false;
  const input = payload.tool_input && typeof payload.tool_input === "object"
    ? payload.tool_input
    : {};
  const command = String(input.cmd || input.command || payload.command || "").trim();
  if (!command) return false;
  // 只接受单条、无重定向/管道/命令替换的检查命令。不能证明只读时继续走任务门禁。
  if (/[\n\r;&<>`]/.test(command) || /\|\||\||\$\(/.test(command)) return false;
  if (/\brg\b[^\n]*\s--pre(?:-glob)?\b/.test(command)) return false;
  if (/^git\s+(?:diff|show|log)\b/.test(command) && /(?:^|\s)--output(?:=|\s|$)/.test(command)) return false;
  return /^(?:(?:\/[^\s/]+)*\/)?(?:rg|grep|ls|pwd|head|tail|wc|stat|file|ps|pgrep|lsof)\b/.test(command)
    || /^git\s+(?:status|diff|log|show|rev-parse)\b/.test(command)
    || /^git\s+branch\s+--show-current\b/.test(command);
}

function isInteractiveExec(payload) {
  const toolName = String(payload.tool_name || payload.tool || payload.name || "");
  if (!["Bash", "exec_command"].includes(toolName)) return false;
  const input = payload.tool_input && typeof payload.tool_input === "object"
    ? payload.tool_input
    : {};
  const command = String(input.command || input.cmd || payload.command || "").trim();
  // tty 不是 Codex Bash Hook 的 canonical 字段，只把它作为其他客户端的附加信号。
  if (input.tty === true) return true;
  const invocation = interpreterInvocation(command);
  if (!invocation) return false;
  const { executable, args } = invocation;
  if (isTerminalQuery(executable, args)) return false;
  if (["bash", "dash", "fish", "sh", "zsh"].includes(executable)) {
    return hasShortFlag(args, "i") || hasShortFlag(args, "s") || args.includes("--interactive") || !hasShellProgram(args);
  }
  if (executable === "node") {
    return hasShortFlag(args, "i") || args.includes("--interactive") || args.includes("-") || !hasNodeProgram(args);
  }
  return hasShortFlag(args, "i") || args.includes("-") || !hasPythonProgram(args);
}

function interpreterInvocation(command) {
  const tokens = splitCommandWords(command);
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
  if (basename(tokens[index]) === "env") {
    index += 1;
    while (index < tokens.length) {
      const token = tokens[index];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        index += 1;
      } else if (["-u", "--unset", "-C", "--chdir"].includes(token)) {
        index += 2;
      } else if (token.startsWith("--unset=") || token.startsWith("--chdir=") || token === "-i" || token === "--ignore-environment") {
        index += 1;
      } else if (token === "--") {
        index += 1;
        break;
      } else {
        break;
      }
    }
  }
  const executable = basename(tokens[index]);
  if (!["bash", "dash", "fish", "sh", "zsh", "node", "python", "python3"].includes(executable)) return null;
  return { executable, args: tokens.slice(index + 1) };
}

function isTerminalQuery(executable, args) {
  if (args.length !== 1) return false;
  const option = args[0];
  if (["--version", "--help"].includes(option)) return true;
  if (executable === "node") return ["-v", "-h"].includes(option);
  if (["python", "python3"].includes(executable)) return ["-V", "-h"].includes(option);
  return false;
}

function hasShortFlag(args, flag) {
  return args.some((token) => /^-[^-]+$/.test(token) && token.slice(1).includes(flag));
}

function hasShellProgram(args) {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "-c" || (/^-[^-]*c/.test(token) && token !== "-")) return Boolean(args[index + 1]);
    if (["-O", "+O", "--rcfile", "--init-file"].includes(token)) {
      index += 1;
      continue;
    }
    if (token === "--") return Boolean(args[index + 1] && args[index + 1] !== "-");
    if (token === "-" || token.startsWith("-") || token.startsWith("+")) continue;
    return true;
  }
  return false;
}

function hasNodeProgram(args) {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (["-e", "--eval", "-p", "--print"].includes(token)) return Boolean(args[index + 1]);
    if (token.startsWith("--eval=") || token.startsWith("--print=")) return true;
    if (["-r", "--require", "--import", "--loader"].includes(token)) {
      index += 1;
      continue;
    }
    if (token === "--") return Boolean(args[index + 1] && args[index + 1] !== "-");
    if (token === "-" || token.startsWith("-")) continue;
    return true;
  }
  return false;
}

function hasPythonProgram(args) {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (["-c", "-m"].includes(token)) return Boolean(args[index + 1]);
    if (["-W", "-X"].includes(token)) {
      index += 1;
      continue;
    }
    if (token === "--") return Boolean(args[index + 1] && args[index + 1] !== "-");
    if (token === "-" || token.startsWith("-")) continue;
    return true;
  }
  return false;
}

function splitCommandWords(command) {
  return (command.match(/(?:[^\s"'\\]+|"(?:\\.|[^"])*"|'[^']*')+/g) || [])
    .map((word) => word.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2"));
}

function basename(value = "") {
  return value.slice(value.lastIndexOf("/") + 1);
}

async function recordToolCall(task) {
  if (!event.tool_name && !event.tool && !event.name) return;
  try {
    await request("POST", "/task-events", {
      type: "tool.call",
      event_id: `hook-tool-${event.call_id || event.tool_use_id || `${sessionId}-${Date.now()}`}`,
      session_id: sessionId,
      task_id: event.task_id || task.id,
      tool_name: event.tool_name || event.tool || event.name,
      tool_use_id: event.tool_use_id || event.call_id || "",
    });
  } catch (error) {
    console.error(`TaskCenter Hook 警告：工具统计上报失败，已放行（${error.message}）`);
  }
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
  if (!result.accepted) throw new Error("TaskCenter 未接受 Session 登记。");
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
    throw new Error("当前 Session 尚未创建 TaskCenter 任务，请先调用 taskcenter_task_create。");
  }
  const tasks = await request("GET", "/tasks");
  const active = (tasks.tasks || []).filter((task) => task.sessionId === sessionId && ["in_progress", "blocked", "planned"].includes(task.status));
  const rank = { in_progress: 3, blocked: 2, planned: 1 };
  const task = active.sort((left, right) => (rank[right.status] - rank[left.status]) || (Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || "")))[0];
  if (!task) throw new Error("当前 Session 无活跃任务，请创建或启动任务后再调用工具。");
  return task;
}

async function request(method, path, body) {
  try {
    return await requestOnce(method, path, body);
  } catch (error) {
    if (!(error instanceof ControlUnavailableError) || recoveryAttempted || controlUrl !== defaultControlUrl) throw error;
    recoveryAttempted = true;
    await recoverControlService(error);
    return requestOnce(method, path, body);
  }
}

async function requestOnce(method, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${controlUrl}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json", "X-TaskCenter-Task": "hook" } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let value;
    try {
      value = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`TaskCenter 返回非 JSON (${response.status})`);
    }
    if (!response.ok) throw new Error(value.error || `TaskCenter 请求失败 (${response.status})`);
    return value;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("TaskCenter 请求超时，写操作已阻断。");
    if (error instanceof TypeError) throw new ControlUnavailableError("TaskCenter 控制服务不可用。");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function recoverControlService(originalError) {
  try {
    await execFileAsync("/bin/bash", [resolve(projectRoot, "scripts/taskcenter-control.sh"), "start"], {
      cwd: projectRoot,
      env: { ...process.env, BASH_ENV: "", ENV: "", TASKCENTER_NO_OPEN: "1" },
      timeout: 30_000,
    });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || "未知错误").trim();
    throw new Error(`${originalError.message} 自动恢复失败，写操作已阻断。${detail ? ` ${detail}` : ""} 可在项目目录运行：/bin/bash scripts/taskcenter-control.sh start`);
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
