#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TASKCENTER_VERSION } from "./version.mjs";

const controlServerUrl = process.env.TASKCENTER_CONTROL_URL || "http://127.0.0.1:3001";
const server = new McpServer({ name: "taskcenter-task-server", version: TASKCENTER_VERSION });
const taskFields = {
  session_id: z.string().min(1).max(200),
  agent: z.enum(["codex", "claude", "workbuddy", "unknown"]).optional(),
  provider: z.string().max(80).optional(),
  model: z.string().max(120).optional(),
  workspace: z.string().max(4_096).optional(),
  task_id: z.string().max(200).optional(),
  context_task_id: z.string().max(200).optional(),
  requirement_id: z.string().max(200).optional(),
  event_id: z.string().max(200).optional(),
  title: z.string().max(200).optional(),
  goal: z.string().max(1_000).optional(),
  // 会话侧不能把任务直接标为已验收：verified 不在此枚举内，验收由 TaskCenter 基于证据判定。
  status: z.enum(["planned", "in_progress", "blocked", "done_claimed", "cancelled"]).optional(),
  priority: z.string().max(20).optional(),
  plan: z.array(z.string().max(500)).max(20).optional(),
  current_step: z.string().max(500).optional(),
  next_action: z.string().max(500).optional(),
  blocker: z.string().max(1_000).optional(),
  acceptance_criteria: z.array(z.string().max(500)).max(20).optional(),
  changed_files: z.array(z.string().max(500)).max(50).optional(),
  tests: z.array(z.string().max(500)).max(30).optional(),
  evidence: z.array(z.string().max(1_000)).max(30).optional(),
  assumptions: z.array(z.string().max(500)).max(20).optional(),
  risks: z.array(z.string().max(500)).max(20).optional(),
  tradeoffs: z.array(z.string().max(500)).max(20).optional(),
  open_questions: z.array(z.string().max(500)).max(20).optional(),
  retrospective: z.string().max(2_000).optional(),
  expected_at: z.string().datetime({ offset: true }).optional().describe("建议填写预计完成时间，便于任务治理和逾期提醒"),
};

server.registerTool("taskcenter_session_register", {
  title: "注册 TaskCenter Session",
  description: "开始任务前登记当前 Session、工作目录和任务协议。",
  inputSchema: z.object({ session_id: z.string().min(1).max(200), agent: z.enum(["codex", "claude", "workbuddy", "unknown"]).optional(), provider: z.string().max(80).optional(), model: z.string().max(120).optional(), workspace: z.string().min(1).max(4_096), event_id: z.string().max(200).optional(), rationale: z.string().max(1_000).optional() }).strict(),
}, async (input) => report("session.register", input));

server.registerTool("taskcenter_task_create", {
  title: "创建 TaskCenter 任务",
  description: "在修改代码前创建正式任务。必须先获得 task_id 和 accepted=true；当前 Turn 已绑定 Context semantic task 时必须传 context_task_id，以接管内部影子任务并保持完成状态闭环；建议填写 expected_at。",
  inputSchema: z.object({ ...taskFields, title: z.string().min(1).max(200), goal: z.string().min(1).max(1_000), acceptance_criteria: z.array(z.string().min(1).max(500)).min(1).max(20), plan: z.array(z.string().min(1).max(500)).min(1).max(20) }).strict(),
}, async (input) => report("task.create", input));

server.registerTool("taskcenter_task_update", {
  title: "更新 TaskCenter 任务",
  description: "更新当前步骤、下一步、假设、风险、取舍和阻塞信息。",
  inputSchema: z.object(taskFields).extend({ task_id: z.string().min(1).max(200) }).strict(),
}, async (input) => report("task.update", input));

server.registerTool("taskcenter_task_report", {
  title: "上报 TaskCenter 任务结果",
  description: "上报任务结果、变更文件、测试、证据和复盘；完成只记录为 done_claimed。",
  inputSchema: z.object(taskFields).extend({ task_id: z.string().min(1).max(200), status: z.enum(["in_progress", "blocked", "done_claimed"]).optional() }).strict(),
}, async (input) => report("task.report", input));

server.registerTool("taskcenter_routing_record", {
  title: "记录 TaskCenter 模型路由",
  description: "记录直接执行、原生派发、CLI 兜底或有理由偏离的模型路由决定。该记录仅用于审计，不改变任务状态，也不作为执行门禁。",
  inputSchema: z.object({
    session_id: z.string().min(1).max(200),
    task_id: z.string().min(1).max(200),
    event_id: z.string().max(200).optional(),
    routing_action: z.enum(["direct_execute", "delegate_native", "fallback_cli", "reasoned_override"]),
    orchestrator_model: z.string().min(1).max(120),
    preferred_executor_model: z.string().min(1).max(120),
    selected_executor_model: z.string().min(1).max(120),
    dispatch_channel: z.enum(["direct", "native", "cli", "other"]),
    routing_reason: z.string().min(1).max(1_000),
    routing_outcome: z.enum(["selected", "started", "succeeded", "failed"]).optional(),
    policy_version: z.string().min(1).max(80).optional(),
  }).strict(),
}, async (input) => report("routing.decision", input));

server.registerTool("taskcenter_task_query", {
  title: "查询 TaskCenter 任务",
  description: "查询当前 Session 的任务账本，获取 TaskCenter 的下一步上下文。",
  inputSchema: z.object({ session_id: z.string().min(1).max(200), task_id: z.string().max(200).optional() }).strict(),
}, async ({ session_id, task_id }) => {
  let response;
  try {
    response = await fetch(`${controlServerUrl}/tasks`);
  } catch (e) {
    return result({ error: "TASKCENTER_UNAVAILABLE", message: `TaskCenter 控制服务不可用（${controlServerUrl}）。请先运行 npm run dev:live 启动 TaskCenter。`, detail: e.message });
  }
  const payload = await readJson(response);
  const tasks = (payload.tasks || []).filter((task) => task.sessionId === session_id && (!task_id || task.id === task_id));
  return result({ tasks });
});

server.registerTool("taskcenter_session_status", {
  title: "查询 TaskCenter Session 状态",
  description: "查询当前 Session 是否已登记、执行器身份和任务数量。",
  inputSchema: z.object({ session_id: z.string().min(1).max(200) }).strict(),
}, async ({ session_id }) => {
  try {
    const response = await fetch(`${controlServerUrl}/session-status`);
    const payload = await readJson(response);
    return result({ sessions: (payload.sessions || []).filter((session) => session.sessionId === session_id) });
  } catch (e) {
    return result({ error: "TASKCENTER_UNAVAILABLE", message: `TaskCenter 控制服务不可用（${controlServerUrl}）。请先运行 npm run dev:live 启动 TaskCenter。`, detail: e.message });
  }
});

async function report(type, input) {
  let response;
  try {
    response = await fetch(`${controlServerUrl}/task-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "mcp" },
      body: JSON.stringify({ type, ...input }),
    });
  } catch (e) {
    return result({ error: "TASKCENTER_UNAVAILABLE", message: `TaskCenter 控制服务不可用（${controlServerUrl}）。请先运行 npm run dev:live 启动 TaskCenter。`, detail: e.message });
  }
  try {
    return result(await readJson(response));
  } catch (e) {
    return result({ error: "TASKCENTER_REQUEST_FAILED", message: e.message });
  }
}

async function readJson(response) {
  const payload = await response.json().catch(() => ({ error: "TaskCenter 返回了无效 JSON。" }));
  if (!response.ok) throw new Error(payload.error || `TaskCenter 请求失败（${response.status}）。`);
  return payload;
}

function result(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

await server.connect(new StdioServerTransport());
