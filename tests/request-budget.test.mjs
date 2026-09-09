import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgetSnapshot, readRequestBudget } from "../scripts/request-budget.mjs";

test("L1 和普通阶段在第 8/35 次到限，重复 started 不重置同阶段预算", () => {
  for (const [profile, limit] of [["fast", 8], ["standard", 35]]) {
    const task = { workflowProfile: profile, createdAt: "2026-09-09T00:00:00Z" };
    const state = { compactions: 0, requests: Array.from({ length: limit - 1 }, () => ({ at: Date.parse(task.createdAt), input: 1 })) };
    assert.equal(budgetSnapshot(state, task).handoff_required, false);
    state.requests.push({ at: Date.parse(task.createdAt), input: 1 });
    const result = budgetSnapshot(state, task);
    assert.equal(result.handoff_required, true);
    assert.deepEqual(result.allowed_operations, ["diagnose", "checkpoint", "task_close", "handoff"]);
    task.phaseEvents = [0, 1].map((hour) => ({ phase: "implementation", transition: "started", occurred_at: `2026-09-09T0${hour}:00:00Z` }));
    assert.equal(budgetSnapshot(state, task).handoff_required, true);
  }
  assert.equal(budgetSnapshot({ requests: [], compactions: 2 }).new_session_required, true);
  assert.equal(budgetSnapshot(null).continuation_count.session, null);
});

test("实时读取只消费完整新增行，重复用量不重复计数，二次压缩要求新 Session", async () => {
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
    assert.equal(result.new_session_required, true);
    assert.equal(result.continuation_count.session, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
