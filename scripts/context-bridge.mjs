import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = resolve(import.meta.dirname, "..");
const contextRoot = resolve(process.env.REQRADAR_CONTEXT_ROOT || "/Users/liuyuge/Documents/ProjectContextAgent");
const contextServer = resolve(process.env.REQRADAR_CONTEXT_SERVER || join(contextRoot, "mcp", "server.mjs"));
const nodeCommand = process.env.REQRADAR_CONTEXT_NODE || "/Users/liuyuge/.workbuddy/binaries/node/versions/22.22.2/bin/node";
const mapPath = resolve(process.env.REQRADAR_CONTEXT_TASK_MAP_PATH || join(projectRoot, "data", "context-task-map.json"));
const auditPath = resolve(process.env.REQRADAR_CONTEXT_AUDIT_PATH || join(projectRoot, "data", "context-sync-events.jsonl"));
const timeoutMs = Number(process.env.REQRADAR_CONTEXT_TIMEOUT_MS || 10_000);

export async function syncContextEvent(event, task) {
  if (process.env.REQRADAR_CONTEXT_BRIDGE_ENABLED !== "true") {
    return { status: "disabled" };
  }
  if (!task?.id || !event?.event_id) return { status: "skipped", reason: "missing_task_or_event" };

  try {
    const result = await withTimeout(sync(event, task), timeoutMs);
    appendAudit({ event, task, status: "synced", contextTaskId: result.contextTaskId });
    return { status: "synced", contextTaskId: result.contextTaskId };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 500);
    appendAudit({ event, task, status: "failed", error: message });
    return { status: "failed", error: message };
  }
}

async function sync(event, task) {
  let contextTaskId = loadMap()[task.id]?.contextTaskId;
  if (!contextTaskId) {
    const started = await callTool("context.start_task", {
      project_id: "reqradar",
      goal: task.goal || task.title,
      keywords: [task.title, "ReqRadar"].filter(Boolean),
      event_id: `reqradar-context-start-${task.id}`,
    });
    contextTaskId = started.task_id;
    if (!contextTaskId) throw new Error("Context MCP 未返回 task_id。");
    saveMap({ ...loadMap(), [task.id]: { contextTaskId, reqradarTaskId: task.id, startedAt: new Date().toISOString() } });
  }

  if (event.type === "task.create") return { contextTaskId };

  const observationType = event.status === "blocked" ? "risk" : event.type === "task.report" ? "test_result" : "code_evidence";
  await callTool("context.report_observation", {
    task_id: contextTaskId,
    observation_type: observationType,
    content: formatObservation(event, task),
    evidence_path: task.evidence?.[0] || undefined,
    event_id: `reqradar-context-observation-${event.event_id}`,
  });

  if (event.type === "task.report" && event.status === "done_claimed") {
    await callTool("context.complete_task", {
      task_id: contextTaskId,
      summary: task.goal || task.title,
      outcomes: [...(task.changedFiles || []), ...(task.tests || [])],
      event_id: `reqradar-context-complete-${event.event_id}`,
    });
  }
  return { contextTaskId };
}

async function callTool(name, arguments_) {
  const client = new Client({ name: "reqradar-context-bridge", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: nodeCommand,
    args: [contextServer],
    cwd: contextRoot,
    env: { ...process.env, REQRADAR_CONTEXT_BRIDGE: "1" },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: arguments_ });
    if (result?.isError) throw new Error(textOf(result) || `${name} 失败。`);
    const payload = JSON.parse(textOf(result) || "{}");
    if (payload.error) throw new Error(payload.message || payload.error);
    return payload;
  } finally {
    await client.close().catch(() => {});
  }
}

function textOf(result) {
  return (result?.content || []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

function formatObservation(event, task) {
  return JSON.stringify({
    reqradar_task_id: task.id,
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
