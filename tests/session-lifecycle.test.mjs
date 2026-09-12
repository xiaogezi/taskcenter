import test from "node:test";
import assert from "node:assert/strict";
import { recommendSessionLifecycle, machineHandoff, recommendTaskClose } from "../scripts/session-lifecycle.mjs";

test("机器交接包保留 task 身份，转义密集长字段仍不超过 2KB", () => {
  const packet = machineHandoff({ id: "task-1", sessionId: "s1", goal: "\u0000".repeat(1000), nextAction: "\u0000".repeat(1000), currentSubject: { type: "artifact", value: "\u0000".repeat(500) } });
  assert.equal(packet.task_id, "task-1");
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 2048);
});

const task = {
  title: "实现用量治理",
  goal: "生成可靠的用量报告",
  scope: ["Session JSONL", "Task ledger"],
  currentSubject: { type: "git_worktree_snapshot", value: "snapshot-1" },
  changedFiles: ["scripts/usage-report.mjs"],
  verificationStatus: "passed",
  reviewStatus: "pending",
  openQuestions: ["官方费率缺失"],
  nextAction: "补充独立审查",
  status: "in_progress",
};

test("无生命周期信号时继续当前 Session", () => {
  const result = recommendSessionLifecycle({ usage: { alerts: [] }, tasks: [task], currentTask: task });
  assert.equal(result.action, "continue_current_session");
  assert.equal(result.handoff, "");
});

test("压缩或用量压力建议新建 Codex Session 并生成有界交接包", () => {
  const result = recommendSessionLifecycle({
    usage: { alerts: [{ code: "COMPRESSED_AFTER_MAIN_PHASE" }, { code: "MODEL_CONTINUATIONS_HIGH" }] },
    tasks: [task], currentTask: task,
  });
  assert.equal(result.action, "recommend_new_codex_session");
  assert.match(result.handoff, /目标：生成可靠的用量报告/);
  assert.match(result.handoff, /顺序承载多个任务/);
  assert.ok(Buffer.byteLength(result.handoff) <= 2_048);
});

test("项目变化要求先交接", () => {
  const result = recommendSessionLifecycle({ usage: { projectChanged: true, alerts: [] }, tasks: [task], currentTask: task });
  assert.equal(result.action, "require_handoff_before_continue");
  assert.deepEqual(result.reasons, ["project_changed"]);
});

test("相邻正式任务目标变化可继续同一 Session", () => {
  const result = recommendSessionLifecycle({
    usage: { alerts: [] },
    tasks: [
      { ...task, goal: "完成用量报告", createdAt: "2026-08-20T00:00:00Z", status: "done_claimed" },
      { ...task, goal: "实现登录页面", createdAt: "2026-08-20T01:00:00Z", status: "in_progress" },
    ],
  });
  assert.equal(result.action, "continue_current_session");
  assert.deepEqual(result.reasons, []);
});

test("同一 Session 完成多个独立任务时仍可继续创建新任务", () => {
  const result = recommendSessionLifecycle({
    usage: { alerts: [] },
    tasks: [{ ...task, status: "done_claimed" }, { ...task, title: "另一交付", status: "verified" }],
  });
  assert.equal(result.action, "continue_current_session");
  assert.match(result.taskSemantics, /顺序承载多个/);
});


test("task_close 按新目标、上下文和预计续轮给出建议", () => {
  for (const context_large of [false, true]) {
    for (const expected_more_rounds of [false, true]) {
      assert.equal(recommendTaskClose({ new_independent_goal: true, context_large, expected_more_rounds }).action, context_large && expected_more_rounds ? "recommend_compact" : "continue");
      assert.equal(recommendTaskClose({ context_large, expected_more_rounds }).action, context_large && expected_more_rounds ? "recommend_compact" : "continue");
    }
  }
  assert.equal(recommendTaskClose().action, "continue");
});
