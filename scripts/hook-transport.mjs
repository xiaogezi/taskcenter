import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

class ControlUnavailableError extends Error {}

// The host allows 10s. Leave 1.5s for process startup, output and shutdown,
// and reserve 1s inside this budget for best-effort denial reporting.
export function createHookTransport({ controlUrl, recover, totalMs = 8_500, reportMs = 1_000, requestMs = 8_000 } = {}) {
  const started = performance.now();
  const remaining = (report = false) => Math.max(0, Math.floor(totalMs - (report ? 0 : reportMs) - (performance.now() - started)));
  let recoveryAttempted = false;

  function timeout(method, path, phase, requestId, since, limitMs) {
    const diagnostic = {
      code: "TASKCENTER_HOOK_TIMEOUT", request_id: requestId, method,
      // Never expose workspace/session query parameters or unknown endpoint text.
      endpoint: ["/task-prepare", "/session-status", "/tasks", "/task-events", "/sessions/l0-audit", "/gate-session-allowlist", "/gate-denials", "control:start"].includes(path.split("?")[0]) ? path.split("?")[0] : "unknown",
      phase, elapsed_ms: Math.round(performance.now() - since),
      hook_elapsed_ms: Math.round(performance.now() - started), limit_ms: limitMs, total_budget_ms: totalMs,
    };
    return Object.assign(new Error(`TASKCENTER_HOOK_TIMEOUT ${JSON.stringify(diagnostic)}。控制面通信超时，不是任务执行时长超限；本次授权未确认，不执行原工具。先核对请求结果与服务健康，再重试；不要重复提交结果未知的写请求或重启健康服务。`), { diagnostic });
  }

  async function bounded(method, path, report, operation, phase = "request") {
    const requestId = randomUUID();
    const since = performance.now();
    const limitMs = Math.min(report ? reportMs : requestMs, remaining(report));
    if (limitMs <= 0) throw timeout(method, path, phase, requestId, since, 0);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limitMs);
    try {
      return await operation(controller.signal, requestId, limitMs);
    } catch (error) {
      if (controller.signal.aborted) throw timeout(method, path, phase, requestId, since, limitMs);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function requestOnce(method, path, body, { report = false } = {}) {
    return bounded(method, path, report, async (signal, requestId) => {
      try {
        const response = await fetch(`${controlUrl}${path}`, {
          method,
          headers: { "X-Request-ID": requestId, ...(body ? { "Content-Type": "application/json", "X-TaskCenter-Task": "hook" } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal,
        });
        const text = await response.text();
        let value;
        try { value = text ? JSON.parse(text) : {}; }
        catch { throw new Error(`TaskCenter 返回非 JSON (${response.status})`); }
        if (!response.ok) throw Object.assign(new Error(value.error || `TaskCenter 请求失败 (${response.status})`), { statusCode: response.status });
        return value;
      } catch (error) {
        if (error instanceof TypeError && !signal.aborted) throw new ControlUnavailableError("TaskCenter 控制服务不可用。");
        throw error;
      }
    });
  }

  async function request(method, path, body) {
    try { return await requestOnce(method, path, body); }
    catch (error) {
      // A disconnected POST may already have taken effect. Never blindly replay it.
      if (!(error instanceof ControlUnavailableError) || recoveryAttempted || !recover || method !== "GET") throw error;
      recoveryAttempted = true;
      await bounded("EXEC", "control:start", false, recover, "recovery");
      return requestOnce(method, path, body);
    }
  }
  return { request, requestOnce };
}
