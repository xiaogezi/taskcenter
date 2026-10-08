import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isAllowedControlPath, controlProxyTarget } from "../lib/control-proxy.mjs";

const dir = await mkdtemp(join(tmpdir(), "taskcenter-model-management-"));
const configPath = join(dir, "models.json");
process.env.TASKCENTER_MODEL_ROLE_CONFIG_PATH = configPath;
process.env.TASKCENTER_ROUTING_CONTROL_PATH = join(dir, "routing.json");
process.env.TASKCENTER_RUNTIME_DIR = dir;
const { modelManagementConfig, updateModelManagement } = await import("../scripts/model-role-config.mjs");
const { routingSelect, routingResult, routingDecisions, routeForId } = await import("../scripts/routing-control.mjs");
const base = {
  schema_version: "taskcenter-model-roles-v1",
  roles: {
    executor: { model: "a", fallback_models: ["b"], reasoning_effort: "low", concurrency_limit: 2, dispatch_channel: "native", model_reasoning_efforts: { b: "high" }, native_models: { a: { runtime_model: "runtime/a", reasoning_efforts: ["low", "medium"] }, b: { runtime_model: "runtime/b", reasoning_efforts: ["high"] } } },
    reviewer: { model: "r", fallback_models: [], reasoning_effort: "low", concurrency_limit: 1 },
  },
  model_catalog: { a: { description: "A", automatic_until: "2099-01-01T00:00:00Z" }, b: { description: "B" }, c: { description: "C" }, r: { description: "R" } },
  native_models: { c: { runtime_model: "runtime/c", reasoning_efforts: ["low"] } },
  manual_only_models: ["manual"], retired_models: ["old"],
  quota_pools: [{ id: "pool", models: ["a", "b"], source: "unknown" }],
  cli_profiles: { retained: { model: "c" } }, optional_astra_policy: { preset: "saving", threshold_percent: 0 },
};
const reset = () => writeFile(configPath, JSON.stringify(base));
test.beforeEach(() => rm(process.env.TASKCENTER_ROUTING_CONTROL_PATH, { force: true }));
test.after(() => rm(dir, { recursive: true, force: true }));

test("模型管理 CRUD、启停排序、配置保留与运行中路由隔离", async () => {
  await reset();
  const route = routingSelect({ task_id: "existing", event_id: "existing-route", orchestrator_model: "main", channel: "native", task_class: "implementation", available_native_models: ["runtime/a", "runtime/b"] }).route;
  assert.equal(route.selected_model, "a");
  let draft = modelManagementConfig();
  draft.fallback_models = [];
  draft = updateModelManagement(draft);
  assert.equal(draft.models.find(model => model.id === "b").executor_reasoning_effort, "high", "停用保留模型档位");
  draft.fallback_models = ["b"];
  draft = updateModelManagement(draft);
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).roles.executor.model_reasoning_efforts.b, "high", "重新启用恢复原档位");
  draft.models.find(model => model.id === "a").description = "Updated A";
  draft.models.push({ id: "new", description: "New model", runtime_model: "runtime/new", reasoning_efforts: ["low", "medium"], executor_reasoning_effort: "" });
  draft.executor_model = "b"; draft.fallback_models = ["new", "a"];
  draft = updateModelManagement(draft);
  assert.deepEqual(draft.fallback_models, ["new", "a"]);
  const stored = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(stored.model_catalog.a.automatic_until, base.model_catalog.a.automatic_until);
  assert.deepEqual(stored.roles.reviewer, base.roles.reviewer);
  assert.deepEqual(stored.quota_pools, base.quota_pools);
  assert.deepEqual(stored.cli_profiles, base.cli_profiles);
  assert.deepEqual(stored.optional_astra_policy, base.optional_astra_policy);
  assert.equal(routeForId(route.route_id).selectedModel, "a");
  assert.equal(routeForId(route.route_id).status, "leased");
  draft.fallback_models = [];
  draft = updateModelManagement(draft);
  const next = routingSelect({ task_id: "next", event_id: "next-route", orchestrator_model: "main", channel: "native", task_class: "implementation", available_native_models: ["runtime/a", "runtime/b"] }).route;
  assert.equal(next.selected_model, "b");
  assert.equal(next.reasoning_effort, "high");
  draft.models = draft.models.filter(model => model.id !== "new");
  updateModelManagement(draft);
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).native_models.new, undefined);
});

test("引用删除、无效输入和版本冲突拒绝且不写入", async () => {
  await reset();
  const original = await readFile(configPath, "utf8");
  const reject = (change, pattern, status = 400) => {
    const draft = modelManagementConfig(); change(draft);
    assert.throws(() => updateModelManagement(draft), error => error.statusCode === status && pattern.test(error.message));
  };
  reject(draft => { draft.models = draft.models.filter(model => model.id !== "r"); }, /角色引用/);
  reject(draft => { draft.fallback_models = []; draft.models = draft.models.filter(model => model.id !== "b"); }, /先保存/);
  reject(draft => { draft.content_hash = "stale"; }, /其他操作/, 409);
  reject(draft => { draft.models[0].id = "__proto__"; }, /ID/);
  reject(draft => { draft.models[0].runtime_model = 1; }, /runtime/);
  reject(draft => { draft.models[0].description = ""; }, /描述/);
  reject(draft => { draft.fallback_models = ["b", "b"]; }, /不得重复/);
  reject(draft => { draft.models[0].executor_reasoning_effort = "high"; }, /支持范围/);
  reject(draft => { draft.models[0].runtime_model = ""; draft.models[0].reasoning_efforts = []; }, /需要 native/);
  reject(draft => { draft.models.push({ ...draft.models[0], id: "old" }); }, /退役/);
  reject(draft => { draft.models.push({ ...draft.models[0], id: "manual" }); }, /仅手动/);
  assert.equal(await readFile(configPath, "utf8"), original);
  await writeFile(`${configPath}.lock`, "busy");
  reject(() => {}, /正在保存/, 409);
  await rm(`${configPath}.lock`);
  const stale = modelManagementConfig();
  await writeFile(configPath, `${original}\n`);
  assert.throws(() => updateModelManagement(stale), error => error.statusCode === 409);
  assert.equal(await readFile(configPath, "utf8"), `${original}\n`);
});

test("白名单限制显式、容量与额度策略；空名单由主模型继续，Reviewer 保留", async () => {
  await reset();
  const draft = modelManagementConfig(); draft.fallback_models = [];
  updateModelManagement(draft);
  const input = { task_id: "whitelist", orchestrator_model: "main", channel: "native", task_class: "implementation", available_native_models: ["runtime/a", "runtime/b", "runtime/c"] };
  const excluded = routingSelect({ ...input, preferred_model: "c" }).route;
  assert.equal(excluded.channel, "direct");
  assert.equal(excluded.preferred_model, "c");
  assert.equal(excluded.fallback_reason, "executor_model_not_in_dispatch_list");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.roles.executor.capacity_fallback_model = "c";
  await writeFile(configPath, JSON.stringify(config));
  const first = routingSelect(input).route; const second = routingSelect(input).route;
  assert.equal(first.selected_model, "a"); assert.equal(second.selected_model, "a");
  assert.equal(routingSelect(input).route.channel, "direct", "容量回退不能把 c 加回派发");
  assert.equal(routingSelect({ ...input, execution_model_policy: { mode: "quota_preferred", preferred_model: "manual", quota_limit_id: "pool", fallback_on_exhaustion: true } }).route.channel, "direct", "quota 策略也受白名单约束");
  const empty = modelManagementConfig(); empty.executor_model = ""; empty.fallback_models = [];
  const result = updateModelManagement(empty);
  assert.equal(result.executor_model, "");
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).roles.executor.allowed_models, []);
  const fallback = routingSelect(input).route;
  assert.equal(fallback.channel, "direct"); assert.equal(fallback.selected_model, "main");
  assert.equal(fallback.fallback_reason, "executor_dispatch_list_empty");
  const review = routingSelect({ ...input, task_class: "ocr", review_artifacts: { subject: { ref: "subject://1" }, bundle: { ref: "bundle://1" }, rules: { ref: "rules://1" } } }).route;
  assert.equal(review.selected_model, "r");
  assert.equal(routeForId(first.route_id).selectedModel, "a", "已运行租约不变");
});

test("从会话目录加入新型号与明确恢复退役模型，停用清除旧任务型号偏好", async () => {
  await reset();
  let draft = modelManagementConfig();
  draft.models.push({ id: "old", description: "会话目录仍可选", runtime_model: "runtime/old", reasoning_efforts: ["low", "medium"], executor_reasoning_effort: "" });
  draft.executor_model = "old"; draft.fallback_models = [];
  draft = updateModelManagement(draft);
  assert.equal(draft.retired_models.includes("old"), false);
  const route = routingSelect({ task_id: "restored", orchestrator_model: "main", channel: "native", task_class: "implementation", available_native_models: ["runtime/old"] }).route;
  assert.equal(route.native_model, "runtime/old");
  const config = JSON.parse(await readFile(configPath, "utf8")); config.roles.executor.task_class_models = { security: "old" };
  await writeFile(configPath, JSON.stringify(config));
  draft = modelManagementConfig(); draft.executor_model = "a"; draft.fallback_models = [];
  updateModelManagement(draft);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).roles.executor.task_class_models, {});
});

test("日志保留每个阶段完整 Jev 判断和真实失败回执，分页不泄露内部授权", async () => {
  await reset();
  const input = { task_id: "log-task", orchestrator_model: "main", channel: "direct", task_class: "implementation", direct_reason: "连续整合" };
  const jev = { status: "succeeded", phase_id: "implementation", phase_summary_excerpt: "实现名单", candidate_models: ["a", "b"], execution_choice: "delegate", task_class_choice: "implementation", executor_model_choice: "b", execution_confidence: 0.9, model_applied: false, usage: { input_tokens: 10, output_tokens: 2 }, latency_ms: 8, execution_override_reason: "explicit_channel" };
  const first = routingSelect(input, "2026-10-08T10:00:00Z", jev).route;
  routingResult({ route_id: first.route_id, outcome: "failed", error_type: "permission", error_code: "CLAIM_REJECTED", request_id: "request-1" }, "2026-10-08T10:01:00Z");
  const second = routingSelect(input, "2026-10-08T10:02:00Z", { phase_id: "verify", status: "no_api_key", candidate_models: ["a", "b"], error: "no_api_key" }).route;
  const latest = routingDecisions({ taskId: "log-task", limit: 1 }, "2026-10-08T10:03:00Z");
  assert.equal(latest.total, 2); assert.equal(latest.routes[0].route_id, second.route_id);
  const older = routingDecisions({ taskId: "log-task", limit: 1, before: latest.next_cursor });
  assert.equal(older.routes[0].jev_decision.execution_choice, "delegate");
  assert.deepEqual(older.routes[0].jev_decision.candidate_models, ["a", "b"]);
  assert.equal(older.routes[0].result.error_code, "CLAIM_REJECTED");
  assert.equal(older.routes[0].result.request_id, "request-1");
  assert.equal(older.next_cursor, null);
  assert.equal(Object.hasOwn(older.routes[0], "selectSignature"), false);
  assert.throws(() => routingDecisions({ limit: 101 }), /1–100/);
  assert.throws(() => routingDecisions({ before: "missing" }), /游标/);
});

test("控制接口沿用本机来源和操作标记，代理仅开放 GET/POST", async t => {
  await reset();
  const portServer = createServer(); portServer.listen(0, "127.0.0.1"); await once(portServer, "listening");
  const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
  const env = { ...process.env, TASKCENTER_CONTROL_PORT: String(port), TASKCENTER_DISABLE_LIVE_SESSION_RECONCILIATION: "1", TASKCENTER_JEV_ROUTING: "0", TASKCENTER_MCP_TOKEN_PATH: join(dir, "token") };
  for (const key of ["DASHBOARD", "TASK_LEDGER", "TASK_EVENTS", "SESSION_REGISTRY", "DELEGATIONS", "USAGE_REPORT", "GOVERNANCE_METRICS", "BUG_DISPATCHES"]) env[`TASKCENTER_${key}_PATH`] = join(dir, key.toLowerCase());
  const child = spawn(process.execPath, ["scripts/control-server.mjs"], { env, stdio: "ignore" });
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; } });
  const url = `http://127.0.0.1:${port}/routing/models`;
  let response;
  for (let attempt = 0; attempt < 100; attempt++) { try { response = await fetch(url); break; } catch { await new Promise(resolve => setTimeout(resolve, 30)); } }
  assert.equal(response?.status, 200);
  const draft = await response.json();
  assert.equal(isAllowedControlPath("/routing/models", "GET"), true);
  assert.equal(isAllowedControlPath("/routing/models", "POST"), true);
  assert.equal(isAllowedControlPath("/routing/models", "DELETE"), false);
  assert.equal(isAllowedControlPath("/routing/model-catalog", "GET"), false);
  assert.equal(isAllowedControlPath("/routing/model-catalog", "POST"), false);
  assert.equal(isAllowedControlPath("/routing/decisions", "GET"), true);
  assert.equal(controlProxyTarget("/routing/decisions", "?limit=10&before=route1&task_id=one&ignored=true").search, "?limit=10&before=route1&task_id=one");
  const logResponse = await fetch(`http://127.0.0.1:${port}/routing/decisions?limit=1`);
  assert.equal(logResponse.status, 200);
  assert.equal(Array.isArray((await logResponse.json()).routes), true);
  assert.equal((await fetch(`http://127.0.0.1:${port}/routing/decisions?limit=101`)).status, 400);
  const post = headers => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(draft) });
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ origin: "https://untrusted.example", "x-taskcenter-action": "delegate" })).status, 403);
  assert.equal((await post({ origin: "http://localhost:3000" })).status, 403);
  const valid = { origin: "http://localhost:3000", "x-taskcenter-action": "delegate" };
  draft.models.find(model => model.id === "c").description = "Changed through API";
  response = await post(valid); assert.equal(response.status, 200);
  assert.equal((await response.json()).accepted, true);
  assert.equal((await post(valid)).status, 409);
  assert.equal(modelManagementConfig().models.find(model => model.id === "c").description, "Changed through API");
});
