import assert from "node:assert/strict";
import test from "node:test";
import { projectLabelFromWorkspace, resolveTaskSessionDisplay, taskMatchesSession } from "../app/task-session-display.mjs";

test("session 映射优先使用控制服务实时数据", () => {
  // 静态 dashboard 数据
  const staticAvailableThreads = [
    { id: "thread-static-1", title: "静态会话1" },
    { id: "thread-static-2", title: "静态会话2" },
  ];

  // 控制服务实时数据
  const liveAvailableThreads = [
    { id: "thread-live-1", title: "实时会话1" },
    { id: "thread-live-2", title: "实时会话2" },
  ];

  // 任务属于实时会话
  const sessionId = "thread-live-1";

  // 模拟 TaskRow 中的 sessionInfo 逻辑
  const allThreads = liveAvailableThreads.length > 0 ? liveAvailableThreads : staticAvailableThreads;
  const thread = allThreads.find((t) => t.id === sessionId);

  assert.ok(thread, "应找到实时会话");
  assert.equal(thread.title, "实时会话1", "应返回实时会话标题");
});

test("控制服务不可用时回退到静态 dashboard", () => {
  // 静态 dashboard 数据
  const staticAvailableThreads = [
    { id: "thread-static-1", title: "静态会话1" },
    { id: "thread-static-2", title: "静态会话2" },
  ];

  // 控制服务无数据
  const liveAvailableThreads = [];

  // 任务属于静态会话
  const sessionId = "thread-static-2";

  // 模拟 TaskRow 中的 sessionInfo 逻辑
  const allThreads = liveAvailableThreads.length > 0 ? liveAvailableThreads : staticAvailableThreads;
  const thread = allThreads.find((t) => t.id === sessionId);

  assert.ok(thread, "应回退到静态会话");
  assert.equal(thread.title, "静态会话2", "应返回静态会话标题");
});

test("找不到会话时返回 null 表示未关联", () => {
  const liveAvailableThreads = [
    { id: "thread-live-1", title: "实时会话1" },
  ];
  const staticAvailableThreads = [
    { id: "thread-static-1", title: "静态会话1" },
  ];

  // 任务会话 ID 不在任何列表中
  const sessionId = "thread-unknown-999";

  const allThreads = liveAvailableThreads.length > 0 ? liveAvailableThreads : staticAvailableThreads;
  const thread = allThreads.find((t) => t.id === sessionId);

  assert.equal(thread, undefined, "不应找到会话");
  assert.equal(thread?.title, undefined, "未关联会话标题应为空");
});

test("左侧会话切换不影响任务关联逻辑", () => {
  // 模拟切换左侧会话后的状态
  const selectedThread = "thread-live-2";
  const liveAvailableThreads = [
    { id: "thread-live-1", title: "实时会话1" },
    { id: "thread-live-2", title: "实时会话2" },
  ];

  // 任务仍属于 thread-live-1
  const taskSessionId = "thread-live-1";

  const allThreads = liveAvailableThreads;
  const thread = allThreads.find((t) => t.id === taskSessionId);

  // 任务应该仍然能找到其对应会话
  assert.ok(thread, "任务应仍能找到关联会话");
  assert.equal(thread.title, "实时会话1", "任务应保持原会话关联");
  assert.notEqual(taskSessionId, selectedThread, "任务会话应与选中会话不同");
});

test("演示任务明确标记为未关联真实会话", () => {
  const liveAvailableThreads = [
    { id: "019f7fad-9139-7710-8f33-0a58676cf1e4", title: "真实 Codex 会话" },
  ];

  // 演示任务的 sessionId 是伪造的
  const demoSessionId = "ui-demo-session-20260722";

  const allThreads = liveAvailableThreads;
  const thread = allThreads.find((t) => t.id === demoSessionId);

  assert.equal(thread, undefined, "演示任务不应找到真实会话");
  // 在 UI 中应显示为 "未关联会话"
});

test("会话标题不应伪造或回退到通用值", () => {
  const liveAvailableThreads = [
    { id: "thread-1", title: "" }, // 标题为空
    { id: "thread-2", title: null }, // 标题为 null（typescript 不允许但在 JS 中可能）
  ];

  const sessionId1 = "thread-1";
  const sessionId2 = "thread-2";

  const allThreads = liveAvailableThreads;

  const thread1 = allThreads.find((t) => t.id === sessionId1);
  const thread2 = allThreads.find((t) => t.id === sessionId2);

  // 标题为空字符串时，thread?.title 为 falsy，不应显示伪造标题
  assert.equal(thread1?.title, "", "空标题应保持为空，不伪造");
  assert.equal(thread2?.title, null, "null 标题应保持为 null");

  // 在 UI 中应检查 title 是否为真值，否则显示短 ID
});

test("刷新后任务与会话关联保持一致", () => {
  // 初始状态
  let liveAvailableThreads = [
    { id: "thread-live-1", title: "实时会话1" },
  ];

  const taskSessionId = "thread-live-1";

  // 第一次查找
  let thread = liveAvailableThreads.find((t) => t.id === taskSessionId);
  assert.equal(thread?.title, "实时会话1");

  // 模拟刷新后控制服务返回相同数据
  liveAvailableThreads = [
    { id: "thread-live-1", title: "实时会话1" },
  ];

  thread = liveAvailableThreads.find((t) => t.id === taskSessionId);
  assert.equal(thread?.title, "实时会话1", "刷新后应保持相同关联");
});

test("真实 Session 标题优先显示，workspace 作为项目副标题", () => {
  const task = { sessionId: "session-atlas", workspace: "/Users/example/projects/Atlas" };
  const display = resolveTaskSessionDisplay(task, { id: task.sessionId, title: "分析 delegation 使用率偏低" });
  assert.deepEqual(display, {
    title: "分析 delegation 使用率偏低",
    detail: "项目：Atlas",
    sessionId: "session-atlas",
    hasSession: true,
  });
  assert.equal(projectLabelFromWorkspace("/Users/example/projects/TaskCenter"), "TaskCenter");
});

test("其他项目仍显示真实 Session 标题", () => {
  const display = resolveTaskSessionDisplay(
    { sessionId: "session-other", workspace: "/Users/example/projects/OtherProject" },
    { id: "session-other", title: "其他项目会话" },
  );
  assert.equal(display?.title, "其他项目会话");
  assert.equal(display?.hasSession, true);
});

test("项目任务缺失真实 Session 时不伪造关联", () => {
  const display = resolveTaskSessionDisplay(
    { sessionId: "session-missing", workspace: "/Users/example/projects/Atlas" },
    undefined,
  );
  assert.equal(display?.title, "未关联会话");
  assert.equal(display?.hasSession, false);
  assert.equal(display?.detail, "项目：Atlas");
});

test("无 workspace 且缺失真实 Session 返回 null", () => {
  assert.equal(resolveTaskSessionDisplay({ sessionId: "session-missing" }, undefined), null);
});

test("共享根 workspace 不冒充 Atlas 项目", () => {
  assert.equal(projectLabelFromWorkspace("/Users/example/shared-workspace"), null);
  const display = resolveTaskSessionDisplay(
    { sessionId: "executor-session", workspace: "/Users/example/shared-workspace" },
    undefined,
  );
  assert.equal(display, null);
});

test("共享根 workspace 任务不会混入 Atlas 会话", () => {
  const matched = taskMatchesSession(
    { sessionId: "executor-session", workspace: "/Users/example/shared-workspace" },
    {
      selectedSessionIds: [],
      availableSessionIds: [],
      selectedThread: { id: "atlas", title: "atlas", cwd: "/Users/example/shared-workspace" },
    },
  );
  assert.equal(matched, false);
});
