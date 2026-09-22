import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const directory = await mkdtemp(join(tmpdir(), "jev-routing-"));
const statePath = join(directory, "routes.json");
process.env.TASKCENTER_ROUTING_CONTROL_PATH = statePath;
process.env.TASKCENTER_MODEL_ROLE_CONFIG_PATH = join(directory, "roles.json");
const fixtureConfig = JSON.parse(await readFile(new URL("../config/model-roles.json", import.meta.url), "utf8"));
fixtureConfig.roles.executor.model = "kimi-code/k3-256k";
fixtureConfig.roles.executor.fallback_models = ["mimo-v2.5-pro"];
fixtureConfig.roles.executor.task_class_models = {};
fixtureConfig.model_catalog = {};
await writeFile(process.env.TASKCENTER_MODEL_ROLE_CONFIG_PATH, JSON.stringify(fixtureConfig));
const { routingSelect, routeForId } = await import("../scripts/routing-control.mjs");
const { prepareRoutingInput, clearJevCache } = await import("../scripts/jev-routing.mjs");
const task = { id: "task-jev", title: "修复路由审计", goal: "修改指定模块并测试", currentStep: "实现" };
const input = { task_id: task.id, orchestrator_model: "current-main", task_class: "implementation", channel: "native", phase_id: "implement", phase_summary: "修改路由审计字段" };
const result = (taskClass = "search", execution = "delegate", executorModel = undefined) => ({ status: "succeeded", model: "jev-1.13.0", answers: {
  task_class: { type: "choice", choice: taskClass, confidence: 0.9 },
  execution: { type: "choice", choice: execution, confidence: 0.9 },
  ...(executorModel === undefined ? {} : { executor_model: { type: "choice", choice: executorModel, confidence: 0.8 } }),
}, usage: { input_tokens: 80, output_tokens: 12 }, latency_ms: 10 });
const prepare = (body = input, evaluator = async () => result(), options = {}) => prepareRoutingInput(body, task, { evaluator, ...options });

test.beforeEach(async () => {
  clearJevCache();
  process.env.TASKCENTER_JEV_ROUTING = "1";
  process.env.TYPESAFE_API_KEY = "offline-test-only";
  await rm(statePath, { force: true });
});
test.after(async () => rm(directory, { recursive: true, force: true }));

test("同阶段并发去重，下一阶段重新判断，并消费真实类别和通道", async () => {
  let calls = 0;
  const evaluator = async () => { calls++; return result(); };
  const [first, second] = await Promise.all([prepare(input, evaluator), prepare(input, evaluator)]);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.equal(first.input.task_class, "search");
  assert.equal(first.input.channel, "cli");
  assert.deepEqual(first.jevDecision.usage, { input_tokens: 80, output_tokens: 12 });
  await prepare({ ...input, phase_id: "next" }, evaluator);
  assert.equal(calls, 2);
  await prepare({ ...input, phase_summary: "新的语义输入" }, evaluator);
  assert.equal(calls, 3);
});

test("失败被缓存且保留错误，普通请求确定性回到 CLI", async () => {
  let calls = 0;
  const evaluator = async () => { calls++; return { status: "failed", error: "timeout", latency_ms: 5000 }; };
  const first = await prepare({ ...input, channel: "other" }, evaluator);
  await prepare({ ...input, channel: "other" }, evaluator);
  assert.equal(calls, 1);
  assert.equal(first.input.task_class, "implementation");
  assert.equal(first.input.channel, "cli");
  assert.equal(first.jevDecision.error, "timeout");
  assert.equal(first.jevDecision.latency_ms, 5000);
});

test("缺 key 与截断区外密钥均不调用评估，仍留下可审计降级", async () => {
  const forbidden = async () => assert.fail("must not call evaluator");
  delete process.env.TYPESAFE_API_KEY;
  let prepared = await prepare(input, forbidden);
  assert.equal(prepared.jevDecision.status, "no_api_key");
  assert.equal(prepared.input.channel, "cli");
  process.env.TYPESAFE_API_KEY = "offline-test-only";
  prepared = await prepareRoutingInput(input, { ...task, title: "x".repeat(1000) + " api_key=" + "s".repeat(40) }, { evaluator: forbidden });
  assert.equal(prepared.jevDecision.status, "suspected_secret");
  assert.ok(prepared.jevDecision.input_hash);
  assert.equal(JSON.stringify(prepared.jevDecision).includes("s".repeat(40)), false);
});

test("direct 原因在评估之前校验，缺 key 也不能跳过", async () => {
  delete process.env.TYPESAFE_API_KEY;
  await assert.rejects(prepare({ ...input, channel: "direct" }, async () => assert.fail("must not evaluate")), e => e.statusCode === 400 && e.code === "DIRECT_REASON_REQUIRED");
  assert.equal(routeForId("none"), undefined);
});

test("显式型号、profile、配额与主模型 direct 覆盖保留", async () => {
  for (const extra of [{ preferred_model: "explicit" }, { cli_profile: "explicit" }, { execution_model_policy: { mode: "quota_preferred" } }]) {
    const prepared = await prepare({ ...input, ...extra });
    assert.equal(prepared.input.channel, "native");
  }
  const direct = await prepare({ ...input, channel: "direct", direct_reason: "整合执行器产物" });
  assert.equal(direct.input.channel, "direct");
  assert.equal(direct.input.direct_reason, "整合执行器产物");
});

test("高风险类别保持，普通任务不能被转换成 Reviewer", async () => {
  for (const taskClass of ["security", "high_risk", "data_migration"]) {
    assert.equal((await prepare({ ...input, task_class: taskClass })).input.task_class, taskClass);
  }
  clearJevCache();
  assert.equal((await prepare(input, async () => result("independent_review"))).input.task_class, "implementation");
});

test("Reviewer 和关闭开关不评估，HTTP body 不能伪造决策", async () => {
  const forbidden = async () => assert.fail("must not evaluate");
  const review = await prepare({ ...input, task_class: "independent_review" }, forbidden);
  assert.equal(review.jevDecision, null);
  process.env.TASKCENTER_JEV_ROUTING = "0";
  const disabled = await prepare({ ...input, channel: "direct", jev_decision: { status: "succeeded" } }, forbidden);
  assert.equal(disabled.jevDecision, null);
  assert.equal(disabled.input.jev_decision, undefined);
  const forged = routingSelect({ ...input, jev_decision: result() });
  assert.equal(forged.route.jev_decision, null);
});

test("needs_context 返回可处理的 409，invalid_response 不改变类别", async () => {
  await assert.rejects(prepare(input, async () => result("general", "needs_context")), e => e.statusCode === 409 && e.code === "JEV_NEEDS_CONTEXT");
  clearJevCache();
  const prepared = await prepare(input, async () => ({ status: "succeeded", answers: {} }));
  assert.equal(prepared.jevDecision.error, "invalid_response");
  assert.equal(prepared.input.task_class, "implementation");
});

test("Jev 型号候选来自白名单并可注入可信 preferred_model", async () => {
  let request;
  const prepared = await prepare(input, async req => { request = req; return result("implementation", "delegate", "mimo-v2.5-pro"); });
  assert.equal(prepared.input.preferred_model, "mimo-v2.5-pro");
  assert.equal(prepared.jevDecision.executor_model_choice, "mimo-v2.5-pro");
  assert.equal(prepared.jevDecision.executor_model_confidence, 0.8);
  assert.deepEqual(prepared.jevDecision.candidate_models, ["kimi-code/k3-256k", "mimo-v2.5-pro"]);
  // 三问同一次请求；候选约束为白名单且含 no_match 哨兵。
  assert.ok(Object.hasOwn(request.questions, "task_class") && Object.hasOwn(request.questions, "execution") && Object.hasOwn(request.questions, "executor_model"));
  assert.ok(Object.hasOwn(request.questions.executor_model.criteria, "no_match"));
  assert.ok(Object.hasOwn(request.questions.executor_model.criteria, "kimi-code/k3-256k"));
  assert.ok(!Object.hasOwn(request.questions.executor_model.criteria, "gpt-5.6-luna"));
});

test("越界型号与 no_match 不注入 preferred_model", async () => {
  const forged = await prepare({ ...input, phase_id: "forge" }, async () => result("implementation", "delegate", "gpt-evil-model"));
  assert.equal(forged.input.preferred_model, undefined);
  assert.equal(forged.jevDecision.executor_model_choice, null);
  assert.equal(forged.jevDecision.status, "succeeded");
  const none = await prepare({ ...input, phase_id: "nomatch" }, async () => result("implementation", "delegate", "no_match"));
  assert.equal(none.input.preferred_model, undefined);
  assert.equal(none.jevDecision.executor_model_choice, "no_match");
});

test("显式 preferred_model 与 direct 路由不被 Jev 型号覆盖", async () => {
  const pinned = await prepare({ ...input, phase_id: "pinned", preferred_model: "explicit" }, async () => result("implementation", "delegate", "mimo-v2.5-pro"));
  assert.equal(pinned.input.preferred_model, "explicit");
  const direct = await prepare({ ...input, phase_id: "direct-model", channel: "direct", direct_reason: "整合验收" }, async () => result("implementation", "direct", "mimo-v2.5-pro"));
  assert.equal(direct.input.channel, "direct");
  assert.equal(direct.input.preferred_model, undefined);
  assert.equal(direct.jevDecision.executor_model_choice, "mimo-v2.5-pro");
});

test("配置/目录变化使缓存失效，同阶段仍幂等", async () => {
  let calls = 0;
  const evaluator = async () => { calls++; return result("implementation", "delegate", "mimo-v2.5-pro"); };
  await prepare({ ...input, phase_id: "cache-cfg" }, evaluator);
  await prepare({ ...input, phase_id: "cache-cfg" }, evaluator);
  assert.equal(calls, 1);
  const original = await readFile(process.env.TASKCENTER_MODEL_ROLE_CONFIG_PATH, "utf8");
  try {
    const config = JSON.parse(original);
    config.model_catalog = { "mimo-v2.5-pro": { description: "更强的诊断型号" } };
    await writeFile(process.env.TASKCENTER_MODEL_ROLE_CONFIG_PATH, JSON.stringify(config));
    await prepare({ ...input, phase_id: "cache-cfg" }, evaluator);
    assert.equal(calls, 2);
  } finally {
    await writeFile(process.env.TASKCENTER_MODEL_ROLE_CONFIG_PATH, original);
  }
});

test("并发不同 phase 各自评估一次", async () => {
  let calls = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const evaluator = async () => { calls++; await pending; return result("implementation", "delegate", "kimi-code/k3-256k"); };
  const requests = [
    prepare({ ...input, phase_id: "phase-a" }, evaluator),
    prepare({ ...input, phase_id: "phase-b" }, evaluator),
  ];
  assert.equal(calls, 2);
  release();
  const [a, b] = await Promise.all(requests);
  assert.equal(a.input.preferred_model, "kimi-code/k3-256k");
  assert.equal(b.input.preferred_model, "kimi-code/k3-256k");
});

test("自动候选到期后同阶段缓存不能恢复过期型号", async t => {
  const original = await readFile(process.env.TASKCENTER_MODEL_ROLE_CONFIG_PATH, "utf8");
  const config = JSON.parse(original);
  config.model_catalog = { "mimo-v2.5-pro": { description: "旧型号", automatic_until: "2026-10-21T02:00:00Z" } };
  await writeFile(process.env.TASKCENTER_MODEL_ROLE_CONFIG_PATH, JSON.stringify(config));
  t.mock.method(Date, "now", () => Date.parse("2026-10-21T01:59:59Z"));
  try {
    let calls = 0;
    const evaluator = async () => { calls++; return result("implementation", "delegate", "mimo-v2.5-pro"); };
    assert.equal((await prepare(input, evaluator)).input.preferred_model, "mimo-v2.5-pro");
    Date.now.mock.mockImplementation(() => Date.parse("2026-10-21T02:00:00Z"));
    assert.equal((await prepare(input, evaluator)).input.preferred_model, undefined);
    assert.equal(calls, 2);
  } finally { await writeFile(process.env.TASKCENTER_MODEL_ROLE_CONFIG_PATH, original); }
});

test("Jev 型号推荐满额后可回退，但用户显式锁定保持不降级", async () => {
  const prepared = await prepare(input, async () => result("implementation", "delegate", "kimi-code/k3-256k"));
  assert.equal(prepared.jevDecision.model_applied, true);
  for (let i = 0; i < 2; i++) {
    assert.equal(routingSelect({ ...prepared.input, event_id: `capacity-${i}` }, undefined, prepared.jevDecision).route.selected_model, "kimi-code/k3-256k");
  }
  const fallback = routingSelect({ ...prepared.input, event_id: "capacity-fallback" }, undefined, prepared.jevDecision);
  assert.equal(fallback.route.selected_model, "mimo-v2.5-pro");
  const pinned = await prepare({ ...input, preferred_model: "kimi-code/k3-256k" }, async () => result("implementation", "delegate", "kimi-code/k3-256k"));
  assert.notEqual(pinned.jevDecision.model_applied, true);
  assert.equal(routingSelect({ ...pinned.input, event_id: "capacity-pinned" }, undefined, pinned.jevDecision).route.available, false);
});

test("真实集中路由原子保存决策、用量与审计，语义进入幂等键", async () => {
  const prepared = await prepare({ ...input, channel: "direct", direct_reason: "部署后集成验收" });
  const body = { ...prepared.input, event_id: "jev-persist" };
  const first = routingSelect(body, undefined, prepared.jevDecision);
  assert.match(first.route.selected_model, /^(kimi-code\/|mimo-)/);
  assert.equal(first.route.direct_reason, "部署后集成验收");
  assert.deepEqual(routeForId(first.route.route_id).jevDecision, first.route.jev_decision);
  const audit = first.auditEvents.find(e => e.type === "routing.decision");
  assert.deepEqual(audit.jev_decision, first.route.jev_decision);
  assert.deepEqual(audit.jev_decision.usage, { input_tokens: 80, output_tokens: 12 });
  assert.equal(audit.direct_reason, "部署后集成验收");
  assert.equal(routingSelect(body, undefined, { ...prepared.jevDecision, latency_ms: 200 }).idempotent, true);
  assert.throws(() => routingSelect(body, undefined, { ...prepared.jevDecision, phase_id: "different" }), e => e.statusCode === 409);
  assert.throws(() => routingSelect({ ...body, direct_reason: "different" }, undefined, prepared.jevDecision), e => e.statusCode === 409);
  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(persisted.routes.length, 1);
});
