import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentGuidance, aiActivity, collaborationRules, governanceSnapshot } from "../scripts/ai-governance.mjs";
import { boundedResponse } from "../scripts/bounded-response.mjs";

const subject = value => ({ type: "artifact", value, observed_at: "2026-10-12T00:00:00Z" });
const task = { id: "collaborate", title: "交付", goal: "完成交付", scope: ["core"], contractVersion: "v2", status: "in_progress", workflowProfile: "standard", acceptanceCriteria: [{ id: "ac", description: "正确", required: true }], verificationPlan: [{ id: "verify", kind: "test", required: true }], currentSubject: subject("v2"), requirementResults: [{ requirement_id: "ac", status: "passed", subject_ref: subject("v2") }], verificationClaims: [{ id: "old", requirement_id: "verify", kind: "test", status: "passed", subject_ref: subject("v1"), evidence_ref: "/tmp/test.log" }] };
const result = { summary: "修复证据绑定后继续", findings: [{ severity: "medium", basis: "observed", message: "版本不同", evidence_refs: ["readiness"] }], next_steps: ["核对真实证据与版本，追加新 claim"] };

test("规则协作提供绑定修复而非盲目重跑，保留任务契约及独立验收", () => {
  const before = JSON.stringify(task);
  const guidance = collaborationRules(task);
  assert.equal(guidance.advisory_only, true);
  assert.match(guidance.steps.find(x => x.id === "binding").action, /对象变化时补做受影响验证/);
  assert.match(guidance.steps.find(x => x.id === "portable").action, /不编造日志/);
  const missing = collaborationRules({ ...task, verificationClaims: [] });
  assert.match(missing.steps.find(x => x.id === "missing").action, /不因.*停工/);
  const blocked = collaborationRules({ ...task, status: "blocked", blocker: "模型不可用" });
  assert.match(blocked.steps.find(x => x.id === "recovery").action, /结果未知先查状态/);
  assert.match(collaborationRules({ ...task, blocker: "EACCES sandbox" }).steps.find(x => x.id === "recovery").reason, /filesystem_permission/);
  assert.match(collaborationRules({ id: "new", status: "planned" }).steps[0].action, /只有.*实质歧义才询问/);
  assert.equal(JSON.stringify(task), before);
  assert.equal(agentGuidance(null), null);
});

test("仅消费当前快照的有效 AI 结果；日志损坏、缺失及输出异常均保留规则", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ai-collaboration-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "activity");
  const row = { id: "receipt", run_id: "run", task_id: task.id, status: "succeeded", source: "governance", at: "2026-10-12T00:00:00Z", input_hash: governanceSnapshot(task, "evidence").input_hash, result };
  await writeFile(path, `broken\n${JSON.stringify(row)}\n`);
  assert.deepEqual(agentGuidance(task, path).ai.next_steps, result.next_steps);
  assert.equal(agentGuidance({ ...task, currentSubject: subject("v3") }, path).ai, undefined);
  assert.equal(agentGuidance({ ...task, scope: ["different"] }, path).ai, undefined);
  await writeFile(path, JSON.stringify({ ...row, result: { ...result, findings: [{ ...result.findings[0], evidence_refs: ["invented"] }] } }));
  assert.equal(agentGuidance(task, path).ai, undefined);
  assert.ok(agentGuidance(task, dir).steps.length);
  assert.ok(agentGuidance(task, join(dir, "missing")).steps.length);
  const long = { ...task, goal: "x".repeat(3000) };
  assert.notEqual(governanceSnapshot(long, "evidence").input_hash, governanceSnapshot({ ...long, goal: long.goal + "y" }, "evidence").input_hash);
});

test("行为页后续事实来自账本，内容变化不等于建议已执行；响应截断保留可继续动作", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ai-follow-up-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "activity");
  await writeFile(path, JSON.stringify({ id: "row", source: "governance", task_id: task.id, at: "2026-10-12T00:00:00Z", snapshot: governanceSnapshot(task, "evidence"), result }) + "\n");
  const activity = await aiActivity({ path, jevPath: join(dir, "missing"), tasks: [{ ...task, status: "done_claimed", verificationStatus: "stale", acceptanceStatus: "pending" }] });
  assert.equal(activity.rows[0].follow_up.changed_since_analysis, true);
  assert.equal(activity.rows[0].follow_up.acceptance_status, "pending");
  assert.match(activity.rows[0].follow_up.attribution, /未确认.*不能据此推断因果/);
  const response = boundedResponse({ accepted: true, task_id: task.id, agent_guidance: collaborationRules(task), evidence: "x".repeat(9000) });
  assert.ok(response.agent_guidance.steps[0].action);
  assert.equal(response.agent_guidance.advisory_only, true);
  assert.ok(response.continuation_cursor);
  assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 4096);
});
