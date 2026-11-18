import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSessionPathAsync } from "../scripts/session-cli.mjs";
import { boundedResponse } from "../scripts/bounded-response.mjs";
import { budgetSnapshot, readPreparationBudget, readRequestBudget } from "../scripts/request-budget.mjs";

test("任务准备到期时返回未知的建议预算，迟到读取仍可完成", async () => {
  const task = { workflowProfile: "fast" };
  let complete;
  const pending = new Promise((resolve) => { complete = resolve; });
  const result = await readPreparationBudget(task, () => pending, 10);
  assert.equal(result.timedOut, true);
  assert.equal(result.budget.source, "unavailable");
  assert.equal(result.budget.continuation_count.session, null);
  assert.equal(result.budget.request_limit, 8);
  assert.equal(result.budget.handoff_required, false);
  const updated = budgetSnapshot({ requests: [], compactions: 0 }, task);
  complete(updated);
  const next = await readPreparationBudget(task, () => pending);
  assert.equal(next.timedOut, false);
  assert.deepEqual(next.budget, updated);
});

test("L1 和普通阶段在第 8/35 次预警，重复 started 不重置同阶段预算", () => {
  for (const [profile, limit] of [["fast", 8], ["standard", 35]]) {
    const task = { workflowProfile: profile, createdAt: "2026-09-09T00:00:00Z" };
    const state = { compactions: 0, requests: Array.from({ length: limit - 1 }, () => ({ at: Date.parse(task.createdAt), input: 1 })) };
    assert.equal(budgetSnapshot(state, task).handoff_recommended, false);
    state.requests.push({ at: Date.parse(task.createdAt), input: 1 });
    const result = budgetSnapshot(state, task);
    assert.equal(result.handoff_recommended, true);
    assert.equal(result.handoff_required, false);
    assert.equal(result.new_session_required, false);
    assert.deepEqual(result.recommendation_reasons, ["request_budget_exhausted"]);
    assert.deepEqual(result.allowed_operations, ["diagnose", "checkpoint", "task_close", "handoff", "implement", "query", "verify"]);
    task.phaseEvents = [0, 1].map((hour) => ({ phase: "implementation", transition: "started", occurred_at: `2026-09-09T0${hour}:00:00Z` }));
    assert.equal(budgetSnapshot(state, task).handoff_recommended, true);
  }
  assert.equal(budgetSnapshot({ requests: [], compactions: 2 }).new_session_recommended, true);
  assert.equal(budgetSnapshot(null).continuation_count.session, null);
});

test("实时读取只消费完整新增行，重复用量不重复计数，二次压缩建议新 Session", async () => {
  const root = await mkdtemp(join(tmpdir(), "request-budget-"));
  const id = "019f0000-0000-7000-8000-000000000001";
  const path = join(root, `${id}.jsonl`);
  const usage = { type: "event_msg", timestamp: "2026-09-09T00:00:00Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10 }, total_token_usage: { input_tokens: 10 } } } };
  try {
    await writeFile(path, JSON.stringify({ type: "session_meta", payload: { id } }) + "\n" + JSON.stringify(usage) + "\n");
    assert.equal((await readRequestBudget(id, root)).continuation_count.session, 1);
    await appendFile(path, JSON.stringify(usage) + "\n" + JSON.stringify({ type: "compacted" }) + "\n" + JSON.stringify({ type: "compacted" }));
    assert.equal((await readRequestBudget(id, root)).compaction_count, 1);
    await appendFile(path, "\n");
    const result = await readRequestBudget(id, root);
    assert.equal(result.new_session_recommended, true);
    assert.equal(result.new_session_required, false);
    assert.equal(result.handoff_required, false);
    assert.deepEqual(result.recommendation_reasons, ["second_compaction"]);
    assert.equal(result.continuation_count.session, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("返回同一阶段时累计该阶段请求，不混入中间其他阶段", () => {
  const at = (hour) => Date.parse(`2026-09-09T0${hour}:00:00Z`);
  const task = { createdAt: new Date(at(0)).toISOString(), workflowProfile: "standard", phaseEvents: ["implementation", "review", "implementation"].map((phase, hour) => ({ phase, transition: "started", occurred_at: new Date(at(hour)).toISOString() })) };
  const requests = [5, 30, 1].flatMap((count, hour) => Array.from({ length: count }, () => ({ at: at(hour), input: 1 })));
  const budget = budgetSnapshot({ requests, compactions: 0 }, task);
  assert.equal(budget.continuation_count.task, 36);
  assert.equal(budget.continuation_count.phase, 6);
  assert.equal(budget.handoff_recommended, false);
});

test("历史 Session 文件在缓存后消失不阻断新 Session，缺失计数保持未知", async () => {
  const root = await mkdtemp(join(tmpdir(), "request-budget-missing-"));
  const previous = "019f0000-0000-7000-8000-000000000002";
  const current = "019f0000-0000-7000-8000-000000000003";
  const record = (id) => JSON.stringify({ type: "session_meta", payload: { id } }) + "\n";
  try {
    await writeFile(join(root, `${previous}.jsonl`), record(previous));
    await writeFile(join(root, `${current}.jsonl`), record(current));
    await readRequestBudget(previous, root);
    await rm(join(root, `${previous}.jsonl`));
    const result = await readRequestBudget(current, root, { sessionHistory: [previous] });
    assert.equal(result.continuation_count.session, 0);
    assert.equal(result.continuation_count.task, null);
    assert.equal(result.token_budget.input_used, null);
    assert.equal(result.handoff_recommended, false);
    assert.equal((await readRequestBudget(previous, root)).source, "unavailable");
    await writeFile(join(root, `restored-${previous}.jsonl`), record(previous));
    assert.equal((await readRequestBudget(previous, root)).source, "session_jsonl_incremental");
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("超限和两次压缩的建议及原因保留在默认摘要，不收缩操作", () => {
  const budget = budgetSnapshot({ requests: Array.from({ length: 38 }, () => ({ input: 1 })), compactions: 2 });
  for (const extra of [{ contract: "x".repeat(5000) }, { active_task: { id: "x".repeat(5000) } }]) {
  const result = boundedResponse({ ...budget, ...extra });
  assert.equal(result.handoff_required, false);
  assert.equal(result.new_session_required, false);
  assert.equal(result.handoff_recommended, true);
  assert.equal(result.new_session_recommended, true);
  assert.deepEqual(result.recommendation_reasons, ["request_budget_exhausted", "second_compaction"]);
  assert.ok(result.allowed_operations.includes("implement"));
  assert.equal(result.continuation_count.phase, 38);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4096);
  }
});


test("异步查找冷会话保持最新文件选择并返回缺失结果", async () => {
  const root = await mkdtemp(join(tmpdir(), "budget-discovery-"));
  const id = "019f0000-0000-7000-8000-000000000004";
  try {
    await mkdir(join(root, "nested"));
    const old = join(root, `${id}.jsonl`);
    const newest = join(root, "nested", `${id}.jsonl`);
    await writeFile(old, JSON.stringify({ type: "session_meta", payload: { id } }) + "\n");
    await writeFile(newest, JSON.stringify({ type: "session_meta", payload: { id } }) + "\n");
    await utimes(old, new Date(1000), new Date(1000));
    await utimes(newest, new Date(2000), new Date(2000));
    assert.equal(await findSessionPathAsync(id, root), newest);
    assert.equal((await readRequestBudget(id, root)).source, "session_jsonl_incremental");
    assert.equal(await findSessionPathAsync("absent", root), "");
    assert.equal(await findSessionPathAsync(id, join(root, "missing")), "");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("慢目录发现不阻塞预算截止或事件循环，迟到读取仍可完成", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const io = {
    async readdir() { entered(); await gate; return []; },
    async stat() { throw new Error("unexpected stat"); },
  };
  const pending = findSessionPathAsync("missing", "/ignored", io);
  await started;
  try {
    const result = await readPreparationBudget(null, async () => {
      await pending;
      return budgetSnapshot(null);
    }, 20);
    assert.equal(result.timedOut, true);
    assert.equal(result.budget.source, "unavailable");
  } finally { release(); }
  assert.equal(await pending, "");
});


test("并发预算读取共享冷会话结果但分别投影任务配置", async () => {
  const root = await mkdtemp(join(tmpdir(), "budget-concurrent-"));
  const id = "019f0000-0000-7000-8000-000000000005";
  try {
    await writeFile(join(root, `${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id } }) + "\n");
    const [fast, standard] = await Promise.all([
      readRequestBudget(id, root, { workflowProfile: "fast" }),
      readRequestBudget(id, root, { workflowProfile: "standard" }),
    ]);
    assert.equal(fast.source, "session_jsonl_incremental");
    assert.equal(standard.source, "session_jsonl_incremental");
    assert.equal(fast.request_limit, 8);
    assert.equal(standard.request_limit, 35);
  } finally { await rm(root, { recursive: true, force: true }); }
});
