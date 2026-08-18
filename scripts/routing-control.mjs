import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
export const routingControlPath = resolve(process.env.TASKCENTER_ROUTING_CONTROL_PATH || resolve(projectRoot, "data", "routing-control.json"));

const defaultFailureThreshold = integerEnv("TASKCENTER_ROUTING_FAILURE_THRESHOLD", 3, 1, 20);
const defaultCooldownMs = integerEnv("TASKCENTER_ROUTING_COOLDOWN_MS", 300_000, 1_000, 86_400_000);
const defaultLeaseTtlMs = integerEnv("TASKCENTER_ROUTING_LEASE_TTL_MS", 3_600_000, 60_000, 28_800_000);
const defaultConcurrency = Object.freeze({
  "gpt-5.3-codex-spark": 2,
  "gpt-5.6-luna": 2,
  "gpt-5.6-terra": 1,
});
const terminalOutcomes = new Set(["succeeded", "failed", "cancelled", "unavailable", "overloaded"]);
const circuitFailureTypes = new Set(["server_overloaded", "capacity", "model_unavailable", "rate_limit", "timeout"]);
const immediateOpenFailureTypes = new Set(["server_overloaded", "capacity", "model_unavailable", "rate_limit"]);
const complexTaskClasses = new Set(["architecture", "security", "migration", "data_migration", "complex_diagnosis", "high_risk"]);
const ocrTaskClasses = new Set(["ocr", "ocr_review", "independent_review"]);

export class RoutingControlError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function routingSelect(input, now = new Date().toISOString()) {
  const preferredModel = clean(input.preferred_model, 120);
  const taskId = clean(input.task_id, 200);
  const taskClass = clean(input.task_class, 80) || "general";
  const channel = clean(input.channel, 40) || "cli";
  const eventId = clean(input.event_id, 200) || `routing-select-${randomUUID()}`;
  if (!taskId || !preferredModel) throw new RoutingControlError(400, "routing_select 缺少 task_id 或 preferred_model。");
  if (!["direct", "native", "cli", "other"].includes(channel)) throw new RoutingControlError(400, "routing_select channel 无效。");

  const state = readState();
  expireRoutes(state, now);
  const signature = signatureOf({ taskId, preferredModel, taskClass, channel });
  const replay = state.routes.find((route) => route.selectEventId === eventId);
  if (replay) {
    if (replay.selectSignature !== signature) throw new RoutingControlError(409, "event_id 已被不同 routing_select 请求使用。");
    persistState(state, now);
    return { route: publicRoute(replay), health: healthSnapshot(state, now), idempotent: true, auditEvents: [] };
  }

  const preferred = ensureHealth(state, preferredModel, now);
  advanceCircuit(preferred, now);
  let selectedModel = preferredModel;
  let reason = "preferred_model_available";
  let probe = preferred.state === "half_open";

  if (!canLease(state, preferred, now)) {
    if (ocrTaskClasses.has(taskClass)) {
      const route = buildUnavailableRoute({ eventId, signature, taskId, preferredModel, taskClass, channel, preferred, now });
      state.routes.push(route);
      persistState(state, now);
      return {
        route: publicRoute(route),
        health: healthSnapshot(state, now),
        idempotent: false,
        auditEvents: auditEventsFor(route, preferred, "selection_unavailable"),
      };
    }
    const fallback = chooseFallback(state, taskClass, preferredModel, now);
    if (!fallback) {
      const route = buildUnavailableRoute({ eventId, signature, taskId, preferredModel, taskClass, channel, preferred, now, reason: "no_model_capacity_available" });
      state.routes.push(route);
      persistState(state, now);
      return { route: publicRoute(route), health: healthSnapshot(state, now), idempotent: false, auditEvents: auditEventsFor(route, preferred, "selection_unavailable") };
    }
    selectedModel = fallback.model;
    reason = preferred.state === "open"
      ? `${modelSlug(preferredModel)}_circuit_open_until_${preferred.retryAfterAt}`
      : preferred.state === "half_open"
        ? `${modelSlug(preferredModel)}_half_open_probe_leased`
        : `${modelSlug(preferredModel)}_concurrency_limit_reached`;
    probe = fallback.state === "half_open";
  }

  const selected = ensureHealth(state, selectedModel, now);
  const route = {
    id: clean(input.route_id, 200) || `route_${randomUUID()}`,
    selectEventId: eventId,
    selectSignature: signature,
    taskId,
    preferredModel,
    selectedModel,
    taskClass,
    channel,
    circuitState: selected.state,
    reason,
    requiresNewSession: selectedModel !== preferredModel || channel === "cli",
    available: true,
    probe,
    status: "leased",
    createdAt: now,
    expiresAt: new Date(Date.parse(now) + normalizeTtlMs(input.lease_ttl_ms)).toISOString(),
    completedAt: "",
    resultEventId: "",
    resultSignature: "",
    result: null,
  };
  if (state.routes.some((item) => item.id === route.id)) throw new RoutingControlError(409, "route_id 已存在。");
  state.routes.push(route);
  if (probe) selected.halfOpenLease = route.id;
  refreshActiveExecutors(state, now);
  selected.updatedAt = now;
  persistState(state, now);
  return { route: publicRoute(route), health: healthSnapshot(state, now), idempotent: false, auditEvents: auditEventsFor(route, selected, "lease_acquired") };
}

export function routingResult(input, now = new Date().toISOString()) {
  const routeId = clean(input.route_id, 200);
  const outcome = clean(input.outcome, 40);
  const eventId = clean(input.event_id, 200) || `routing-result-${randomUUID()}`;
  if (!routeId || !terminalOutcomes.has(outcome)) throw new RoutingControlError(400, "routing_result 缺少 route_id 或 outcome 无效。");
  const state = readState();
  expireRoutes(state, now);
  const route = state.routes.find((item) => item.id === routeId);
  if (!route) throw new RoutingControlError(404, "route_id 不存在。");
  if (!route.available) throw new RoutingControlError(409, "未发放执行租约的路由不能上报执行结果。");

  const result = {
    outcome,
    httpStatus: normalizeHttpStatus(input.http_status),
    errorType: clean(input.error_type, 120),
    errorCode: clean(input.error_code, 160),
    requestId: clean(input.request_id, 300),
  };
  const signature = signatureOf(result);
  if (route.result) {
    if (route.resultEventId !== eventId && route.resultSignature !== signature) throw new RoutingControlError(409, "route 已上报不同结果。");
    if (route.resultSignature !== signature) throw new RoutingControlError(409, "event_id 已被不同 routing_result 使用。");
    return { route: publicRoute(route), health: healthSnapshot(state, now), idempotent: true, auditEvents: [] };
  }
  if (route.status !== "leased") throw new RoutingControlError(409, "route 租约已过期或不可用。");

  const health = ensureHealth(state, route.selectedModel, now);
  const previousState = health.state;
  route.status = outcome;
  route.completedAt = now;
  route.resultEventId = eventId;
  route.resultSignature = signature;
  route.result = result;
  if (health.halfOpenLease === route.id) health.halfOpenLease = "";

  if (outcome === "succeeded") {
    health.state = "closed";
    health.consecutiveFailures = 0;
    health.openedAt = "";
    health.retryAfterAt = "";
    health.lastSuccessAt = now;
  } else if (isCircuitFailure(result)) {
    health.consecutiveFailures += 1;
    health.lastErrorCode = result.errorCode || result.errorType || String(result.httpStatus || "");
    health.lastRequestId = result.requestId;
    if (previousState === "half_open" || immediateOpenFailureTypes.has(result.errorType) || health.consecutiveFailures >= health.failureThreshold) openCircuit(health, now);
  }
  health.updatedAt = now;
  refreshActiveExecutors(state, now);
  persistState(state, now);
  const transition = previousState === health.state ? "result_recorded" : `${previousState}_to_${health.state}`;
  return { route: publicRoute(route), health: healthSnapshot(state, now), idempotent: false, auditEvents: auditEventsFor(route, health, transition) };
}

export function routingHealth(now = new Date().toISOString()) {
  const state = readState();
  expireRoutes(state, now);
  persistState(state, now);
  return healthSnapshot(state, now);
}

function chooseFallback(state, taskClass, preferredModel, now) {
  const candidates = complexTaskClasses.has(taskClass)
    ? ["gpt-5.6-terra", "gpt-5.6-luna"]
    : ["gpt-5.6-luna", "gpt-5.6-terra"];
  return candidates
    .filter((model) => model !== preferredModel)
    .map((model) => ensureHealth(state, model, now))
    .find((health) => {
      advanceCircuit(health, now);
      return canLease(state, health, now);
    }) || null;
}

function canLease(state, health, now) {
  advanceCircuit(health, now);
  if (health.state === "open") return false;
  if (health.state === "half_open" && health.halfOpenLease) return false;
  return activeRoutes(state, health.model, now).length < health.concurrencyLimit;
}

function advanceCircuit(health, now) {
  if (health.state === "open" && Date.parse(health.retryAfterAt || "") <= Date.parse(now)) {
    health.state = "half_open";
    health.halfOpenLease = "";
    health.updatedAt = now;
  }
}

function openCircuit(health, now) {
  health.state = "open";
  health.openedAt = now;
  health.retryAfterAt = new Date(Date.parse(now) + health.cooldownMs).toISOString();
  health.halfOpenLease = "";
}

function isCircuitFailure(result) {
  return [429, 500, 502, 503, 504].includes(result.httpStatus)
    || circuitFailureTypes.has(result.errorType)
    || /overload|capacity|unavailable|rate.?limit|timeout/i.test(`${result.errorType} ${result.errorCode}`);
}

function buildUnavailableRoute({ eventId, signature, taskId, preferredModel, taskClass, channel, preferred, now, reason }) {
  return {
    id: `route_${randomUUID()}`,
    selectEventId: eventId,
    selectSignature: signature,
    taskId,
    preferredModel,
    selectedModel: "",
    taskClass,
    channel,
    circuitState: preferred.state,
    reason: reason || "ocr_reviewer_unavailable_no_substitute",
    requiresNewSession: false,
    available: false,
    probe: false,
    status: "unavailable",
    createdAt: now,
    expiresAt: now,
    completedAt: now,
    resultEventId: "",
    resultSignature: "",
    result: null,
  };
}

function ensureHealth(state, model, now) {
  state.models[model] ||= {
    model,
    state: "closed",
    consecutiveFailures: 0,
    openedAt: "",
    retryAfterAt: "",
    halfOpenLease: "",
    activeExecutors: 0,
    concurrencyLimit: concurrencyLimit(model),
    failureThreshold: defaultFailureThreshold,
    cooldownMs: defaultCooldownMs,
    lastErrorCode: "",
    lastRequestId: "",
    lastSuccessAt: "",
    updatedAt: now,
  };
  return state.models[model];
}

function expireRoutes(state, now) {
  let changed = false;
  for (const route of state.routes) {
    if (route.status !== "leased" || Date.parse(route.expiresAt || "") > Date.parse(now)) continue;
    route.status = "expired";
    route.completedAt = now;
    const health = state.models[route.selectedModel];
    if (health?.halfOpenLease === route.id) health.halfOpenLease = "";
    changed = true;
  }
  refreshActiveExecutors(state, now);
  return changed;
}

function refreshActiveExecutors(state, now) {
  for (const health of Object.values(state.models)) health.activeExecutors = activeRoutes(state, health.model, now).length;
}

function activeRoutes(state, model, now) {
  return state.routes.filter((route) => route.selectedModel === model && route.status === "leased" && Date.parse(route.expiresAt || "") > Date.parse(now));
}

function healthSnapshot(state, now) {
  refreshActiveExecutors(state, now);
  return Object.values(state.models).map((health) => ({
    model: health.model,
    state: health.state,
    consecutive_failures: health.consecutiveFailures,
    opened_at: health.openedAt || null,
    retry_after_at: health.retryAfterAt || null,
    half_open_lease: health.halfOpenLease || null,
    active_executors: health.activeExecutors,
    concurrency_limit: health.concurrencyLimit,
    last_error_code: health.lastErrorCode || null,
    last_request_id: health.lastRequestId || null,
    last_success_at: health.lastSuccessAt || null,
    updated_at: health.updatedAt,
  })).sort((left, right) => left.model.localeCompare(right.model));
}

function publicRoute(route) {
  return {
    route_id: route.id,
    task_id: route.taskId,
    preferred_model: route.preferredModel,
    selected_model: route.selectedModel || null,
    task_class: route.taskClass,
    channel: route.channel,
    circuit_state: route.circuitState,
    reason: route.reason,
    requires_new_session: route.requiresNewSession,
    available: route.available,
    probe: route.probe,
    status: route.status,
    created_at: route.createdAt,
    expires_at: route.expiresAt,
    completed_at: route.completedAt || null,
    result: route.result ? {
      outcome: route.result.outcome,
      http_status: route.result.httpStatus || null,
      error_type: route.result.errorType || null,
      error_code: route.result.errorCode || null,
      request_id: route.result.requestId || null,
    } : null,
  };
}

function auditEventsFor(route, health, transition) {
  const selected = route.selectedModel || route.preferredModel;
  return [
    {
      type: "routing.decision",
      event_id: `routing-decision-${route.id}-${route.status}`,
      task_id: route.taskId,
      routing_action: route.selectedModel === route.preferredModel
        ? route.channel === "native"
          ? "delegate_native"
          : route.channel === "cli"
            ? "fallback_cli"
            : route.channel === "direct" && selected === "gpt-5.6-sol"
              ? "direct_execute"
              : "reasoned_override"
        : "reasoned_override",
      orchestrator_model: "gpt-5.6-sol",
      preferred_executor_model: route.preferredModel,
      selected_executor_model: selected,
      dispatch_channel: route.channel,
      routing_reason: route.reason,
      routing_outcome: route.status === "succeeded" ? "succeeded" : ["failed", "overloaded", "unavailable"].includes(route.status) ? "failed" : "selected",
      policy_version: "routing-control-v1",
      route_id: route.id,
      task_class: route.taskClass,
      circuit_state: route.circuitState,
    },
    {
      type: "routing.health",
      event_id: `routing-health-${route.id}-${route.status}`,
      task_id: route.taskId,
      route_id: route.id,
      health_model: health.model,
      circuit_state: health.state,
      health_transition: transition,
      consecutive_failures: health.consecutiveFailures,
      active_executors: health.activeExecutors,
      retry_after_at: health.retryAfterAt,
    },
  ];
}

function readState() {
  if (!existsSync(routingControlPath)) return { version: 2, models: {}, routes: [], updatedAt: "" };
  try {
    const value = JSON.parse(readFileSync(routingControlPath, "utf8"));
    if (!value?.models || typeof value.models !== "object" || Array.isArray(value.models) || !Array.isArray(value.routes)) throw new Error("invalid state");
    const state = { version: Number(value.version) || 1, models: value.models, routes: value.routes, updatedAt: clean(value.updatedAt, 80) };
    migrateState(state);
    return state;
  } catch {
    throw new RoutingControlError(500, "路由控制状态损坏，已拒绝覆盖；请先修复或移走该运行态文件。");
  }
}

function persistState(state, now) {
  state.version = 2;
  state.updatedAt = now;
  state.routes = state.routes.slice(-5_000);
  mkdirSync(dirname(routingControlPath), { recursive: true });
  const temporary = `${routingControlPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, routingControlPath);
}

function migrateState(state) {
  if (state.version >= 2) return;
  for (const health of Object.values(state.models)) {
    const latest = state.routes
      .filter((route) => route.selectedModel === health.model && route.result)
      .sort((left, right) => Date.parse(right.completedAt || "") - Date.parse(left.completedAt || ""))[0];
    if (!latest || latest.result.outcome === "succeeded" || !immediateOpenFailureTypes.has(latest.result.errorType)) continue;
    health.consecutiveFailures = Math.max(1, Number(health.consecutiveFailures) || 0);
    health.lastErrorCode = latest.result.errorCode || latest.result.errorType;
    health.lastRequestId = latest.result.requestId || "";
    openCircuit(health, latest.completedAt || latest.createdAt);
    health.updatedAt = latest.completedAt || latest.createdAt;
  }
  state.version = 2;
}

function concurrencyLimit(model) {
  const envKey = `TASKCENTER_ROUTING_CONCURRENCY_${model.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
  return integerEnv(envKey, defaultConcurrency[model] || 1, 1, 64);
}

function normalizeTtlMs(value) {
  const number = Number(value ?? defaultLeaseTtlMs);
  if (!Number.isInteger(number) || number < 60_000 || number > 28_800_000) throw new RoutingControlError(400, "lease_ttl_ms 必须在 60000 到 28800000 之间。");
  return number;
}

function normalizeHttpStatus(value) {
  if (value === undefined || value === null) return 0;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 599) throw new RoutingControlError(400, "http_status 无效。");
  return number;
}

function integerEnv(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function clean(value, limit) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

function signatureOf(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function modelSlug(model) {
  if (model === "gpt-5.3-codex-spark") return "spark";
  return model.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
}
