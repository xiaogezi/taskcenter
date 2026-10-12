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

// 活动白名单：tool.call 仅工具名、调用 ID 与时间；其他事件仅类型与时间。
// 绝不渲染 tool_input、command、output、prompt 或任何未知字段。

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

  }
  return { type, time, lines, note };
}
