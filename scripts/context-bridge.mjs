import { accessSync, chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TASKCENTER_VERSION } from "./version.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const contextRoot = resolve(process.env.TASKCENTER_CONTEXT_ROOT || join(projectRoot, "..", "ProjectContextAgent"));
const contextServer = resolve(process.env.TASKCENTER_CONTEXT_SERVER || join(contextRoot, "mcp", "server.mjs"));
const nodeCommand = resolveContextCommand();
const mapPath = resolve(process.env.TASKCENTER_CONTEXT_TASK_MAP_PATH || join(projectRoot, "data", "context-task-map.json"));
const auditPath = resolve(process.env.TASKCENTER_CONTEXT_AUDIT_PATH || join(projectRoot, "data", "context-sync-events.jsonl"));
const defaultAttestationTokenPath = join(homedir(), ".local", "state", "project-context-agent", "taskcenter-attestation-token");
const timeoutMs = Number(process.env.TASKCENTER_CONTEXT_TIMEOUT_MS || 10_000);

export function resolveContextCommand(options = {}) {
  const root = resolve(options.contextRoot || contextRoot);
  const explicitCommand = options.explicitCommand ?? process.env.TASKCENTER_CONTEXT_NODE;
  if (explicitCommand) return resolve(explicitCommand);
  if ((options.platform || process.platform) !== "darwin") return process.execPath;

  // ProjectContext 自带的启动器会探测能加载当前 better-sqlite3 的 Node ABI。
  // TaskCenter 自身可能运行在更高版本 Node 上，不能直接假设 process.execPath 兼容。
  const projectLauncher = join(root, "scripts", "mac-node.sh");
  try {
    (options.assertExecutable || ((path) => accessSync(path, constants.X_OK)))(projectLauncher);
    return projectLauncher;
  } catch {
    return process.execPath;
  }
}

export async function syncContextEvent(event, task, options = {}) {
  if (["routing.decision", "task.reminder", "phase.reported", "tool.call"].includes(event?.type)) {
    const reason = event.type === "task.reminder"
      ? "local_overdue_reminder"
      : event.type === "phase.reported"
        ? "local_phase_timing"
        : event.type === "tool.call"
          ? "local_tool_fact"
        : "routing_audit";
    return { status: "skipped", reason };
  }
  const explicitContextTaskId = task?.contextTaskId || event?.context_task_id || "";
  const enabled = options.enabled ?? Boolean(explicitContextTaskId || process.env.TASKCENTER_CONTEXT_BRIDGE_ENABLED === "true");
  if (!enabled) {
    return { status: "disabled" };
  }
  if (!task?.id || !event?.event_id) return { status: "skipped", reason: "missing_task_or_event" };

  const started = performance.now();
  try {
    const result = await withTimeout((signal) => sync(event, task, {
      callTool: async (...args) => {
        signal.throwIfAborted();
        const result = await (options.callTool || callTool)(...args, { signal });
        signal.throwIfAborted();
        return result;
      },
      loadMap: options.loadMap || loadMap,
      saveMap: options.saveMap || saveMap,
      isLocalTaskId: options.isLocalTaskId,
    }), options.timeoutMs || timeoutMs);
    if (options.audit !== false) appendAudit({ event, task, ...result, elapsedMs: Math.round(performance.now() - started) });
    return result;
  } catch (error) {
    const message = String(error?.message || error).slice(0, 500);
    if (options.audit !== false) appendAudit({ event, task, status: "failed", error: message, elapsedMs: Math.round(performance.now() - started) });
    return { status: "failed", error: message };
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function packetDigest(packet) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(packet))).digest("hex")}`;
}

function bridgeIdentity(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
}

async function requestCompletionAttestation(input, options = {}) {
  if (options.issueAttestation) return options.issueAttestation(input);
  const token = contextAttestationToken(options);
  const target = new URL(options.agentWebUrl || process.env.TASKCENTER_CONTEXT_AGENT_WEB_URL || "http://127.0.0.1:4173");
  const response = await (options.fetchImpl || globalThis.fetch)(new URL("/api/user-attestations", target), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agent-Authorization-Token": token,
      Origin: target.origin,
    },
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) throw new Error(payload.error || `ProjectContext 授权失败: HTTP ${response.status}`);
  return payload;
}

function contextAttestationToken(options = {}) {
  const explicit = options.authorizationToken || process.env.TASKCENTER_CONTEXT_ATTESTATION_TOKEN;
  if (explicit) return String(explicit);
  const tokenPath = resolve(
    options.authorizationTokenPath
      || process.env.PROJECT_CONTEXT_ATTESTATION_TOKEN_PATH
      || defaultAttestationTokenPath
  );
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
  if (!existsSync(tokenPath)) {
    try {
      writeFileSync(tokenPath, `${randomBytes(32).toString("base64url")}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  let descriptor;
  try {
    descriptor = openSync(tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error("ProjectContext 一次性授权凭证必须是普通文件。");
    if ((metadata.mode & 0o077) !== 0) fchmodSync(descriptor, 0o600);
    const token = readFileSync(descriptor, "utf8").trim();
    if (!token) throw new Error("ProjectContext 一次性授权凭证为空。");
    return token;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** 本机 TaskCenter 页面确认后，把同一 Completion Packet 同步给 ProjectContext。 */
export async function syncContextCompletionFromUi(task, packet, input = {}, options = {}) {
  if (!task?.id || !task.contextTaskId) throw new Error("任务没有关联 ProjectContext semantic task。");
  if (packet?.completionReadiness?.completionClaim?.allowed !== true) {
    throw new Error(`TaskCenter 完成门禁未满足: ${(packet?.completionReadiness?.reasons || []).join(", ") || "unknown"}`);
  }
  const requestId = String(input.requestId || "");
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error("ProjectContext 同步 requestId 无效。");
  const dependencies = { callTool: options.callTool || callTool };
  const audit = options.appendAudit || appendAudit;
  const recordAudit = value => {
    if (options.audit === false) return;
    try { audit(value); } catch { /* 完成副作用不能因本地审计文件故障被误报为失败 */ }
  };
  const auditBase = {
    event: {
      type: "context.complete_task.ui",
      event_id: `taskcenter-ui-context-complete-${requestId}`,
    },
    task,
    contextTaskId: task.contextTaskId,
    taskCenterTaskId: task.id,
    packetDigest: packetDigest(packet),
  };
  const strict = packet.taskContract?.workflowProfile === "strict";
  const completionArguments = {
    task_id: task.contextTaskId,
    taskcenter_task_id: task.id,
    summary: task.goal || task.title,
    outcomes: [...(task.changedFiles || []), ...(task.tests || [])],
    event_id: `taskcenter-ui-context-complete-${requestId}`,
  };
  let completionAttestation;
  let clientSessionId;
  let turnId;
  try {
    if (strict) {
      try {
        const replay = await dependencies.callTool("context.complete_task", completionArguments);
        recordAudit({ ...auditBase, status: "synced", idempotent: true });
        return replay;
      } catch (error) {
        if (error?.code !== "USER_ATTESTATION_REQUIRED") throw error;
      }
      clientSessionId = `taskcenter-ui:${bridgeIdentity(task.id)}`;
      turnId = `completion-${requestId}`;
      const attached = await dependencies.callTool("context.attach_session", {
        client_session_id: clientSessionId,
        client_id: "taskcenter-ui",
        workspace: task.workspace,
        task_id: task.contextTaskId,
        source: "taskcenter-ui",
        event_id: `taskcenter-context-attach-${requestId}`,
      });
      await dependencies.callTool("context.open_task", {
        project_id: attached.project_id,
        workspace: task.workspace,
        client_session_id: clientSessionId,
        task_id: task.contextTaskId,
      });
      await dependencies.callTool("context.prepare_turn", {
        project_id: attached.project_id,
        workspace: task.workspace,
        task_id: task.contextTaskId,
        client_session_id: clientSessionId,
        turn_id: turnId,
        message: "用户在 TaskCenter 确认完成并同步 ProjectContext",
        provider_policy: "never",
        candidate_policy: "never",
      });
      completionAttestation = await requestCompletionAttestation({
        authorization_id: `auth-taskcenter-${bridgeIdentity(requestId)}`,
        project_id: attached.project_id,
        client_session_id: clientSessionId,
        turn_id: turnId,
        action: "context.complete_task_review",
        proposal_id: task.contextTaskId,
        decision: "approved",
        payload: {
          packet_digest: packetDigest(packet),
          subject_ref: packet.currentSubject || null,
          taskcenter_task_id: task.id,
        },
      }, options);
    }
    const result = await dependencies.callTool("context.complete_task", {
      ...completionArguments,
      ...(clientSessionId ? { client_session_id: clientSessionId, turn_id: turnId } : {}),
      ...(completionAttestation ? { completion_attestation: completionAttestation } : {}),
    });
    recordAudit({ ...auditBase, status: "synced" });
    return result;
  } catch (error) {
    recordAudit({ ...auditBase, status: "failed", error: String(error?.message || error).slice(0, 500) });
    throw error;
  }
}

async function sync(event, task, dependencies) {
  const map = dependencies.loadMap();
  const mapped = map[task.id];
  const explicitContextTaskId = task.contextTaskId || event.context_task_id || "";
  let contextTaskId = explicitContextTaskId
    || (mapped?.workspace === task.workspace ? mapped.contextTaskId : undefined);
  if (dependencies.isLocalTaskId?.(contextTaskId)) {
    // Historical mislinks remain in the ledger. Never forward their evidence to a different task.
    return { status: "skipped", reason: "CONTEXT_TASK_ID_IS_LOCAL", contextTaskId };
  }
  if (!contextTaskId) {
    const started = await dependencies.callTool("context.start_task", {
      ...(task.projectId ? { project_id: task.projectId } : {}),
      workspace: task.workspace,
      goal: task.goal || task.title,
      keywords: [task.title].filter(Boolean),
      // 外部幂等键属于持久化协议，品牌改名后仍保留旧前缀以兼容补偿重放。
      event_id: `reqradar-context-start-${task.id}`,
    });
    contextTaskId = started.task_id;
    if (!contextTaskId) throw new Error("Context MCP 未返回 task_id。");
  }
  if (!mapped || mapped.contextTaskId !== contextTaskId || mapped.workspace !== task.workspace) {
    dependencies.saveMap({
      ...map,
      [task.id]: {
        contextTaskId,
        workspace: task.workspace,
        taskcenterTaskId: task.id,
        startedAt: mapped?.startedAt || new Date().toISOString(),
      },
    });
  }

  if (event.type === "task.create") return { status: "synced", contextTaskId };

  const completion = event.status === "done_claimed" || event.type === "task.done_claimed";
  const observationType = event.status === "blocked" ? "risk" : completion || event.type === "task.report" ? "test_result" : "code_evidence";
  const observation = {
    task_id: contextTaskId,
    observation_type: observationType,
    content: formatObservation(event, task),
    evidence_path: task.evidence?.[0] || undefined,
    event_id: `reqradar-context-observation-${event.event_id}`,
  };
  try {
    await dependencies.callTool("context.report_observation", observation);
  } catch (error) {
    if (!isIdempotencyConflict(error)) throw error;
    // 543cf19 已经使用相同 event_id 和 taskcenter_task_id；只在精确冲突时重放该历史形态。
    await dependencies.callTool("context.report_observation", {
      ...observation,
      content: formatObservation(event, task, "taskcenter_task_id"),
    });
  }

  if (completion) {
    await dependencies.callTool("context.complete_task", {
      task_id: contextTaskId,
      taskcenter_task_id: task.id,
      summary: task.goal || task.title,
      outcomes: [...(task.changedFiles || []), ...(task.tests || [])],
      event_id: `reqradar-context-complete-${event.event_id}`,
    });
  }
  return { status: "synced", contextTaskId };
}

async function callTool(name, arguments_, { signal } = {}) {
  const client = new Client({ name: "taskcenter-context-bridge", version: TASKCENTER_VERSION });
  const transport = new StdioClientTransport({
    command: nodeCommand,
    args: [contextServer],
    cwd: contextRoot,
    env: { ...process.env, TASKCENTER_CONTEXT_BRIDGE: "1" },
    stderr: "pipe",
  });
  const abort = () => { void client.close().catch(() => {}); };
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await client.connect(transport, { signal });
    signal?.throwIfAborted();
    const result = await client.callTool({ name, arguments: arguments_ }, undefined, { signal });
    return parseContextToolResult(result, name);
  } finally {
    signal?.removeEventListener("abort", abort);
    await client.close().catch(() => {});
  }
}

export function parseContextToolResult(result, name = "Context MCP") {
  const text = textOf(result);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    if (result?.isError) throw new Error(text || `${name} 失败。`);
    throw new Error(`${name} 返回非 JSON 成功响应。`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${name} 返回的成功响应不是 JSON object。`);
  }
  if (result?.isError || payload.error) {
    const error = new Error(payload.message || payload.error || text || `${name} 失败。`);
    error.code = payload.error || payload.code || "";
    throw error;
  }
  return payload;
}

function textOf(result) {
  return (result?.content || []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

function formatObservation(event, task, taskIdField = "reqradar_task_id") {
  return JSON.stringify({
    [taskIdField]: task.id,
    event_type: event.type,
    status: event.status || task.status,
    current_step: task.currentStep,
    next_action: task.nextAction,
    blocker: task.blocker,
    changed_files: task.changedFiles,
    tests: task.tests,
    evidence: task.evidence,
    risks: task.risks,
    ...(task.workspaceBranch ? {
      project_id: task.projectId,
      workspace: task.workspace,
      git_branch: task.workspaceBranch,
    } : {}),
  });
}

function isIdempotencyConflict(error) {
  return error?.code === "IDEMPOTENCY_CONFLICT" || /\bIDEMPOTENCY_CONFLICT\b/.test(String(error?.message || error));
}

function loadMap() {
  try { return JSON.parse(readFileSync(mapPath, "utf8")); } catch { return {}; }
}

function saveMap(value) {
  mkdirSync(dirname(mapPath), { recursive: true });
  const temp = `${mapPath}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, mapPath);
}

function appendAudit(value) {
  mkdirSync(dirname(auditPath), { recursive: true });
  const descriptor = openSync(auditPath, "a", 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    const failureCode = String(value.error || "").match(/\b(?:CORE_TASK_REQUIRED|CORE_REVISION_MISMATCH|CORE_RECOVERY_REQUIRED|CORE_TIMEOUT|USER_ATTESTATION_REQUIRED|IDEMPOTENCY_CONFLICT)\b/)?.[0]
      || (String(value.error || "").includes("超时") ? "CONTEXT_TIMEOUT" : "SYNC_FAILED");
    writeFileSync(descriptor, `${JSON.stringify({
      schemaVersion: 2,
      eventId: String(value.event?.event_id || "").slice(0, 200),
      eventType: String(value.event?.type || "").slice(0, 80),
      taskId: String(value.task?.id || value.taskCenterTaskId || "").slice(0, 200),
      contextTaskId: String(value.contextTaskId || value.task?.contextTaskId || "").slice(0, 200),
      status: value.status,
      ...(value.reason ? { reason: value.reason } : {}),
      ...(value.error ? { failureCode } : {}),
      ...(Number.isFinite(value.elapsedMs) ? { elapsedMs: value.elapsedMs } : {}),
      ...(value.packetDigest ? { packetDigest: value.packetDigest } : {}),
      ...(value.idempotent ? { idempotent: true } : {}),
      createdAt: new Date().toISOString(),
    })}\n`);
  } finally { closeSync(descriptor); }
}

async function withTimeout(operation, ms) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Context MCP 超时（${ms}ms）；已发送操作结果未知，请沿用原幂等键核对。`);
          controller.abort(error);
          reject(error);
        }, ms);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
