import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const directory = await mkdtemp(join(tmpdir(), "task-reuse-advisor-"));
process.env.TASKCENTER_TASK_REUSE_DECISIONS_PATH = join(directory, "task-reuse-decisions.jsonl");

const {
  loadTaskReuseDecisions,
  recordTaskReuseDecision,
  summarizeTaskReuseDecisions,
  taskReuseCheck,
  taskReuseDecisionIndexPath,
  taskReuseDecisionsPath,
  TaskReuseAdvisorError,
} = await import("../scripts/task-reuse-advisor.mjs");

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

const owner = { type: "human", id: "owner-a", provider: "local" };
const baseRequest = {
  workspace: "/projects/alpha",
  project_id: "alpha",
  session_id: "session-new",
  context_task_id: "context-fcm",
  title: "继续完善 FCM 推送链路",
  goal: "补齐 FCM 通知的失败重试和送达验证",
  scope: ["FCM notification delivery"],
};

function task(overrides = {}) {
  return {
    id: "task-fcm",
    sessionId: "session-existing",
    ownerActor: owner,
    workspace: "/projects/alpha",
    title: "实现 FCM 推送链路",
    goal: "完成 FCM 通知发送、失败重试和送达验证",
    scope: ["FCM notification delivery"],
    status: "in_progress",
    contextTaskId: "context-fcm",
    executionEnvironment: "local",
    updatedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function check(request, tasks, options = {}) {
  return taskReuseCheck(request, {
    tasks,
    sessionRegistry: options.sessionRegistry || {},
    delegations: options.delegations || [],
    canonicalSessionId: (value) => String(value || ""),
    now: "2026-09-02T01:00:00.000Z",
  });
}

test("相同 context_task_id 与 workspace 会召回候选，身份未知时保持 uncertain", () => {
  const result = check(baseRequest, [task({ status: "done_claimed" })]);
  assert.equal(result.recommendation, "uncertain");
  assert.equal(result.advisory_only, true);
  assert.equal(result.candidates[0].task_id, "task-fcm");
  assert.ok(result.candidates[0].match_reasons.includes("same_context_task_id"));
  assert.ok(result.candidates[0].match_reasons.includes("done_claimed_pending_acceptance"));
});

test("相同 context、workspace 与 Session 时可给出强复用建议", () => {
  const result = check(baseRequest, [task({ sessionId: "session-new", status: "done_claimed" })]);
  assert.equal(result.recommendation, "reuse");
  assert.ok(result.candidates[0].match_reasons.includes("same_session"));
});

test("同一 Session 的 FCM 追加要求返回 reuse 或 uncertain", () => {
  const request = { ...baseRequest, context_task_id: "", session_id: "session-existing" };
  const result = check(request, [task({ contextTaskId: undefined })]);
  assert.ok(["reuse", "uncertain"].includes(result.recommendation));
  assert.ok(result.candidates[0].match_reasons.includes("same_session"));
  assert.ok(result.candidates[0].semantic_similarity >= 0.3);
});

test("同仓库或同 Session 但独立目标不会得到强复用建议", () => {
  const request = {
    ...baseRequest,
    context_task_id: "",
    session_id: "session-existing",
    title: "升级账单导出格式",
    goal: "为财务报表增加 PDF 分页和水印",
    scope: ["billing PDF export"],
  };
  const result = check(request, [task({ contextTaskId: undefined })]);
  assert.notEqual(result.recommendation, "reuse");
  assert.equal(result.candidates[0].semantic_similarity, 0);
});

test("不同 Worktree 和 Owner 即使 context 相同也不会强复用", () => {
  const requesterTask = task({
    id: "task-requester",
    sessionId: "session-new",
    contextTaskId: "other-context",
    ownerActor: owner,
  });
  const otherOwnerTask = task({
    workspace: "/worktrees/alpha-other",
    executionEnvironment: "worktree",
    ownerActor: { type: "human", id: "owner-b", provider: "local" },
  });
  const result = check(baseRequest, [requesterTask, otherOwnerTask], {
    sessionRegistry: { "session-existing": { projectId: "alpha" } },
  });
  const candidate = result.candidates.find((item) => item.task_id === "task-fcm");
  assert.ok(candidate.conflicts.includes("different_worktree"));
  assert.ok(candidate.conflicts.includes("different_owner"));
  assert.notEqual(result.recommendation, "reuse");
});

test("同 workspace 但不同 Owner 时不会把 context 命中升级为强复用", () => {
  const requesterTask = task({
    id: "task-requester-owner",
    sessionId: "session-new",
    contextTaskId: "other-context",
    ownerActor: owner,
  });
  const otherOwnerTask = task({
    ownerActor: { type: "human", id: "owner-b", provider: "local" },
  });
  const result = check(baseRequest, [requesterTask, otherOwnerTask]);
  const candidate = result.candidates.find((item) => item.task_id === "task-fcm");
  assert.ok(candidate.conflicts.includes("different_owner"));
  assert.notEqual(result.recommendation, "reuse");
});

test("取消、归档和被替代任务被排除，done_claimed 仍可召回", () => {
  const result = check(baseRequest, [
    task({ id: "cancelled", status: "cancelled" }),
    task({ id: "archived", archivedAt: "2026-09-01T00:00:00.000Z" }),
    task({ id: "superseded", supersededBy: "replacement" }),
    task({ id: "verified", status: "verified" }),
    task({ id: "claimed", status: "done_claimed" }),
  ]);
  assert.deepEqual(result.candidates.map((item) => item.task_id), ["claimed"]);
});

test("Advisor 查询本身不创建任何审计或任务写入", () => {
  assert.equal(existsSync(taskReuseDecisionsPath), false);
  check(baseRequest, [task()]);
  assert.equal(existsSync(taskReuseDecisionsPath), false);
});

test("最终选择与 force_new_reason append-only 记录并保持语义幂等", async () => {
  const input = {
    event_id: "decision-force-new-1",
    check_id: "reuse-check-example",
    session_id: "session-new",
    workspace: "/projects/alpha",
    project_id: "alpha",
    context_task_id: "context-fcm",
    title: "FCM 独立供应商迁移",
    recommendation: "uncertain",
    confidence: 0.62,
    candidate_task_ids: ["task-fcm"],
    match_reasons: ["same_context_task_id", "different_worktree"],
    final_decision: "create_new",
    force_new_reason: "独立供应商迁移、独立 Owner 和独立发布窗口，需要单独交付。",
    occurred_at: "2026-09-02T02:00:00.000Z",
  };
  const first = recordTaskReuseDecision(input, { now: "2026-09-02T02:00:01.000Z" });
  const replay = recordTaskReuseDecision(input, { now: "2026-09-02T02:00:02.000Z" });
  assert.equal(first.idempotent, false);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.record.force_new_reason, input.force_new_reason);
  await rm(join(taskReuseDecisionIndexPath, "state.json"), { force: true });
  assert.equal(recordTaskReuseDecision(input).idempotent, true, "索引状态丢失后从 JSONL 恢复幂等记录");
  assert.equal((await readFile(taskReuseDecisionsPath, "utf8")).trim().split("\n").length, 1);
  assert.equal(loadTaskReuseDecisions({ project_id: "alpha" })[0].final_decision, "create_new");
  assert.deepEqual(summarizeTaskReuseDecisions(loadTaskReuseDecisions({ project_id: "alpha" })), {
    schema_version: "taskcenter-task-reuse-decision-summary-v1",
    decision_count: 1,
    project_count: 1,
    recommendations: { reuse: 0, create_new: 0, uncertain: 1 },
    final_decisions: { reuse: 0, create_new: 1, uncertain: 0 },
    agreement_count: 0,
    agreement_rate: 0,
    force_new_reason_count: 1,
    automatic_block_count: 0,
    automatic_merge_count: 0,
  });
  assert.throws(
    () => recordTaskReuseDecision({ ...input, force_new_reason: "冲突原因" }),
    (error) => error instanceof TaskReuseAdvisorError && error.statusCode === 409,
  );
  for (let index = 0; index < 105; index += 1) {
    recordTaskReuseDecision({
      ...input,
      event_id: `decision-retention-${index}`,
      recommendation: "create_new",
      final_decision: "create_new",
      candidate_task_ids: [],
      match_reasons: [],
      force_new_reason: "独立交付目标。",
    });
  }
  assert.equal(recordTaskReuseDecision(input).idempotent, true, "旧 event_id 超出查询窗口后仍须幂等");
  assert.equal((await readFile(taskReuseDecisionsPath, "utf8")).trim().split("\n").length, 106);
});

test("覆盖复用建议新建时缺少 force_new_reason 会被拒绝", () => {
  assert.throws(
    () => recordTaskReuseDecision({
      event_id: "decision-invalid-force-new",
      check_id: "reuse-check-example",
      session_id: "session-new",
      workspace: "/projects/alpha",
      project_id: "alpha",
      recommendation: "reuse",
      confidence: 0.9,
      candidate_task_ids: ["task-fcm"],
      match_reasons: ["same_context_task_id"],
      final_decision: "create_new",
      occurred_at: "2026-09-02T02:00:00.000Z",
    }),
    (error) => error instanceof TaskReuseAdvisorError && error.statusCode === 400,
  );
});

test("跨进程并发记录保持 event_id 唯一并拒绝冲突 payload", async () => {
  const input = {
    event_id: "decision-cross-process-same",
    check_id: "reuse-check-cross-process",
    session_id: "session-new",
    workspace: "/projects/alpha",
    project_id: "alpha",
    context_task_id: "context-fcm",
    title: "FCM 并发审计",
    recommendation: "uncertain",
    confidence: 0.62,
    candidate_task_ids: ["task-fcm"],
    match_reasons: ["same_context_task_id"],
    final_decision: "uncertain",
    occurred_at: "2026-09-02T02:30:00.000Z",
  };
  const sameResults = await Promise.all(Array.from({ length: 12 }, () => runDecisionWorker(input)));
  assert.equal(sameResults.filter((result) => result.ok && result.idempotent === false).length, 1);
  assert.equal(sameResults.filter((result) => result.ok && result.idempotent === true).length, 11);
  assert.equal(loadTaskReuseDecisions({ limit: 500 }).filter((record) => record.event_id === input.event_id).length, 1);

  const conflictingEventId = "decision-cross-process-conflict";
  const conflictingResults = await Promise.all(Array.from({ length: 12 }, (_, index) => runDecisionWorker({
    ...input,
    event_id: conflictingEventId,
    final_decision: index % 2 === 0 ? "uncertain" : "create_new",
    force_new_reason: index % 2 === 0 ? undefined : "独立交付边界。",
  })));
  assert.equal(conflictingResults.filter((result) => result.ok && result.idempotent === false).length, 1);
  assert.ok(conflictingResults.some((result) => !result.ok && result.statusCode === 409));
  assert.equal(loadTaskReuseDecisions({ limit: 500 }).filter((record) => record.event_id === conflictingEventId).length, 1);
});

function runDecisionWorker(input) {
  const moduleUrl = new URL("../scripts/task-reuse-advisor.mjs", import.meta.url).href;
  const script = `
const { recordTaskReuseDecision } = await import(process.env.TASK_REUSE_ADVISOR_MODULE_URL);
try {
  const result = recordTaskReuseDecision(JSON.parse(process.env.TASK_REUSE_ADVISOR_INPUT));
  console.log(JSON.stringify({ ok: true, idempotent: result.idempotent, finalDecision: result.record.final_decision }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, statusCode: error.statusCode || 500, message: error.message }));
}
`;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      env: {
        ...process.env,
        TASK_REUSE_ADVISOR_MODULE_URL: moduleUrl,
        TASK_REUSE_ADVISOR_INPUT: JSON.stringify(input),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`复用决策并发 worker 失败：${stderr || code}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout.trim()));
      } catch {
        rejectPromise(new Error(`复用决策并发 worker 返回无效结果：${stdout || stderr}`));
      }
    });
  });
}
