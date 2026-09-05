import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadModelRoleConfig, publicModelRoleConfig } from "./model-role-config.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
export const routingControlPath = resolve(process.env.TASKCENTER_ROUTING_CONTROL_PATH || resolve(projectRoot, "data", "routing-control.json"));

const defaultFailureThreshold = integerEnv("TASKCENTER_ROUTING_FAILURE_THRESHOLD", 3, 1, 20);
const defaultCooldownMs = integerEnv("TASKCENTER_ROUTING_COOLDOWN_MS", 300_000, 1_000, 86_400_000);
const defaultLeaseTtlMs = integerEnv("TASKCENTER_ROUTING_LEASE_TTL_MS", 3_600_000, 60_000, 28_800_000);
const terminalOutcomes = new Set(["succeeded", "failed", "cancelled", "unavailable", "overloaded"]);
const circuitFailureTypes = new Set(["server_overloaded", "capacity", "model_unavailable", "rate_limit", "timeout"]);
const immediateOpenFailureTypes = new Set(["server_overloaded", "capacity", "model_unavailable", "rate_limit"]);
const ocrTaskClasses = new Set(["ocr", "ocr_review", "independent_review"]);

export class RoutingControlError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function routingSelect(input, now = new Date().toISOString()) {
  const config = loadModelRoleConfig();
  const requestedPreferredModel = clean(input.preferred_model, 120);
  const taskId = clean(input.task_id, 200);
  const taskClass = clean(input.task_class, 80) || "general";
  const orchestratorModel = clean(input.orchestrator_model, 120);
  const roleName = ocrTaskClasses.has(taskClass) ? "reviewer" : "executor";
  const role = config.roles[roleName];
  const preferredModel = roleName === "reviewer"
    ? role.model
    : normalizePreferredModel(requestedPreferredModel || role.model, config);
  const channel = clean(input.channel, 40) || "cli";
  const eventId = clean(input.event_id, 200) || `routing-select-${randomUUID()}`;
  if (!taskId || !orchestratorModel) throw new RoutingControlError(400, "routing_select 缺少 task_id 或 orchestrator_model。");
  if (!["direct", "native", "cli", "other"].includes(channel)) throw new RoutingControlError(400, "routing_select channel 无效。");
  const reviewArtifacts = normalizeReviewArtifacts(input.review_artifacts, ocrTaskClasses.has(taskClass));

  const state = readState();
  expireRoutes(state, now);
  const signatureInput = { taskId, orchestratorModel, preferredModel, taskClass, channel, configVersion: config.schemaVersion };
  if (reviewArtifacts) signatureInput.reviewArtifacts = reviewArtifacts;
  const signature = signatureOf(signatureInput);
  const replay = state.routes.find((route) => route.selectEventId === eventId);
  if (replay) {
    if (replay.selectSignature !== signature) throw new RoutingControlError(409, "event_id 已被不同 routing_select 请求使用。");
    const auditEvents = replayAuditEvents(state, replay, "select", now, config);
    persistState(state, now);
    return { route: publicRoute(replay), health: healthSnapshot(state, now, config), roles: publicModelRoleConfig(config), idempotent: true, auditEvents };
  }

  const preferred = ensureHealth(state, preferredModel, now, config);
  advanceCircuit(preferred, now);
  let selectedModel = preferredModel;
  let reason = roleName === "reviewer"
    ? "reviewer_model_from_config"
    : !requestedPreferredModel
      ? "executor_model_from_config"
      : requestedPreferredModel === preferredModel
        ? "preferred_model_available"
        : "retired_preference_normalized_to_executor";
  let fallbackFrom = "";
  let fallbackReason = "";
  let retryAfterAt = "";
  let probe = preferred.state === "half_open";

  if (!canLease(state, preferred, now)) {
    fallbackFrom = preferredModel;
    fallbackReason = fallbackReasonFor(preferred);
    retryAfterAt = preferred.retryAfterAt;
    const fallback = chooseFallback(state, role, preferredModel, now, config);
    if (!fallback) {
      const route = buildUnavailableRoute({
        eventId, signature, taskId, orchestratorModel, preferredModel, taskClass, channel, preferred, now,
        reason: role.failClosed ? "reviewer_model_unavailable" : "no_model_capacity_available",
        fallbackFrom, fallbackReason, retryAfterAt, reviewArtifacts,
        configVersion: config.schemaVersion,
      });
      state.routes.push(route);
      route.selectAuditEvents = auditEventsFor(route, preferred, "selection_unavailable");
      persistState(state, now);
      return { route: publicRoute(route), health: healthSnapshot(state, now, config), roles: publicModelRoleConfig(config), idempotent: false, auditEvents: route.selectAuditEvents };
    }
    selectedModel = fallback.model;
    reason = detailedFallbackReason(preferredModel, preferred);
    probe = fallback.state === "half_open";
  }

  const selected = ensureHealth(state, selectedModel, now, config);
  const route = {
    id: clean(input.route_id, 200) || `route_${randomUUID()}`,
    selectEventId: eventId,
    selectSignature: signature,
    taskId,
    orchestratorModel,
    preferredModel,
    selectedModel,
    taskClass,
    channel,
    circuitState: selected.state,
    reason,
    fallbackFrom,
    fallbackReason,
    retryAfterAt,
    reviewArtifacts,
    configVersion: config.schemaVersion,
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
  route.selectAuditEvents = auditEventsFor(route, selected, "lease_acquired", "select");
  persistState(state, now);
  return { route: publicRoute(route), health: healthSnapshot(state, now, config), roles: publicModelRoleConfig(config), idempotent: false, auditEvents: route.selectAuditEvents };
}

export function routingResult(input, now = new Date().toISOString()) {
  const config = loadModelRoleConfig();
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
    const auditEvents = replayAuditEvents(state, route, "result", now, config);
    persistState(state, now);
    return { route: publicRoute(route), health: healthSnapshot(state, now, config), roles: publicModelRoleConfig(config), idempotent: true, auditEvents };
  }
  if (route.status !== "leased") throw new RoutingControlError(409, "route 租约已过期或不可用。");

  const health = ensureHealth(state, route.selectedModel, now, config);
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
  const transition = previousState === health.state ? "result_recorded" : `${previousState}_to_${health.state}`;
  route.resultAuditEvents = auditEventsFor(route, health, transition, "result");
  persistState(state, now);
  return { route: publicRoute(route), health: healthSnapshot(state, now, config), roles: publicModelRoleConfig(config), idempotent: false, auditEvents: route.resultAuditEvents };
}

export function routingHealth(now = new Date().toISOString()) {
  const config = loadModelRoleConfig();
  const state = readState();
  expireRoutes(state, now);
  for (const health of Object.values(state.models)) advanceCircuit(health, now);
  persistState(state, now);
  return healthSnapshot(state, now, config);
}

export function routingRoles() {
  return publicModelRoleConfig(loadModelRoleConfig());
}

function chooseFallback(state, role, preferredModel, now, config) {
  return role.fallbackModels
    .filter((model) => model !== preferredModel)
    .map((model) => ensureHealth(state, model, now, config))
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

function buildUnavailableRoute({
  eventId, signature, taskId, orchestratorModel, preferredModel, taskClass, channel, preferred, now, reason,
  fallbackFrom = "", fallbackReason = "", retryAfterAt = "", reviewArtifacts = null,
  configVersion = "",
}) {
  return {
    id: `route_${randomUUID()}`,
    selectEventId: eventId,
    selectSignature: signature,
    taskId,
    orchestratorModel,
    preferredModel,
    selectedModel: "",
    taskClass,
    channel,
    circuitState: preferred.state,
    reason: reason || "no_model_capacity_available",
    fallbackFrom,
    fallbackReason,
    retryAfterAt,
    reviewArtifacts,
    configVersion,
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

function ensureHealth(state, model, now, config) {
  state.models[model] ||= {
    model,
    state: "closed",
    consecutiveFailures: 0,
    openedAt: "",
    retryAfterAt: "",
    halfOpenLease: "",
    activeExecutors: 0,
    concurrencyLimit: concurrencyLimit(model, config),
    failureThreshold: defaultFailureThreshold,
    cooldownMs: defaultCooldownMs,
    lastErrorCode: "",
    lastRequestId: "",
    lastSuccessAt: "",
    updatedAt: now,
  };
  state.models[model].concurrencyLimit = concurrencyLimit(model, config);
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

function healthSnapshot(state, now, config) {
  refreshActiveExecutors(state, now);
  return Object.values(state.models).filter((health) => !config.retiredModels.includes(health.model)).map((health) => ({
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
    orchestrator_model: route.orchestratorModel || "unknown",
    preferred_model: route.preferredModel,
    selected_model: route.selectedModel || null,
    task_class: route.taskClass,
    channel: route.channel,
    circuit_state: route.circuitState,
    reason: route.reason,
    fallback_from: route.fallbackFrom || null,
    fallback_reason: route.fallbackReason || null,
    retry_after_at: route.retryAfterAt || null,
    review_artifacts: route.reviewArtifacts || null,
    config_version: route.configVersion || null,
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

function auditEventsFor(route, health, transition, phase = "select") {
  const selected = route.selectedModel || route.preferredModel;
  return [
    phase === "select" ? {
      type: "routing.decision",
      event_id: `routing-decision-${route.id}-${route.status}`,
      task_id: route.taskId,
      routing_action: route.selectedModel === route.preferredModel
        ? route.channel === "native"
          ? "delegate_native"
          : route.channel === "cli"
            ? "fallback_cli"
            : route.channel === "direct" && selected === route.orchestratorModel
              ? "direct_execute"
              : "reasoned_override"
        : "reasoned_override",
      orchestrator_model: route.orchestratorModel || "unknown",
      preferred_executor_model: route.preferredModel,
      selected_executor_model: selected,
      dispatch_channel: route.channel,
      routing_reason: route.reason,
      fallback_from: route.fallbackFrom,
      fallback_reason: route.fallbackReason,
      retry_after_at: route.retryAfterAt,
      review_artifacts: route.reviewArtifacts,
      routing_outcome: route.status === "succeeded" ? "succeeded" : ["failed", "overloaded", "unavailable"].includes(route.status) ? "failed" : "selected",
      policy_version: "routing-control-v3",
      route_id: route.id,
      task_class: route.taskClass,
      circuit_state: route.circuitState,
    } : {
      type: "routing.result",
      event_id: `routing-result-${route.id}-${route.status}`,
      task_id: route.taskId,
      route_id: route.id,
      routing_outcome: route.status,
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

function replayAuditEvents(state, route, phase, now, config) {
  const key = phase === "select" ? "selectAuditEvents" : "resultAuditEvents";
  if (Array.isArray(route[key]) && route[key].length) return route[key];
  const health = ensureHealth(state, route.selectedModel || route.preferredModel, now, config);
  const transition = phase === "select"
    ? route.available ? "lease_acquired" : "selection_unavailable"
    : "result_recorded";
  route[key] = auditEventsFor(route, health, transition, phase);
  return route[key];
}

function readState() {
  if (!existsSync(routingControlPath)) return { version: 3, models: {}, routes: [], updatedAt: "" };
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
  state.version = 3;
  state.updatedAt = now;
  state.routes = state.routes.slice(-5_000);
  mkdirSync(dirname(routingControlPath), { recursive: true });
  const temporary = `${routingControlPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, routingControlPath);
}

function migrateState(state) {
  if (state.version < 2) {
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
  }
  state.version = 3;
}

function concurrencyLimit(model, config) {
  const envKey = `TASKCENTER_ROUTING_CONCURRENCY_${model.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
  const roleLimit = Object.values(config.roles).find((role) => role.model === model)?.concurrencyLimit || 1;
  return integerEnv(envKey, roleLimit, 1, 64);
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

function normalizePreferredModel(model, config) {
  return config.retiredModels.includes(model) ? config.roles.executor.model : model;
}

function normalizeReviewArtifacts(value, required) {
  if (!value && !required) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RoutingControlError(400, "OCR routing_select 必须提供 review_artifacts。");
  }
  const normalized = {
    subject: normalizeReviewArtifact(value.subject, "subject"),
    bundle: normalizeReviewArtifact(value.bundle, "bundle"),
    rules: normalizeReviewArtifact(value.rules, "rules"),
  };
  return normalized;
}

function normalizeReviewArtifact(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RoutingControlError(400, `review_artifacts.${name} 必须提供 ref 或 fingerprint。`);
  }
  const ref = clean(value.ref, 1_000);
  const fingerprint = clean(value.fingerprint, 300);
  if (!ref && !fingerprint) throw new RoutingControlError(400, `review_artifacts.${name} 必须提供 ref 或 fingerprint。`);
  return { ref: ref || null, fingerprint: fingerprint || null };
}

function fallbackReasonFor(health) {
  if (health.state === "open") return "preferred_model_circuit_open";
  if (health.state === "half_open") return "preferred_model_half_open_probe_leased";
  return "preferred_model_concurrency_limit_reached";
}

function detailedFallbackReason(preferredModel, health) {
  if (health.state === "open") return `${modelSlug(preferredModel)}_circuit_open_until_${health.retryAfterAt}`;
  if (health.state === "half_open") return `${modelSlug(preferredModel)}_half_open_probe_leased`;
  return `${modelSlug(preferredModel)}_concurrency_limit_reached`;
}

function signatureOf(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function modelSlug(model) {
  return model.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
}
