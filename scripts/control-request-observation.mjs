import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

// Observe gate hot paths without retaining query parameters, bodies or Session data.
export function observeControlRequest(request, response, { now = () => performance.now(), write = line => console.log(line), slowMs = 1_000 } = {}) {
  const endpoint = String(request.url || "").split("?")[0];
  if (!["/tasks", "/task-prepare", "/session-status", "/task-events", "/sessions/l0-audit", "/gate-denials"].includes(endpoint)) return;
  const started = now();
  const suppliedId = request.headers["x-request-id"];
  const requestId = typeof suppliedId === "string" && /^[a-f0-9-]{36}$/i.test(suppliedId) ? suppliedId : randomUUID();
  let recorded = false;
  const observe = () => {
    if (recorded) return;
    recorded = true;
    const elapsed = Math.round(now() - started);
    const aborted = !response.writableFinished;
    if (elapsed < slowMs && !aborted) return;
    write(JSON.stringify({ event: "control_request_slow", at: new Date().toISOString(), request_id: requestId,
      method: ["GET", "POST"].includes(request.method) ? request.method : "other", endpoint,
      elapsed_ms: elapsed, status: aborted ? 499 : response.statusCode, client_aborted: aborted }));
  };
  response.once("finish", observe);
  response.once("close", observe);
}
