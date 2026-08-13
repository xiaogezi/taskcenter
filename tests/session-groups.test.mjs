import assert from "node:assert/strict";
import test from "node:test";
import { groupSessions, mergeTaskSessions, sessionIdsForGroup, filterThreadsWithRequirements, filterThreadsWithTasks, requirementThreadIds } from "../app/session-groups.mjs";

test("同名 Codex 会话归并为一个组并保留全部 sessionId", () => {
  const groups = groupSessions([
    { id: "session-1", title: "TaskCenter 任务", updatedAt: "2026-07-23T01:00:00Z" },
    { id: "session-2", title: " TaskCenter   任务 ", updatedAt: "2026-07-23T02:00:00Z" },
    { id: "session-3", title: "另一个任务" },
  ]);

  assert.equal(groups.length, 2);
  const taskcenter = groups.find((group) => group.title === "TaskCenter 任务");
  assert.deepEqual(taskcenter?.sessionIds, ["session-1", "session-2"]);
  assert.equal(taskcenter?.sessionCount, 2);
});

test("没有标题的会话不会被错误合并", () => {
  const groups = groupSessions([
    { id: "session-1", title: "" },
    { id: "session-2", title: "" },
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(sessionIdsForGroup(groups[0].id, groups), ["session-1"]);
});

test("会话组按组内最新修改时间倒序排列", () => {
  const groups = groupSessions([
    { id: "old", title: "旧会话", updatedAt: "2026-07-23T01:00:00Z" },
    { id: "new", title: "新会话", updatedAt: "2026-07-23T03:00:00Z" },
    { id: "same-name-latest", title: "旧会话", updatedAt: "2026-07-23T04:00:00Z" },
  ]);

  assert.deepEqual(groups.map((group) => group.title), ["旧会话", "新会话"]);
  assert.deepEqual(groups[0].sessionIds, ["old", "same-name-latest"]);
});

test("requirementThreadIds 提取需求关联的所有 threadId", () => {
  const requirements = [
    { threadId: "thread-1" },
    { sources: [{ threadId: "thread-2" }] },
    { source: { threadId: "thread-3" } },
    { threadId: "thread-1", sources: [{ threadId: "thread-4" }] },
  ];

  const ids = requirementThreadIds(requirements);
  assert.deepEqual([...ids].sort(), ["thread-1", "thread-2", "thread-3", "thread-4"]);
});

test("filterThreadsWithRequirements 排除无需求关联的会话", () => {
  const threads = [
    { id: "thread-1", title: "有需求" },
    { id: "thread-2", title: "无需求" },
    { id: "thread-3", title: "通过 sources 关联" },
    { id: "thread-4", title: "会话组包含需求" },
  ];

  const requirements = [
    { threadId: "thread-1" },
    { sources: [{ threadId: "thread-3" }] },
  ];

  const filtered = filterThreadsWithRequirements(threads, requirements);
  assert.deepEqual(filtered.map((t) => t.id), ["thread-1", "thread-3"]);
});

test("filterThreadsWithRequirements 支持会话组 sessionIds 匹配", () => {
  const threads = [
    { id: "group-1", title: "会话组", sessionIds: ["thread-1", "thread-2"] },
    { id: "thread-3", title: "无需求" },
  ];

  const requirements = [{ threadId: "thread-1" }];

  const filtered = filterThreadsWithRequirements(threads, requirements);
  assert.deepEqual(filtered.map((t) => t.id), ["group-1"]);
});

test("filterThreadsWithRequirements 保留有任务但没有需求卡片的会话", () => {
  const threads = [
    { id: "thread-task", title: "只有任务" },
    { id: "thread-empty", title: "没有数据" },
  ];

  const filtered = filterThreadsWithRequirements(threads, [], [{ sessionId: "thread-task" }]);
  assert.deepEqual(filtered.map((t) => t.id), ["thread-task"]);
});

test("filterThreadsWithTasks 不因需求卡片保留无任务会话", () => {
  const threads = [
    { id: "thread-task", title: "有任务" },
    { id: "thread-atlas", title: "atlas" },
  ];

  const filtered = filterThreadsWithTasks(threads, [{ sessionId: "thread-task" }]);
  assert.deepEqual(filtered.map((t) => t.id), ["thread-task"]);
});

test("已登记但不在 Codex 来源中的任务 Session 会补齐到左侧来源", () => {
  const merged = mergeTaskSessions(
    [{ id: "codex-session", title: "Codex 会话" }],
    [{ id: "task-external", sessionId: "external-session", title: "Claude 文件修改", workspace: "/work", status: "in_progress", updatedAt: "2026-07-26T04:00:00Z" }],
    { "external-session": { agent: "claude", status: "registered" } },
  );

  const external = merged.find((thread) => thread.id === "external-session");
  assert.equal(external?.title, "Claude 文件修改");
  assert.equal(external?.sessionSource, "task-ledger");
  assert.deepEqual(external?.sessionIds, ["external-session"]);
});

test("已有同一个真实 Session 时不会重复补齐", () => {
  const merged = mergeTaskSessions(
    [{ id: "same-session", title: "真实会话" }],
    [{ id: "task-1", sessionId: "same-session", title: "任务" }],
  );

  assert.equal(merged.filter((thread) => thread.id === "same-session").length, 1);
});
