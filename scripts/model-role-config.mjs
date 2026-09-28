import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
export const modelRoleConfigPath = resolve(
  process.env.TASKCENTER_MODEL_ROLE_CONFIG_PATH
    || resolve(projectRoot, "config", "model-roles.json"),
);
const optionalAstraPolicyPath = resolve(process.env.TASKCENTER_RUNTIME_DIR || resolve(projectRoot, ".local", "runtime"), "optional-astra-policy.json");

const allowedReasoningEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const supportedTaskClasses = new Set(["general", "search", "mechanical", "implementation", "test", "documentation", "architecture", "security", "migration", "data_migration", "complex_diagnosis", "high_risk", "ocr", "ocr_review", "independent_review"]);
const reviewerTaskClasses = new Set(["ocr", "ocr_review", "independent_review"]);

export class ModelRoleConfigError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

export function loadModelRoleConfig() {
  if (!existsSync(modelRoleConfigPath)) {
    throw new ModelRoleConfigError(`模型角色配置不存在: ${modelRoleConfigPath}`);
  }
  let raw;
  let input;
  try {
    raw = readFileSync(modelRoleConfigPath, "utf8");
    input = JSON.parse(raw);
  } catch {
    throw new ModelRoleConfigError(`模型角色配置不是有效 JSON: ${modelRoleConfigPath}`);
  }
  if (input?.schema_version !== "taskcenter-model-roles-v1") {
    throw new ModelRoleConfigError("模型角色配置 schema_version 无效。");
  }
  const executor = normalizeRole(input.roles?.executor, "executor", false);
  const reviewer = normalizeRole(input.roles?.reviewer, "reviewer", true);
  const manualOnlyModels = uniqueModels(input.manual_only_models || [], "manual_only_models");
  const retiredModels = uniqueModels(input.retired_models, "retired_models");
  const optionalAstraPolicy = readOptionalAstraPolicy(input.optional_astra_policy);
  const quotaPools = normalizeQuotaPools(input.quota_pools);
  const modelCatalog = normalizeModelCatalog(input.model_catalog);
  const nativeModels = { ...normalizeNativeModels(input.native_models), ...normalizeNativeModels(input.roles?.executor?.native_models) };
  const activeModels = new Set([
    executor.model,
    reviewer.model,
    ...executor.fallbackModels,
    executor.capacityFallbackModel,
    ...reviewer.fallbackModels,
  ]);
  const conflict = retiredModels.find((model) => activeModels.has(model));
  if (conflict) throw new ModelRoleConfigError(`已退役模型不能同时用于活跃角色: ${conflict}`);
  const manualRetiredConflict = manualOnlyModels.find((model) => retiredModels.includes(model));
  if (manualRetiredConflict) throw new ModelRoleConfigError(`手动模型不能同时标记为已退役: ${manualRetiredConflict}`);
  const manualActiveConflict = manualOnlyModels.find((model) => activeModels.has(model));
  if (manualActiveConflict) throw new ModelRoleConfigError(`手动模型不能进入自动角色池: ${manualActiveConflict}`);
  const nativeConflict = Object.keys(nativeModels).find((model) => retiredModels.includes(model) || manualOnlyModels.includes(model));
  if (nativeConflict) throw new ModelRoleConfigError(`退役或手动模型不能配置 native 映射: ${nativeConflict}`);
  return {
    schemaVersion: input.schema_version,
    contentHash: createHash("sha256").update(raw).digest("hex"),
    roles: { executor, reviewer },
    manualOnlyModels, retiredModels, optionalAstraPolicy, quotaPools, modelCatalog, nativeModels,
  };
}

// 自动选择资格：退役、manual_only 与超过 model_catalog.automatic_until 的模型都不得进入自动路由；
// 显式 cli_profile / preferred_model 语义不受本函数影响。
export function isAutomaticEligible(config, model, now = new Date().toISOString()) {
  if (!model || config.retiredModels.includes(model) || config.manualOnlyModels.includes(model)) return false;
  const until = config.modelCatalog?.[model]?.automatic_until;
  if (!until) return true;
  const untilMs = Date.parse(until);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(untilMs) || !Number.isFinite(nowMs)) return true;
  return untilMs > nowMs;
}

export function publicModelRoleConfig(config = loadModelRoleConfig()) {
  return {
    schema_version: config.schemaVersion,
    content_hash: config.contentHash,
    executor: publicRole(config.roles.executor),
    reviewer: publicRole(config.roles.reviewer),
    manual_only_models: config.manualOnlyModels,
    optional_astra_policy: config.optionalAstraPolicy,
    quota_pools: config.quotaPools,
    model_catalog: config.modelCatalog,
    native_models: publicNativeModels(config.nativeModels),
  };
}

// Codex 原生派发能力：canonical 模型有映射、本轮工具能力列表包含 runtime_model，
// 且请求档位在映射声明的范围内时，返回实际 spawn 用的 runtime model id；否则返回空串。
export function nativeRuntimeModel(config, canonicalModel, availableNativeModels = [], effort = "low") {
  const entry = config?.nativeModels?.[canonicalModel];
  if (!entry || !entry.reasoningEfforts.includes(effort)) return "";
  return availableNativeModels.includes(entry.runtimeModel) ? entry.runtimeModel : "";
}

export function executorReasoningEffort(config, model, taskClass) {
  const role = config.roles.executor;
  return role.modelReasoningEfforts[model] || role.taskClassReasoningEfforts[taskClass] || role.reasoningEffort;
}

export function configuredPreferredModel(taskClass, config = loadModelRoleConfig()) {
  if (!supportedTaskClasses.has(taskClass)) throw new ModelRoleConfigError(`未知 task_class：${taskClass}。`);
  if (reviewerTaskClasses.has(taskClass)) return config.roles.reviewer.model;
  return config.roles.executor.taskClassModels[taskClass] || config.roles.executor.model;
}

export function updateOptionalAstraPolicy(input, actor = "local-ui", now = new Date().toISOString()) {
  loadModelRoleConfig();
  const preset = String(input?.preset || "").trim();
  const thresholds = { saving: 0, balanced: 35, quality: 60, custom: Number(input?.threshold_percent) };
  if (!(preset in thresholds) || !Number.isInteger(thresholds[preset]) || thresholds[preset] < 0 || thresholds[preset] > 100) throw new ModelRoleConfigError("可选 Astra 策略必须是有效预设或 0–100 阈值。");
  const policy = { preset, threshold_percent: thresholds[preset], updated_at: now, updated_by: actor };
  if (!existsSync(dirname(optionalAstraPolicyPath))) throw new ModelRoleConfigError("本地策略目录不可用。");
  const temporary = `${optionalAstraPolicyPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, optionalAstraPolicyPath);
  return policy;
}

function normalizeRole(value, name, failClosed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ModelRoleConfigError(`模型角色配置缺少 roles.${name}。`);
  }
  const model = cleanModel(value.model);
  const reasoningEffort = String(value.reasoning_effort || "").trim();
  const concurrencyLimit = Number(value.concurrency_limit);
  const globalConcurrencyLimit = value.global_concurrency_limit === undefined ? null : Number(value.global_concurrency_limit);
  if (!model) throw new ModelRoleConfigError(`roles.${name}.model 无效。`);
  if (!allowedReasoningEfforts.has(reasoningEffort)) {
    throw new ModelRoleConfigError(`roles.${name}.reasoning_effort 无效。`);
  }
  if (!Number.isInteger(concurrencyLimit) || concurrencyLimit < 1 || concurrencyLimit > 64) {
    throw new ModelRoleConfigError(`roles.${name}.concurrency_limit 必须在 1 到 64 之间。`);
  }
  if (globalConcurrencyLimit !== null && (!Number.isInteger(globalConcurrencyLimit) || globalConcurrencyLimit < 1 || globalConcurrencyLimit > 64)) {
    throw new ModelRoleConfigError(`roles.${name}.global_concurrency_limit 必须在 1 到 64 之间。`);
  }
  const fallbackModels = uniqueModels(value.fallback_models, `roles.${name}.fallback_models`)
    .filter((candidate) => candidate !== model);
  const capacityFallbackModel = name === "executor" ? cleanModel(value.capacity_fallback_model) : "";
  if (failClosed && fallbackModels.length > 0) {
    throw new ModelRoleConfigError("Reviewer 必须 fail closed，不能配置 fallback_models。");
  }
  const taskClassModels = normalizeTaskClassModels(value.task_class_models, model, fallbackModels, name);
  const taskClassReasoningEfforts = normalizeTaskClassReasoningEfforts(value.task_class_reasoning_efforts, name);
  const dispatchChannel = value.dispatch_channel || "cli";
  if (!["cli", "native"].includes(dispatchChannel)) throw new ModelRoleConfigError(`roles.${name}.dispatch_channel 无效。`);
  const modelReasoningEfforts = value.model_reasoning_efforts || {};
  if (typeof modelReasoningEfforts !== "object" || Array.isArray(modelReasoningEfforts)) throw new ModelRoleConfigError(`roles.${name}.model_reasoning_efforts 必须是对象。`);
  for (const [candidate, effort] of Object.entries(modelReasoningEfforts)) {
    if (![model, ...fallbackModels].includes(candidate) || !allowedReasoningEfforts.has(effort)) throw new ModelRoleConfigError(`roles.${name}.model_reasoning_efforts 含无效模型或档位。`);
  }
  return { model, reasoningEffort, fallbackModels, capacityFallbackModel, concurrencyLimit, globalConcurrencyLimit, failClosed, taskClassModels, taskClassReasoningEfforts, dispatchChannel, modelReasoningEfforts };
}

function normalizeTaskClassReasoningEfforts(value, roleName) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ModelRoleConfigError(`roles.${roleName}.task_class_reasoning_efforts 必须是对象。`);
  }
  const result = {};
  for (const [taskClass, effort] of Object.entries(value)) {
    if (!supportedTaskClasses.has(taskClass)) throw new ModelRoleConfigError(`roles.${roleName}.task_class_reasoning_efforts 含未知 task_class：${taskClass}。`);
    if (roleName === "reviewer" ? !reviewerTaskClasses.has(taskClass) : reviewerTaskClasses.has(taskClass)) {
      throw new ModelRoleConfigError(`roles.${roleName}.task_class_reasoning_efforts 的 task_class 与角色不匹配：${taskClass}。`);
    }
    if (!allowedReasoningEfforts.has(effort)) throw new ModelRoleConfigError(`roles.${roleName}.task_class_reasoning_efforts.${taskClass} 无效。`);
    result[taskClass] = effort;
  }
  return result;
}

function normalizeTaskClassModels(value, model, fallbackModels, roleName) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ModelRoleConfigError(`roles.${roleName}.task_class_models 必须是对象。`);
  }
  const allowedModels = new Set([model, ...fallbackModels]);
  const result = {};
  for (const [taskClass, candidate] of Object.entries(value)) {
    if (!supportedTaskClasses.has(taskClass)) {
      throw new ModelRoleConfigError(`roles.${roleName}.task_class_models 含未知 task_class：${taskClass}。`);
    }
    if (roleName === "reviewer" || reviewerTaskClasses.has(taskClass)) {
      throw new ModelRoleConfigError(`roles.${roleName}.task_class_models 不支持 Reviewer/OCR task_class：${taskClass}。`);
    }
    const normalized = cleanModel(candidate);
    if (!allowedModels.has(normalized)) {
      throw new ModelRoleConfigError(`roles.${roleName}.task_class_models.${taskClass} 必须引用当前角色模型池。`);
    }
    result[taskClass] = normalized;
  }
  return result;
}

function uniqueModels(value, name) {
  if (!Array.isArray(value)) throw new ModelRoleConfigError(`${name} 必须是数组。`);
  const models = value.map(cleanModel);
  if (models.some((model) => !model)) throw new ModelRoleConfigError(`${name} 包含无效模型。`);
  return [...new Set(models)];
}

function cleanModel(value) {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

function normalizeOptionalAstraPolicy(value) {
  const preset = String(value?.preset || "saving").trim();
  const threshold = Number(value?.threshold_percent ?? 0);
  if (!(["saving", "balanced", "quality", "custom"].includes(preset)) || !Number.isInteger(threshold) || threshold < 0 || threshold > 100) throw new ModelRoleConfigError("optional_astra_policy 无效。");
  return { preset, threshold_percent: threshold, updated_at: String(value?.updated_at || ""), updated_by: String(value?.updated_by || "default") };
}

function readOptionalAstraPolicy(fallback) {
  try { return normalizeOptionalAstraPolicy(JSON.parse(readFileSync(optionalAstraPolicyPath, "utf8"))); } catch { return normalizeOptionalAstraPolicy(fallback); }
}

function normalizeModelCatalog(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelRoleConfigError("model_catalog 必须是按模型 id 键控的对象。");
  const catalog = {};
  for (const [key, entry] of Object.entries(value)) {
    const model = cleanModel(key);
    const description = typeof entry?.description === "string" ? entry.description.trim().slice(0, 300) : "";
    if (!model || !description) throw new ModelRoleConfigError(`model_catalog.${key || "?"} 需要有效模型 id 与能力与成本描述。`);
    let automaticUntil = "";
    if (entry.automatic_until !== undefined && entry.automatic_until !== null && entry.automatic_until !== "") {
      const raw = String(entry.automatic_until).trim();
      if (!Number.isFinite(Date.parse(raw))) throw new ModelRoleConfigError(`model_catalog.${model}.automatic_until 不是有效时间。`);
      automaticUntil = new Date(raw).toISOString();
    }
    catalog[model] = automaticUntil ? { description, automatic_until: automaticUntil } : { description };
  }
  return catalog;
}

const nativeReasoningEfforts = new Set(["low", "medium", "high"]);
function normalizeNativeModels(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelRoleConfigError("native_models 必须是按 canonical 模型键控的对象。");
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    const model = cleanModel(key);
    const runtimeModel = cleanModel(entry?.runtime_model);
    if (!model || !runtimeModel) throw new ModelRoleConfigError(`native_models.${key || "?"} 需要有效 canonical 模型与 runtime_model。`);
    const efforts = uniqueModels(entry?.reasoning_efforts, `native_models.${model}.reasoning_efforts`);
    if (!efforts.length || efforts.some((effort) => !nativeReasoningEfforts.has(effort))) {
      throw new ModelRoleConfigError(`native_models.${model}.reasoning_efforts 只允许已声明的 low/medium/high 值。`);
    }
    result[model] = { runtimeModel, reasoningEfforts: efforts };
  }
  return result;
}

function publicNativeModels(nativeModels = {}) {
  return Object.fromEntries(Object.entries(nativeModels).map(([model, entry]) => [model, {
    runtime_model: entry.runtimeModel,
    reasoning_efforts: entry.reasoningEfforts,
  }]));
}

function publicRole(role) {
  return {
    model: role.model,
    dispatch_channel: role.dispatchChannel,
    model_reasoning_efforts: role.modelReasoningEfforts,
    reasoning_effort: role.reasoningEffort,
    fallback_models: role.fallbackModels,
    capacity_fallback_model: role.capacityFallbackModel || null,
    concurrency_limit: role.concurrencyLimit,
    global_concurrency_limit: role.globalConcurrencyLimit,
    fail_closed: role.failClosed,
    task_class_models: role.taskClassModels,
    task_class_reasoning_efforts: role.taskClassReasoningEfforts,
  };
}

const allowedQuotaPoolSources = new Set(["official-api", "runtime-signal", "unknown"]);
function normalizeQuotaPools(value) {
  if (!Array.isArray(value)) return [];
  const pools = [];
  for (const pool of value) {
    if (!pool || typeof pool !== "object" || typeof pool.id !== "string" || !pool.id.trim()) continue;
    const models = Array.isArray(pool.models) ? [...new Set(pool.models.filter((model) => typeof model === "string" && model.trim()).map((model) => model.trim()))] : [];
    if (!models.length) continue;
    const poolConcurrency = Number(pool.concurrency_limit);
    pools.push({
      id: pool.id.trim(),
      provider: typeof pool.provider === "string" && pool.provider.trim() ? pool.provider.trim() : "unknown",
      models,
      source: allowedQuotaPoolSources.has(pool.source) ? pool.source : "unknown",
      notes: typeof pool.notes === "string" && pool.notes.trim() ? pool.notes.trim() : "",
      ...(Number.isInteger(poolConcurrency) && poolConcurrency >= 1 && poolConcurrency <= 64 ? { concurrency_limit: poolConcurrency } : {}),
    });
  }
  return pools;
}
