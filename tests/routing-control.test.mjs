import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const directory = await mkdtemp(join(tmpdir(), "taskcenter-routing-"));
const statePath = join(directory, "routing-control.json");
const roleConfigPath = join(directory, "model-roles.json");
process.env.TASKCENTER_ROUTING_CONTROL_PATH = statePath;
process.env.TASKCENTER_MODEL_ROLE_CONFIG_PATH = roleConfigPath;
process.env.TASKCENTER_ROUTING_FAILURE_THRESHOLD = "2";
process.env.TASKCENTER_ROUTING_COOLDOWN_MS = "1000";
process.env.TASKCENTER_ROUTING_CONCURRENCY_GPT_5_6_LUNA = "1";
process.env.TASKCENTER_ROUTING_CONCURRENCY_GPT_5_6_TERRA = "2";

const roleConfig = {
  schema_version: "taskcenter-model-roles-v1",
  cli_profiles: { optional: { harness: "claude", model: "optional-model", provider: "test", reasoning_effort: "low" } },
  roles: {
    executor: { model: "gpt-5.6-luna", reasoning_effort: "medium", fallback_models: ["gpt-5.6-terra"], task_class_models: { architecture: "gpt-5.6-terra", security: "gpt-5.6-terra", migration: "gpt-5.6-terra", data_migration: "gpt-5.6-terra", complex_diagnosis: "gpt-5.6-terra", high_risk: "gpt-5.6-terra" }, concurrency_limit: 1 },
    reviewer: { model: "gpt-5.6-luna", reasoning_effort: "medium", fallback_models: [], concurrency_limit: 1 },
  },
  manual_only_models: ["gpt-5.3-codex-spark"],
  retired_models: [],
};
await writeFile(roleConfigPath, `${JSON.stringify(roleConfig)}\n`, "utf8");

const {
  RoutingControlError,
  routingHealth,
  routingResult,
  routingSelect,
  sanitizeJevDecision,
} = await import("../scripts/routing-control.mjs");

const spark = "gpt-5.3-codex-spark";
const luna = "gpt-5.6-luna";
const terra = "gpt-5.6-terra";
const baseInput = { task_id: "task-routing", orchestrator_model: "gpt-current-main", task_class: "implementation", channel: "cli" };
const reviewArtifacts = {
  subject: { fingerprint: "sha256:subject" },
  bundle: { ref: "bundle://ocr/review-1", fingerprint: "sha256:bundle" },
  rules: { fingerprint: "sha256:rules" },
};

test.after(async () => rm(directory, { recursive: true, force: true }));


test("可选 CLI profile 显式路由并记录客户端与档位，不改变默认角色", () => {
  const selected = routingSelect({ ...baseInput, cli_profile: "optional" });
  assert.equal(selected.route.selected_model, "optional-model");
  assert.equal(selected.route.harness, "claude");
  assert.equal(selected.route.reasoning_effort, "low");
  assert.equal(selected.roles.executor.model, luna);
  assert.equal(selected.roles.reviewer.model, luna);
  assert.throws(() => routingSelect({ ...baseInput, cli_profile: "optional", task_class: "ocr" }), /Reviewer/);
  assert.throws(() => routingSelect({ ...baseInput, cli_profile: "optional", channel: "native" }), /CLI/);
});
test.beforeEach(async () => rm(statePath, { force: true }));

test("routing_select 原子发放租约、幂等重放并在并发满时回退", () => {
  const first = routingSelect({ ...baseInput, event_id: "select-1" }, "2026-08-18T08:00:00.000Z");
  assert.equal(first.route.selected_model, luna);
  assert.equal(first.route.orchestrator_model, "gpt-current-main");
  assert.equal(first.roles.executor.model, luna);
  assert.equal(first.route.available, true);
  assert.equal(first.route.requires_new_session, true);
  assert.equal(first.health.find((item) => item.model === luna).active_executors, 1);

  const replay = routingSelect({ ...baseInput, event_id: "select-1" }, "2026-08-18T08:00:01.000Z");
  assert.equal(replay.idempotent, true);
  assert.equal(replay.route.route_id, first.route.route_id);
  assert.deepEqual(replay.auditEvents, first.auditEvents);

  const second = routingSelect({ ...baseInput, event_id: "select-2" }, "2026-08-18T08:00:02.000Z");
  assert.equal(second.route.selected_model, terra);
  assert.match(second.route.reason, /concurrency_limit/);
});

test("连续容量失败触发 Open，冷却后只发一个 Half-Open 探测租约", () => {
  const first = routingSelect({ ...baseInput, event_id: "failure-select-1" }, "2026-08-18T08:00:00.000Z");
  routingResult({ route_id: first.route.route_id, event_id: "failure-result-1", outcome: "failed", http_status: 504, error_type: "timeout", error_code: "upstream_timeout", request_id: "req-1" }, "2026-08-18T08:00:01.000Z");
  const second = routingSelect({ ...baseInput, event_id: "failure-select-2" }, "2026-08-18T08:00:02.000Z");
  const opened = routingResult({ route_id: second.route.route_id, event_id: "failure-result-2", outcome: "failed", http_status: 504, error_type: "timeout", error_code: "upstream_timeout", request_id: "req-2" }, "2026-08-18T08:00:03.000Z");
  const lunaOpen = opened.health.find((item) => item.model === luna);
  assert.equal(lunaOpen.state, "open");
  assert.equal(lunaOpen.retry_after_at, "2026-08-18T08:00:04.000Z");

  const whileOpen = routingSelect({ ...baseInput, event_id: "open-select" }, "2026-08-18T08:00:03.500Z");
  assert.equal(whileOpen.route.selected_model, terra);
  assert.match(whileOpen.route.reason, /circuit_open/);

  const probe = routingSelect({ ...baseInput, event_id: "probe-select" }, "2026-08-18T08:00:04.100Z");
  assert.equal(probe.route.selected_model, luna);
  assert.equal(probe.route.circuit_state, "half_open");
  assert.equal(probe.route.probe, true);
  const parallel = routingSelect({ ...baseInput, event_id: "parallel-select" }, "2026-08-18T08:00:04.200Z");
  assert.equal(parallel.route.selected_model, terra);
  assert.match(parallel.route.reason, /half_open_probe_leased/);

  const closed = routingResult({ route_id: probe.route.route_id, event_id: "probe-success", outcome: "succeeded", request_id: "req-probe" }, "2026-08-18T08:00:05.000Z");
  assert.equal(closed.health.find((item) => item.model === luna).state, "closed");
  assert.equal(closed.health.find((item) => item.model === luna).consecutive_failures, 0);
});

test("明确容量错误立即 Open，避免在同一模型重复重试", () => {
  const selected = routingSelect({ ...baseInput, event_id: "capacity-select" }, "2026-08-18T08:00:00.000Z");
  const failed = routingResult({ route_id: selected.route.route_id, event_id: "capacity-result", outcome: "overloaded", error_type: "server_overloaded", error_code: "selected_model_at_capacity", request_id: "req-capacity" }, "2026-08-18T08:00:01.000Z");
  assert.equal(failed.health.find((item) => item.model === luna).state, "open");
  const fallback = routingSelect({ ...baseInput, event_id: "capacity-fallback" }, "2026-08-18T08:00:01.500Z");
  assert.equal(fallback.route.selected_model, terra);
  const halfOpen = routingHealth("2026-08-18T08:00:02.100Z").find((item) => item.model === luna);
  assert.equal(halfOpen.state, "half_open");
  assert.equal(halfOpen.half_open_lease, null);
});

test("高风险任务优先回退 Terra", () => {
  routingSelect({ ...baseInput, event_id: "occupy-luna" }, "2026-08-18T08:00:00.000Z");
  const complex = routingSelect({ ...baseInput, task_class: "security", event_id: "complex-select" }, "2026-08-18T08:00:01.000Z");
  assert.equal(complex.route.selected_model, terra);
});

test("策略命中规则和内容 hash 可见，高要求模型容量不足时不降级", () => {
  const first = routingSelect({ ...baseInput, task_class: "security", event_id: "security-select" }, "2026-08-18T08:00:00.000Z");
  assert.equal(first.route.selected_model, terra);
  assert.equal(first.route.matched_rule, "task_class_models.security");
  assert.match(first.route.config_version, /^[a-f0-9]{64}$/);
  routingResult({ route_id: first.route.route_id, outcome: "overloaded", error_type: "server_overloaded" }, "2026-08-18T08:00:01.000Z");
  const unavailable = routingSelect({ ...baseInput, task_class: "security", event_id: "security-capacity" }, "2026-08-18T08:00:01.100Z");
  assert.equal(unavailable.route.available, false);
  assert.equal(unavailable.route.selected_model, null);
});

test("显式模型覆盖优先，未知 task_class 拒绝静默降级", () => {
  const selected = routingSelect({ ...baseInput, task_class: "security", preferred_model: luna, event_id: "security-explicit" }, "2026-08-18T08:00:00.000Z");
  assert.equal(selected.route.selected_model, luna);
  assert.equal(selected.route.matched_rule, "preferred_model");
  assert.throws(() => routingSelect({ ...baseInput, task_class: "securty", event_id: "unknown-class" }), (error) => error instanceof RoutingControlError && error.statusCode === 400);
});

test("旧版持久化签名在升级后仍可幂等重放", async () => {
  const first = routingSelect({ ...baseInput, event_id: "legacy-replay" }, "2026-08-18T08:00:00.000Z");
  const state = JSON.parse(await (await import("node:fs/promises")).readFile(statePath, "utf8"));
  const route = state.routes.find((item) => item.id === first.route.route_id);
  route.configVersion = "taskcenter-model-roles-v1";
  const { createHash } = await import("node:crypto");
  route.selectSignature = createHash("sha256").update(JSON.stringify({ taskId: route.taskId, orchestratorModel: route.orchestratorModel, preferredModel: route.preferredModel, taskClass: route.taskClass, channel: route.channel, configVersion: route.configVersion })).digest("hex");
  await writeFile(statePath, `${JSON.stringify(state)}\n`, "utf8");
  const replay = routingSelect({ ...baseInput, event_id: "legacy-replay" }, "2026-08-18T08:00:01.000Z");
  assert.equal(replay.idempotent, true);
  assert.equal(replay.route.route_id, first.route.route_id);
  assert.throws(() => routingSelect({ ...baseInput, task_id: "changed-task", event_id: "legacy-replay" }), (error) => error instanceof RoutingControlError && error.statusCode === 409);
  assert.throws(() => routingSelect({ ...baseInput, task_class: "security", event_id: "legacy-replay" }), (error) => error instanceof RoutingControlError && error.statusCode === 409);
  assert.throws(() => routingSelect({ ...baseInput, channel: "direct", event_id: "legacy-replay" }), (error) => error instanceof RoutingControlError && error.statusCode === 409);
  assert.throws(() => routingSelect({ ...baseInput, preferred_model: terra, event_id: "legacy-replay" }), (error) => error instanceof RoutingControlError && error.statusCode === 409);
});

test("配置热更新只影响新 event，同一 event_id 重放原选择", async () => {
  const first = routingSelect({ ...baseInput, task_class: "security", event_id: "hot-reload-select" }, "2026-08-18T08:00:00.000Z");
  const updated = { ...roleConfig, roles: { ...roleConfig.roles, executor: { ...roleConfig.roles.executor, task_class_models: { ...roleConfig.roles.executor.task_class_models, security: luna } } } };
  await writeFile(roleConfigPath, `${JSON.stringify(updated)}\n`, "utf8");
  const replay = routingSelect({ ...baseInput, task_class: "security", event_id: "hot-reload-select" }, "2026-08-18T08:00:01.000Z");
  assert.equal(replay.idempotent, true);
  assert.equal(replay.route.selected_model, first.route.selected_model);
  const fresh = routingSelect({ ...baseInput, task_class: "security", event_id: "hot-reload-fresh" }, "2026-08-18T08:00:02.000Z");
  assert.equal(fresh.route.selected_model, luna);
  await writeFile(roleConfigPath, `${JSON.stringify(roleConfig)}\n`, "utf8");
});

test("manual_only 首选不能通过旧单次覆盖进入自动路由", () => {
  const selected = routingSelect({ ...baseInput, preferred_model: spark, event_id: "legacy-spark-select" }, "2026-08-18T08:00:00.000Z");
  assert.equal(selected.route.preferred_model, luna);
  assert.equal(selected.route.selected_model, luna);
  assert.equal(selected.route.reason, "manual_only_preference_requires_task_policy");
  assert.equal(selected.health.some((item) => item.model === spark), false);
});

test("额度优先任务使用 Spark，耗尽时回退且重置后重新探测", () => {
  const policy = { mode: "quota_preferred", preferred_model: spark, quota_limit_id: "codex_bengalfox", fallback_on_exhaustion: true };
  const available = routingSelect({
    ...baseInput,
    event_id: "spark-available",
    execution_model_policy: policy,
    quota_snapshot: { limit_id: "codex_bengalfox", observed_at: "2026-08-18T08:00:00.000Z", primary: { used_percent: 10, window_minutes: 300, resets_at: 1787043900 }, secondary: { used_percent: 20, window_minutes: 10080, resets_at: 1787600000 } },
  }, "2026-08-18T08:00:01.000Z");
  assert.equal(available.route.preferred_model, spark);
  assert.equal(available.route.selected_model, spark);
  assert.equal(available.route.preference_mode, "quota_preferred");
  assert.equal(available.route.quota_limit_id, "codex_bengalfox");
  assert.equal(available.route.quota_used_percent, 10);
  assert.equal(available.route.matched_rule, "task.execution_model_policy.quota_preferred");

  const limited = routingResult({
    route_id: available.route.route_id,
    outcome: "failed",
    http_status: 429,
    error_type: "rate_limit",
    error_code: "spark_quota_exhausted",
    quota_limit_id: "codex_bengalfox",
    quota_retry_after_at: "2026-08-18T08:05:00.000Z",
  }, "2026-08-18T08:00:02.000Z");
  const sparkHealth = limited.health.find((item) => item.model === spark);
  assert.equal(sparkHealth.state, "closed", "额度耗尽不能污染质量熔断");
  assert.equal(sparkHealth.consecutive_failures, 0);
  assert.equal(sparkHealth.quota_retry_after_at, "2026-08-18T08:05:00.000Z");

  const fallback = routingSelect({ ...baseInput, event_id: "spark-cooldown", execution_model_policy: policy }, "2026-08-18T08:01:00.000Z");
  assert.equal(fallback.route.selected_model, luna);
  assert.equal(fallback.route.fallback_reason, "preferred_model_quota_exhausted");
  routingResult({ route_id: fallback.route.route_id, outcome: "succeeded" }, "2026-08-18T08:01:01.000Z");

  const restored = routingSelect({ ...baseInput, event_id: "spark-restored", execution_model_policy: policy }, "2026-08-18T08:05:01.000Z");
  assert.equal(restored.route.selected_model, spark);
  assert.equal(restored.route.probe, true, "重置后额度仍未知时只在新派发边界探测");
});

test("派发前额度快照已耗尽时直接回退到现有执行模型", () => {
  const selected = routingSelect({
    ...baseInput,
    event_id: "spark-preflight-exhausted",
    execution_model_policy: { mode: "quota_preferred", preferred_model: spark, quota_limit_id: "codex_bengalfox", fallback_on_exhaustion: true },
    quota_snapshot: { limit_id: "codex_bengalfox", observed_at: "2026-08-18T08:00:00.000Z", primary: { used_percent: 100, window_minutes: 300, resets_at: 1787043900 } },
  }, "2026-08-18T08:00:01.000Z");

  assert.equal(selected.route.preferred_model, spark);
  assert.equal(selected.route.selected_model, luna);
  assert.equal(selected.route.fallback_reason, "preferred_model_quota_exhausted");
  assert.equal(selected.route.quota_used_percent, 100);
  assert.equal(selected.route.probe, false);
});

test("OCR 选择集中配置的 Reviewer，并保留审查输入证据", () => {
  const ocrInput = { ...baseInput, task_class: "ocr_review", event_id: "ocr-select", review_artifacts: reviewArtifacts };
  const ocr = routingSelect(ocrInput, "2026-08-18T08:00:00.000Z");
  assert.equal(ocr.route.available, true);
  assert.equal(ocr.route.preferred_model, luna);
  assert.equal(ocr.route.selected_model, luna);
  assert.equal(ocr.route.fallback_from, null);
  assert.deepEqual(ocr.route.review_artifacts, {
    subject: { ref: null, fingerprint: "sha256:subject" },
    bundle: { ref: "bundle://ocr/review-1", fingerprint: "sha256:bundle" },
    rules: { ref: null, fingerprint: "sha256:rules" },
  });
  const decision = ocr.auditEvents.find((event) => event.type === "routing.decision");
  assert.equal(decision.preferred_executor_model, luna);
  assert.equal(decision.selected_executor_model, luna);
  assert.equal(decision.orchestrator_model, "gpt-current-main");
  assert.equal(decision.policy_version, "routing-control-v5");
  assert.deepEqual(decision.review_artifacts, ocr.route.review_artifacts);

  const replay = routingSelect(ocrInput, "2026-08-18T08:00:00.100Z");
  assert.equal(replay.idempotent, true);
  assert.throws(
    () => routingSelect({ ...ocrInput, review_artifacts: { ...reviewArtifacts, rules: { fingerprint: "sha256:changed" } } }, "2026-08-18T08:00:00.200Z"),
    (error) => error instanceof RoutingControlError && error.statusCode === 409,
  );
});

test("OCR 缺少冻结输入或配置 Reviewer 不可用时 fail closed", () => {
  assert.throws(
    () => routingSelect({ ...baseInput, task_class: "ocr_review", event_id: "ocr-missing-artifacts" }, "2026-08-18T08:00:00.000Z"),
    (error) => error instanceof RoutingControlError && error.statusCode === 400,
  );

  routingSelect({ ...baseInput, event_id: "occupy-luna" }, "2026-08-18T08:00:01.000Z");
  const unavailable = routingSelect({
    ...baseInput,
    task_class: "ocr_review",
    event_id: "ocr-no-luna",
    review_artifacts: reviewArtifacts,
  }, "2026-08-18T08:00:01.200Z");
  assert.equal(unavailable.route.available, false);
  assert.equal(unavailable.route.selected_model, null);
  assert.equal(unavailable.route.reason, "reviewer_model_unavailable");
  assert.equal(unavailable.route.fallback_from, luna);
});

test("routing_result 幂等且拒绝冲突结果，租约过期会释放并发", () => {
  const selected = routingSelect({ ...baseInput, event_id: "result-select", lease_ttl_ms: 60_000 }, "2026-08-18T08:00:00.000Z");
  const input = { route_id: selected.route.route_id, event_id: "result-id", outcome: "succeeded", request_id: "req-ok" };
  const first = routingResult(input, "2026-08-18T08:00:01.000Z");
  assert.equal(first.idempotent, false);
  const replay = routingResult(input, "2026-08-18T08:00:02.000Z");
  assert.equal(replay.idempotent, true);
  assert.deepEqual(replay.auditEvents, first.auditEvents);
  const selectReplayAfterResult = routingSelect({ ...baseInput, event_id: "result-select", lease_ttl_ms: 60_000 }, "2026-08-18T08:00:02.500Z");
  assert.equal(selectReplayAfterResult.idempotent, true);
  assert.deepEqual(selectReplayAfterResult.auditEvents, selected.auditEvents);
  assert.ok(selectReplayAfterResult.auditEvents.every((event) => event.event_id.endsWith("-leased")));
  assert.throws(
    () => routingResult({ ...input, event_id: "result-conflict", outcome: "failed" }, "2026-08-18T08:00:03.000Z"),
    (error) => error instanceof RoutingControlError && error.statusCode === 409,
  );

  routingSelect({ ...baseInput, event_id: "expiring-select", lease_ttl_ms: 60_000 }, "2026-08-18T09:00:00.000Z");
  const health = routingHealth("2026-08-18T09:01:01.000Z");
  assert.equal(health.find((item) => item.model === luna).active_executors, 0);
});

test("损坏的派生状态 fail closed，不会被覆盖", async () => {
  await writeFile(statePath, "{broken", "utf8");
  assert.throws(
    () => routingHealth("2026-08-18T08:00:00.000Z"),
    (error) => error instanceof RoutingControlError && error.statusCode === 500,
  );
});

test("v1 容量失败状态迁移为 Open，升级后不会继续撞同一模型", async () => {
  await writeFile(statePath, `${JSON.stringify({
    version: 1,
    models: {
      [luna]: { model: luna, state: "closed", consecutiveFailures: 1, openedAt: "", retryAfterAt: "", halfOpenLease: "", activeExecutors: 0, concurrencyLimit: 1, failureThreshold: 3, cooldownMs: 300_000, lastErrorCode: "selected_model_at_capacity", lastRequestId: "req-legacy", lastSuccessAt: "", updatedAt: "2026-08-18T08:00:01.000Z" },
    },
    routes: [{ id: "route_legacy", selectedModel: luna, status: "overloaded", createdAt: "2026-08-18T08:00:00.000Z", completedAt: "2026-08-18T08:00:01.000Z", result: { outcome: "overloaded", errorType: "server_overloaded", errorCode: "selected_model_at_capacity", requestId: "req-legacy" } }],
  })}\n`, "utf8");
  const health = routingHealth("2026-08-18T08:00:02.000Z");
  assert.equal(health.find((item) => item.model === luna).state, "open");
});

test("manual_only Spark 健康状态可观察，退役后隐藏", async () => {
  await writeFile(statePath, `${JSON.stringify({
    version: 3,
    models: {
      [spark]: { model: spark, state: "closed", consecutiveFailures: 0, openedAt: "", retryAfterAt: "", halfOpenLease: "", activeExecutors: 0, concurrencyLimit: 2, failureThreshold: 3, cooldownMs: 300_000, lastErrorCode: "", lastRequestId: "", lastSuccessAt: "2026-08-18T08:00:00.000Z", updatedAt: "2026-08-18T08:00:00.000Z" },
    },
    routes: [],
  })}\n`, "utf8");
  assert.equal(routingHealth("2026-08-18T08:00:01.000Z").some((item) => item.model === spark), true);
  await writeFile(roleConfigPath, `${JSON.stringify({ ...roleConfig, manual_only_models: [], retired_models: [spark] })}\n`, "utf8");
  assert.equal(routingHealth("2026-08-18T08:00:02.000Z").some((item) => item.model === spark), false);
  await writeFile(roleConfigPath, `${JSON.stringify(roleConfig)}\n`, "utf8");
});

test("当前项目策略先派发非 Codex 客户端，总容量满后才使用 Luna", async () => {
  const current = await readFile(new URL("../config/model-roles.json", import.meta.url), "utf8");
  await writeFile(roleConfigPath, current);
  const kimi = "kimi-code/k3-256k";
  const mimo = "mimo-v2.6-flash";
  const mimoPro = "mimo-v2.6-pro";
  try {
    await rm(statePath, { force: true });
    const general = routingSelect({ ...baseInput, event_id: "policy-general" });
    assert.equal(general.route.selected_model, kimi);
    assert.equal(general.route.harness, "kimi");
    assert.equal(general.route.cli_profile, "kimi-k3");
    assert.equal(general.route.reasoning_effort, "low");
    assert.equal(Object.keys(general.roles.model_catalog).length, 8, "自动候选覆盖 4 Kimi + 4 MiMo 目录条目");
    assert.ok(general.roles.model_catalog["mimo-v2.5-pro"].automatic_until, "MiMo 2.5 保留自动截止");
    assert.equal(general.roles.executor.global_concurrency_limit, 4);
    assert.deepEqual(general.roles.executor.fallback_models, [
      "mimo-v2.6-flash", "mimo-v2.6-pro", "kimi-code/k3", "kimi-code/kimi-for-coding",
      "kimi-code/kimi-for-coding-highspeed", "mimo-v2.5", "mimo-v2.5-pro",
    ], "自动候选覆盖 4 Kimi + 4 MiMo，无 Codex 与未验证 UltraSpeed");

    const second = routingSelect({ ...baseInput, event_id: "policy-second" });
    assert.equal(second.route.selected_model, kimi, "第二个独立执行复用 K3 的第二个容量名额");
    assert.equal(second.route.harness, "kimi");
    assert.equal(second.route.cli_profile, "kimi-k3");

    const third = routingSelect({ ...baseInput, event_id: "policy-third" });
    assert.equal(third.route.selected_model, mimo, "K3 两个名额占满后回退 MiMo 2.6 Flash，而不是 Luna");
    assert.equal(third.route.harness, "claude");
    assert.equal(third.route.cli_profile, "claude-mimo-v2.6-flash");

    const fourth = routingSelect({ ...baseInput, event_id: "policy-fourth" });
    assert.equal(fourth.route.selected_model, mimo, "Mimo 也使用 executor 角色的第二个容量名额");
    assert.equal(fourth.route.harness, "claude");
    assert.equal(fourth.route.cli_profile, "claude-mimo-v2.6-flash");

    const fifth = routingSelect({ ...baseInput, cli_profile: "kimi-k3", event_id: "policy-fifth" });
    assert.equal(fifth.route.selected_model, "gpt-6-luna", "普通 CLI 总并发满时才使用 Luna 末级兜底");
    assert.equal(fifth.route.cli_profile, "codex-luna");
    assert.equal(fifth.route.channel, "cli");
    assert.equal(fifth.route.fallback_reason, "ordinary_executor_capacity_exhausted");
    const sixth = routingSelect({ ...baseInput, event_id: "policy-sixth" });
    assert.equal(sixth.route.selected_model, "gpt-6-luna");
    assert.equal(routingSelect({ ...baseInput, event_id: "policy-seventh" }).route.available, false, "末级兜底也满时保持不可用");
    routingResult({ route_id: general.route.route_id, event_id: "policy-permission-result", outcome: "failed", error_type: "task_permission" });
    assert.equal(routingSelect({ ...baseInput, event_id: "policy-after-permission" }).route.selected_model, kimi, "权限失败释放名额后不继续使用 Luna");

    await rm(statePath, { force: true });
    const capacityConfig = JSON.parse(current);
    capacityConfig.roles.executor.fallback_models = [mimo];
    capacityConfig.roles.executor.task_class_models = {};
    await writeFile(roleConfigPath, JSON.stringify(capacityConfig));
    const kimiRoute = routingSelect({ ...baseInput, event_id: "policy-kimi-overload" });
    routingResult({ route_id: kimiRoute.route.route_id, event_id: "policy-kimi-overload-result", outcome: "overloaded", error_type: "server_overloaded" });
    const mimoRoute = routingSelect({ ...baseInput, event_id: "policy-mimo-overload" });
    assert.equal(mimoRoute.route.selected_model, mimo);
    routingResult({ route_id: mimoRoute.route.route_id, event_id: "policy-mimo-overload-result", outcome: "overloaded", error_type: "server_overloaded" });
    assert.equal(routingSelect({ ...baseInput, event_id: "policy-capacity-last-resort" }).route.selected_model, "gpt-6-luna", "上游容量熔断也使用 Luna 兜底");
    await writeFile(roleConfigPath, current);

    for (const taskClass of ["security", "data_migration", "complex_diagnosis", "high_risk"]) {
      await rm(statePath, { force: true });
      const selected = routingSelect({ ...baseInput, task_class: taskClass, event_id: `policy-${taskClass}` });
      assert.equal(selected.route.selected_model, mimoPro, `${taskClass} 按能力选择 MiMo 2.6 Pro`);
      assert.equal(selected.route.reasoning_effort, "medium");
      assert.equal(selected.route.harness, "claude");
    }

    await rm(statePath, { force: true });
    const explicitLuna = routingSelect({ ...baseInput, preferred_model: "gpt-6-luna", event_id: "policy-explicit-luna" });
    assert.equal(explicitLuna.route.selected_model, "gpt-6-luna", "用户显式授权仍可选择 Luna");

    await rm(statePath, { force: true });
    const nativeDefault = routingSelect({ ...baseInput, channel: "native", event_id: "policy-native-default" });
    assert.equal(nativeDefault.route.available, false, "显式 native 的非 Codex 模型能力缺失时返回不可用，绝不静默转 CLI");
    assert.equal(nativeDefault.route.channel, "native");
    assert.match(nativeDefault.route.reason, /^native_model_not_configured:/);
    assert.equal(nativeDefault.route.cli_profile, undefined);

    const directMain = routingSelect({ ...baseInput, channel: "direct", event_id: "policy-direct" });
    assert.equal(directMain.route.channel, "direct", "direct 主模型语义不被强制改 CLI");
    assert.equal(directMain.route.cli_profile, undefined);

    await rm(statePath, { force: true });
    const nativeExplicit = routingSelect({ ...baseInput, channel: "native", preferred_model: "gpt-6-luna", event_id: "policy-native-explicit" });
    assert.equal(nativeExplicit.route.selected_model, "gpt-6-luna");
    assert.equal(nativeExplicit.route.channel, "native", "显式 Codex native 既有路径保持原生语义");

    for (const model of [luna, terra, "gpt-5.6-sol", spark]) {
      await rm(statePath, { force: true });
      assert.equal(routingSelect({ ...baseInput, preferred_model: model }).route.selected_model, kimi, "退役或 manual_only 覆盖归一为非 Codex 默认");
    }

    for (const [profile, model] of [["kimi-k3", kimi], ["kimi-k2.7-highspeed", "kimi-code/kimi-for-coding-highspeed"], ["claude-mimo", "mimo-v2.5-pro"], ["claude-mimo-v2.6-flash", mimo], ["claude-mimo-v2.6-pro", mimoPro]]) {
      await rm(statePath, { force: true });
      const selected = routingSelect({ ...baseInput, cli_profile: profile });
      assert.equal(selected.route.selected_model, model);
      assert.equal(selected.route.cli_profile, profile);
    }
  } finally {
    await writeFile(roleConfigPath, JSON.stringify(roleConfig));
    await rm(statePath, { force: true });
  }
});

test("默认路由推理档位始终等于实际 profile 档位，不只在不支持时才调整", async () => {
  const custom = {
    ...roleConfig,
    cli_profiles: { acme: { harness: "claude", model: "acme-model", provider: "test", reasoning_effort: "low" } },
    roles: {
      ...roleConfig.roles,
      executor: { ...roleConfig.roles.executor, model: "acme-model", reasoning_effort: "medium", fallback_models: [], task_class_models: {} },
    },
  };
  await writeFile(roleConfigPath, `${JSON.stringify(custom)}\n`, "utf8");
  try {
    await rm(statePath, { force: true });
    const selected = routingSelect({ ...baseInput, event_id: "effort-profile-cli" });
    assert.equal(selected.route.selected_model, "acme-model");
    assert.equal(selected.route.cli_profile, "acme");
    assert.equal(selected.route.reasoning_effort, "low", "即使角色档位在客户端支持列表内，也采用 runDelegatedCli 实际 profile 档位");

    await rm(statePath, { force: true });
    const nativeSelected = routingSelect({ ...baseInput, channel: "native", event_id: "effort-profile-native" });
    assert.equal(nativeSelected.route.available, false, "显式 native 无能力时不可用，不再转换为 CLI profile");
    assert.equal(nativeSelected.route.channel, "native");
    assert.match(nativeSelected.route.reason, /^native_model_not_configured:/);
  } finally {
    await writeFile(roleConfigPath, `${JSON.stringify(roleConfig)}\n`, "utf8");
    await rm(statePath, { force: true });
  }
});

test("Jev 决策保留模型选择、置信度与候选列表并进入签名与审计", async () => {
  const jev = {
    phase_id: "phase-1",
    input_hash: "sha256:input",
    requested_task_class: "implementation",
    requested_channel: "cli",
    task_class_choice: "implementation",
    task_class_confidence: 0.9,
    execution_choice: "delegate",
    execution_confidence: 0.8,
    executor_model_choice: "gpt-5.6-terra",
    executor_model_confidence: 0.87,
    candidate_models: ["gpt-5.6-terra", "gpt-5.6-luna", "  ", 42],
    usage: { input_tokens: 12, output_tokens: 3 },
    latency_ms: 45,
  };
  const sanitized = sanitizeJevDecision(jev);
  assert.equal(sanitized.executor_model_choice, "gpt-5.6-terra");
  assert.equal(sanitized.executor_model_confidence, 0.87);
  assert.deepEqual(sanitized.candidate_models, ["gpt-5.6-terra", "gpt-5.6-luna", "42"]);
  assert.equal(sanitizeJevDecision(null), null);
  assert.equal(sanitizeJevDecision({}).executor_model_choice, null);
  assert.equal(sanitizeJevDecision({}).candidate_models, null);

  await rm(statePath, { force: true });
  const selected = routingSelect({ ...baseInput, event_id: "jev-model-select" }, "2026-08-18T08:00:00.000Z", jev);
  assert.equal(selected.route.jev_decision.executor_model_choice, "gpt-5.6-terra");
  assert.equal(selected.route.jev_decision.executor_model_confidence, 0.87);
  assert.deepEqual(selected.route.jev_decision.candidate_models, ["gpt-5.6-terra", "gpt-5.6-luna", "42"]);
  const decision = selected.auditEvents.find((event) => event.type === "routing.decision");
  assert.equal(decision.jev_decision.executor_model_choice, "gpt-5.6-terra");
  assert.deepEqual(decision.jev_decision.candidate_models, ["gpt-5.6-terra", "gpt-5.6-luna", "42"]);

  const replay = routingSelect({ ...baseInput, event_id: "jev-model-select" }, "2026-08-18T08:00:01.000Z", jev);
  assert.equal(replay.idempotent, true, "相同 Jev 模型字段的 event 可幂等重放");
  assert.throws(
    () => routingSelect({ ...baseInput, event_id: "jev-model-select" }, "2026-08-18T08:00:02.000Z", { ...jev, executor_model_choice: "gpt-5.6-luna" }),
    (error) => error instanceof RoutingControlError && error.statusCode === 409,
  );
});

test("automatic_until 到期后旧模型退出自动映射与回退，显式目录条目不受影响", async () => {
  const expiring = {
    schema_version: "taskcenter-model-roles-v1",
    roles: {
      executor: { model: "exec-main", reasoning_effort: "low", fallback_models: ["exec-old"], task_class_models: { security: "exec-old" }, concurrency_limit: 1 },
      reviewer: { model: "rev-main", reasoning_effort: "low", fallback_models: [], concurrency_limit: 1 },
    },
    retired_models: [],
    model_catalog: {
      "exec-main": { description: "默认执行模型" },
      "exec-old": { description: "旧代回退模型", automatic_until: "2026-10-21T10:00:00+08:00" },
    },
  };
  await writeFile(roleConfigPath, `${JSON.stringify(expiring)}\n`, "utf8");
  try {
    await rm(statePath, { force: true });
    routingSelect({ ...baseInput, event_id: "expiry-occupy" }, "2026-10-20T08:00:00.000Z");
    const before = routingSelect({ ...baseInput, event_id: "expiry-before" }, "2026-10-20T08:00:01.000Z");
    assert.equal(before.route.selected_model, "exec-old", "截止前自动回退仍可使用旧模型");
    routingResult({ route_id: before.route.route_id, outcome: "succeeded" }, "2026-10-20T08:00:02.000Z");

    await rm(statePath, { force: true });
    const mapped = routingSelect({ ...baseInput, task_class: "security", event_id: "expiry-mapped" }, "2026-10-21T02:00:01.000Z");
    assert.equal(mapped.route.selected_model, "exec-main", "到期后 task_class 映射回落到角色默认模型");

    routingSelect({ ...baseInput, event_id: "expiry-occupy-2" }, "2026-10-21T02:00:02.000Z");
    const after = routingSelect({ ...baseInput, event_id: "expiry-after" }, "2026-10-21T02:00:03.000Z");
    assert.equal(after.route.available, false, "到期后旧模型不再作为自动回退");
    assert.equal(after.route.selected_model, null);
  } finally {
    await writeFile(roleConfigPath, `${JSON.stringify(roleConfig)}\n`, "utf8");
    await rm(statePath, { force: true });
  }
});

test("共享 quota pool 并发上限跨候选模型生效", async () => {
  const pooled = {
    schema_version: "taskcenter-model-roles-v1",
    roles: {
      executor: { model: "exec-a", reasoning_effort: "low", fallback_models: ["exec-b"], concurrency_limit: 2 },
      reviewer: { model: "rev-a", reasoning_effort: "low", fallback_models: [], concurrency_limit: 1 },
    },
    retired_models: [],
    quota_pools: [{ id: "pool-x", provider: "test", models: ["exec-a", "exec-b"], concurrency_limit: 2 }],
  };
  await writeFile(roleConfigPath, `${JSON.stringify(pooled)}\n`, "utf8");
  try {
    await rm(statePath, { force: true });
    const first = routingSelect({ ...baseInput, event_id: "pool-1" }, "2026-08-18T08:00:00.000Z");
    const second = routingSelect({ ...baseInput, event_id: "pool-2" }, "2026-08-18T08:00:01.000Z");
    assert.equal(first.route.selected_model, "exec-a");
    assert.equal(second.route.selected_model, "exec-a", "模型级 2 个名额先用满");
    const third = routingSelect({ ...baseInput, event_id: "pool-3" }, "2026-08-18T08:00:02.000Z");
    assert.equal(third.route.available, false, "pool 上限 2 跨 exec-a/exec-b 共享，回退也被拒绝");

    routingResult({ route_id: first.route.route_id, outcome: "succeeded" }, "2026-08-18T08:00:03.000Z");
    const fourth = routingSelect({ ...baseInput, event_id: "pool-4" }, "2026-08-18T08:00:04.000Z");
    assert.equal(fourth.route.selected_model, "exec-a", "租约释放后 pool 名额可复用");

    routingResult({ route_id: second.route.route_id, outcome: "succeeded" }, "2026-08-18T08:00:04.500Z");

    const expired = routingSelect({ ...baseInput, event_id: "pool-5", lease_ttl_ms: 60_000 }, "2026-08-18T08:00:05.000Z");
    assert.equal(expired.route.available, true);
    routingSelect({ ...baseInput, event_id: "pool-6" }, "2026-08-18T08:00:06.000Z");
    const blocked = routingSelect({ ...baseInput, event_id: "pool-7" }, "2026-08-18T08:00:07.000Z");
    assert.equal(blocked.route.available, false);
    const afterExpiry = routingSelect({ ...baseInput, event_id: "pool-8" }, "2026-08-18T08:01:06.000Z");
    assert.equal(afterExpiry.route.available, true, "pool-5 租约过期后正确释放 pool 名额");
  } finally {
    await writeFile(roleConfigPath, `${JSON.stringify(roleConfig)}\n`, "utf8");
    await rm(statePath, { force: true });
  }
});

test("executor 全局并发上限跨全部候选模型生效", async () => {
  const globalLimited = {
    schema_version: "taskcenter-model-roles-v1",
    roles: {
      executor: { model: "exec-a", reasoning_effort: "low", fallback_models: ["exec-b"], concurrency_limit: 2, global_concurrency_limit: 3 },
      reviewer: { model: "rev-a", reasoning_effort: "low", fallback_models: [], concurrency_limit: 1 },
    },
    retired_models: [],
    quota_pools: [{ id: "pool-x", provider: "test", models: ["exec-a", "exec-b"], concurrency_limit: 4 }],
  };
  await writeFile(roleConfigPath, `${JSON.stringify(globalLimited)}\n`, "utf8");
  try {
    await rm(statePath, { force: true });
    assert.equal(routingSelect({ ...baseInput, event_id: "global-1" }, "2026-08-18T08:00:00.000Z").route.selected_model, "exec-a");
    assert.equal(routingSelect({ ...baseInput, event_id: "global-2" }, "2026-08-18T08:00:01.000Z").route.selected_model, "exec-a");
    assert.equal(routingSelect({ ...baseInput, event_id: "global-3" }, "2026-08-18T08:00:02.000Z").route.selected_model, "exec-b");
    const fourth = routingSelect({ ...baseInput, event_id: "global-4" }, "2026-08-18T08:00:03.000Z");
    assert.equal(fourth.route.available, false, "第 4 个 executor 租约超过全局上限 3，即使 exec-b 模型级仍有余量");
  } finally {
    await writeFile(roleConfigPath, `${JSON.stringify(roleConfig)}\n`, "utf8");
    await rm(statePath, { force: true });
  }
});
