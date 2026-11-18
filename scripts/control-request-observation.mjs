import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const observations = new WeakMap();
const prepareStages = new Set(["registry", "tasks", "budget", "response"]);

// Only fixed phase names can enter logs; never accept Session data or query text.
export function markPrepareStage(request, stage) {
  if (stage !== null && !prepareStages.has(stage)) return;
  observations.get(request)?.stage(stage);
}

// Observe gate hot paths without retaining query parameters, bodies or Session data.
export function observeControlRequest(request, response, { now = () => performance.now(), write = line => console.log(line), slowMs = 1_000 } = {}) {
  const endpoint = String(request.url || "").split("?")[0];
  if (!["/tasks", "/task-prepare", "/session-status", "/task-events", "/sessions/l0-audit", "/gate-denials"].includes(endpoint)) return;
  const started = now();
  const suppliedId = request.headers["x-request-id"];
  const requestId = typeof suppliedId === "string" && /^[a-f0-9-]{36}$/i.test(suppliedId) ? suppliedId : randomUUID();
  let recorded = false;
  let activeStage = null;
  let stageStarted = started;
  const stages = {};
  const stage = (next) => {
    if (recorded) return;
    const tick = now();
    if (activeStage) stages[activeStage] = (stages[activeStage] || 0) + tick - stageStarted;
    activeStage = next;
    stageStarted = tick;
  };
  observations.set(request, { stage });
  const observe = () => {
    if (recorded) return;
    recorded = true;
    observations.delete(request);
    const tick = now();
    const elapsed = Math.round(tick - started);
    const durations = { ...stages };
    if (activeStage) durations[activeStage] = (durations[activeStage] || 0) + tick - stageStarted;
    const aborted = !response.writableFinished;
    if (elapsed < slowMs && !aborted) return;
    write(JSON.stringify({ event: "control_request_slow", at: new Date().toISOString(), request_id: requestId,
      method: ["GET", "POST"].includes(request.method) ? request.method : "other", endpoint,
      elapsed_ms: elapsed,
      ...(Object.keys(durations).length ? { stage_elapsed_ms: Object.fromEntries(Object.entries(durations).map(([key, value]) => [key, Math.round(value)])), active_stage: activeStage } : {}),
      status: aborted ? 499 : response.statusCode, client_aborted: aborted }));
  };
  response.once("finish", observe);
  response.once("close", observe);
  return requestId;
}
