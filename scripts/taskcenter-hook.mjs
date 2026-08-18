#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { taskTimeState } from "../app/task-time-state.mjs";

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
  } else if (action === "user-prompt-submit") {
    await provideTaskPreparationContext();
  } else if (action === "pre-tool-use") {
    if (isInteractiveExec(event)) {
      throw new Error("TaskCenter 不允许启动可由 write_stdin 续写的交互式命令；请使用一次性命令。Hook 是生命周期守卫，不是进程级安全沙箱。");
    }
    if (isReadOnlyInspection(event)) {
      console.log("TaskCenter 只读检查放行");
      process.exit(0);
    }
    if (await isGateAllowlistedSession()) {
      console.log("TaskCenter 门禁豁免白名单放行：当前 Session 无需活跃任务");
      process.exit(0);
    }
    const task = await requireTask();
    await remindOverdueTask(task);
    await recordToolCall(task);
    console.log(task.delegation ? `TaskCenter delegation 放行：${task.delegation.id} → ${task.id}` : "TaskCenter 任务门禁通过");
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
  if (!samePath(resolve(payload.cwd), projectRoot)) return false;
  const toolInput = payload.tool_input;
  if (!toolInput || typeof toolInput !== "object" || typeof toolInput.command !== "string") return false;
  return new Set([
    "node scripts/taskcenter-control.mjs start",
    "node scripts/taskcenter-control.mjs status",
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
  const inspectedCommand = command.replace(/^(?:(?:\/[^\s/]+)*\/)?rtk\s+/, "");
  if (/\brg\b[^\n]*\s--pre(?:-glob)?\b/.test(inspectedCommand)) return false;
  if (/^git\s+(?:diff|show|log)\b/.test(inspectedCommand) && /(?:^|\s)--output(?:=|\s|$)/.test(inspectedCommand)) return false;
  return /^(?:(?:\/[^\s/]+)*\/)?(?:rg|grep|ls|pwd|head|tail|wc|stat|file|ps|pgrep|lsof)\b/.test(inspectedCommand)
    || /^git\s+(?:status|diff|log|show|rev-parse)\b/.test(inspectedCommand)
    || /^git\s+branch\s+--show-current\b/.test(inspectedCommand);
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
  if (["powershell", "pwsh"].includes(executable)) {
    if (hasPowerShellFlag(args, ["-noexit"])) return true;
    return !hasPowerShellProgram(args);
  }
  if (executable === "cmd") {
    if (args.some((token) => token.toLowerCase() === "/k")) return true;
    return !hasCmdProgram(args);
  }
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
  if (!["bash", "dash", "fish", "sh", "zsh", "node", "python", "python3", "powershell", "pwsh", "cmd"].includes(executable)) return null;
  return { executable, args: tokens.slice(index + 1) };
}

function isTerminalQuery(executable, args) {
  if (args.length !== 1) return false;
  const option = args[0];
  if (["bash", "dash", "fish", "sh", "zsh"].includes(executable)) return ["--version", "--help"].includes(option);
  if (executable === "node") return ["-v", "-h", "--version", "--help"].includes(option);
  if (["python", "python3"].includes(executable)) return ["-V", "-h", "--version", "--help"].includes(option);
  if (["powershell", "pwsh"].includes(executable)) {
    if (["-h", "-help", "--help", "-?", "/?"].includes(option.toLowerCase())) return true;
    return executable === "pwsh" && option === "--version";
  }
  if (executable === "cmd") return ["/?"].includes(option.toLowerCase());
  return false;
}

function hasPowerShellFlag(args, flags) {
  const expected = new Set(flags.map((flag) => flag.toLowerCase()));
  return args.some((token) => expected.has(token.toLowerCase()));
}

function hasPowerShellProgram(args) {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index].toLowerCase();
    if (["-command", "-commandwithargs", "-c", "/command", "/c", "-encodedcommand", "-e", "/encodedcommand", "-file", "-f", "/file"].includes(token)) {
      return Boolean(args[index + 1]);
    }
    if (["-executionpolicy", "-ep", "-inputformat", "-outputformat", "-windowstyle", "-workingdirectory"].includes(token)) {
      index += 1;
    }
  }
  return false;
}

function hasCmdProgram(args) {
  const index = args.findIndex((token) => token.toLowerCase() === "/c");
  return index >= 0 && Boolean(args[index + 1]);
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
  const name = value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1).toLowerCase();
  return name.replace(/\.(?:exe|cmd|bat|com)$/i, "");
}

function samePath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function recordToolCall(task) {
  if (!event.tool_name && !event.tool && !event.name) return;
  try {
    if (task.delegation) {
      await request("POST", "/delegations/touch", {
        delegation_id: task.delegation.id,
        session_id: sessionId,
        workspace,
        tool_name: event.tool_name || event.tool || event.name,
        tool_use_id: event.tool_use_id || event.call_id || "",
        paths: delegationPaths(event),
      });
      return;
    }
    await request("POST", "/task-events", {
      type: "tool.call",
      event_id: `hook-tool-${event.call_id || event.tool_use_id || `${sessionId}-${Date.now()}`}`,
      session_id: task.sessionId || sessionId,
      task_id: event.task_id || task.id,
      tool_name: event.tool_name || event.tool || event.name,
      tool_use_id: event.tool_use_id || event.call_id || "",
    });
  } catch (error) {
    if (task.delegation) throw error;
    console.error(`TaskCenter Hook 警告：工具统计上报失败，已放行（${error.message}）`);
  }
}

function delegationPaths(payload) {
  const input = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  const paths = [];
  for (const key of ["path", "file_path", "filepath", "target_path", "output_path"]) {
    if (typeof input[key] === "string" && input[key].trim()) paths.push(input[key].trim());
  }
  for (const key of ["paths", "file_paths"]) {
    if (Array.isArray(input[key])) paths.push(...input[key].filter((item) => typeof item === "string"));
  }
  const patch = typeof input.patch === "string" ? input.patch : typeof input.input === "string" ? input.input : "";
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)) paths.push(match[1].trim());
  return [...new Set(paths)].slice(0, 100);
}

async function remindOverdueTask(task) {
  if (!["planned", "in_progress", "blocked"].includes(task.status)) return;
  const timeState = taskTimeState(task);
  if (!timeState.overdue && !timeState.effortOverrun) return;
  const overdueHours = Math.max(1, Math.ceil(timeState.scheduleOverdueMs / (60 * 60 * 1000)));
  const effortOverrunMinutes = timeState.effortVarianceMs === null ? 0 : Math.max(1, Math.ceil(timeState.effortVarianceMs / 60_000));
  const reminderIdentity = createHash("sha256")
    .update(`${task.id}:${task.dueAt || ""}:${task.estimatedEffortMs || ""}`)
    .digest("hex")
    .slice(0, 24);
  try {
    const result = await request("POST", "/task-events", {
      type: "task.reminder",
      event_id: `hook-overdue-${reminderIdentity}`,
      session_id: task.sessionId || sessionId,
      task_id: task.id,
      expected_at: task.expectedAt,
      due_at: task.dueAt,
      estimated_effort_ms: task.estimatedEffortMs,
      next_action: "区分有效执行、阻塞等待和范围变化，记录估时偏差原因；必要时调整 due_at、estimated_effort_ms 或拆分任务。",
    });
    if (!result.idempotent) {
      const signals = [
        timeState.overdue ? `交付截止已超 ${overdueHours} 小时` : "",
        timeState.effortOverrun ? `有效执行超出预估约 ${effortOverrunMinutes} 分钟` : "",
      ].filter(Boolean).join("；");
      console.log(`TaskCenter 估时提醒：${signals}。请区分范围变化、阻塞等待与执行偏差，再调整估时或拆分任务；同一估时版本仅提醒一次。`);
    }
  } catch (error) {
    console.error(`TaskCenter Hook 警告：逾期反馈记录失败，已放行（${error.message}）`);
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

async function isGateAllowlistedSession() {
  try {
    const result = await request("GET", "/gate-session-allowlist");
    return Array.isArray(result.selection?.threadIds) && result.selection.threadIds.includes(sessionId);
  } catch (error) {
    // 升级窗口内旧控制服务尚无此接口时保持原门禁，避免新 Hook 与旧服务互相锁死。
    if (/接口不存在|\b404\b/.test(String(error.message || ""))) return false;
    throw error;
  }
}

async function requireTask() {
  const result = await request("GET", "/session-status");
  const current = Array.isArray(result.sessions)
    ? result.sessions.find((session) => session.sessionId === sessionId)
    : null;
  if (!current || current.status !== "registered") {
    throw new Error("当前 Session 尚未登记，请先完成 SessionStart 登记。");
  }
  const tasks = await request("GET", "/tasks");
  const active = (tasks.tasks || []).filter((task) => task.sessionId === sessionId && ["in_progress", "blocked", "planned"].includes(task.status));
  const rank = { in_progress: 3, blocked: 2, planned: 1 };
  const task = active.sort((left, right) => (rank[right.status] - rank[left.status]) || (Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || "")))[0];
  if (task) return task;
  const delegated = await resolveCurrentDelegation();
  if (delegated?.task && delegated?.delegation) return { ...delegated.task, delegation: delegated.delegation };
  throw new Error("当前 Session 无活跃任务或有效 delegation。主 Agent 应创建正式任务；CLI 执行器应先登记 Session 并领取 taskcenter_delegation_grant，不要为普通 CLI Run 重复创建正式任务。");
}

async function provideTaskPreparationContext() {
  if (await isGateAllowlistedSession()) return;
  const status = await request("GET", "/session-status");
  const current = Array.isArray(status.sessions)
    ? status.sessions.find((session) => session.sessionId === sessionId)
    : null;
  let activeTask = null;
  if (current?.status === "registered" && current.taskCount > 0) {
    const tasks = await request("GET", "/tasks");
    activeTask = (tasks.tasks || []).find(
      (task) => task.sessionId === sessionId && ["in_progress", "blocked", "planned"].includes(task.status),
    );
  }
  if (activeTask || (await resolveCurrentDelegation())?.task) return;
  const registrationInstruction = current?.status === "registered"
    ? "当前 Session 已登记"
    : "先调用 taskcenter_session_register 登记当前真实 Session";
  const additionalContext = [
    `TaskCenter 任务准备提示：当前 Session 不在门禁豁免白名单且没有活跃正式任务；${registrationInstruction}。`,
    "如果本轮只做只读检查，可以直接继续。",
    "如果本轮是主 Agent 的正式工作，必须在第一次工具调用前调用 taskcenter_task_create；如果是 CLI 派发执行器，应领取主 Agent 提供的 delegation，不要为普通 CLI Run 创建正式子任务。",
    "不要先撞 PreToolUse 门禁，也不要要求用户手动创建任务、启动服务或批准提案。只有 TaskCenter MCP 确实不可用时，才限制为只读并报告 TASKCENTER_UNAVAILABLE。",
  ].join("\n");
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  }));
}

async function resolveCurrentDelegation() {
  try {
    return await request("GET", `/delegations/resolve?session_id=${encodeURIComponent(sessionId)}&workspace=${encodeURIComponent(workspace)}`);
  } catch (error) {
    if (/接口不存在|\b404\b/.test(String(error.message || ""))) return null;
    throw error;
  }
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
    await execFileAsync(process.execPath, [resolve(projectRoot, "scripts/taskcenter-control.mjs"), "start"], {
      cwd: projectRoot,
      env: { ...process.env, TASKCENTER_NO_OPEN: "1" },
      timeout: 30_000,
    });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || "未知错误").trim();
    throw new Error(`${originalError.message} 自动恢复失败，写操作已阻断。${detail ? ` ${detail}` : ""} 可在项目目录运行：node scripts/taskcenter-control.mjs start`);
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
