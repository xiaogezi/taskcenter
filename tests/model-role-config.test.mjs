import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const directory = await mkdtemp(join(tmpdir(), "taskcenter-model-roles-"));
const configPath = join(directory, "model-roles.json");
process.env.TASKCENTER_MODEL_ROLE_CONFIG_PATH = configPath;

const { loadModelRoleConfig, ModelRoleConfigError, publicModelRoleConfig } = await import("../scripts/model-role-config.mjs");

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
