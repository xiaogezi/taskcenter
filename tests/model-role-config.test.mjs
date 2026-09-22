import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const directory = await mkdtemp(join(tmpdir(), "taskcenter-model-roles-"));
const configPath = join(directory, "model-roles.json");
process.env.TASKCENTER_MODEL_ROLE_CONFIG_PATH = configPath;

const { loadModelRoleConfig, ModelRoleConfigError, publicModelRoleConfig, isAutomaticEligible } = await import("../scripts/model-role-config.mjs");

test.after(async () => rm(directory, { recursive: true, force: true }));

test("加载执行器与 Reviewer 的单一模型角色配置", async () => {
  await writeFile(configPath, `${JSON.stringify({
    schema_version: "taskcenter-model-roles-v1",
    roles: {
      executor: { model: "model-executor", reasoning_effort: "low", task_class_reasoning_efforts: { security: "medium" }, fallback_models: ["model-fallback"], concurrency_limit: 2 },
      reviewer: { model: "model-reviewer", reasoning_effort: "low", fallback_models: [], concurrency_limit: 1 },
    },
    retired_models: ["model-retired"],
  })}\n`, "utf8");
  const config = loadModelRoleConfig();
  assert.equal(config.roles.executor.model, "model-executor");
  assert.equal(config.roles.reviewer.model, "model-reviewer");
  assert.deepEqual(config.roles.executor.fallbackModels, ["model-fallback"]);
  assert.equal(config.roles.executor.taskClassReasoningEfforts.security, "medium");
  assert.equal(publicModelRoleConfig(config).executor.task_class_reasoning_efforts.security, "medium");
  assert.equal(publicModelRoleConfig(config).reviewer.fail_closed, true);
});

test("Reviewer 配置回退模型时 fail closed", async () => {
  await writeFile(configPath, `${JSON.stringify({
    schema_version: "taskcenter-model-roles-v1",
    roles: {
      executor: { model: "model-executor", reasoning_effort: "medium", fallback_models: [], concurrency_limit: 1 },
      reviewer: { model: "model-reviewer", reasoning_effort: "medium", fallback_models: ["model-other"], concurrency_limit: 1 },
    },
    retired_models: [],
  })}\n`, "utf8");
  assert.throws(() => loadModelRoleConfig(), (error) => error instanceof ModelRoleConfigError && /fail closed/.test(error.message));
});

test("活跃角色不能引用已退役模型", async () => {
  await writeFile(configPath, `${JSON.stringify({
    schema_version: "taskcenter-model-roles-v1",
    roles: {
      executor: { model: "model-executor", reasoning_effort: "medium", fallback_models: [], concurrency_limit: 1 },
      reviewer: { model: "model-reviewer", reasoning_effort: "medium", fallback_models: [], concurrency_limit: 1 },
    },
    retired_models: ["model-executor"],
  })}\n`, "utf8");
  assert.throws(() => loadModelRoleConfig(), (error) => error instanceof ModelRoleConfigError && /已退役模型/.test(error.message));
});

test("manual_only 模型不能进入自动角色池或同时退役", async () => {
  const base = {
    schema_version: "taskcenter-model-roles-v1",
    roles: {
      executor: { model: "model-executor", reasoning_effort: "medium", fallback_models: [], concurrency_limit: 1 },
      reviewer: { model: "model-reviewer", reasoning_effort: "medium", fallback_models: [], concurrency_limit: 1 },
    },
    manual_only_models: ["model-manual"],
    retired_models: [],
  };
  await writeFile(configPath, `${JSON.stringify(base)}\n`, "utf8");
  assert.deepEqual(loadModelRoleConfig().manualOnlyModels, ["model-manual"]);
  assert.deepEqual(publicModelRoleConfig().manual_only_models, ["model-manual"]);
  await writeFile(configPath, `${JSON.stringify({ ...base, retired_models: ["model-manual"] })}\n`, "utf8");
  assert.throws(() => loadModelRoleConfig(), (error) => error instanceof ModelRoleConfigError && /同时标记为已退役/.test(error.message));
  await writeFile(configPath, `${JSON.stringify({ ...base, manual_only_models: ["model-executor"] })}\n`, "utf8");
  assert.throws(() => loadModelRoleConfig(), (error) => error instanceof ModelRoleConfigError && /不能进入自动角色池/.test(error.message));
});

test("task_class_models 只允许 executor 的非 Reviewer 类别", async () => {
  await writeFile(configPath, `${JSON.stringify({
    schema_version: "taskcenter-model-roles-v1",
    roles: {
      executor: { model: "model-executor", reasoning_effort: "medium", fallback_models: ["model-fallback"], task_class_models: { ocr_review: "model-fallback" }, concurrency_limit: 1 },
      reviewer: { model: "model-reviewer", reasoning_effort: "medium", fallback_models: [], concurrency_limit: 1 },
    },
    retired_models: [],
  })}\n`, "utf8");
  assert.throws(() => loadModelRoleConfig(), (error) => error instanceof ModelRoleConfigError && /不支持 Reviewer\/OCR/.test(error.message));

  await writeFile(configPath, `${JSON.stringify({
    schema_version: "taskcenter-model-roles-v1",
    roles: {
      executor: { model: "model-executor", reasoning_effort: "medium", fallback_models: [], concurrency_limit: 1 },
      reviewer: { model: "model-reviewer", reasoning_effort: "medium", fallback_models: [], task_class_models: { security: "model-reviewer" }, concurrency_limit: 1 },
    },
    retired_models: [],
  })}\n`, "utf8");
  assert.throws(() => loadModelRoleConfig(), (error) => error instanceof ModelRoleConfigError && /不支持 Reviewer\/OCR/.test(error.message));
});

test("model_catalog 归一化描述与 automatic_until，并在公共配置暴露", async () => {
  await writeFile(configPath, `${JSON.stringify({
    schema_version: "taskcenter-model-roles-v1",
    roles: {
      executor: { model: "model-executor", reasoning_effort: "low", fallback_models: ["model-old"], concurrency_limit: 2, global_concurrency_limit: 4 },
      reviewer: { model: "model-reviewer", reasoning_effort: "low", fallback_models: [], concurrency_limit: 1 },
    },
    retired_models: [],
    model_catalog: {
      "model-executor": { description: "默认执行模型；编码能力强，成本中高" },
      "model-old": { description: "旧代模型；即将退役", automatic_until: "2026-10-21T10:00:00+08:00" },
    },
  })}\n`, "utf8");
  const config = loadModelRoleConfig();
  assert.equal(config.modelCatalog["model-executor"].description, "默认执行模型；编码能力强，成本中高");
  assert.equal(config.modelCatalog["model-old"].automatic_until, "2026-10-21T02:00:00.000Z", "时区归一化为 UTC ISO");
  assert.equal(config.roles.executor.globalConcurrencyLimit, 4);
  const publicConfig = publicModelRoleConfig(config);
  assert.deepEqual(publicConfig.model_catalog, config.modelCatalog);
  assert.equal(publicConfig.executor.global_concurrency_limit, 4);
});

test("缺少 model_catalog 与新并发字段的旧配置保持兼容", async () => {
  await writeFile(configPath, `${JSON.stringify({
    schema_version: "taskcenter-model-roles-v1",
    roles: {
      executor: { model: "model-executor", reasoning_effort: "low", fallback_models: [], concurrency_limit: 2 },
      reviewer: { model: "model-reviewer", reasoning_effort: "low", fallback_models: [], concurrency_limit: 1 },
    },
    retired_models: [],
  })}\n`, "utf8");
  const config = loadModelRoleConfig();
  assert.deepEqual(config.modelCatalog, {});
  assert.equal(config.roles.executor.globalConcurrencyLimit, null);
  const publicConfig = publicModelRoleConfig(config);
  assert.deepEqual(publicConfig.model_catalog, {});
  assert.equal(publicConfig.executor.global_concurrency_limit, null);
});

test("model_catalog 需要有效描述、时间与并发上限", async () => {
  const base = {
    schema_version: "taskcenter-model-roles-v1",
    roles: {
      executor: { model: "model-executor", reasoning_effort: "low", fallback_models: [], concurrency_limit: 2 },
      reviewer: { model: "model-reviewer", reasoning_effort: "low", fallback_models: [], concurrency_limit: 1 },
    },
    retired_models: [],
  };
  await writeFile(configPath, `${JSON.stringify({ ...base, model_catalog: { "model-executor": { description: "" } } })}\n`, "utf8");
  assert.throws(() => loadModelRoleConfig(), (error) => error instanceof ModelRoleConfigError && /描述/.test(error.message));
  await writeFile(configPath, `${JSON.stringify({ ...base, model_catalog: { "model-executor": { description: "x", automatic_until: "not-a-date" } } })}\n`, "utf8");
  assert.throws(() => loadModelRoleConfig(), (error) => error instanceof ModelRoleConfigError && /automatic_until/.test(error.message));
  await writeFile(configPath, `${JSON.stringify({ ...base, roles: { ...base.roles, executor: { ...base.roles.executor, global_concurrency_limit: 0 } } })}\n`, "utf8");
  assert.throws(() => loadModelRoleConfig(), (error) => error instanceof ModelRoleConfigError && /global_concurrency_limit/.test(error.message));
});

test("isAutomaticEligible 在 automatic_until 边界停止自动资格", async () => {
  await writeFile(configPath, `${JSON.stringify({
    schema_version: "taskcenter-model-roles-v1",
    roles: {
      executor: { model: "model-executor", reasoning_effort: "low", fallback_models: ["model-old"], concurrency_limit: 2 },
      reviewer: { model: "model-reviewer", reasoning_effort: "low", fallback_models: [], concurrency_limit: 1 },
    },
    manual_only_models: ["model-manual"],
    retired_models: ["model-retired"],
    model_catalog: {
      "model-old": { description: "旧代模型", automatic_until: "2026-10-21T10:00:00+08:00" },
    },
  })}\n`, "utf8");
  const config = loadModelRoleConfig();
  assert.equal(isAutomaticEligible(config, "model-executor", "2026-10-21T02:00:01.000Z"), true, "未配置截止时间的模型始终自动合格");
  assert.equal(isAutomaticEligible(config, "model-old", "2026-10-21T01:59:59.000Z"), true);
  assert.equal(isAutomaticEligible(config, "model-old", "2026-10-21T02:00:00.000Z"), false, "到达截止时间即停止自动资格");
  assert.equal(isAutomaticEligible(config, "model-retired", "2026-01-01T00:00:00.000Z"), false);
  assert.equal(isAutomaticEligible(config, "model-manual", "2026-01-01T00:00:00.000Z"), false);
});
