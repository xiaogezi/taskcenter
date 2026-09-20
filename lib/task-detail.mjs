// 任务详情纯展示 helper：响应校验、freshness 归并、客户端报告模型解析、活动白名单渲染。

export function isValidTaskResponse(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const task = body.task;
  if (!task || typeof task !== "object" || Array.isArray(task)) return null;
  if (typeof task.id !== "string" || !task.id) return null;
  return task;
}

export function isValidEventsResponse(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const events = body.events;
  if (!Array.isArray(events)) return null;
  for (const item of events) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  }
  return events;
}

function keepPrevious(previous, requestedTaskId, hasData) {
  return previous.taskId === requestedTaskId && hasData;
}

export function reduceDetailSuccess(previous, body, requestedTaskId, tick, now) {
  const task = isValidTaskResponse(body);
  if (!task || task.id !== requestedTaskId) {
    return reduceDetailFailure(previous, "服务返回无效任务数据", requestedTaskId, tick);
  }
  return { taskId: requestedTaskId, tick, error: "", lastSuccessAt: now, value: task };
}

export function reduceDetailFailure(previous, message, requestedTaskId, tick) {
  const keep = keepPrevious(previous, requestedTaskId, Boolean(previous.value));
  return { taskId: requestedTaskId, tick, error: message, lastSuccessAt: keep ? previous.lastSuccessAt : 0, value: keep ? previous.value : null };
}

export function reduceEventsSuccess(previous, body, requestedTaskId, tick, now) {
  const events = isValidEventsResponse(body);
  if (!events) {
    return reduceEventsFailure(previous, "服务返回无效活动数据", requestedTaskId, tick);
  }
  return { taskId: requestedTaskId, tick, error: "", lastSuccessAt: now, values: events };
}

export function reduceEventsFailure(previous, message, requestedTaskId, tick) {
  const keep = keepPrevious(previous, requestedTaskId, previous.lastSuccessAt > 0);
  return { taskId: requestedTaskId, tick, error: message, lastSuccessAt: keep ? previous.lastSuccessAt : 0, values: keep ? previous.values : [] };
}

// loading 派生：请求由 (taskId, pollTick) 标识，响应记录的 tick 与当前请求 tick 不同即为进行中。
export function fetchInFlight(fetchState, taskId, tick) {
  return Boolean(taskId) && (fetchState.taskId !== taskId || fetchState.tick !== tick);
}

// 从未成功过（lastSuccessAt 为 0）时返回空串，调用方不得据此渲染 1970。
export function lastSuccessText(lastSuccessAt, now = Date.now()) {
  if (typeof lastSuccessAt !== "number" || !(lastSuccessAt > 0)) return "";
  const minutes = Math.max(0, Math.floor((now - lastSuccessAt) / 60000));
  return `上次成功：${minutes} 分钟前`;
}

// 客户端报告模型只采信 cliRuns[].evidence 中完整可解析、且绑定当前 delegation 的 JSON。
// executorModel / requested_model 是请求而非实际执行，不作为报告模型。
export function parseClientReport(run) {
  if (!run || typeof run.id !== "string" || !run.id) return null;
  const evidence = Array.isArray(run.evidence) ? run.evidence : [];
  let report = null;
  for (const entry of evidence) {
    if (typeof entry !== "string") continue;
    let parsed;
    try {
      parsed = JSON.parse(entry);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    if (parsed.delegation_id !== run.id) continue;
    if (typeof run.delegateSessionId === "string" && run.delegateSessionId && parsed.sessionId !== run.delegateSessionId) continue;
    if (!Object.hasOwn(parsed, "reportedModels")) continue;
    const value = parsed.reportedModels;
    const models = Array.isArray(value) ? value : null;
    if (!models || !models.length || models.some((model) => typeof model !== "string" || !model.trim())) return null;
    report = {
      models: models.map((model) => model.trim()),
      requestedEffort: typeof parsed.requested_effort === "string" && parsed.requested_effort ? parsed.requested_effort : null,
      effectiveEffort: typeof parsed.effective_effort === "string" && parsed.effective_effort ? parsed.effective_effort : null,
    };
  }
  return report;
}

// CLI 运行状态展示：终态直读；active 按最近运行状态与心跳新鲜度判断，失联与失败分开；信号不足标待确认。
export const CLI_LOST_AFTER_MS = 3 * 60_000; // 执行器心跳 60s，连续缺失 3 个周期视为失联
const CLI_STATUS_LABELS = { issued: "未领取", started: "启动中", running: "执行中", waiting_permission: "等待权限", waiting_quota: "等待限流恢复", succeeded: "成功", failed: "失败", cancelled: "取消", revoked: "已撤销", expired: "已过期" };

export function cliRunStatusLabel(run, now = Date.now()) {
  if (!run || typeof run !== "object") return { label: "未知", lost: false };
  const status = run.status || "";
  if (status !== "active") return { label: CLI_STATUS_LABELS[status] || status || "未知", lost: false };
  const observedAt = Date.parse(run.lastObservedAt || "");
  if (!Number.isFinite(observedAt)) return { label: "待确认", lost: false };
  const lost = now - observedAt > CLI_LOST_AFTER_MS;
  const runStatus = run.runStatus || "";
  return { label: lost ? "失联" : CLI_STATUS_LABELS[runStatus] || "执行中", lost };
}

// 活动白名单：tool.call 仅工具名、调用 ID 与时间；routing.decision 仅模型/动作/结果；其他事件仅类型与时间。
// 绝不渲染 tool_input、command、output、prompt 或任何未知字段。
const ROUTING_DECISION_FIELDS = [["selected_executor_model", "路由选择模型"], ["orchestrator_model", "主代理模型"], ["routing_action", "动作"], ["routing_outcome", "结果"]];

export function describeActivityEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const type = typeof event.type === "string" && event.type ? event.type : "未知事件";
  const time = typeof event.occurred_at === "string" ? event.occurred_at : typeof event.recorded_at === "string" ? event.recorded_at : null;
  const lines = [];
  let note = null;
  if (type === "tool.call") {
    if (typeof event.tool_name === "string" && event.tool_name) lines.push(`工具：${event.tool_name}`);
    if (typeof event.tool_use_id === "string" && event.tool_use_id) lines.push(`调用 ID：${event.tool_use_id}`);
    note = "调用已记录，执行结果未记录";
  } else if (type === "routing.decision") {
    for (const [key, label] of ROUTING_DECISION_FIELDS) {
      const value = event[key];
      if (typeof value === "string" && value) lines.push(`${label}：${value}`);
    }
  }
  return { type, time, lines, note };
}

// 客户端回执用量：只采信与 parseClientReport 相同的绑定证据，容错解析 usage 快照。
// Claude event.usage 与 Kimi observed 的字段名不一致，按多候选取数；无任何数字字段返回 null。
const USAGE_INPUT_KEYS = ["input_tokens", "inputTokens", "prompt_tokens", "input"];
const USAGE_OUTPUT_KEYS = ["output_tokens", "outputTokens", "completion_tokens", "output"];
const USAGE_CACHE_READ_KEYS = ["cache_read_input_tokens", "cacheReadInputTokens", "cachedInput"];
const USAGE_CACHE_WRITE_KEYS = ["cache_creation_input_tokens", "cacheCreationInputTokens"];

function pickTokenField(usage, keys) {
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

export function parseClientUsage(run) {
  if (!run || typeof run.id !== "string" || !run.id) return null;
  const evidence = Array.isArray(run.evidence) ? run.evidence : [];
  for (const entry of evidence) {
    if (typeof entry !== "string") continue;
    let parsed;
    try {
      parsed = JSON.parse(entry);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    if (parsed.delegation_id !== run.id) continue;
    if (typeof run.delegateSessionId === "string" && run.delegateSessionId && parsed.sessionId !== run.delegateSessionId) continue;
    const usage = parsed.usage;
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) continue;
    const input = pickTokenField(usage, USAGE_INPUT_KEYS);
    const output = pickTokenField(usage, USAGE_OUTPUT_KEYS);
    const cacheRead = pickTokenField(usage, USAGE_CACHE_READ_KEYS);
    const cacheWrite = pickTokenField(usage, USAGE_CACHE_WRITE_KEYS);
    if (input === null && output === null && cacheRead === null && cacheWrite === null) continue;
    return { input, output, cacheRead, cacheWrite };
  }
  return null;
}
