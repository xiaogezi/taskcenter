import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  roles: {
    executor: { model: "gpt-5.6-luna", reasoning_effort: "medium", fallback_models: ["gpt-5.6-terra"], concurrency_limit: 1 },
    reviewer: { model: "gpt-5.6-luna", reasoning_effort: "medium", fallback_models: [], concurrency_limit: 1 },
  },
  retired_models: ["gpt-5.3-codex-spark"],
};
await writeFile(roleConfigPath, `${JSON.stringify(roleConfig)}\n`, "utf8");

const {
  RoutingControlError,
  routingHealth,
  routingResult,
  routingSelect,
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

test("已退役首选请求会归一化为集中配置的执行器", () => {
  const selected = routingSelect({ ...baseInput, preferred_model: spark, event_id: "legacy-spark-select" }, "2026-08-18T08:00:00.000Z");
  assert.equal(selected.route.preferred_model, luna);
  assert.equal(selected.route.selected_model, luna);
  assert.equal(selected.route.reason, "retired_preference_normalized_to_executor");
  assert.equal(selected.health.some((item) => item.model === spark), false);
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
  assert.equal(decision.policy_version, "routing-control-v3");
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

test("历史 Spark 健康状态不再作为活跃候选返回", async () => {
  await writeFile(statePath, `${JSON.stringify({
    version: 3,
    models: {
      [spark]: { model: spark, state: "closed", consecutiveFailures: 0, openedAt: "", retryAfterAt: "", halfOpenLease: "", activeExecutors: 0, concurrencyLimit: 2, failureThreshold: 3, cooldownMs: 300_000, lastErrorCode: "", lastRequestId: "", lastSuccessAt: "2026-08-18T08:00:00.000Z", updatedAt: "2026-08-18T08:00:00.000Z" },
    },
    routes: [],
  })}\n`, "utf8");
  assert.equal(routingHealth("2026-08-18T08:00:01.000Z").some((item) => item.model === spark), false);
});
