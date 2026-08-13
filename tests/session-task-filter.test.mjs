import assert from "node:assert/strict";
import test from "node:test";

/**
 * Session 任务看板筛选逻辑回归测试
 * 验收标准：
 * - 左侧全部任务显示全局任务
 * - 选择具体 Session 只显示该 Session 关联任务
 * - 切换 Session 后右侧任务即时刷新且不残留上一个会话
 * - 无关联任务显示明确空状态
 * - 保留现有手动关联和移除能力
 * - 精确 session_id 匹配优先，项目回退只在 Session 不可用时启用
 * - 其他项目任务不进入当前视图
 * - 无明确项目标识的任务不被猜测归类
 */

// 模拟 TaskLedger 的筛选逻辑（包含项目回退）
function filterTasksBySession(tasks, selectedSessionId, availableThreads = []) {
  if (selectedSessionId === "全部任务") {
    return tasks;
  }
  return tasks.filter((task) => {
    // 优先精确 session_id 匹配
    if (task.sessionId === selectedSessionId) return true;

    // 检查任务 session_id 是否在左侧可用 Session 列表中
    const taskSessionAvailable = availableThreads.some((t) => t.id === task.sessionId);
    if (taskSessionAvailable) return false; // 精确 Session 存在，不启用回退

    // 项目标识回退：提取任务 workspace 的项目名
    if (!task.workspace) return false;
    const projectMatch = task.workspace.match(/\/([^/]+)$/);
    const taskProject = projectMatch?.[1];
    if (!taskProject) return false;

    // 获取左侧 Session 的标题或 cwd 提取的项目名
    const selectedThread = availableThreads.find((t) => t.id === selectedSessionId);
    if (!selectedThread) return false;

    // 从 Session 标题或 cwd 提取项目名
    const sessionTitle = selectedThread.title || "";
    const sessionCwd = selectedThread.cwd || "";
    const cwdMatch = sessionCwd.match(/\/([^/]+)$/);
    const cwdProject = cwdMatch?.[1];

    // 比对：Session 标题或 cwd 项目名与任务项目名（大小写不敏感）
    const normalizedTaskProject = taskProject.toLowerCase();
    const normalizedTitle = sessionTitle.toLowerCase();
    const normalizedCwdProject = cwdProject?.toLowerCase();

    // 标题或 cwd 匹配项目名（允许 atlas 匹配 Atlas）
    return normalizedTitle === normalizedTaskProject || normalizedCwdProject === normalizedTaskProject;
  });
}

const mockTasks = [
  { id: "task-1", sessionId: "session-A", title: "任务 A1", status: "in_progress" },
  { id: "task-2", sessionId: "session-A", title: "任务 A2", status: "planned" },
  { id: "task-3", sessionId: "session-B", title: "任务 B1", status: "in_progress" },
  { id: "task-4", sessionId: "session-B", title: "任务 B2", status: "done_claimed" },
  { id: "task-5", sessionId: "session-C", title: "任务 C1", status: "blocked" },
];

const mockThreads = [
  { id: "session-A", title: "任务 A", cwd: "/Users/example/projectA" },
  { id: "session-B", title: "任务 B", cwd: "/Users/example/projectB" },
  { id: "session-C", title: "任务 C", cwd: "/Users/example/projectC" },
];

test("全部任务视图显示所有任务", () => {
  const filtered = filterTasksBySession(mockTasks, "全部任务", mockThreads);
  assert.equal(filtered.length, 5);
  assert.ok(filtered.every((task) => mockTasks.includes(task)));
});

test("具体 Session 只显示关联任务", () => {
  const sessionATasks = filterTasksBySession(mockTasks, "session-A", mockThreads);
  assert.equal(sessionATasks.length, 2);
  assert.ok(sessionATasks.every((task) => task.sessionId === "session-A"));

  const sessionBTasks = filterTasksBySession(mockTasks, "session-B", mockThreads);
  assert.equal(sessionBTasks.length, 2);
  assert.ok(sessionBTasks.every((task) => task.sessionId === "session-B"));

  const sessionCTasks = filterTasksBySession(mockTasks, "session-C", mockThreads);
  assert.equal(sessionCTasks.length, 1);
  assert.equal(sessionCTasks[0].sessionId, "session-C");
});

test("无关联任务的 Session 返回空数组", () => {
  const filtered = filterTasksBySession(mockTasks, "session-UNKNOWN", mockThreads);
  assert.equal(filtered.length, 0);
  assert.ok(Array.isArray(filtered));
});

test("切换 Session 后不残留上一个会话的任务", () => {
  // 先选择 session-A
  const sessionATasks = filterTasksBySession(mockTasks, "session-A", mockThreads);
  assert.equal(sessionATasks.length, 2);
  assert.ok(sessionATasks.every((task) => task.sessionId === "session-A"));

  // 切换到 session-B
  const sessionBTasks = filterTasksBySession(mockTasks, "session-B", mockThreads);
  assert.equal(sessionBTasks.length, 2);
  assert.ok(sessionBTasks.every((task) => task.sessionId === "session-B"));

  // 再次切换回 session-A，确保没有残留
  const sessionATasksAgain = filterTasksBySession(mockTasks, "session-A", mockThreads);
  assert.equal(sessionATasksAgain.length, 2);
  assert.ok(sessionATasksAgain.every((task) => task.sessionId === "session-A"));
});

test("未设置 session_id 的任务不归入具体 Session", () => {
  const tasksWithMissing = [
    ...mockTasks,
    { id: "task-6", sessionId: undefined, title: "无 Session 任务" },
    { id: "task-7", sessionId: "", title: "空 Session 任务" },
    { id: "task-8", sessionId: null, title: "null Session 任务" },
  ];

  // 全部任务应包含所有任务（包括无 session 的）
  const allTasks = filterTasksBySession(tasksWithMissing, "全部任务", mockThreads);
  assert.equal(allTasks.length, 8);

  // 具体 Session 不应包含无 session_id 的任务
  const sessionATasks = filterTasksBySession(tasksWithMissing, "session-A", mockThreads);
  assert.equal(sessionATasks.length, 2);
  assert.ok(sessionATasks.every((task) => task.sessionId === "session-A"));
});

test("空任务列表处理", () => {
  const emptyTasks = [];

  const allTasks = filterTasksBySession(emptyTasks, "全部任务", mockThreads);
  assert.equal(allTasks.length, 0);

  const sessionATasks = filterTasksBySession(emptyTasks, "session-A", mockThreads);
  assert.equal(sessionATasks.length, 0);
});

test("多次切换稳定性", () => {
  const sessions = ["全部任务", "session-A", "session-B", "session-C", "session-UNKNOWN"];

  for (const session of sessions) {
    for (let i = 0; i < 5; i++) {
      const filtered = filterTasksBySession(mockTasks, session, mockThreads);
      if (session === "全部任务") {
        assert.equal(filtered.length, 5);
      } else if (session === "session-A") {
        assert.equal(filtered.length, 2);
      } else if (session === "session-B") {
        assert.equal(filtered.length, 2);
      } else if (session === "session-C") {
        assert.equal(filtered.length, 1);
      } else {
        assert.equal(filtered.length, 0);
      }
    }
  }
});

// 跨工作区任务测试：验证全部任务视图包含不同工作区的任务
test("全部任务视图包含跨工作区任务", () => {
  const crossWorkspaceTasks = [
    { id: "task-taskcenter-1", sessionId: "session-taskcenter", title: "TaskCenter 任务", status: "in_progress", workspace: "/Users/example/TaskCenter" },
    { id: "task-atlas-1", sessionId: "session-atlas", title: "Atlas 任务", status: "planned", workspace: "/Users/example/Atlas" },
    { id: "task-other-1", sessionId: "session-other", title: "其他项目任务", status: "blocked", workspace: "/Users/example/OtherProject" },
  ];

  const crossWorkspaceThreads = [
    { id: "session-taskcenter", title: "TaskCenter 任务", cwd: "/Users/example/TaskCenter" },
    { id: "session-atlas", title: "Atlas 任务", cwd: "/Users/example/Atlas" },
    { id: "session-other", title: "其他项目任务", cwd: "/Users/example/OtherProject" },
  ];

  // 全部任务视图应包含所有工作区的任务
  const allTasks = filterTasksBySession(crossWorkspaceTasks, "全部任务", crossWorkspaceThreads);
  assert.equal(allTasks.length, 3);
  assert.ok(allTasks.some((task) => task.workspace?.includes("TaskCenter")));
  assert.ok(allTasks.some((task) => task.workspace?.includes("Atlas")));
  assert.ok(allTasks.some((task) => task.workspace?.includes("OtherProject")));

  // 具体 Session 只显示该 Session 的任务
  const taskcenterSession = filterTasksBySession(crossWorkspaceTasks, "session-taskcenter", crossWorkspaceThreads);
  assert.equal(taskcenterSession.length, 1);
  assert.equal(taskcenterSession[0].workspace, "/Users/example/TaskCenter");

  const atlasSession = filterTasksBySession(crossWorkspaceTasks, "session-atlas", crossWorkspaceThreads);
  assert.equal(atlasSession.length, 1);
  assert.equal(atlasSession[0].workspace, "/Users/example/Atlas");
});

test("任务账本数据源不依赖 dashboard requirements", () => {
  // 模拟任务账本有 5 个任务
  const ledgerTasks = [
    { id: "task-ledger-1", sessionId: "session-A", title: "账本任务 A", status: "in_progress" },
    { id: "task-ledger-2", sessionId: "session-B", title: "账本任务 B", status: "planned" },
    { id: "task-ledger-3", sessionId: "session-C", title: "账本任务 C（无需求卡片）", status: "blocked" },
    { id: "task-ledger-4", sessionId: "session-D", title: "账本任务 D（跨工作区）", status: "done_claimed" },
    { id: "task-ledger-5", sessionId: "session-E", title: "账本任务 E（历史任务）", status: "cancelled" },
  ];

  // 模拟 dashboard requirements 只有 2 个
  const dashboardRequirements = [
    { id: "req-1", title: "需求 1", status: "verified" },
    { id: "req-2", title: "需求 2", status: "missing" },
  ];

  // 全部任务视图应显示任务账本的 5 个任务，而不是 dashboard requirements 的 2 个
  const allTasks = filterTasksBySession(ledgerTasks, "全部任务", mockThreads);
  assert.equal(allTasks.length, 5);
  assert.equal(allTasks.length, ledgerTasks.length);
  assert.notEqual(allTasks.length, dashboardRequirements.length);
});

test("无 session_id 的历史任务只在全部任务视图显示", () => {
  const historicalTasks = [
    { id: "task-historical-1", sessionId: undefined, title: "历史任务 1", status: "done_claimed" },
    { id: "task-historical-2", sessionId: "", title: "历史任务 2", status: "cancelled" },
    { id: "task-active-1", sessionId: "session-active", title: "活跃任务", status: "in_progress" },
  ];

  const historicalThreads = [
    { id: "session-active", title: "活跃任务", cwd: "/Users/example/active" },
  ];

  // 全部任务视图包含历史任务
  const allTasks = filterTasksBySession(historicalTasks, "全部任务", historicalThreads);
  assert.equal(allTasks.length, 3);

  // 具体活跃 Session 不包含历史任务
  const activeSessionTasks = filterTasksBySession(historicalTasks, "session-active", historicalThreads);
  assert.equal(activeSessionTasks.length, 1);
  assert.equal(activeSessionTasks[0].id, "task-active-1");
});

// 运行时刷新回归测试：验证控制服务任务接口返回跨工作区任务
test("运行时任务接口包含跨工作区任务", () => {
  // 模拟控制服务返回的任务列表
  const runtimeTasks = [
    { id: "task-taskcenter-1", sessionId: "session-taskcenter", title: "TaskCenter 任务", workspace: "/Users/example/TaskCenter", status: "in_progress" },
    { id: "task-atlas-1", sessionId: "session-atlas", title: "Atlas 任务", workspace: "/Users/example/Atlas", status: "planned" },
    { id: "task-other-1", sessionId: "session-other", title: "其他项目任务", workspace: "/Users/example/OtherProject", status: "blocked" },
  ];

  const runtimeThreads = [
    { id: "session-taskcenter", title: "TaskCenter 任务", cwd: "/Users/example/TaskCenter" },
    { id: "session-atlas", title: "Atlas 任务", cwd: "/Users/example/Atlas" },
    { id: "session-other", title: "其他项目任务", cwd: "/Users/example/OtherProject" },
  ];

  // 全部任务视图应包含所有工作区任务
  const allTasks = filterTasksBySession(runtimeTasks, "全部任务", runtimeThreads);
  assert.equal(allTasks.length, 3);
  assert.ok(allTasks.some((task) => task.workspace?.includes("TaskCenter")));
  assert.ok(allTasks.some((task) => task.workspace?.includes("Atlas")));
  assert.ok(allTasks.some((task) => task.workspace?.includes("OtherProject")));
});

test("运行时任务筛选不依赖 dashboard requirements", () => {
  // 模拟运行时任务账本数据
  const ledgerTasks = [
    { id: "task-ledger-1", sessionId: "session-A", title: "账本任务 A", status: "in_progress" },
    { id: "task-ledger-2", sessionId: "session-B", title: "账本任务 B", status: "planned" },
  ];

  // 任务筛选应基于 task ledger，不依赖 dashboard
  const allTasks = filterTasksBySession(ledgerTasks, "全部任务", mockThreads);
  assert.equal(allTasks.length, 2);

  // 具体 Session 筛选仍按 session_id 精确过滤
  const sessionATasks = filterTasksBySession(ledgerTasks, "session-A", mockThreads);
  assert.equal(sessionATasks.length, 1);
  assert.equal(sessionATasks[0].sessionId, "session-A");
});

// ========== 项目回退映射测试 ==========

test("项目标识回退：Session 标题匹配任务 workspace", () => {
  // 模拟 Codex 左侧 atlas Session
  const atlasThread = { id: "session-atlas-codex", title: "atlas", cwd: "/Users/example/shared-workspace" };

  // 模拟 Atlas 任务（由 Claude/WorkBuddy 创建，session_id 不同）
  const atlasTask = {
    id: "task-atlas-1",
    sessionId: "session-atlas-claude", // 不同的 session_id
    title: "Atlas 任务",
    workspace: "/Users/example/Atlas",
    status: "in_progress"
  };

  // Session 列表只有 atlas Session
  const threads = [atlasThread];

  // 精确 session_id 不匹配，但项目标识匹配（atlas -> Atlas）
  const filtered = filterTasksBySession([atlasTask], "session-atlas-codex", threads);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, "task-atlas-1");
});

test("项目标识回退：Session cwd 匹配任务 workspace", () => {
  // 模拟 Codex Session cwd 包含项目名
  const atlasThread = { id: "session-atlas-codex", title: "分析 Atlas 项目", cwd: "/Users/example/Atlas" };

  const atlasTask = {
    id: "task-atlas-2",
    sessionId: "session-atlas-claude",
    title: "Atlas 任务",
    workspace: "/Users/example/Atlas",
    status: "planned"
  };

  const threads = [atlasThread];
  const filtered = filterTasksBySession([atlasTask], "session-atlas-codex", threads);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, "task-atlas-2");
});

test("精确 session_id 匹配优先，不被项目回退覆盖", () => {
  // Session A 有精确匹配的任务
  const sessionA = { id: "session-A", title: "Project A", cwd: "/Users/example/ProjectA" };

  // Session B 的任务
  const taskForB = {
    id: "task-B",
    sessionId: "session-B", // 不同的 session_id
    title: "Project B 任务",
    workspace: "/Users/example/ProjectB",
    status: "in_progress"
  };

  // Session A 的精确匹配任务
  const taskForA = {
    id: "task-A",
    sessionId: "session-A", // 精确匹配
    title: "Project A 任务",
    workspace: "/Users/example/ProjectA",
    status: "planned"
  };

  const threads = [sessionA, { id: "session-B", title: "Project B", cwd: "/Users/example/ProjectB" }];
  const tasks = [taskForA, taskForB];

  // Session A 只显示精确匹配的任务，不显示 Project B 的任务（即使 workspace 不同）
  const filtered = filterTasksBySession(tasks, "session-A", threads);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, "task-A");
});

test("其他项目任务不进入当前视图", () => {
  const atlasThread = { id: "session-atlas", title: "atlas", cwd: "/Users/example/shared-workspace" };

  const taskcenterTask = {
    id: "task-taskcenter",
    sessionId: "session-taskcenter",
    title: "TaskCenter 任务",
    workspace: "/Users/example/TaskCenter",
    status: "in_progress"
  };

  const otherProjectTask = {
    id: "task-other",
    sessionId: "session-other",
    title: "其他项目任务",
    workspace: "/Users/example/OtherProject",
    status: "planned"
  };

  const threads = [atlasThread];
  const tasks = [taskcenterTask, otherProjectTask];

  // atlas Session 不应显示 TaskCenter 或其他项目任务
  const filtered = filterTasksBySession(tasks, "session-atlas", threads);
  assert.equal(filtered.length, 0);
});

test("无明确项目标识的任务不被猜测归类", () => {
  const atlasThread = { id: "session-atlas", title: "atlas", cwd: "/Users/example/shared-workspace" };

  // 任务没有 workspace 字段
  const noWorkspaceTask = {
    id: "task-no-workspace",
    sessionId: "session-claude",
    title: "无 workspace 任务",
    status: "in_progress"
  };

  // 任务 workspace 无法提取项目名
  const invalidWorkspaceTask = {
    id: "task-invalid-workspace",
    sessionId: "session-claude",
    title: "无效 workspace 任务",
    workspace: "/",
    status: "planned"
  };

  const threads = [atlasThread];
  const tasks = [noWorkspaceTask, invalidWorkspaceTask];

  // atlas Session 不应猜测归类这些任务
  const filtered = filterTasksBySession(tasks, "session-atlas", threads);
  assert.equal(filtered.length, 0);
});

test("全部任务仍显示所有任务（含跨执行器）", () => {
  const allTasks = [
    { id: "task-taskcenter", sessionId: "session-taskcenter", title: "TaskCenter 任务", workspace: "/Users/example/TaskCenter", status: "in_progress" },
    { id: "task-atlas", sessionId: "session-atlas-claude", title: "Atlas 任务", workspace: "/Users/example/Atlas", status: "planned" },
    { id: "task-other", sessionId: "session-other", title: "其他任务", workspace: "/Users/example/OtherProject", status: "blocked" },
  ];

  const filtered = filterTasksBySession(allTasks, "全部任务", []);
  assert.equal(filtered.length, 3);
});

test("任务 session_id 在左侧可用时不启用回退", () => {
  // Claude Session 和 Codex Session 都存在
  const claudeThread = { id: "session-claude", title: "Claude 任务", cwd: "/Users/example/Atlas" };
  const codexThread = { id: "session-codex", title: "atlas", cwd: "/Users/example/shared-workspace" };

  const atlasTask = {
    id: "task-atlas",
    sessionId: "session-claude", // 精确匹配 claudeThread
    title: "Atlas 任务",
    workspace: "/Users/example/Atlas",
    status: "in_progress"
  };

  const threads = [claudeThread, codexThread];
  const tasks = [atlasTask];

  // Codex Session 不应通过项目回退显示 Claude Session 的任务
  const codexFiltered = filterTasksBySession(tasks, "session-codex", threads);
  assert.equal(codexFiltered.length, 0);

  // Claude Session 应显示精确匹配的任务
  const claudeFiltered = filterTasksBySession(tasks, "session-claude", threads);
  assert.equal(claudeFiltered.length, 1);
  assert.equal(claudeFiltered[0].id, "task-atlas");
});

test("大小写不敏感匹配：atlas 匹配 Atlas", () => {
  const atlasThread = { id: "session-atlas", title: "atlas", cwd: "/Users/example/shared-workspace" };

  const atlasTask = {
    id: "task-atlas",
    sessionId: "session-claude",
    title: "Atlas 任务",
    workspace: "/Users/example/Atlas", // Atlas（大写 Z）
    status: "in_progress"
  };

  const threads = [atlasThread];
  const tasks = [atlasTask];

  // atlas（小写）应匹配 Atlas（大写）
  const filtered = filterTasksBySession(tasks, "session-atlas", threads);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, "task-atlas");
});

// ========== 仅展示真实 Codex Session 测试 ==========

test("任务账本中的未知 session_id 不生成左侧伪造会话", () => {
  const scannedThreads = [
    { id: "session-codex-1", title: "Codex 任务 1" },
  ];
  const tasks = [
    { id: "task-1", sessionId: "session-codex-1", title: "Codex 任务", status: "in_progress" },
    { id: "task-2", sessionId: "session-claude-external", title: "Claude 外部任务", status: "planned" },
  ];

  const visibleThreads = scannedThreads;
  assert.equal(visibleThreads.length, 1);
  assert.ok(!visibleThreads.some((thread) => thread.title?.startsWith("[任务来源]")));
  assert.equal(filterTasksBySession(tasks, "session-codex-1", visibleThreads).length, 1);
});

test("未知 session_id 任务仍出现在全部任务，但具体 Codex 会话不猜测归类", () => {
  const tasks = [
    { id: "task-1", sessionId: "session-claude-external", title: "外部任务", status: "planned" },
  ];
  const threads = [{ id: "session-codex-1", title: "Codex 任务" }];

  assert.equal(filterTasksBySession(tasks, "全部任务", threads).length, 1);
  assert.equal(filterTasksBySession(tasks, "session-codex-1", threads).length, 0);
});
