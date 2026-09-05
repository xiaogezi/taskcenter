import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
export const modelRoleConfigPath = resolve(
  process.env.TASKCENTER_MODEL_ROLE_CONFIG_PATH
    || resolve(projectRoot, "config", "model-roles.json"),
);

const allowedReasoningEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

export class ModelRoleConfigError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 500;
  }
}

export function loadModelRoleConfig() {
  if (!existsSync(modelRoleConfigPath)) {
    throw new ModelRoleConfigError(`模型角色配置不存在: ${modelRoleConfigPath}`);
  }
  let input;
  try {
    input = JSON.parse(readFileSync(modelRoleConfigPath, "utf8"));
  } catch {
    throw new ModelRoleConfigError(`模型角色配置不是有效 JSON: ${modelRoleConfigPath}`);
  }
  if (input?.schema_version !== "taskcenter-model-roles-v1") {
    throw new ModelRoleConfigError("模型角色配置 schema_version 无效。");
  }
  const executor = normalizeRole(input.roles?.executor, "executor", false);
  const reviewer = normalizeRole(input.roles?.reviewer, "reviewer", true);
  const retiredModels = uniqueModels(input.retired_models, "retired_models");
  const activeModels = new Set([
    executor.model,
    reviewer.model,
    ...executor.fallbackModels,
    ...reviewer.fallbackModels,
  ]);
  const conflict = retiredModels.find((model) => activeModels.has(model));
  if (conflict) throw new ModelRoleConfigError(`已退役模型不能同时用于活跃角色: ${conflict}`);
  return {
    schemaVersion: input.schema_version,
    roles: { executor, reviewer },
    retiredModels,
  };
}

export function publicModelRoleConfig(config = loadModelRoleConfig()) {
  return {
    schema_version: config.schemaVersion,
    executor: publicRole(config.roles.executor),
    reviewer: publicRole(config.roles.reviewer),
  };
}

function normalizeRole(value, name, failClosed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ModelRoleConfigError(`模型角色配置缺少 roles.${name}。`);
  }
  const model = cleanModel(value.model);
  const reasoningEffort = String(value.reasoning_effort || "").trim();
  const concurrencyLimit = Number(value.concurrency_limit);
  if (!model) throw new ModelRoleConfigError(`roles.${name}.model 无效。`);
  if (!allowedReasoningEfforts.has(reasoningEffort)) {
    throw new ModelRoleConfigError(`roles.${name}.reasoning_effort 无效。`);
  }
  if (!Number.isInteger(concurrencyLimit) || concurrencyLimit < 1 || concurrencyLimit > 64) {
    throw new ModelRoleConfigError(`roles.${name}.concurrency_limit 必须在 1 到 64 之间。`);
  }
  const fallbackModels = uniqueModels(value.fallback_models, `roles.${name}.fallback_models`)
    .filter((candidate) => candidate !== model);
  if (failClosed && fallbackModels.length > 0) {
    throw new ModelRoleConfigError("Reviewer 必须 fail closed，不能配置 fallback_models。");
  }
  return { model, reasoningEffort, fallbackModels, concurrencyLimit, failClosed };
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

function publicRole(role) {
  return {
    model: role.model,
    reasoning_effort: role.reasoningEffort,
    fallback_models: role.fallbackModels,
    concurrency_limit: role.concurrencyLimit,
    fail_closed: role.failClosed,
  };
}
