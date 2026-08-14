import { accessSync, constants, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TASKCENTER_VERSION } from "./version.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const contextRoot = resolve(process.env.TASKCENTER_CONTEXT_ROOT || join(projectRoot, "..", "ProjectContextAgent"));
const contextServer = resolve(process.env.TASKCENTER_CONTEXT_SERVER || join(contextRoot, "mcp", "server.mjs"));
const nodeCommand = resolveContextCommand();
const mapPath = resolve(process.env.TASKCENTER_CONTEXT_TASK_MAP_PATH || join(projectRoot, "data", "context-task-map.json"));
const auditPath = resolve(process.env.TASKCENTER_CONTEXT_AUDIT_PATH || join(projectRoot, "data", "context-sync-events.jsonl"));
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
  if (event?.type === "routing.decision") {
    return { status: "skipped", reason: "routing_audit" };
  }
  const explicitContextTaskId = task?.contextTaskId || event?.context_task_id || "";
  const enabled = options.enabled ?? Boolean(explicitContextTaskId || process.env.TASKCENTER_CONTEXT_BRIDGE_ENABLED === "true");
  if (!enabled) {
    return { status: "disabled" };
  }
  if (!task?.id || !event?.event_id) return { status: "skipped", reason: "missing_task_or_event" };

  try {
    const result = await withTimeout(sync(event, task, {
      callTool: options.callTool || callTool,
      loadMap: options.loadMap || loadMap,
      saveMap: options.saveMap || saveMap,
    }), options.timeoutMs || timeoutMs);
    if (options.audit !== false) appendAudit({ event, task, status: "synced", contextTaskId: result.contextTaskId });
    return { status: "synced", contextTaskId: result.contextTaskId };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 500);
    if (options.audit !== false) appendAudit({ event, task, status: "failed", error: message });
    return { status: "failed", error: message };
  }
}

async function sync(event, task, dependencies) {
  const map = dependencies.loadMap();
  const mapped = map[task.id];
  const explicitContextTaskId = task.contextTaskId || event.context_task_id || "";
  let contextTaskId = explicitContextTaskId
    || (mapped?.workspace === task.workspace ? mapped.contextTaskId : undefined);
  if (!contextTaskId) {
    const started = await dependencies.callTool("context.start_task", {
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

  if (event.type === "task.create") return { contextTaskId };

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
      summary: task.goal || task.title,
      outcomes: [...(task.changedFiles || []), ...(task.tests || [])],
      event_id: `reqradar-context-complete-${event.event_id}`,
    });
  }
  return { contextTaskId };
}

async function callTool(name, arguments_) {
  const client = new Client({ name: "taskcenter-context-bridge", version: TASKCENTER_VERSION });
  const transport = new StdioClientTransport({
    command: nodeCommand,
    args: [contextServer],
    cwd: contextRoot,
    env: { ...process.env, TASKCENTER_CONTEXT_BRIDGE: "1" },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: arguments_ });
    return parseContextToolResult(result, name);
  } finally {
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
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, mapPath);
}

function appendAudit(value) {
  mkdirSync(dirname(auditPath), { recursive: true });
  writeFileSync(auditPath, `${JSON.stringify({ ...value, createdAt: new Date().toISOString() })}\n`, { flag: "a" });
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Context MCP 超时（${ms}ms）。`)), ms)),
  ]);
}
