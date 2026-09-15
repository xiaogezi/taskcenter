import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { controlProxyTarget, isAllowedControlPath } from "../lib/control-proxy.mjs";
import { actionReasons, parseTaskWorkspaceSearch, projectInfo, taskActions, taskAxes, taskListRequestKey, taskMatchesBucket, taskViewBuckets } from "../lib/task-workspace.mjs";

test("任务工作区 URL 仅用列表条件构造请求 key", () => {
  const state = parseTaskWorkspaceSearch("?project=/work&bucket=attention&query=api&page=2&task=t-1&tab=evidence");
  assert.deepEqual(state, { project: "/work", bucket: "attention", query: "api", page: 2, task: "t-1", tab: "evidence" });
  assert.equal(taskListRequestKey(state), taskListRequestKey({ ...state, task: "t-2", tab: "activity" }));

  const withRoutingTab = parseTaskWorkspaceSearch("?task=task-taskcenter-ui-refresh-20260907&tab=routing&bucket=attention");
  assert.equal(withRoutingTab.tab, "routing");
});

test("桌面详情展开时主工作区应开启三列网格", () => {
  const componentSource = readFileSync("features/tasks/TaskWorkspace.tsx", "utf8");
  const styleSource = readFileSync("app/globals.css", "utf8");

  assert.match(componentSource, /className=\{state\.task \? "task-workspace with-open-detail" : "task-workspace"\}/);
  assert.match(styleSource, /\.task-workspace\.with-open-detail \{\s*grid-template-columns:\s*220px minmax\(0, 1fr\) minmax\(320px, min\(390px, 34vw\)\);\s*\}/);
  assert.match(styleSource, /\.task-detail \{[\s\S]*width: 100%;[\s\S]*min-width: 0;/);
  assert.match(componentSource, /<th>Token<\/th>/);
  assert.match(componentSource, /<strong>总计 \{formatTokens\(task\.tokenUsage\.totalTokens\)\}<\/strong>/);
  assert.match(componentSource, /输入 \{formatTokens\(task\.tokenUsage\.usage\.input\)\}（缓存/);
  assert.match(componentSource, /\["输入 Token", inputTokens\]/);
  assert.match(componentSource, /\["输出 Token", outputTokens\]/);
  assert.match(componentSource, /\["Git 分支", task\?\.workspaceBranch\]/);
});

test("任务状态列保持可读并提供受控处理入口", () => {
  const componentSource = readFileSync("features/tasks/TaskWorkspace.tsx", "utf8");
  const styleSource = readFileSync("app/globals.css", "utf8");

  assert.match(componentSource, /<th>操作<\/th>/);
  assert.match(componentSource, /X-TaskCenter-Action": "delegate"/);
  assert.match(componentSource, /window\.confirm\(`确认关闭任务/);
  assert.match(componentSource, /window\.confirm\(`确认归档任务/);
  assert.match(componentSource, /taskActions\(task\)/);
  assert.match(styleSource, /\.status-chip \{[^}]*display: inline-flex;[^}]*white-space: nowrap;/);
  assert.match(styleSource, /\.task-table \{[^}]*min-width: 1040px;/);
  assert.match(styleSource, /\.task-table th:last-child, \.task-actions \{[^}]*position: sticky;[^}]*right: 0;/);
  assert.match(styleSource, /\.task-action-danger \{ color: #b1413b; \}/);
});

test("需处理原因映射为可闭环的现有任务操作", () => {
  assert.deepEqual(taskActions({ status: "blocked" }), [{ action: "start", label: "恢复执行" }, { action: "cancel", label: "关闭任务" }]);
  assert.deepEqual(taskActions({ status: "planned" }), [{ action: "start", label: "开始执行" }, { action: "cancel", label: "关闭任务" }]);
  assert.deepEqual(taskActions({ status: "cancelled", verificationStatus: "stale" }), [{ action: "start", label: "重新处理" }, { action: "archive", label: "归档" }]);
  assert.deepEqual(taskActions({ status: "done_claimed", reviewStatus: "changes_requested" }), []);
  assert.deepEqual(taskActions({ status: "in_progress", blocker: "等待外部输入" }), [{ action: "start", label: "重新处理" }, { action: "cancel", label: "关闭任务" }]);
});

test("四轴状态与需处理判定忽略通用 completion pending", () => {
  const task = { status: "in_progress", verificationStatus: "passed", reviewStatus: "pending", acceptanceStatus: "pending", completionReadiness: { reasons: ["缺少独立审查"] } };
  assert.deepEqual(taskAxes(task), [["执行", "in_progress"], ["验证", "passed"], ["审查", "pending"], ["验收", "pending"]]);
  assert.deepEqual(actionReasons(task), []);
  assert.equal(taskMatchesBucket(task, "attention"), false);
});

test("失败或过期的验证和验收进入需处理，Review 不干预流程", () => {
  for (const task of [{ verificationStatus: "failed" }, { verificationStatus: "stale" }, { acceptanceStatus: "rejected" }]) {
    assert.equal(actionReasons(task).length > 0, true);
    assert.equal(taskViewBuckets(task).attention, true);
  }
  for (const reviewStatus of ["pending", "stale", "changes_requested", "rejected"]) {
    const task = { status: "done_claimed", verificationStatus: "passed", acceptanceStatus: "pending", reviewStatus, reviewAttestations: [{ unresolvedFindings: 2 }] };
    assert.deepEqual(actionReasons(task), []);
    assert.equal(taskViewBuckets(task).awaiting_acceptance, true);
  }
});

test("项目筛选把项目 worktree 归并到主项目", () => {
  assert.deepEqual(projectInfo("/work/inStory-worktrees/feat-a"), { id: "project:instory", label: "inStory" });
  assert.deepEqual(projectInfo("/Users/name/.codex/worktrees/hash/ReqRadar"), { id: "project:reqradar", label: "ReqRadar" });
  assert.deepEqual(projectInfo("/tmp/arbitrary", "reqradar", "/work/ReqRadar"), { id: "project:reqradar", label: "ReqRadar" });
});

test("同源代理只允许明确的控制台路径和方法", () => {
  assert.equal(isAllowedControlPath("/tasks/task-1/actions", "POST"), true);
  assert.equal(isAllowedControlPath("/tasks/task-1/actions", "GET"), false);
  assert.equal(isAllowedControlPath("/health", "POST"), false);
  assert.equal(isAllowedControlPath("/health", "GET"), true);
  assert.equal(isAllowedControlPath("/routing/optional-astra-policy", "POST"), true);
  assert.equal(isAllowedControlPath("/context-management-pilots", "GET"), true);
  assert.equal(isAllowedControlPath("/context-management-pilots/intents", "POST"), true);
  assert.equal(isAllowedControlPath("/routing/select", "POST"), false);
  assert.equal(controlProxyTarget("/usage-report")?.toString(), "http://127.0.0.1:3001/usage-report");
  assert.equal(controlProxyTarget("/tasks", "?view=summary&page_size=100")?.toString(), "http://127.0.0.1:3001/tasks?view=summary&page_size=100");
  assert.equal(isAllowedControlPath("/reflections/item/actions", "POST"), true);
  assert.equal(isAllowedControlPath("/reflections/item/actions", "GET"), false);
  assert.equal(controlProxyTarget("/tasks", "?view=summary&project=/work&bucket=attention&query=api&page=2&page_size=50&ignored=yes")?.toString(), "http://127.0.0.1:3001/tasks?view=summary&project=%2Fwork&bucket=attention&query=api&page=2&page_size=50");
  assert.equal(controlProxyTarget("/tasks/task-1/events", "?limit=30")?.toString(), "http://127.0.0.1:3001/tasks/task-1/events?limit=30");
  assert.equal(controlProxyTarget("/tasks/task-1/actions", "", "POST")?.toString(), "http://127.0.0.1:3001/tasks/task-1/actions");
});

test("模型调度页展示额度、真实调度和刷新反馈", () => {
  const source = readFileSync("features/console/ConsolePage.tsx", "utf8");
  assert.match(source, /api<UsageData>\("\/usage-report"\)/);
  assert.match(source, /api<\{ tasks\?: RoutingTask\[\] \}>\("\/tasks\?view=summary&page_size=100"\)/);
  assert.match(source, /未绑定额度池（不代表额度充足）/);
  assert.match(source, /刷新成功：/);
  assert.match(source, /刷新失败：/);
  assert.match(source, /暂无真实调度记录/);
  assert.match(source, /历史快照（重置时间已过，当前额度未知）/);
  assert.match(source, /按最近更新的 100 个任务聚合，最多展示 20 条/);
});

test("会话与试点页面持续刷新标题并在卸载时清理轮询", () => {
  const source = readFileSync("features/console/ConsolePage.tsx", "utf8");
  assert.equal(source.match(/window\.setInterval\(load, 5000\)/g)?.length, 1);
  assert.match(source, /window\.setInterval\(refreshStatus, 5000\)/);
  assert.match(source, /setState\(current => current \? \{ \.\.\.current, status \} : current\)/);
  assert.equal(source.match(/window\.clearInterval\(timer\)/g)?.length, 2);
  assert.match(source, /item\.title \|\| "未命名会话"/);
  assert.match(source, /session\?\.title \|\| "未命名会话"/);
  assert.match(source, /Token 总计：\{item\.tokenUsage \? formatTokens\(item\.tokenUsage\.totalTokens\) : "暂无统计"\}/);
  assert.match(source, /输入：\{formatTokens\(item\.tokenUsage\.usage\.input\)\} · 其中缓存/);
  assert.match(source, /输出：\{formatTokens\(item\.tokenUsage\.usage\.output\)\} · 其中推理/);
});
