import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const directory = await mkdtemp(join(tmpdir(), "taskcenter-native-"));
const statePath = join(directory, "routing-control.json");
const roleConfigPath = join(directory, "model-roles.json");
const delegationsPath = join(directory, "delegations.json");
process.env.TASKCENTER_ROUTING_CONTROL_PATH = statePath;
process.env.TASKCENTER_MODEL_ROLE_CONFIG_PATH = roleConfigPath;
process.env.TASKCENTER_DELEGATIONS_PATH = delegationsPath;
process.env.TASKCENTER_ROUTING_FAILURE_THRESHOLD = "2";
process.env.TASKCENTER_ROUTING_COOLDOWN_MS = "1000";

const flash = "mimo-v2.6-flash";
const pro = "mimo-v2.6-pro";
const flashRuntime = "xiaomi-tokenplan/mimo-v2.6-flash";
const proRuntime = "xiaomi-tokenplan/mimo-v2.6-pro";

const roleConfig = {
  schema_version: "taskcenter-model-roles-v1",
  cli_profiles: { "claude-mimo": { harness: "claude", model: flash, provider: "xiaomi", reasoning_effort: "low" } },
  roles: {
    executor: {
      model: flash, reasoning_effort: "low", fallback_models: [pro], concurrency_limit: 1,
      task_class_models: { security: pro }, task_class_reasoning_efforts: { security: "medium" },
    },
    reviewer: { model: "gpt-6-luna", reasoning_effort: "low", fallback_models: [], concurrency_limit: 1 },
  },
  native_models: {
    [flash]: { runtime_model: flashRuntime, reasoning_efforts: ["low", "medium"] },
    [pro]: { runtime_model: proRuntime, reasoning_efforts: ["low", "medium"] },
  },
  retired_models: ["gpt-5.6-terra"],
  quota_pools: [{ id: "codex", provider: "codex", models: ["gpt-6-luna", "gpt-6-astra"] }],
};
await writeFile(roleConfigPath, `${JSON.stringify(roleConfig)}\n`, "utf8");

const { loadModelRoleConfig, nativeRuntimeModel, publicModelRoleConfig } = await import("../scripts/model-role-config.mjs");
const { routingResult, routingSelect, activeExecutionRoute } = await import("../scripts/routing-control.mjs");
const { grantDelegation, claimDelegation, revokeDelegation } = await import("../scripts/delegation-store.mjs");
const { boundedResponse } = await import("../scripts/bounded-response.mjs");

const baseInput = { task_id: "task-native", orchestrator_model: "gpt-current-main", task_class: "implementation" };

test.beforeEach(async () => {
  await rm(statePath, { force: true });
  await rm(delegationsPath, { force: true });
  await writeFile(roleConfigPath, `${JSON.stringify(roleConfig)}\n`, "utf8");
});
test.after(async () => rm(directory, { recursive: true, force: true }));

test("native_models 配置校验：最高 high，退役或 manual_only 模型不得映射", async () => {
  await writeFile(roleConfigPath, `${JSON.stringify({ ...roleConfig, native_models: { [flash]: { runtime_model: flashRuntime, reasoning_efforts: ["ultra"] } } })}\n`, "utf8");
  assert.throws(() => loadModelRoleConfig(), /low\/medium/);
  await writeFile(roleConfigPath, `${JSON.stringify({ ...roleConfig, native_models: { "gpt-5.6-terra": { runtime_model: "x/y", reasoning_efforts: ["low"] } } })}\n`, "utf8");
  assert.throws(() => loadModelRoleConfig(), /退役或手动模型不能配置 native 映射/);
  await writeFile(roleConfigPath, `${JSON.stringify({ ...roleConfig, native_models: { [flash]: { runtime_model: "", reasoning_efforts: ["low"] } } })}\n`, "utf8");
  assert.throws(() => loadModelRoleConfig(), /runtime_model/);
});

test("public config 同步 native_models，能力判定不推断未声明模型", () => {
  const config = loadModelRoleConfig();
  assert.deepEqual(publicModelRoleConfig(config).native_models[flash], { runtime_model: flashRuntime, reasoning_efforts: ["low", "medium"] });
  assert.equal(nativeRuntimeModel(config, flash, [flashRuntime], "low"), flashRuntime);
  assert.equal(nativeRuntimeModel(config, flash, [proRuntime], "low"), "", "能力列表缺失时不可 spawn");
  assert.equal(nativeRuntimeModel(config, "kimi-code/k3-256k", [flashRuntime], "low"), "", "无映射模型不推断");
});

test("普通路径在能力交集内优先原生候选，按 canonical 记账并释放租约", () => {
  const selected = routingSelect({ ...baseInput, channel: "other", available_native_models: [flashRuntime], event_id: "native-auto" }, "2026-09-28T08:00:00.000Z");
  assert.equal(selected.route.channel, "native");
  assert.equal(selected.route.selected_model, flash, "selected_model 保持 canonical");
  assert.equal(selected.route.native_model, flashRuntime);
  assert.equal(selected.route.reasoning_effort, "low");
  assert.equal(selected.route.cli_profile, undefined, "原生路由不是假原生 CLI 转换");
  assert.equal(selected.route.requires_new_session, true);
  assert.equal(selected.health.find((item) => item.model === flash).active_executors, 1, "健康与并发按 canonical 记账");

  const released = routingResult({ route_id: selected.route.route_id, outcome: "succeeded", event_id: "native-auto-result" }, "2026-09-28T08:01:00.000Z");
  assert.equal(released.route.status, "succeeded");
  assert.equal(released.route.channel, "native");
  assert.equal(released.health.find((item) => item.model === flash).active_executors, 0, "原生成功释放 canonical 租约");
});

test("普通路径能力缺失维持可解释 CLI 兼容，显式 cli 保持 CLI", () => {
  const auto = routingSelect({ ...baseInput, channel: "other", available_native_models: [], event_id: "native-auto-miss" });
  assert.equal(auto.route.channel, "cli");
  assert.equal(auto.route.cli_profile, "claude-mimo");
  assert.equal(auto.route.native_model, null);
  routingResult({ route_id: auto.route.route_id, outcome: "cancelled", event_id: "native-auto-miss-release" });

  const explicitCli = routingSelect({ ...baseInput, channel: "cli", available_native_models: [flashRuntime], event_id: "native-explicit-cli" });
  assert.equal(explicitCli.route.channel, "cli", "显式 cli 不被升级为原生");
  assert.equal(explicitCli.route.cli_profile, "claude-mimo");
});

test("显式 native 能力缺失回退当前主模型且不消费执行器容量", () => {
  const missing = routingSelect({ ...baseInput, channel: "native", preferred_model: flash, available_native_models: [proRuntime], event_id: "native-missing" });
  assert.equal(missing.route.available, true);
  assert.equal(missing.route.channel, "direct");
  assert.equal(missing.route.fallback_reason, `native_model_not_available:${flashRuntime}`);
  assert.match(missing.route.next_action, /当前主模型/);
  assert.equal(missing.health.find((item) => item.model === flash)?.active_executors ?? 0, 0, "不可用不发放租约");

  const unconfigured = routingSelect({ ...baseInput, channel: "native", preferred_model: "kimi-code/k3-256k", available_native_models: [flashRuntime], event_id: "native-unconfigured" });
  assert.equal(unconfigured.route.available, true);
  assert.match(unconfigured.route.fallback_reason, /^native_model_not_configured:/);
});

test("MCP 大响应裁剪保留启动原生执行所需的完整路由字段", () => {
  const selected = routingSelect({ ...baseInput, channel: "other", available_native_models: [flashRuntime] });
  const bounded = boundedResponse({ ...selected, extra: "x".repeat(5000) });
  assert.equal(bounded.truncated, true);
  for (const field of ["route_id", "native_model", "selected_model", "channel", "reasoning_effort"]) {
    assert.equal(bounded.route[field], selected.route[field]);
  }
});

test("CLI-only 默认模型不会遮蔽原生候选，Jev 推荐和显式模型保留边界", async () => {
  const config = structuredClone(roleConfig);
  config.roles.executor.model = "cli-only";
  config.roles.executor.fallback_models = [flash, pro];
  await writeFile(roleConfigPath, JSON.stringify(config));
  const selected = routingSelect({ ...baseInput, channel: "other", available_native_models: [flashRuntime, proRuntime] });
  assert.equal(selected.route.channel, "native");
  assert.equal(selected.route.selected_model, flash);
  assert.equal(selected.route.fallback_from, "cli-only");
  assert.equal(selected.route.reason, "native_capability_preferred");
  const second = routingSelect({ ...baseInput, channel: "cli", preferred_model: "cli-only", available_native_models: [flashRuntime, proRuntime] }, undefined, { requested_channel: "other", model_applied: true });
  assert.equal(second.route.channel, "native");
  assert.equal(second.route.selected_model, pro, "原生候选容量已满时选择下一可用原生候选");
  routingResult({ route_id: selected.route.route_id, outcome: "cancelled" });
  routingResult({ route_id: second.route.route_id, outcome: "failed", error_type: "task_permission" });
  const pinned = routingSelect({ ...baseInput, channel: "native", preferred_model: "cli-only", available_native_models: [flashRuntime] });
  assert.equal(pinned.route.selected_model, baseInput.orchestrator_model, "显式模型不可用时由主模型兜底，不换其他执行器");
  const protectedClass = routingSelect({ ...baseInput, channel: "other", task_class: "security", available_native_models: [flashRuntime] });
  assert.equal(protectedClass.route.selected_model, pro, "高风险类别仍遵守配置模型");
});

test("native 能力声明严格校验且参与幂等签名", () => {
  for (const value of [[123], [""], new Array(33).fill(flashRuntime)]) {
    assert.throws(() => routingSelect({ ...baseInput, channel: "other", available_native_models: value }), /available_native_models/);
  }
  const input = { ...baseInput, channel: "other", event_id: "capability-replay", available_native_models: [flashRuntime, proRuntime] };
  routingSelect(input);
  assert.equal(routingSelect({ ...input, available_native_models: [proRuntime, flashRuntime] }).idempotent, true);
  assert.throws(() => routingSelect({ ...input, available_native_models: [proRuntime] }), /event_id/);
});

test("档位只声明实际请求值：映射内档位可原生，不支持时主模型兜底", async () => {
  const medium = routingSelect({ ...baseInput, channel: "native", task_class: "security", available_native_models: [proRuntime], event_id: "native-medium" });
  assert.equal(medium.route.channel, "native");
  assert.equal(medium.route.selected_model, pro);
  assert.equal(medium.route.reasoning_effort, "medium");
  routingResult({ route_id: medium.route.route_id, outcome: "cancelled", event_id: "native-medium-release" });

  const lowOnly = JSON.parse(JSON.stringify(roleConfig));
  lowOnly.native_models[pro].reasoning_efforts = ["low"];
  await writeFile(roleConfigPath, `${JSON.stringify(lowOnly)}\n`, "utf8");
  const unsupported = routingSelect({ ...baseInput, channel: "native", task_class: "security", available_native_models: [proRuntime], event_id: "native-effort" });
  assert.equal(unsupported.route.available, true);
  assert.equal(unsupported.route.fallback_reason, "native_effort_not_supported:medium")
  assert.equal(unsupported.route.reasoning_effort, "unknown", "不把执行器档位冒充主模型档位");
});

test("首选熔断后回退到有能力候选仍走原生，退休模型不进入原生", () => {
  const state = { version: 3, models: { [flash]: { model: flash, state: "open", consecutiveFailures: 3, openedAt: "2026-09-28T08:00:00.000Z", retryAfterAt: "2026-09-28T09:00:00.000Z", halfOpenLease: "", activeExecutors: 0, concurrencyLimit: 1, failureThreshold: 2, cooldownMs: 1000, lastErrorCode: "x", lastRequestId: "", lastSuccessAt: "", quotaLimitId: "", quotaRetryAfterAt: "", updatedAt: "2026-09-28T08:00:00.000Z" } }, routes: [], directAuthorizations: {}, updatedAt: "" };
  return writeFile(statePath, `${JSON.stringify(state)}\n`, "utf8").then(() => {
    const selected = routingSelect({ ...baseInput, channel: "other", available_native_models: [proRuntime], event_id: "native-fallback" }, "2026-09-28T08:30:00.000Z");
    assert.equal(selected.route.selected_model, pro);
    assert.equal(selected.route.channel, "native");
    assert.equal(selected.route.native_model, proRuntime);
    assert.equal(selected.route.fallback_from, flash);

    const retired = routingSelect({ ...baseInput, channel: "native", preferred_model: "gpt-5.6-terra", available_native_models: [proRuntime], event_id: "native-retired" }, "2026-09-28T08:31:00.000Z");
    assert.notEqual(retired.route.selected_model, "gpt-5.6-terra", "退役偏好归一，不进入原生映射");
  });
});

test("显式 Codex native：canonical id 即 runtime，能力声明后可路由并携带 native_model", () => {
  const selected = routingSelect({ ...baseInput, channel: "native", preferred_model: "gpt-6-luna", available_native_models: ["gpt-6-luna"], event_id: "native-codex" });
  assert.equal(selected.route.available, true);
  assert.equal(selected.route.channel, "native");
  assert.equal(selected.route.selected_model, "gpt-6-luna");
  assert.equal(selected.route.native_model, "gpt-6-luna", "显式 Codex native 必须携带 native_model 供 grant/claim 绑定");
  assert.equal(selected.route.cli_profile, undefined);
  routingResult({ route_id: selected.route.route_id, outcome: "succeeded", event_id: "native-codex-release" });

  const missing = routingSelect({ ...baseInput, channel: "native", preferred_model: "gpt-6-luna", available_native_models: ["gpt-6-astra"], event_id: "native-codex-missing" });
  assert.equal(missing.route.available, true, "能力未声明时回退当前主模型");
  assert.equal(missing.route.channel, "direct");
  assert.equal(missing.route.fallback_reason, "native_model_not_available:gpt-6-luna");
});

test("native grant 绑定 route_id，store 保留绑定且幂等重放", () => {
  const task = { id: "task-native", sessionId: "parent", workspace: "/work", status: "in_progress" };
  const input = { parent_session_id: "parent", task_id: task.id, workspace: "/work", scope: ["."], executor_model: flash, channel: "native", route_id: "route-native-1", event_id: "grant-native" };
  const granted = grantDelegation(input, task);
  assert.equal(granted.delegation.routeId, "route-native-1");
  assert.equal(granted.delegation.channel, "native");
  const replay = grantDelegation(input, task);
  assert.equal(replay.idempotent, true);
  assert.throws(() => grantDelegation({ ...input, event_id: "duplicate-route-grant" }, task), /只能绑定一个/);
  assert.throws(() => grantDelegation({ ...input, route_id: "route-other" }, task), /event_id 已被不同 delegation 使用/);

  const session = { status: "registered", sessionId: "child", workspace: "/work" };
  const claimed = claimDelegation({ delegation_id: granted.delegation.id, claim_token: granted.claimToken, session_id: "child", workspace: "/work" }, session);
  assert.equal(claimed.delegation.status, "active");
  const revoked = revokeDelegation({ delegation_id: granted.delegation.id, parent_session_id: "parent" });
  assert.equal(revoked.delegation.status, "revoked");
  assert.throws(() => claimDelegation({ delegation_id: granted.delegation.id, claim_token: "x", session_id: "other-child", workspace: "/work" }, { ...session, sessionId: "other-child" }), /已被其他 Session 领取/);
});


test("能力缺失产生可用于 Hook 的 direct 租约，幂等重放且正确结束", () => {
  const now = "2026-09-28T08:00:00.000Z";
  const request = { ...baseInput, channel: "native", available_native_models: [], event_id: "main-fallback", lease_ttl_ms: 60_000 };
  const selected = routingSelect(request, now);
  assert.equal(selected.route.reason, "main_model_fallback");
  assert.equal(selected.route.selected_model, baseInput.orchestrator_model);
  assert.equal(selected.route.expires_at, "2026-09-28T08:01:00.000Z");
  assert.equal(selected.route.native_model, null);
  assert.equal(activeExecutionRoute(baseInput.task_id, now).direct, true);
  assert.equal(selected.auditEvents[0].dispatch_channel, "direct");
  assert.equal(selected.auditEvents[0].fallback_reason, `native_model_not_available:${flashRuntime}`);
  const replay = routingSelect(request, now);
  assert.equal(replay.route.route_id, selected.route.route_id);
  assert.equal(replay.idempotent, true);
  assert.equal(selected.health.every(model => model.active_executors === 0), true);
  routingResult({ route_id: selected.route.route_id, outcome: "succeeded" }, "2026-09-28T08:00:30.000Z");
  assert.equal(activeExecutionRoute(baseInput.task_id, "2026-09-28T08:00:31.000Z").direct, false);
});

test("执行器失败回执保留原始失败和主模型接管提示，大响应裁剪也不丢失", () => {
  for (const outcome of ["failed", "unavailable", "overloaded"]) {
    const selected = routingSelect({ ...baseInput, channel: "native", available_native_models: [flashRuntime] });
    const failed = routingResult({ route_id: selected.route.route_id, outcome, error_type: "task_permission", error_code: "SPAWN_FAILED", request_id: "request-failed" });
    assert.equal(failed.route.result.outcome, outcome);
    assert.equal(failed.route.result.error_code, "SPAWN_FAILED");
    assert.match(failed.route.next_action, /channel=direct/);
    assert.match(failed.route.next_action, /停止.*撤销/);
    assert.equal(failed.health.find(model => model.model === flash).active_executors, 0);
    const bounded = boundedResponse({ ...failed, extra: "x".repeat(5000) });
    assert.equal(bounded.route.next_action, failed.route.next_action);
    assert.equal(bounded.route.result.request_id, "request-failed");
  }
});
