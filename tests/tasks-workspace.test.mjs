import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { controlProxyTarget, isAllowedControlPath } from "../lib/control-proxy.mjs";
import { evidenceFollowUp, actionReasons, parseTaskWorkspaceSearch, projectInfo, taskActions, taskAxes, taskListRequestKey, taskMatchesBucket, taskViewBuckets } from "../lib/task-workspace.mjs";

test("任务工作区 URL 仅用列表条件构造请求 key", () => {
  const state = parseTaskWorkspaceSearch("?project=/work&bucket=attention&query=api&page=2&task=t-1&tab=evidence");
  assert.deepEqual(state, { project: "/work", bucket: "attention", query: "api", page: 2, task: "t-1", tab: "evidence" });
  assert.equal(taskListRequestKey(state), taskListRequestKey({ ...state, task: "t-2", tab: "activity" }));

  const withRoutingTab = parseTaskWorkspaceSearch("?task=task-taskcenter-ui-refresh-20260907&tab=routing&bucket=attention");
  assert.equal(withRoutingTab.tab, "overview");
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
  assert.match(componentSource, /\["Git 分支", task\.workspaceBranch\]/);
});

test("任务状态列保持可读并提供受控处理入口", () => {
  const componentSource = readFileSync("features/tasks/TaskWorkspace.tsx", "utf8");
  const styleSource = readFileSync("app/globals.css", "utf8");

  assert.match(componentSource, /<th>操作<\/th>/);
  assert.match(componentSource, /X-TaskCenter-Action": "delegate"/);
  assert.match(componentSource, /askConfirm\(managementCancelConfirmation/);
  assert.match(componentSource, /askConfirm\(`确认归档任务/);
  assert.match(componentSource, /taskActions\(task\)/);
  assert.match(styleSource, /\.status-chip \{[^}]*display: inline-flex;[^}]*white-space: nowrap;/);
  assert.match(styleSource, /\.task-table \{[^}]*min-width: 1040px;/);
  assert.match(styleSource, /\.task-table th:last-child, \.task-actions \{[^}]*position: sticky;[^}]*right: 0;/);
  assert.match(styleSource, /\.task-action-danger \{ color: #b1413b; \}/);
});

test("任务按钮依据生命周期展示，Review 不触发状态操作", () => {
  const cancel = { action: "cancel", label: "取消管理（不会停止执行）" };
  const terminal = [{ action: "start", label: "重新处理" }, { action: "archive", label: "归档" }];
  assert.deepEqual(taskActions({ status: "blocked" }), [{ action: "start", label: "恢复为执行中" }, cancel]);
  assert.deepEqual(taskActions({ status: "planned" }), [{ action: "start", label: "标记执行中" }, cancel]);
  for (const status of ["done_claimed", "verified", "cancelled"]) {
    assert.deepEqual(taskActions({ status }), terminal);
    assert.deepEqual(taskActions({ status, reviewStatus: "changes_requested", actionReasons: [{ code: "review_changes_requested" }] }), terminal);
  }
  assert.deepEqual(taskActions({ status: "in_progress", blocker: "等待外部输入" }), [cancel]);
  assert.deepEqual(taskActions({ status: "cancelled", archivedAt: "2026-09-17" }), [{ action: "unarchive", label: "取消归档" }]);
  assert.deepEqual(taskActions({ status: "unknown", actionReasons: [{ code: "verification_failed" }] }), []);
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
  assert.equal(isAllowedControlPath("/governance-metrics", "GET"), true);
  assert.equal(isAllowedControlPath("/governance-metrics", "POST"), false);
  assert.equal(isAllowedControlPath("/routing/optional-astra-policy", "POST"), false);
  assert.equal(isAllowedControlPath("/context-management-pilots", "GET"), true);
  assert.equal(isAllowedControlPath("/context-management-pilots/intents", "POST"), false);
  assert.equal(isAllowedControlPath("/routing/select", "POST"), false);
  assert.equal(controlProxyTarget("/usage-report")?.toString(), "http://127.0.0.1:3001/usage-report");
  assert.equal(controlProxyTarget("/tasks", "?view=summary&page_size=100")?.toString(), "http://127.0.0.1:3001/tasks?view=summary&page_size=100");
  assert.equal(isAllowedControlPath("/reflections/item/actions", "POST"), true);
  assert.equal(isAllowedControlPath("/reflections/item/actions", "GET"), false);
  assert.equal(controlProxyTarget("/tasks", "?view=summary&project=/work&bucket=attention&query=api&page=2&page_size=50&ignored=yes")?.toString(), "http://127.0.0.1:3001/tasks?view=summary&project=%2Fwork&bucket=attention&query=api&page=2&page_size=50");
  assert.equal(controlProxyTarget("/tasks/task-1/events", "?limit=30")?.toString(), "http://127.0.0.1:3001/tasks/task-1/events?limit=30");
  assert.equal(controlProxyTarget("/tasks/task-1/actions", "", "POST")?.toString(), "http://127.0.0.1:3001/tasks/task-1/actions");
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


test("旧 Bug 链接回落到普通任务入口", () => {
  assert.equal(parseTaskWorkspaceSearch("tab=bug&bucket=bugs").tab, "overview");
  for (const bucket of ["bugs", "awaiting_merge", "completed_bugs"]) assert.equal(parseTaskWorkspaceSearch(`bucket=${bucket}`).bucket, "all");
  for (const path of ["bug", "bug-acceptance", "bug-merge", "bug-dispatch", "bug-dispatch/control"]) assert.equal(isAllowedControlPath(`/tasks/task-old/${path}`, "POST"), false);
});


test("结束与事实待确认任务从执行中统计剔除但保持可恢复", () => {
  for (const task of [{ status: "in_progress", runs: [{ ended_at: "2026-10-12" }] }, { status: "in_progress", executionReconciliation: { state: "recovery_pending", next_action: "核对并恢复" } }]) {
    assert.equal(taskMatchesBucket(task, "in_progress"), false);
    assert.equal(taskMatchesBucket(task, "execution_unconfirmed"), true);
    assert.equal(taskMatchesBucket(task, "attention"), true);
    assert.equal(taskMatchesBucket(task, "completed"), false);
  }
  assert.equal(taskMatchesBucket({ status: "in_progress", runs: [{ ended_at: "" }] }, "in_progress"), true);
});


test("无任务的会话回执不产生补证据项", () => {
  assert.equal(evidenceFollowUp(null), null);
  assert.equal(evidenceFollowUp(), null);
});

test("关闭执行后具体缺项保留需处理，不计已完成；补齐后待独立验收", () => {
  const task = { status: "done_claimed", acceptanceStatus: "pending", verificationStatus: "pending",
    acceptanceRequirements: [{ id: "final", description: "最终清单" }],
    verificationPlan: [{ id: "test", title: "定向测试" }, { id: "build", title: "构建" }],
    completionReadiness: { missingRequirements: ["final", "test", "build"], reasons: ["required_verification_missing"] } };
  assert.match(actionReasons(task)[0].label, /待补最终清单；待补定向测试；待补构建/);
  assert.equal(taskViewBuckets(task).attention, true);
  assert.equal(taskViewBuckets(task).completed, false);
  assert.equal(taskViewBuckets(task).awaiting_verification, true);
  const ready = { ...task, verificationStatus: "passed", acceptanceStatus: "ready", completionReadiness: { ready: true, reasons: [], missingRequirements: [] } };
  assert.deepEqual(actionReasons(ready), []);
  assert.equal(taskViewBuckets(ready).completed, false);
  assert.equal(taskViewBuckets(ready).awaiting_acceptance, true);
  assert.equal(taskViewBuckets({ ...ready, status: "verified" }).completed, false);
  assert.equal(taskViewBuckets({ ...ready, status: "verified" }).awaiting_acceptance, true);
  assert.equal(taskViewBuckets({ ...ready, acceptanceStatus: "accepted" }).completed, true);
  assert.deepEqual(actionReasons({ ...task, status: "in_progress" }), []);
});

test("失效证据不能消除待办，非阻断Review不制造证据待办", () => {
  const task = { status: "done_claimed", acceptanceStatus: "stale", verificationStatus: "stale", completionReadiness: { staleEvidence: ["test-v1"], reasons: ["verification_stale"] } };
  assert.ok(actionReasons(task).some(reason => reason.label === "待更新过期证据"));
  assert.equal(taskViewBuckets(task).completed, false);
  assert.deepEqual(actionReasons({ status: "done_claimed", reviewStatus: "pending", completionReadiness: { reasons: ["review_pending"] } }), []);
});

test("计划中的失联Run显示执行待确认，正常阻塞不误报结束事实", () => {
  const task = { status: "planned", runs: [{ ended_at: "" }], executionReconciliation: { state: "recovery_pending", basis: "session_end_unconfirmed" } };
  assert.equal(taskViewBuckets(task).planned, false);
  assert.equal(taskViewBuckets(task).execution_unconfirmed, true);
  assert.equal(taskViewBuckets(task).attention, true);
  assert.equal(taskViewBuckets(task).completed, false);
  assert.equal(taskViewBuckets({ status: "blocked", runs: [{ ended_at: "2026-11-18" }] }).execution_unconfirmed, false);
});
