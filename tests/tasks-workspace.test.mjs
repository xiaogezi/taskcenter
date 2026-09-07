import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { controlProxyTarget, isAllowedControlPath } from "../lib/control-proxy.mjs";
import { actionReasons, parseTaskWorkspaceSearch, projectInfo, taskAxes, taskListRequestKey, taskMatchesBucket, taskViewBuckets } from "../lib/task-workspace.mjs";

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
});

test("四轴状态与需处理判定忽略通用 completion pending", () => {
  const task = { status: "in_progress", verificationStatus: "passed", reviewStatus: "pending", acceptanceStatus: "pending", completionReadiness: { reasons: ["缺少独立审查"] } };
  assert.deepEqual(taskAxes(task), [["执行", "in_progress"], ["验证", "passed"], ["审查", "pending"], ["验收", "pending"]]);
  assert.deepEqual(actionReasons(task), []);
  assert.equal(taskMatchesBucket(task, "attention"), false);
});

test("失败或过期的验证、审查和验收进入需处理", () => {
  for (const task of [{ verificationStatus: "failed" }, { verificationStatus: "stale" }, { reviewStatus: "changes_requested" }, { reviewStatus: "stale" }, { acceptanceStatus: "rejected" }]) {
    assert.equal(actionReasons(task).length > 0, true);
    assert.equal(taskViewBuckets(task).attention, true);
  }
});

test("项目筛选把项目 worktree 归并到主项目", () => {
  assert.deepEqual(projectInfo("/work/inStory-worktrees/feat-a"), { id: "project:instory", label: "inStory" });
  assert.deepEqual(projectInfo("/Users/name/.codex/worktrees/hash/ReqRadar"), { id: "project:reqradar", label: "ReqRadar" });
});

test("同源代理只允许明确的控制台路径和方法", () => {
  assert.equal(isAllowedControlPath("/tasks/task-1/actions"), false);
  assert.equal(isAllowedControlPath("/health", "POST"), false);
  assert.equal(isAllowedControlPath("/health", "GET"), true);
  assert.equal(isAllowedControlPath("/routing/optional-astra-policy", "POST"), true);
  assert.equal(isAllowedControlPath("/routing/select", "POST"), false);
  assert.equal(isAllowedControlPath("/reflections/item/actions", "POST"), true);
  assert.equal(isAllowedControlPath("/reflections/item/actions", "GET"), false);
  assert.equal(controlProxyTarget("/tasks", "?view=summary&project=/work&bucket=attention&query=api&page=2&page_size=50&ignored=yes")?.toString(), "http://127.0.0.1:3001/tasks?view=summary&project=%2Fwork&bucket=attention&query=api&page=2&page_size=50");
  assert.equal(controlProxyTarget("/tasks/task-1/events", "?limit=30")?.toString(), "http://127.0.0.1:3001/tasks/task-1/events?limit=30");
});
