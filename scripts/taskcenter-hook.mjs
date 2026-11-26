#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { createHookTransport } from "./hook-transport.mjs";
import { occupiesSession } from "../lib/task-workspace.mjs";
import { taskTimeState } from "../app/task-time-state.mjs";
import { isSubagentSession } from "./harnesses/codex-session.mjs";
import { classifyGateDenial, evaluateGateDenials, formatGateDenialAssessment, NO_ACTIVE_TASK_RECOVERY } from "./governance-metrics.mjs";
import { inspectManagedReport, inspectManagedReportContent, repairManagedReportHash } from "./scheduled-report-probe.mjs";
import { sessionRegistryPath, setSessionScheduledReadonlyProfile } from "./task-ledger.mjs";
import { inspectionBatch } from "./inspection-command.mjs";
import { explorationCommand } from "./jev-inspection.mjs";
import { isTrustedInspectionEntry } from "./trusted-cli-identity.mjs";
import { inspectTrustedCli } from "./trusted-cli-inspection.mjs";
import { isTrustedSystemQuery } from "./network-inspection.mjs";
import { isReadOnlyRemoteProbe } from "./ssh-inspection.mjs";
import { assertNoSymlinks, auditAutomationMemory, automationMemoryBinding, inspectAutomationMemoryPatch } from "./automation-memory.mjs";

const defaultControlUrl = "http://127.0.0.1:3001";
const controlUrl = (process.env.TASKCENTER_CONTROL_URL || defaultControlUrl).replace(/\/$/, "");
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const { request, requestOnce } = createHookTransport({
  controlUrl,
  recover: controlUrl === defaultControlUrl ? recoverControlService : undefined,
});
let scheduledPatchRewrite = "";
let preparedTask;
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
  // A registered ordinary session can use the existing deterministic read-only
  // grammar without waiting on the control service. A missing/corrupt registry
  // or a scheduled profile falls back to the existing authoritative gate.
  if (action === "pre-tool-use" && sessionId && !scheduledReadonly && !isInteractiveExec(event)
    && isReadOnlyInspection(event) && isKnownOrdinarySession() && isFastPathWorkdirWithinWorkspace(event)) {
    console.log("TaskCenter L0 确定性只读检查放行（快速放行，不登记任务或逐次计数）");
    process.exit(0);
  }
  if (isSubagentSession(sessionId, agent, event)) process.exit(0);
  if ((action === "pre-tool-use" || action === "scheduled-pre-tool-use") && isTrustedRecoveryCommand(event)) {
    console.log("TaskCenter 固定恢复命令放行");
    process.exit(0);
  }
  if (!sessionId) throw new Error("Hook 输入缺少真实 session_id，拒绝猜测会话身份。");
  if (["pre-tool-use", "post-tool-use"].includes(action) && String(event.tool_name || "") === "apply_patch") {
    const patch = extractApplyPatch(event);
    if (/^\*\*\* (?:Add|Update|Delete) File: .*[/\\]automations[/\\][^/\\]+[/\\]memory\.md\s*$/m.test(patch)) {
      const binding = await automationMemoryBinding(sessionId, workspace, agent);
      if (!binding) throw new Error("自动化 memory 写入未绑定可信自动化身份、工作区和用户批准配置。");
      const registered = await requireRegisteredSession();
      if (canonicalExistingPath(registered.workspace) !== binding.workspaceRoot) throw new Error("自动化 memory 登记工作区不一致。");
      if (action === "pre-tool-use") {
        const inspected = inspectAutomationMemoryPatch(binding, patch, simulateScheduledReportPatch);
        auditAutomationMemory(binding, "allowed", inspected.content, inspected.oldSha);
        console.log("TaskCenter 自动化 memory 单文件写入放行：instory-pca-2；不授予项目写入。");
      } else {
        assertNoSymlinks(binding.memoryPath);
        auditAutomationMemory(binding, "verified", readFileSync(binding.memoryPath, "utf8"));
        console.log("TaskCenter 自动化 memory 落盘与基线校验通过。");
      }
      process.exit(0);
    }
  }
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
    if (agent === "claude" && !scheduledReadonly) {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: claudeLifecycleContext() } }));
    } else console.log(`TaskCenter Session 已登记: ${sessionId}`);
  } else if (action === "stop") {
    // Completion readiness remains observable through TaskCenter, but ending a
    // Codex turn must never interrupt the user's active workflow.
    process.stdout.write(JSON.stringify({ continue: true }));
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
    // A 404 means a pre-budget release, not permission to bypass its old gate.
    const prepared = await prepareCurrentTask();
    if (prepared) {
      if (prepared.task_id && isRecoveryOperation(event)) {
        console.log("TaskCenter 收尾通道放行；写入仍由服务端校验 task 身份。");
        process.exit(0);
      }
    }
    if (agent === "codex" && !scheduledReadonly && prepared?.active_task === null
      && event.session_id === sessionId && typeof event.turn_id === "string"
      && ["Bash", "exec_command"].includes(event.tool_name) && !hasCustomExecutionShell(event)
      && isKnownOrdinarySession() && isFastPathWorkdirWithinWorkspace(event)) {
      const command = explorationCommand(event.tool_input?.command ?? event.tool_input?.cmd, sessionId, event.turn_id);
      if (command) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command } },
        }));
        process.exit(0);
      }
    }
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
    console.log("TaskCenter 任务门禁通过");
  } else {
    throw new Error(`未知 Hook 操作: ${action}`);
  }
} catch (error) {
  if (action === "stop") {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }
  console.error(`TaskCenter Hook: ${error.message}`);
  if (agent === "claude" && sessionId && !scheduledReadonly) {
    console.error(`真实 Hook 身份：${JSON.stringify({ session_id: sessionId, workspace })}。不要添加 local_ 或自拟测试身份。通过 MCP 查询该 Session 的任务；同一交付接续使用 taskcenter_task_resume，新目标使用 taskcenter_task_begin（必填 plan、scope）。身份一致不代表其他门禁条件已满足。`);
  }
  if (["pre-tool-use", "scheduled-pre-tool-use", "post-tool-use"].includes(action)) await reportGateDenial(error);
  process.exitCode = ["pre-tool-use", "scheduled-pre-tool-use", "post-tool-use"].includes(action) ? 2 : 1;
}

function claudeLifecycleContext() {
  return [
    `TaskCenter Session 已登记: ${sessionId}`,
    `真实 Hook 身份：${JSON.stringify({ session_id: sessionId, workspace, agent, provider })}。所有 TaskCenter 调用沿用此 session_id，不添加 local_、不自拟测试 ID。`,
    "taskcenter_task_begin 已包含登记；新目标须提供 event_id、session_id、workspace、title、goal、scope、plan、acceptance_criteria。推荐结构化验收项 {id,description,required}，关闭时引用原 id；字符串验收项才自动生成 acceptance-N。已有同一交付先查询并 resume，不重复创建。",
    "Context 已有 Hook 注入时复用其 client_session_id、semantic task_id、turn_id，不重复 attach/commit。手动接入且 execution_mode=taskcenter 时：task_begin → context.open_task(execution_task_id=返回的 TaskCenter task_id，不传 create_new) → prepare_turn(task_id=返回的语义 task_id) → commit_turn(同一语义 task_id/turn_id) → task_close(TaskCenter task_id)。",
    "MCP 接口成功不等于写入门禁通过。验收必须核对真实 Hook Session 下的任务绑定与授权范围内的实际写入，不以自拟身份或 replayed=true 的回执冒充新鲜端到端验证。",
    `完整参数模板与验收步骤：${resolve(projectRoot, "docs/claude-lifecycle.md")}`,
  ].join("\n");
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
    automationId: "instory",
    projectId: "instory",
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
  scheduledReadonly.reportPath = canonicalScheduledReportPath(scheduledReadonly.reportPath);
  const canonicalWorkspace = canonicalExistingPath(workspace);
  if (!scheduledReadonly.workspaceRoot || !scheduledReadonly.reportPath || !canonicalWorkspace) {
    throw new Error("scheduled_readonly workspace-root 与 cwd 必须存在，报告必须绑定在 project-context/90-Agent提案/自动化报告 下的单个 Markdown 文件且不得经过符号链接。");
  }
  if (!isWithinPath(canonicalWorkspace, scheduledReadonly.workspaceRoot)) {
    throw new Error("scheduled_readonly 只能用于绑定的项目工作区。");
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
    const originalPatch = extractApplyPatch(payload);
    if (/^\*\*\* Add File:/m.test(originalPatch)) {
      try {
        lstatSync(scheduledReadonly.reportPath);
        return false;
      } catch (error) {
        if (error.code !== "ENOENT") return false;
      }
      const lines = originalPatch.replaceAll("\r\n", "\n").trimEnd().split("\n").slice(2, -1);
      if (!lines.length || lines.some((line) => !line.startsWith("+"))) return false;
      const created = `${lines.map((line) => line.slice(1)).join("\n")}\n`;
      // First creation has no human-owned envelope to preserve: allow only the managed block.
      if (!created.startsWith("<!-- AUTO-MANAGED-BEGIN -->\n") || !created.endsWith("<!-- AUTO-MANAGED-END -->\n")) return false;
      const repaired = repairManagedReportHash(created);
      if (!inspectManagedReportContent(repaired, scheduledReadonly.reportPath).valid) return false;
      scheduledPatchRewrite = `*** Begin Patch\n*** Add File: ${scheduledReadonly.reportPath}\n${repaired.trimEnd().split("\n").map((line) => `+${line}`).join("\n")}\n*** End Patch`;
      return true;
    }
    const current = readFileSync(scheduledReadonly.reportPath, "utf8");
    if (!inspectManagedReportContent(current, scheduledReadonly.reportPath).valid) return false;
    const updated = simulateScheduledReportPatch(current, originalPatch);
    if (!managedEnvelopeUnchanged(current, updated)) return false;
    const repaired = repairManagedReportHash(updated);
    if (!managedEnvelopeUnchanged(current, repaired)) return false;
    if (!inspectManagedReportContent(repaired, scheduledReadonly.reportPath).valid) return false;
    scheduledPatchRewrite = repaired === updated ? "" : rewriteManagedHashRepair(originalPatch, current, updated, repaired);
    return true;
  } catch {
    return false;
  }
}

function rewriteManagedHashRepair(patch, current, before, after) {
  const hashLine = /^- managed_payload_sha256：.*$/m;
  const beforeLine = before.match(hashLine)?.[0]?.replace(/\r$/, "");
  const afterLine = after.match(hashLine)?.[0]?.replace(/\r$/, "");
  if (!beforeLine || !afterLine || beforeLine === afterLine) throw new Error("managed_hash_repair_unavailable");
  const normalized = patch.replaceAll("\r\n", "\n");
  const staleAddition = `\n+${beforeLine}\n`;
  if (normalized.includes(staleAddition)) return normalized.replace(staleAddition, `\n+${afterLine}\n`);
  const staleContext = `\n ${beforeLine}\n`;
  if (normalized.includes(staleContext)) return normalized.replace(staleContext, `\n-${beforeLine}\n+${afterLine}\n`);

  const currentLines = current.replaceAll("\r\n", "\n").split("\n");
  const hashAt = currentLines.indexOf(beforeLine);
  if (hashAt < 0) throw new Error("managed_hash_source_missing");
  const bodyEnd = normalized.lastIndexOf("\n*** End Patch");
  if (bodyEnd < 0) throw new Error("missing_patch_end");
  const hunkMatches = [...normalized.slice(0, bodyEnd).matchAll(/^@@.*$/gm)];
  let insertAt = bodyEnd + 1;
  for (let index = 0; index < hunkMatches.length; index += 1) {
    const match = hunkMatches[index];
    const sectionStart = match.index + match[0].length + 1;
    const sectionEnd = index + 1 < hunkMatches.length ? hunkMatches[index + 1].index : bodyEnd;
    const rawLines = normalized.slice(sectionStart, sectionEnd).replace(/\n$/, "").split("\n");
    const expected = rawLines.filter((line) => line[0] !== "+").map((line) => line.slice(1));
    const positions = matchingLinePositions(currentLines, expected);
    if (positions.length !== 1) throw new Error("hunk_context_not_unique");
    if (positions[0] > hashAt) {
      insertAt = match.index;
      break;
    }
  }
  return `${normalized.slice(0, insertAt)}@@\n-${beforeLine}\n+${afterLine}\n${normalized.slice(insertAt)}`;
}

function isBoundScheduledReportPatch(payload) {
  if (scheduledReadonly.reportMutation !== "true") return false;
  const patch = extractApplyPatch(payload);
  if (!patch || !/^\*\*\* Begin Patch\r?\n/.test(patch) || !/\r?\n\*\*\* End Patch\s*$/.test(patch)) return false;
  if (/^\*\*\* Delete File:/m.test(patch) || /^\*\*\* Move to:/m.test(patch)) return false;
  const headers = [...patch.matchAll(/^\*\*\* (?:Update|Add) File:\s*(.+)$/gm)];
  if (headers.length !== 1) return false;
  const canonical = canonicalScheduledReportPath(resolveInputPath(headers[0][1].trim(), workspace));
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
  if (hasCustomExecutionShell(payload)) return false;
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
  if (hasCustomExecutionShell(payload)) return false;
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
  if (isGitObjectInspection(args)) return true;
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

// Resolve missing descendants without following symlinks, including dangling links.
function canonicalScheduledReportPath(path) {
  if (!scheduledReadonly.workspaceRoot) return "";
  let target = resolve(path);
  let ancestor = dirname(target);
  while (canonicalExistingPath(ancestor) !== scheduledReadonly.workspaceRoot) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return "";
    ancestor = parent;
  }
  target = resolve(scheduledReadonly.workspaceRoot, relative(ancestor, target));
  const reportRoot = resolve(scheduledReadonly.workspaceRoot, "project-context", "90-Agent提案", "自动化报告");
  if (dirname(target) !== reportRoot || !target.endsWith(".md")) return "";
  let candidate = target;
  while (candidate !== scheduledReadonly.workspaceRoot) {
    try {
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink() || (candidate === target ? !stat.isFile() : !stat.isDirectory())) return "";
    } catch (error) {
      if (error.code !== "ENOENT") return "";
    }
    candidate = dirname(candidate);
  }
  return target;
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
  return current;
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
  const prepared = await prepareCurrentTask();
  let profile = prepared?.scheduled_readonly;
  if (!prepared) {
    // Older services and unregistered Sessions still use the existing checks.
    const result = await request("GET", "/session-status");
    profile = result.sessions?.find(session => session.sessionId === sessionId)?.scheduledReadonly;
  }
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
  return /^Automation ID: instory\s*$/m.test(value)
    && value.includes(scheduledReadonly.reportPath)
    && value.includes("<!-- AUTO-MANAGED-BEGIN -->");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function isTrustedRecoveryCommand(payload) {
  if (hasCustomExecutionShell(payload)) return false;
  const toolName = String(payload.tool_name || payload.tool || payload.name || "");
  // 兼容 Bash（主代理）与 exec_command（Codex）两种工具入口。
  if (!["Bash", "exec_command"].includes(toolName)) return false;
  const toolInput = payload.tool_input;
  if (!toolInput || typeof toolInput !== "object") return false;
  // Codex 用 cmd，Bash 用 command。
  const raw = String(toolInput.cmd || toolInput.command || "").trim();
  if (!raw) return false;
  const cwdValue = payload.cwd || toolInput.workdir || payload.workdir || "";
  // 规范化：剥离 rtk / rtk proxy 前缀与前导 cd <dir> &&。
  let command = raw;
  const tokens = command.split(/\s+/);
  if (tokens[0] === "rtk") {
    tokens.shift();
    if (tokens[0] === "proxy") tokens.shift();
    command = tokens.join(" ");
  }
  const parts = command.split("&&");
  if (parts.length > 1 && parts[0].trim().startsWith("cd ")) {
    const cdArgs = parts[0].trim().slice(3).trim();
    const cwdBase = typeof cwdValue === "string" && cwdValue ? cwdValue : ".";
    let cdOk = cdArgs === "" || cdArgs === ".";
    if (!cdOk) {
      const target = cdArgs.replace(/^['"]|['"]$/g, "");
      cdOk = samePath(resolve(cwdBase, target), projectRoot);
    }
    if (cdOk) command = parts.slice(1).join("&&").trim();
  }
  // 白名单：相对路径形式要求 cwd 在项目根；绝对路径形式自带项目身份，不强制 cwd。
  const relativeAllowed = new Set([
    "node scripts/taskcenter-control.mjs start",
    "node scripts/taskcenter-control.mjs status",
    "/bin/bash scripts/taskcenter-control.sh start",
    "/bin/bash scripts/taskcenter-control.sh status",
  ]);
  if (relativeAllowed.has(command)) {
    // 相对路径形式必须 cwd 在项目根，否则脚本根本不存在。
    return typeof cwdValue === "string" && cwdValue && samePath(resolve(cwdValue), projectRoot);
  }
  // 绝对路径形式：node <abs>/scripts/taskcenter-control.mjs start|status
  const absMatch = command.match(/^node\s+(\/\S*\/scripts\/taskcenter-control\.mjs)\s+(start|status)$/);
  if (absMatch) {
    const scriptPath = resolve(absMatch[1]);
    return samePath(scriptPath, resolve(projectRoot, "scripts", "taskcenter-control.mjs"));
  }
  return false;
}

function isKnownOrdinarySession() {
  try {
    const registry = JSON.parse(readFileSync(sessionRegistryPath, "utf8"));
    if (!registry || typeof registry !== "object" || Array.isArray(registry)) return false;
    const entry = registry[sessionId];
    return Boolean(entry && typeof entry === "object" && !Array.isArray(entry)
      && entry.sessionId === sessionId && entry.registeredAt
      && typeof entry.workspace === "string" && entry.workspace === workspace
      && !entry.scheduledReadonly);
  } catch { return false; }
}

function isFastPathWorkdirWithinWorkspace(payload) {
  const input = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  const explicit = [
    ...["workdir", "cwd"].filter(key => Object.hasOwn(input, key)).map(key => input[key]),
    ...(Object.hasOwn(payload, "workdir") ? [payload.workdir] : []),
  ];
  if (!explicit.length) return true; // Host session cwd is already matched to the registry.
  const root = canonicalExistingPath(workspace);
  if (!root) return false;
  return explicit.every(value => {
    if (typeof value !== "string" || !isAbsolute(value)) return false;
    const actual = canonicalExistingPath(value);
    return Boolean(actual && isWithinPath(actual, root));
  });
}

async function isL0ReadOnlyInspection(payload) {
  if (!isReadOnlyInspection(payload)) return false;
  if (preparedTask) return !preparedTask.active_task;
  const result = await request("GET", "/session-status");
  const current = Array.isArray(result.sessions)
    ? result.sessions.find((session) => session.sessionId === sessionId)
    : null;
  if (!current || current.status !== "registered") return false;
  const tasks = await request("GET", "/tasks");
  const hasActiveTask = (tasks.tasks || []).some((task) => task.sessionId === sessionId && occupiesSession(task));
  return !hasActiveTask;
}

function hasCustomExecutionShell(payload) {
  // A command's read-only grammar says nothing about the program selected to
  // interpret it. Only the host's unchanged default shell is eligible for a
  // no-task exemption. Even a familiar explicit shell path needs a task.
  const input = payload.tool_input;
  return Object.hasOwn(payload, "shell") || Boolean(input && typeof input === "object" && Object.hasOwn(input, "shell"));
}

function isReadOnlyInspection(payload) {
  const toolName = String(payload.tool_name || payload.tool || payload.name || "");
  if (["Read", "Grep", "Glob"].includes(toolName)) return true;
  if (!["Bash", "exec_command"].includes(toolName)) return false;
  if (hasCustomExecutionShell(payload)) return false;
  const input = payload.tool_input && typeof payload.tool_input === "object"
    ? payload.tool_input
    : {};
  const command = String(input.cmd || input.command || payload.command || "").trim();
  if (!command) return false;
  const batch = inspectionBatch(command);
  return Boolean(batch?.every(({ words, heredoc }) => isReadOnlyCommand(words, heredoc, input.workdir || input.cwd || workspace)));
}

function isReadOnlyCommand(words, heredoc, cwd = workspace, depth = 0, remote = false) {
  if (depth > 2) return false;
  // Wrappers execute before adapters, so they need their own installation identity.
  if (basename(words[0]) === "rtk" && !isTrustedInspectionEntry(words[0], { cwd })) return false;
  const trusted = inspectTrustedCli(words, { cwd, workspace, inspectRemote: remote => {
    if (isReadOnlyRemoteProbe(remote)) return true;
    const allowed = ["hostname", "whoami", "uptime", "uname", "sw_vers", "df", "pwd", "ls", "find", "cat", "head", "tail", "wc", "du", "stat", "file", "rg", "sed", "git", "xcode-select", "xcodebuild", "shasum", "sha256sum", "diff", "security"];
    const name = basename(remote[0]);
    if (![name, `/bin/${name}`, `/usr/bin/${name}`].includes(remote[0])) return false;
    // Remote status/diff may execute fsmonitor or external diff from that host's config.
    if (name === "git" && !["--version", "rev-parse", "show-ref", "for-each-ref", "branch", "tag"].includes(remote[1])) return false;
    return allowed.includes(name) && isReadOnlyCommand(remote, false, "/", depth + 1, true);
  } });
  if (trusted !== null) return !heredoc && trusted;
  if (!remote && !isTrustedInspectionEntry(words[0], { cwd })) return false;
  const tokens = [...words];
  if (basename(tokens[0]) === "rtk") {
    tokens.shift();
    if (tokens[0] === "proxy") tokens.shift();
    // RTK read is a wrapper subcommand; all other entries execute another CLI.
    if (tokens[0] !== "read" && !isTrustedInspectionEntry(tokens[0], { cwd, allowBuiltins: false })) return false;
  }
  const executable = basename(tokens[0] || "");
  const args = tokens.slice(1);
  if (heredoc && executable !== "cat") return false;
  if (executable === "env") return false;
  if (isCliVersionQuery(executable, args)) return true;
  if (["which", "command", "type"].includes(executable)) {
    // `command NAME` executes NAME; only its explicit lookup forms are read-only.
    const options = { which: ["-a", "-s"], command: ["-v", "-V"], type: ["-a", "-p", "-P", "-t"] }[executable];
    const names = options.includes(args[0]) ? args.slice(1) : args;
    if (executable === "command" && names === args) return false;
    return names.length > 0 && names.every(name => /^[A-Za-z0-9_./+][A-Za-z0-9_./+:-]*$/.test(name));
  }
  if (executable === "tail" && args.some((arg) => /^--(?:follow|retry)(?:=|$)|^-[^-]*[fF]/.test(arg))) return false;
  if (args.some((token) => /(?:^|[/\\])(?:auth\.json|\.env(?:\.[^/\\]+)?|id_rsa|id_ed25519)(?:$|[/\\])/.test(token))) return false;
  if (["whoami", "hostname", "uptime"].includes(executable)) return args.length === 0;
  if (["sh", "/bin/sh"].includes(tokens[0]) && args.length === 2 && args[0] === "-c") {
    if (!isTrustedSystemQuery(tokens[0], "sh", "/bin/sh")) return false;
    const batch = inspectionBatch(args[1]);
    return Boolean(batch?.every(command => !command.heredoc && isReadOnlyCommand(command.words, false, cwd, depth + 1, remote)));
  }
  if (executable === "xcrun") return args.length === 2 && ["swift", "swiftc"].includes(args[0]) && args[1] === "--version"
    || args.length >= 2 && args[0] === "simctl" && args[1] === "list" && args.slice(2).every(arg => ["runtimes", "devices", "available", "--json", "-j"].includes(arg));
  if (executable === "uname") return args.every(arg => /^-[asnrvmpo]+$/.test(arg));
  if (executable === "sw_vers") return args.length === 0 || args.length === 1 && ["-productName", "-productVersion", "-buildVersion"].includes(args[0]);
  if (executable === "xcode-select") return args.length === 1 && args[0] === "-p";
  if (executable === "xcodebuild") return args.length === 1 && ["-version", "-showsdks", "-checkFirstLaunchStatus"].includes(args[0]);
  if (executable === "df") return args.every(arg => !arg.startsWith("-") || /^-[hHkmiPT]+$/.test(arg));
  if (["shasum", "sha256sum"].includes(executable)) {
    let index = 0;
    if (executable === "shasum" && args[0] === "-a" && ["1", "224", "256", "384", "512"].includes(args[1])) index = 2;
    const files = args.slice(index);
    return files.length > 0 && files.every(arg => arg && !arg.startsWith("-"));
  }
  if (executable === "diff") {
    let index = 0;
    while (["-q", "-u", "-r", "--brief", "--unified", "--recursive"].includes(args[index])) index++;
    if (args[index] === "--") index++;
    return args.length === index + 2 && args.slice(index).every(arg => arg && !arg.startsWith("-"));
  }
  if (basename(words[0]) === "rtk" && words[1] === "read" && executable === "read") {
    let files = 0;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (["-n", "--line-numbers"].includes(arg)) continue;
      if (["-l", "--level"].includes(arg)) {
        if (!["none", "minimal", "aggressive"].includes(args[++index])) return false;
      } else if (["-m", "--max-lines", "--tail-lines"].includes(arg)) {
        if (!/^\d{1,6}$/.test(args[++index] || "")) return false;
      } else if (!arg || arg.startsWith("-")) return false;
      else files++;
    }
    return files > 0;
  }
  if (executable === "adb") return args.length === 1 && args[0] === "version" || args[0] === "devices" && (args.length === 1 || args.length === 2 && args[1] === "-l");
  if (["pwd", "ls", "cat", "head", "tail", "wc", "du", "stat", "file"].includes(executable)) return true;
  if (executable === "rg") return !args.some((token) => /^--(?:pre|hostname-bin)(?:=|$)/.test(token));
  if (executable === "jq") return !args.some((token) => /^(?:--(?:run-tests|from-file|library-path)(?:=|$)|-[fL])/.test(token));
  if (executable === "awk") {
    // Deliberately support print-only programs; arbitrary awk can execute/write.
    return args.length > 0 && /^(?:(?:NR\s*(?:==|<=|>=|<|>)\s*\d+|\/[^/\n]+\/)\s*)?\{\s*print(?:\s+\$(?:0|[1-9]\d*))?\s*;?\s*\}$/.test(args[0]) && args.slice(1).every((arg) => !arg.startsWith("-") && !arg.includes("="));
  }
  if (executable === "ocr") return isReadOnlyOcr(args);
  if (executable === "sed") return isReadOnlySed(args);
  if (executable === "find") return isReadOnlyFind(args);
  if (executable !== "git") return false;
  let gitCwd = cwd;
  let index = 0;
  while (args[index] === "-C") {
    const directory = args[index + 1];
    if (directory === undefined || directory.startsWith("-")) return false;
    if (directory) {
      gitCwd = canonicalExistingPath(resolveInputPath(directory, gitCwd));
      if (!gitCwd || !lstatSync(gitCwd).isDirectory()) return false;
    }
    index += 2;
  }
  const gitArgs = args.slice(index);
  if (isGitObjectInspection(gitArgs)) {
    const base = canonicalExistingPath(resolveInputPath(gitCwd));
    const root = canonicalExistingPath(workspace);
    return Boolean(base && root && isWithinPath(base, root));
  }
  return isReadOnlyGit(gitArgs);
}

// Object inspection never runs textconv/filters or accepts Git global options.
function isGitObjectInspection(args) {
  const [command, ...rest] = args;
  const ref = value => /^refs\/heads\/[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(value || "")
    && !value.includes("..") && !value.includes("//") && !value.endsWith("/") && !value.endsWith(".lock");
  const sha = value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value || "");
  const path = value => Boolean(value) && !value.startsWith("/") && !value.startsWith("-")
    && !value.includes("\\") && !value.split("/").includes("..")
    && !/(?:^|\/)(?:auth\.json|\.env(?:\.[^/]+)?|id_rsa|id_ed25519)(?:$|\/)/.test(value);
  const object = value => {
    const colon = (value || "").indexOf(":");
    return colon < 0 ? sha(value) : sha(value.slice(0, colon)) && path(value.slice(colon + 1));
  };
  if (command === "show-ref") {
    return rest[0] === "--verify" && (rest.length === 2 && ref(rest[1])
      || rest.length === 3 && rest[1] === "--hash" && ref(rest[2]));
  }
  if (command === "rev-parse") {
    return rest.length === 2 && rest[0] === "--verify"
      && (ref(rest[1]) || rest[1].endsWith("^{commit}") && ref(rest[1].slice(0, -9)));
  }
  if (command === "cat-file") return rest.length === 2 && ["-p", "-t", "-s"].includes(rest[0]) && object(rest[1]);
  if (command === "show") return rest.length === 1 && rest[0].includes(":") && object(rest[0]);
  if (command === "ls-tree") {
    let index = 0;
    while (["-r", "--name-only", "-z"].includes(rest[index])) index++;
    if (!sha(rest[index++])) return false;
    return index === rest.length || rest[index++] === "--" && rest.length > index && rest.slice(index).every(path);
  }
  if (command === "diff") {
    return rest[0] === "--name-only" && sha(rest[1]) && sha(rest[2])
      && (rest.length === 3 || rest[3] === "--" && rest.length > 4 && rest.slice(4).every(path));
  }
  return false;
}

function isReadOnlyOcr(args) {
  if (args[0] !== "delegate" || !["preview", "rule"].includes(args[1])) return false;
  const valueOptions = new Set(["--repo", "--rule", "--from", "--to", "--commit", "-c", "--exclude"]);
  for (let index = 2; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("-")) {
      if (args[1] !== "rule" || !token) return false;
      continue;
    }
    const separator = token.indexOf("=");
    const option = separator < 0 ? token : token.slice(0, separator);
    if (!valueOptions.has(option) && option !== "--format" && option !== "-f") return false;
    const value = separator < 0 ? args[++index] : token.slice(separator + 1);
    if (!value || value.startsWith("-")) return false;
    if ((option === "--format" || option === "-f") && !["json", "text"].includes(value)) return false;
  }
  return true;
}

function isRecoveryOperation(payload) {
  const name = String(payload.tool_name || payload.tool || payload.name || "");
  return /(?:^|__)taskcenter_(?:task_begin|task_close|task_update|task_verification_report|task_diagnostic_report|task_prepare|task_resume|session_switch_prepare|session_switch_confirm|task_create|handoff)$/.test(name);
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
  // Invalid literal blob reads must not fall back to the broader legacy show rule.
  if (subcommand === "show" && args.some(arg => /^[a-f0-9]{40,64}:/.test(arg))) return false;
  if (subcommand === "worktree") return args[1] === "list" && args.slice(2).every((arg) => ["--porcelain", "-z", "--verbose", "-v"].includes(arg));
  if (["status", "check-ignore", "ls-files"].includes(subcommand)) return true;
  if (subcommand === "--version") return args.length === 1;
  if (subcommand === "rev-parse") return args.length === 2 && ["HEAD", "--show-toplevel", "--is-inside-work-tree"].includes(args[1])
    || args.length === 3 && ["--short", "--abbrev-ref"].includes(args[1]) && args[2] === "HEAD";
  if (subcommand === "branch") return args.slice(1).every(arg => ["--show-current", "-a", "-r", "-v", "-vv", "-avv", "-av", "--all", "--verbose", "--list"].includes(arg));
  if (subcommand === "tag") return ["-l", "--list"].includes(args[1]) && args.slice(2).every(arg => !arg.startsWith("-") || arg.startsWith("--format=") || arg.startsWith("--sort="));
  if (subcommand === "for-each-ref") return args.slice(1).every(arg => arg.startsWith("--format=") || arg.startsWith("--sort=") || /^--count=\d{1,6}$/.test(arg) || /^refs\/[A-Za-z0-9_./-]+$/.test(arg));
  if (subcommand === "reflog") return args[1] === "show" && args.slice(2).every(arg => !arg.startsWith("-") || ["--oneline", "--date=iso"].includes(arg) || /^-\d{1,6}$/.test(arg));
  if (subcommand === "show-ref") return args[1] === "--tags" && args.slice(2).every(arg => /^[A-Za-z0-9_./-]+$/.test(arg) && !arg.startsWith("-"));
  if (!["diff", "show", "log"].includes(subcommand)) return false;
  return !args.slice(1).some((token) => token === "--ext-diff" || token === "--textconv" || token === "--output" || token.startsWith("--output="));
}

async function recordL0Audit() {
  await request("POST", "/sessions/l0-audit", { session_id: sessionId, workspace, command: "read_only" });
}

// 拒绝即时上报：只发送安全分类输入（消息供服务端分类，不落盘原文），失败不改变拒绝结果。
// 服务端按短窗口去重评估批量/连续拒绝，返回恢复与验证步骤后打印到 stderr。
async function reportGateDenial(error) {
  try {
    if (!sessionId) throw new Error("缺少真实 Session，未上报拒绝记录。");
    const result = await requestOnce("POST", "/gate-denials", {
      source: "hook",
      message: String(error.message || "").slice(0, 500),
      session_id: sessionId,
      task_id: preparedTask?.active_task?.id || event.task_id || "",
      run_id: "",
      failure_kind: "",
    }, { report: true });
    if (result?.assessment) console.error(formatGateDenialAssessment(result.assessment));
    else if (error.message.includes("TASKCENTER_NO_ACTIVE_TASK")) console.error(NO_ACTIVE_TASK_RECOVERY);
  } catch (reportError) {
    console.error(`TaskCenter Hook 警告：拒绝记录失败，门禁结果不变（${reportError.message}）`);
    console.error("本地恢复说明：未记录，无批量判断；控制面不可用时仅继续只读并报告 TASKCENTER_UNAVAILABLE，恢复后重新核对登记、任务和路由。");
    console.error(formatGateDenialAssessment(evaluateGateDenials([], { category: classifyGateDenial({ message: error.message }) })));
  }
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
  const batch = inspectionBatch(command);
  if (batch?.length === 1 && batch[0].heredoc) {
    const invocation = interpreterInvocation(batch[0].words.join(" "));
    if (invocation && ["bash", "dash", "fish", "sh", "zsh", "node", "python", "python3"].includes(invocation.executable) && !hasShortFlag(invocation.args, "i") && !invocation.args.includes("--interactive")) return false;
  }
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

function isCliVersionQuery(executable, args) {
  const options = { node: ["--version", "-v"], claude: ["--version", "-v"], kimi: ["--version", "-V"], ruby: ["--version", "-v"], pod: ["--version"], bundle: ["--version"], python: ["--version", "-V"], python3: ["--version", "-V"] };
  return args.length === 1 && Boolean(options[executable]?.includes(args[0]));
}

function isTerminalQuery(executable, args) {
  if (isCliVersionQuery(executable, args)) return true;
  if (args.length !== 1) return false;
  const option = args[0];
  if (["bash", "dash", "fish", "sh", "zsh"].includes(executable)) return ["--version", "--help"].includes(option);
  if (executable === "node") return ["-h", "--help"].includes(option);
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
    await request("POST", "/task-events", {
      type: "tool.call",
      event_id: `hook-tool-${event.call_id || event.tool_use_id || `${sessionId}-${Date.now()}`}`,
      session_id: task.sessionId || sessionId,
      task_id: event.task_id || task.id,
      tool_name: event.tool_name || event.tool || event.name,
      tool_use_id: event.tool_use_id || event.call_id || "",
    });
  } catch (error) {
    console.error(`TaskCenter Hook 警告：工具统计上报失败，已放行（${error.message}）`);
  }
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
  if (preparedTask) return preparedTask.gate_allowlisted === true;
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
    if (preparedTask?.active_task) return preparedTask.active_task;
  if (preparedTask) throw noActiveTaskError();
  const result = await request("GET", "/session-status");
  const current = Array.isArray(result.sessions)
    ? result.sessions.find((session) => session.sessionId === sessionId)
    : null;
  if (!current || current.status !== "registered") {
    throw new Error("当前 Session 尚未登记，请先完成 SessionStart 登记。");
  }
  const tasks = await request("GET", "/tasks");
  const active = (tasks.tasks || []).filter((task) => task.sessionId === sessionId && occupiesSession(task));
  const rank = { in_progress: 3, blocked: 2, planned: 1 };
  const task = active.sort((left, right) => (rank[right.status] - rank[left.status]) || (Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || "")))[0];
  if (task) return task;
  throw noActiveTaskError();
}

function noActiveTaskError() {
  return new Error(`当前 Session 无活跃任务（TASKCENTER_NO_ACTIVE_TASK）。真实 Hook 身份：${JSON.stringify({ session_id: sessionId, workspace })}。\n该操作不满足 L0 确定性只读规则（L0_COMMAND_NOT_RECOGNIZED）。纯路径探测可直接使用 which NAME、command -v NAME 或 type NAME。`);
}

async function prepareCurrentTask() {
  if (preparedTask !== undefined) return preparedTask;
  try {
    const view = action === "user-prompt-submit" ? "prompt" : "gate";
    preparedTask = await request("GET", `/task-prepare?session_id=${encodeURIComponent(sessionId)}&workspace=${encodeURIComponent(workspace)}&view=${view}`);
    return preparedTask;
  } catch (error) {
    if (/接口不存在|\b404\b|尚未登记/.test(String(error.message || ""))) { preparedTask = null; return null; }
    throw error;
  }
}

async function provideTaskPreparationContext() {
  const prepared = await prepareCurrentTask();
  if (prepared) {
    if (!prepared.truncated && prepared.active_task === null && prepared.task_id === null && prepared.gate_allowlisted) return;
    // Project known fields even against older controllers that ignore view=prompt.
    // Do not assume a prior Hook result reached or survived in the model context.
    const context = Object.fromEntries([
      "session_id", "task_id", "status", "contract_revision", "contract", "handoff",
      "handoff_recommended", "new_session_recommended", "truncated", "continuation_cursor",
    ].filter((key) => prepared[key] != null && prepared[key] !== false).map((key) => [key, prepared[key]]));
    if (prepared.task_id === null) context.task_id = null;
    if (prepared.truncated || prepared.contract?.truncated) {
      const cursorPath = prepared.truncated ? "continuation_cursor" : "contract.continuation_cursor";
      context.binding_instructions = `所需契约或交接不全时，用 taskcenter_response_continue 读取 ${cursorPath}；按游标续读（包括内层 contract）。`;
    } else if (prepared.active_task) {
      context.binding_instructions = "同一交付直接沿用本轮任务绑定。执行收尾用 taskcenter_task_close，核对完成与待补项。";
    }
    if (prepared.active_task === null && !prepared.truncated) {
      context.recovery_instructions = prepared.task_id === null
        ? "纯查询直接继续；已授权的新交付直接 taskcenter_task_begin；继续已归档的同一交付时，使用原 task_id 和真实会话调用 taskcenter_task_resume。"
        : "继续同一交付用 taskcenter_task_resume（含已完成任务，无时间限制）；纯查询直接继续，已授权的新交付用 taskcenter_task_begin。";
    }
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: JSON.stringify(context) } }));
    return;
  }
  if (await isGateAllowlistedSession()) return;
  const status = await request("GET", "/session-status");
  const current = Array.isArray(status.sessions)
    ? status.sessions.find((session) => session.sessionId === sessionId)
    : null;
  let activeTask = null;
  if (current?.status === "registered" && current.taskCount > 0) {
    const tasks = await request("GET", "/tasks");
    activeTask = (tasks.tasks || []).find(
      (task) => task.sessionId === sessionId && occupiesSession(task),
    );
  }
  if (activeTask) return;
  const registrationInstruction = current?.status === "registered"
    ? "当前 Session 已登记"
    : "先调用 taskcenter_session_register 登记当前真实 Session";
  const additionalContext = [
    `TaskCenter 任务准备提示：当前 Session 不在门禁豁免白名单且没有活跃正式任务；${registrationInstruction}。`,
    "如果本轮只做只读检查，可以直接继续。",
    NO_ACTIVE_TASK_RECOVERY,
    "不要先撞 PreToolUse 门禁，也不要要求用户手动创建任务、启动服务或批准提案。只有 TaskCenter MCP 确实不可用时，才限制为只读并报告 TASKCENTER_UNAVAILABLE。",
  ].join("\n");
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  }));
}

async function recoverControlService(signal, _requestId, limitMs) {
  try {
    await execFileAsync(process.execPath, [resolve(projectRoot, "scripts/taskcenter-control.mjs"), "start"], {
      cwd: projectRoot,
      env: { ...process.env, TASKCENTER_NO_OPEN: "1" },
      timeout: limitMs,
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error("TaskCenter 控制服务不可用，自动恢复失败，写操作已阻断。可在项目目录运行：node scripts/taskcenter-control.mjs start");
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
