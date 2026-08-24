#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { taskTimeState } from "../app/task-time-state.mjs";
import { inspectManagedReport, inspectManagedReportContent, repairManagedReportHash } from "./scheduled-report-probe.mjs";
import { setSessionScheduledReadonlyProfile } from "./task-ledger.mjs";

class ControlUnavailableError extends Error {}

const defaultControlUrl = "http://127.0.0.1:3001";
const controlUrl = (process.env.TASKCENTER_CONTROL_URL || defaultControlUrl).replace(/\/$/, "");
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
let recoveryAttempted = false;
let scheduledPatchRewrite = "";
const input = await readStdin();
const event = parseInput(input);
const action = process.argv[2] || "";
const agent = readArg("--agent") || process.env.TASKCENTER_AGENT || "unknown";
const provider = process.env.TASKCENTER_PROVIDER || (agent === "claude" ? "anthropic" : agent === "codex" ? "openai" : "unknown");
const model = process.env.TASKCENTER_MODEL || event.model || "unknown";
const sessionId = String(event.session_id || process.env.CLAUDE_SESSION_ID || process.env.CODEX_SESSION_ID || "").trim().toLowerCase();
const workspace = String(event.cwd || process.env.CLAUDE_PROJECT_DIR || process.env.PWD || "").trim();
let scheduledReadonly = scheduledReadonlyConfig();

try {
  if (action === "pre-tool-use" && isTrustedRecoveryCommand(event)) {
    console.log("TaskCenter 固定恢复命令放行");
    process.exit(0);
  }
  if (!sessionId) throw new Error("Hook 输入缺少真实 session_id，拒绝猜测会话身份。");
  if (action === "scheduled-profile-detect") {
    if (!scheduledReadonly || !matchesScheduledReadonlyPrompt(event.prompt)) process.exit(0);
    validateScheduledReadonlyIdentity();
    await detectScheduledReadonlyProfile();
    process.exit(0);
  }
  if (["pre-tool-use", "scheduled-pre-tool-use", "post-tool-use"].includes(action) && !scheduledReadonly) {
    scheduledReadonly = await loadScheduledReadonlyProfile();
  }
  if (scheduledReadonly) validateScheduledReadonlyIdentity();
  if (action === "session-start") {
    await registerSession();
    console.log(`TaskCenter Session 已登记: ${sessionId}`);
  } else if (action === "user-prompt-submit") {
    if (scheduledReadonly) process.exit(0);
    await provideTaskPreparationContext();
  } else if (action === "post-tool-use") {
    if (!scheduledReadonly) process.exit(0);
    if (String(event.tool_name || "") !== "apply_patch") process.exit(0);
    if (!isBoundScheduledReportPatch(event)) {
      throw new Error("scheduled_readonly 写后校验拒绝非绑定报告的 apply_patch 结果。");
    }
    const integrity = inspectManagedReport(scheduledReadonly.reportPath);
    if (!integrity.valid) {
      throw new Error(`scheduled_readonly 写后 sha256-v1 校验失败：${integrity.reason}。报告已写入但不得视为成功，请恢复有效托管区块。`);
    }
    console.log("TaskCenter scheduled_readonly 写后 sha256-v1 校验通过");
  } else if (["pre-tool-use", "scheduled-pre-tool-use"].includes(action)) {
    if (action === "scheduled-pre-tool-use" && !scheduledReadonly) process.exit(0);
    if (isInteractiveExec(event)) {
      throw new Error("TaskCenter 不允许启动可由 write_stdin 续写的交互式命令；请使用一次性命令。Hook 是生命周期守卫，不是进程级安全沙箱。");
    }
    if (scheduledReadonly) {
      const baselineAllowed = isScheduledReadonlyOperation(event);
      const scanAllowed = !baselineAllowed
        && isScheduledReadonlyScanOperation(event)
        && await hasScheduledReadonlyScanExemption();
      if (!baselineAllowed && !scanAllowed) {
        throw new Error("scheduled_readonly 仅允许绑定项目内的确定性读取、固定报告完整性探针和只读 MCP 查询；不授予任务写入、Context 写入、网络或脚本执行权限。");
      }
      await requireRegisteredSession();
      if (action === "pre-tool-use") await recordScheduledReadonlyAudit();
      if (scheduledPatchRewrite) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            updatedInput: { command: scheduledPatchRewrite },
            additionalContext: "TaskCenter 已限定补丁为绑定报告的托管区块，并补齐 sha256-v1。",
          },
        }));
        process.exit(0);
      }
      console.log(`TaskCenter scheduled_readonly ${scanAllowed ? "扫描豁免放行" : "放行"}：${scheduledReadonly.automationId}（无需 active task）`);
      process.exit(0);
    }
    if (action === "scheduled-pre-tool-use") process.exit(0);
    if (await isL0ReadOnlyInspection(event)) {
      await recordL0Audit();
      console.log("TaskCenter L0 确定性只读检查放行");
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
  process.exitCode = ["pre-tool-use", "post-tool-use"].includes(action) ? 2 : 1;
}

function scheduledReadonlyConfig() {
  const argProfile = readArg("--profile");
  const profile = argProfile || eventIdentityValue("profile");
  if (!profile) return null;
  return {
    profile,
    automationId: readArg("--automation-id") || eventIdentityValue("automation_id", "automationId"),
    projectId: readArg("--project-id") || eventIdentityValue("project_id", "projectId"),
    workspaceRoot: readArg("--workspace-root") || eventIdentityValue("workspace_root", "workspaceRoot"),
    reportPath: readArg("--report-path") || eventIdentityValue("report_path", "reportPath"),
    taskMutation: readArg("--task-mutation") || eventIdentityValue("task_mutation", "taskMutation"),
    pcaMutation: readArg("--pca-mutation") || eventIdentityValue("pca_mutation", "pcaMutation"),
    reportMutation: readArg("--report-mutation") || eventIdentityValue("report_mutation", "reportMutation"),
    network: readArg("--network") || eventIdentityValue("network"),
  };
}

function eventIdentityValue(...keys) {
  const key = keys.find((candidate) => Object.hasOwn(event, candidate));
  return key ? String(event[key]).trim() : "";
}

function validateScheduledReadonlyIdentity() {
  if (scheduledReadonly.profile !== "scheduled_readonly") throw new Error(`未知 Hook profile: ${scheduledReadonly.profile}`);
  const expected = {
    automationId: "cyberrole-agent-context",
    projectId: "cyberrole",
    taskMutation: "false",
    pcaMutation: "false",
    reportMutation: "true",
    network: "false",
  };
  for (const [key, value] of Object.entries(expected)) {
    if (scheduledReadonly[key] !== value) throw new Error(`scheduled_readonly 身份字段 ${key} 必须为 ${value}。`);
  }
  if (!scheduledReadonly.workspaceRoot || !scheduledReadonly.reportPath) {
    throw new Error("scheduled_readonly 需提供 automation-id、project-id、workspace-root、report-path、task/pca mutation 与 network 标识。");
  }
  if (!isAbsolute(scheduledReadonly.workspaceRoot) || !isAbsolute(scheduledReadonly.reportPath)) {
    throw new Error("scheduled_readonly 必须绑定绝对 workspace-root 与 report-path。");
  }
  scheduledReadonly.workspaceRoot = canonicalExistingPath(scheduledReadonly.workspaceRoot);
  scheduledReadonly.reportPath = canonicalExistingPath(scheduledReadonly.reportPath);
  const canonicalWorkspace = canonicalExistingPath(workspace);
  if (!scheduledReadonly.workspaceRoot || !scheduledReadonly.reportPath || !canonicalWorkspace) {
    throw new Error("scheduled_readonly 绑定的 workspace-root、report-path 与当前 cwd 必须真实存在。");
  }
  if (!isWithinPath(canonicalWorkspace, scheduledReadonly.workspaceRoot)) {
    throw new Error("scheduled_readonly 只能用于绑定的 CyberRole 工作区。");
  }
}

function isScheduledReadonlyOperation(payload) {
  const toolName = String(payload.tool_name || payload.tool || payload.name || "");
  if (isScheduledReadonlyMcp(toolName, payload.tool_input)) return true;
  if (toolName === "apply_patch") return isScheduledReportPatch(payload);
  if (["Read", "Grep", "Glob"].includes(toolName)) return isScheduledFileInspection(toolName, payload.tool_input);
  if (!["Bash", "exec_command"].includes(toolName)) return false;
  return isScheduledReadonlyCommand(payload);
}

function isScheduledReportPatch(payload) {
  if (scheduledReadonly.reportMutation !== "true") return false;
  if (!isBoundScheduledReportPatch(payload)) return false;
  try {
    const current = readFileSync(scheduledReadonly.reportPath, "utf8");
    if (!inspectManagedReportContent(current, scheduledReadonly.reportPath).valid) return false;
    const originalPatch = extractApplyPatch(payload);
    const updated = simulateScheduledReportPatch(current, originalPatch);
    if (!managedEnvelopeUnchanged(current, updated)) return false;
    const repaired = repairManagedReportHash(updated);
    if (!managedEnvelopeUnchanged(current, repaired)) return false;
    if (!inspectManagedReportContent(repaired, scheduledReadonly.reportPath).valid) return false;
    scheduledPatchRewrite = repaired === updated ? "" : appendManagedHashRepair(originalPatch, updated, repaired);
    return true;
  } catch {
    return false;
  }
}

function appendManagedHashRepair(patch, before, after) {
  const hashLine = /^- managed_payload_sha256：.*$/m;
  const beforeLine = before.match(hashLine)?.[0]?.replace(/\r$/, "");
  const afterLine = after.match(hashLine)?.[0]?.replace(/\r$/, "");
  if (!beforeLine || !afterLine || beforeLine === afterLine) throw new Error("managed_hash_repair_unavailable");
  const endAt = patch.lastIndexOf("*** End Patch");
  if (endAt < 0) throw new Error("missing_patch_end");
  return `${patch.slice(0, endAt)}@@\n-${beforeLine}\n+${afterLine}\n${patch.slice(endAt)}`;
}

function isBoundScheduledReportPatch(payload) {
  if (scheduledReadonly.reportMutation !== "true") return false;
  const patch = extractApplyPatch(payload);
  if (!patch || !/^\*\*\* Begin Patch\r?\n/.test(patch) || !/\r?\n\*\*\* End Patch\s*$/.test(patch)) return false;
  if (/^\*\*\* (?:Add|Delete) File:/m.test(patch) || /^\*\*\* Move to:/m.test(patch)) return false;
  const headers = [...patch.matchAll(/^\*\*\* Update File:\s*(.+)$/gm)];
  if (headers.length !== 1) return false;
  const canonical = canonicalExistingPath(resolveInputPath(headers[0][1].trim(), workspace));
  return Boolean(canonical) && samePath(canonical, scheduledReadonly.reportPath);
}

function extractApplyPatch(payload) {
  const input = payload.tool_input;
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  for (const key of ["command", "patch", "input"]) {
    if (typeof input[key] === "string") return input[key];
  }
  return "";
}

function simulateScheduledReportPatch(current, patch) {
  const normalized = patch.replaceAll("\r\n", "\n");
  const header = normalized.match(/^\*\*\* Update File:\s*.+$/m);
  if (!header) throw new Error("missing_update_header");
  const bodyStart = header.index + header[0].length + 1;
  const bodyEnd = normalized.lastIndexOf("\n*** End Patch");
  if (bodyEnd < bodyStart) throw new Error("missing_patch_end");
  const body = normalized.slice(bodyStart, bodyEnd);
  const sections = body.split(/^@@.*$/m).slice(1);
  if (sections.length === 0) throw new Error("missing_hunk");
  const usesCrLf = current.includes("\r\n");
  if ((usesCrLf && current.replaceAll("\r\n", "").includes("\n")) || (!usesCrLf && current.includes("\r"))) {
    throw new Error("mixed_or_invalid_line_endings");
  }
  const eol = usesCrLf ? "\r\n" : "\n";
  let lines = current.replaceAll("\r\n", "\n").split("\n");
  for (const section of sections) {
    const rawLines = section.replace(/^\n/, "").replace(/\n$/, "").split("\n");
    if (rawLines.length === 0 || rawLines.some((line) => !/^[ +\-]/.test(line))) throw new Error("invalid_hunk_line");
    const before = rawLines.filter((line) => line[0] !== "+").map((line) => line.slice(1));
    const after = rawLines.filter((line) => line[0] !== "-").map((line) => line.slice(1));
    if (before.length === 0) throw new Error("context_required");
    const positions = matchingLinePositions(lines, before);
    if (positions.length !== 1) throw new Error("hunk_context_not_unique");
    lines.splice(positions[0], before.length, ...after);
  }
  return lines.join(eol);
}

function matchingLinePositions(lines, expected) {
  const positions = [];
  for (let index = 0; index <= lines.length - expected.length; index += 1) {
    if (expected.every((line, offset) => lines[index + offset] === line)) positions.push(index);
  }
  return positions;
}

function managedEnvelopeUnchanged(before, after) {
  const begin = "<!-- AUTO-MANAGED-BEGIN -->";
  const end = "<!-- AUTO-MANAGED-END -->";
  const beforeBegin = uniqueMarkerIndex(before, begin);
  const beforeEnd = uniqueMarkerIndex(before, end);
  const afterBegin = uniqueMarkerIndex(after, begin);
  const afterEnd = uniqueMarkerIndex(after, end);
  if ([beforeBegin, beforeEnd, afterBegin, afterEnd].some((index) => index < 0)) return false;
  return before.slice(0, beforeBegin + begin.length) === after.slice(0, afterBegin + begin.length)
    && before.slice(beforeEnd) === after.slice(afterEnd);
}

function uniqueMarkerIndex(value, marker) {
  const first = value.indexOf(marker);
  if (first < 0 || value.indexOf(marker, first + marker.length) >= 0) return -1;
  return first;
}

function isScheduledReadonlyMcp(toolName, toolInput) {
  const normalized = toolName.replaceAll(".", "_");
  const matches = (allowed) => normalized === allowed || normalized.endsWith(`__${allowed}`);
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  const requestedProject = String(input.project_id || input.projectId || "").trim();
  if (requestedProject && requestedProject !== scheduledReadonly.projectId) return false;
  if (matches("context_capabilities") || matches("context_health_check")) return true;
  if (matches("context_list_active_tasks")) return requestedProject === scheduledReadonly.projectId;
  if (matches("taskcenter_session_register")) {
    const requestedSession = String(input.session_id || input.sessionId || "").trim();
    const requestedWorkspace = String(input.workspace || "").trim();
    if (!requestedWorkspace || !isAbsolute(requestedWorkspace)) return false;
    return requestedSession === sessionId && samePath(canonicalExistingPath(requestedWorkspace) || "", scheduledReadonly.workspaceRoot);
  }
  if (matches("taskcenter_session_status") || matches("taskcenter_task_query")) {
    const requestedSession = String(input.session_id || input.sessionId || "").trim();
    return requestedSession === sessionId && !input.task_id && !input.taskId;
  }
  if (matches("taskcenter_scheduled_readonly_scan_exemption_status")) {
    const requestedSession = String(input.session_id || "").trim().toLowerCase();
    return Object.keys(input).length === 1 && requestedSession === sessionId;
  }
  if (matches("taskcenter_scheduled_readonly_scan_exemption_set")) {
    const requestedSession = String(input.session_id || "").trim().toLowerCase();
    return Object.keys(input).length === 2 && requestedSession === sessionId && typeof input.enabled === "boolean";
  }
  return false;
}

function isScheduledReadonlyScanOperation(payload) {
  const toolName = String(payload.tool_name || payload.tool || payload.name || "");
  if (!["Bash", "exec_command"].includes(toolName)) return false;
  const input = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  const command = String(input.command || input.cmd || payload.command || "").trim();
  if (!command || /[\n\r;&<>`]/.test(command) || /\|\||\||\$\(/.test(command)) return false;
  const commandWorkspace = canonicalExistingPath(resolveInputPath(input.cwd || input.workdir || workspace));
  if (!commandWorkspace || !isWithinPath(commandWorkspace, scheduledReadonly.workspaceRoot)) return false;
  const tokens = splitCommandWords(command);
  if (basename(tokens[0]) === "rtk") tokens.shift();
  if (basename(tokens[0]) !== "git") return false;
  const args = tokens.slice(1);
  if (args[0] === "ls-files") return areWorkspacePathArguments(args.slice(1), commandWorkspace);
  if (args[0] === "check-ignore") {
    const options = new Set(["-q", "--quiet", "-v", "--verbose", "-n", "--non-matching", "--no-index"]);
    return areWorkspacePathArguments(args.slice(1), commandWorkspace, options);
  }
  return args[0] === "branch" && args.length === 2 && args[1] === "--show-current";
}

function areWorkspacePathArguments(args, commandWorkspace, allowedOptions = new Set()) {
  let afterSeparator = false;
  for (const arg of args) {
    if (!afterSeparator && arg === "--") {
      afterSeparator = true;
      continue;
    }
    if (!afterSeparator && arg.startsWith("-")) {
      if (!allowedOptions.has(arg)) return false;
      continue;
    }
    const candidate = resolve(commandWorkspace, arg);
    if (!isWithinPath(candidate, scheduledReadonly.workspaceRoot)) return false;
  }
  return true;
}

async function hasScheduledReadonlyScanExemption() {
  const result = await request("GET", "/session-status");
  const current = Array.isArray(result.sessions)
    ? result.sessions.find((session) => session.sessionId === sessionId)
    : null;
  const profile = current?.scheduledReadonly;
  return profile?.profile === "scheduled_readonly"
    && profile.scanExempt === true
    && profile.automationId === scheduledReadonly.automationId
    && profile.projectId === scheduledReadonly.projectId
    && samePath(canonicalExistingPath(profile.workspaceRoot) || "", scheduledReadonly.workspaceRoot);
}

function isScheduledFileInspection(toolName, toolInput) {
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  const base = canonicalExistingPath(resolveInputPath(input.cwd || input.workdir || workspace));
  if (!base) return false;
  if (!isWithinPath(base, scheduledReadonly.workspaceRoot)) return false;
  const paths = [];
  for (const key of ["path", "file_path", "filepath"]) {
    if (typeof input[key] === "string" && input[key].trim()) paths.push(input[key].trim());
  }
  for (const key of ["paths", "file_paths"]) {
    if (Array.isArray(input[key])) paths.push(...input[key].filter((item) => typeof item === "string" && item.trim()));
  }
  if (toolName === "Read" && paths.length === 0) return false;
  if (toolName === "Glob" && typeof input.pattern === "string" && !isSafeRelativePattern(input.pattern)) return false;
  if (typeof input.glob === "string" && !isSafeRelativePattern(input.glob)) return false;
  return paths.every((path) => isAllowedScheduledPath(resolveInputPath(path, base)));
}

function isSafeRelativePattern(pattern) {
  const value = String(pattern).replaceAll("\\", "/");
  return !isAbsolute(value) && !value.split("/").includes("..");
}

function isScheduledReadonlyCommand(payload) {
  const input = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  const command = String(input.command || input.cmd || payload.command || "").trim();
  if (!command || /[\n\r;&<>`]/.test(command) || /\|\||\||\$\(/.test(command)) return false;
  const commandWorkspace = canonicalExistingPath(resolveInputPath(input.cwd || input.workdir || workspace));
  if (!commandWorkspace) return false;
  if (!isWithinPath(commandWorkspace, scheduledReadonly.workspaceRoot)) return false;
  const tokens = splitCommandWords(command);
  if (basename(tokens[0]) === "rtk") tokens.shift();
  const executable = basename(tokens[0]);
  const args = tokens.slice(1);
  if (executable === "pwd") return args.length === 0;
  if (executable === "git") return isScheduledReadonlyGit(args);
  if (["cat", "head", "tail", "sed"].includes(executable)) {
    return isScheduledReadonlyFileCommand(executable, args, commandWorkspace);
  }
  if (["shasum", "sha256sum"].includes(executable)) return isReportIntegrityProbe(executable, args, commandWorkspace);
  if (executable === "node") return isFixedManagedReportProbe(args);
  return false;
}

function isScheduledReadonlyFileCommand(executable, args, cwd) {
  let pathArg = "";
  if (executable === "cat") {
    pathArg = singleFileArgument(args);
  } else if (["head", "tail"].includes(executable)) {
    pathArg = boundedLineReadArgument(args);
  } else if (executable === "sed") {
    pathArg = boundedSedReadArgument(args);
  }
  if (!pathArg) return false;
  return isAllowedScheduledPath(resolveInputPath(pathArg, cwd));
}

function singleFileArgument(args) {
  if (args.length === 1 && !args[0].startsWith("-")) return args[0];
  if (args.length === 2 && args[0] === "--") return args[1];
  return "";
}

function boundedLineReadArgument(args) {
  if (args.length === 1 && !args[0].startsWith("-")) return args[0];
  if (args.length === 3 && ["-n", "--lines"].includes(args[0]) && /^\d{1,6}$/.test(args[1])) return args[2];
  if (args.length === 2 && /^(?:-n|--lines=)\d{1,6}$/.test(args[0])) return args[1];
  return "";
}

function boundedSedReadArgument(args) {
  if (args.length !== 3 || args[0] !== "-n") return "";
  if (!/^(?:\d{1,9}|\$)(?:,(?:\d{1,9}|\$))?p$/.test(args[1])) return "";
  return args[2];
}

function isFixedManagedReportProbe(args) {
  if (args.length !== 3 || args[1] !== "--report") return false;
  const script = canonicalExistingPath(resolveInputPath(args[0], workspace));
  const report = canonicalExistingPath(resolveInputPath(args[2], workspace));
  return samePath(script || "", resolve(projectRoot, "scripts", "scheduled-report-probe.mjs"))
    && samePath(report || "", scheduledReadonly.reportPath);
}

function isScheduledReadonlyGit(args) {
  if (args[0] === "rev-parse") return args.length === 2 && args[1] === "HEAD";
  if (args[0] !== "status") return false;
  return args.slice(1).every((arg) => ["--short", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--branch", "-b", "--untracked-files=no", "-uno"].includes(arg));
}

function isReportIntegrityProbe(executable, args, cwd) {
  const pathArg = executable === "shasum"
    ? (args.length === 3 && args[0] === "-a" && args[1] === "256" ? args[2] : "")
    : (args.length === 1 ? args[0] : "");
  return Boolean(pathArg) && samePath(canonicalExistingPath(resolveInputPath(pathArg, cwd)) || "", scheduledReadonly.reportPath);
}

function resolveInputPath(path, base = workspace) {
  return resolve(isAbsolute(path) ? path : resolve(base, path));
}

function isAllowedScheduledPath(path) {
  const canonical = canonicalExistingPath(path);
  return Boolean(canonical) && (isWithinPath(canonical, scheduledReadonly.workspaceRoot) || samePath(canonical, scheduledReadonly.reportPath));
}

function canonicalExistingPath(path) {
  try {
    return realpathSync.native(resolve(path));
  } catch {
    return "";
  }
}

function isWithinPath(path, root) {
  const suffix = relative(root, path);
  return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
}

async function requireRegisteredSession() {
  const result = await request("GET", "/session-status");
  const current = Array.isArray(result.sessions)
    ? result.sessions.find((session) => session.sessionId === sessionId)
    : null;
  if (!current || current.status !== "registered") throw new Error("scheduled_readonly Session 尚未登记，请先完成 SessionStart 登记。");
}

async function recordScheduledReadonlyAudit() {
  await request("POST", "/sessions/l0-audit", {
    session_id: sessionId,
    workspace,
    command: "scheduled_readonly",
    profile: scheduledReadonly.profile,
    automation_id: scheduledReadonly.automationId,
    project_id: scheduledReadonly.projectId,
  });
}

async function loadScheduledReadonlyProfile() {
  const result = await request("GET", "/session-status");
  const current = Array.isArray(result.sessions)
    ? result.sessions.find((session) => session.sessionId === sessionId)
    : null;
  const profile = current?.scheduledReadonly;
  if (!profile) return null;
  return {
    profile: String(profile.profile || ""),
    automationId: String(profile.automationId || ""),
    projectId: String(profile.projectId || ""),
    workspaceRoot: String(profile.workspaceRoot || ""),
    reportPath: String(profile.reportPath || ""),
    taskMutation: String(profile.taskMutation),
    pcaMutation: String(profile.pcaMutation),
    reportMutation: String(profile.reportMutation),
    network: String(profile.network),
  };
}

async function detectScheduledReadonlyProfile() {
  await requireRegisteredSession();
  setSessionScheduledReadonlyProfile(sessionId, {
    session_id: sessionId,
    profile: scheduledReadonly.profile,
    automation_id: scheduledReadonly.automationId,
    project_id: scheduledReadonly.projectId,
    workspace_root: scheduledReadonly.workspaceRoot,
    report_path: scheduledReadonly.reportPath,
    task_mutation: false,
    pca_mutation: false,
    report_mutation: true,
    network: false,
  });
  const probe = `rtk node ${shellQuote(resolve(projectRoot, "scripts", "scheduled-report-probe.mjs"))} --report ${shellQuote(scheduledReadonly.reportPath)}`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: [
        "TaskCenter scheduled_readonly Profile 已绑定当前自动化 Session。",
        `完整性校验必须使用固定只读探针：${probe}`,
        "只允许通过 apply_patch 更新绑定的唯一滚动报告；TaskCenter/PCA/task mutation、delegation、网络和其他文件写入仍为 0。",
      ].join("\n"),
    },
  }));
}

function matchesScheduledReadonlyPrompt(prompt) {
  const value = String(prompt || "");
  return [
    "在 CyberRole 当前主工作区执行“夜间项目交付系统优化探索”",
    "trial_id：cyberrole-context-lifecycle-20260820",
    "<!-- AUTO-MANAGED-BEGIN -->",
  ].every((marker) => value.includes(marker));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
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

async function isL0ReadOnlyInspection(payload) {
  if (!isReadOnlyInspection(payload)) return false;
  const result = await request("GET", "/session-status");
  const current = Array.isArray(result.sessions)
    ? result.sessions.find((session) => session.sessionId === sessionId)
    : null;
  if (!current || current.status !== "registered") return false;
  const tasks = await request("GET", "/tasks");
  const hasActiveTask = (tasks.tasks || []).some((task) => task.sessionId === sessionId && ["in_progress", "blocked", "planned"].includes(task.status));
  return !hasActiveTask && !(await resolveCurrentDelegation())?.task;
}

function isReadOnlyInspection(payload) {
  const toolName = String(payload.tool_name || payload.tool || payload.name || "");
  if (["Read", "Grep", "Glob"].includes(toolName)) return true;
  if (!["Bash", "exec_command"].includes(toolName)) return false;
  const input = payload.tool_input && typeof payload.tool_input === "object"
    ? payload.tool_input
    : {};
  const command = String(input.cmd || input.command || payload.command || "").trim();
  if (!command) return false;
  // L0 只接受单条、无重定向/管道/命令替换的确定性检查命令。
  if (/[\n\r;&<>`]/.test(command) || /\|\||\||\$\(/.test(command)) return false;
  const tokens = splitCommandWords(command);
  if (basename(tokens[0]) === "rtk") tokens.shift();
  const executable = basename(tokens[0]);
  const args = tokens.slice(1);
  if (["pwd", "ls", "cat", "head", "tail", "wc", "du", "stat", "file"].includes(executable)) return true;
  if (executable === "rg") return !args.some((token) => token === "--pre" || token.startsWith("--pre="));
  if (executable === "sed") return isReadOnlySed(args);
  if (executable === "find") return isReadOnlyFind(args);
  if (executable !== "git") return false;
  return isReadOnlyGit(args);
}

function isReadOnlySed(args) {
  if (!args.length || !args.some((token) => token === "-n" || token === "--quiet" || token === "--silent")) return false;
  if (args.some((token) => token === "-f" || token === "--file" || token.startsWith("--file=") || token === "--in-place" || token.startsWith("--in-place=") || (/^-[^-]/.test(token) && token !== "-n" && token !== "-e"))) return false;
  const scripts = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "-e" || token === "--expression") {
      if (!args[index + 1]) return false;
      scripts.push(args[index + 1]);
      index += 1;
    } else if (token.startsWith("--expression=")) {
      scripts.push(token.slice("--expression=".length));
    } else if (!token.startsWith("-") && scripts.length === 0) {
      scripts.push(token);
    }
  }
  return scripts.length > 0 && scripts.every(isSafeSedPrintScript);
}

function isSafeSedPrintScript(script) {
  const value = String(script).trim();
  if (/^(?:(?:\d+|\$)(?:,(?:\d+|\$))?)?(?:p|l|=)$/.test(value)) return true;
  if (!value.startsWith("/")) return false;
  let escaped = false;
  for (let index = 1; index < value.length; index += 1) {
    if (!escaped && value[index] === "/") return /^(?:p|l|=)$/.test(value.slice(index + 1));
    escaped = !escaped && value[index] === "\\";
    if (value[index] !== "\\") escaped = false;
  }
  return false;
}

function isReadOnlyFind(args) {
  const unsafeActions = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);
  return !args.some((token) => unsafeActions.has(token));
}

function isReadOnlyGit(args) {
  const subcommand = args[0];
  if (["status", "check-ignore", "ls-files"].includes(subcommand)) return true;
  if (subcommand === "branch") return args.length === 2 && args[1] === "--show-current";
  if (!["diff", "show", "log"].includes(subcommand)) return false;
  return !args.slice(1).some((token) => token === "--ext-diff" || token === "--textconv" || token === "--output" || token.startsWith("--output="));
}

async function recordL0Audit() {
  await request("POST", "/sessions/l0-audit", { session_id: sessionId, workspace, command: "read_only" });
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
  const patch = extractApplyPatch(payload);
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
  throw new Error("该命令不满足 L0 确定性只读规则，请拆成单条只读命令，或创建 fast/standard/strict 任务。当前 Session 无活跃任务或有效 delegation；CLI 执行器应先领取 taskcenter_delegation_grant，不要为普通 CLI Run 重复创建正式任务。");
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
