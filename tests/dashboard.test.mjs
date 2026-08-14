import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { classifyMessage } from "../scripts/classify-message.mjs";

const root = new URL("../", import.meta.url);
const dashboardPath = process.env.TASKCENTER_DASHBOARD_PATH || ".local/test-dashboard.json";

async function readDashboard() {
  return JSON.parse(await readFile(new URL(dashboardPath, root), "utf8"));
}

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("同步结果包含需求、状态和多个 Codex 任务", async () => {
  const dashboard = await readDashboard();
  assert.ok(dashboard.requirements.length >= 1, `requirements: ${dashboard.requirements.length}`);
  assert.ok(dashboard.threads.length >= 1, `threads: ${dashboard.threads.length}`);
  // 状态分布验证：至少存在不同状态
  const statusKeys = ["verified", "in_progress", "partial", "missing", "needs_validation", "untriaged"];
  const hasAnyStatus = statusKeys.some((status) => (dashboard.summary.statusCounts[status] ?? 0) > 0);
  assert.ok(hasAnyStatus, "应存在至少一种状态");
  assert.equal(dashboard.source.mode, "read-only local JSONL");
  // 分类计数验证
  assert.ok(typeof dashboard.summary.excludedCount === "number");
  assert.ok(typeof dashboard.source.classificationCounts.operation === "number");
});

test("Atlas 工程治理需求按专业需求和父子层级同步", async () => {
  const dashboard = await readDashboard();
  const epic = dashboard.requirements.find((item) => item.id === "atlas-engineering-governance");
  assert.ok(epic, "fixture 必须包含 atlas-engineering-governance");
  assert.equal(epic.project, "Atlas");
  assert.equal(epic.kind, "epic");
  assert.ok(["in_progress", "needs_validation", "verified"].includes(epic.status));
  assert.ok(Array.isArray(epic.acceptanceCriteria));
  assert.ok(Array.isArray(epic.implementationStages));
  assert.ok(Array.isArray(epic.evidencePaths));

  const childIds = [
    "atlas-web-api-db-boundary",
    "atlas-remove-fastapi-uvicorn",
    "atlas-boss-selector-reliability",
    "atlas-company-intelligence-inbox",
  ];
  for (const id of childIds) {
    const requirement = dashboard.requirements.find((item) => item.id === id);
    assert.ok(requirement, `fixture 必须包含 ${id}`);
    assert.equal(requirement.project, "Atlas");
    assert.equal(requirement.kind, "requirement");
    assert.equal(requirement.parentId, epic.id);
    assert.equal(requirement.sourceKind, "professional_requirement");
    assert.ok(["in_progress", "needs_validation", "verified"].includes(requirement.status));
    assert.ok(Array.isArray(requirement.acceptanceCriteria));
    assert.ok(Array.isArray(requirement.implementationStages));
    assert.ok(Array.isArray(requirement.evidencePaths));
  }
});

test("只把持续能力和缺陷反馈识别为需求", () => {
  const samples = [
    ["得有个管理按钮吧 丢弃或者继续的", "requirement"],
    ["我需要支持一键启动采集的功能", "requirement"],
    ["采集监控中心好像不好用呢 也没有新的岗位增加", "feedback"],
    ["我对项目 WebUI 不满意，可视化操作的地方太少了", "feedback"],
    ["然后你 github 看下还有哪些可以完善的功能需求", "discovery"],
    ["从一个求职者角度看看还有哪些需要完善的", "discovery"],
    ["强制重启并打开页面吧", "operation"],
    ["现在采集岗位的状态怎么样 可以用吗", "question"],
    ["有 WebUI 页面吗", "question"],
    ["有配置频率的文件吗", "question"],
    ["我需要你做规划 Claude Codex 执行 配置 GLM-5", "collaboration"],
    ["总的来说我希望通过系统提高求职命中率", "business_goal"],
    ["确认队列是干嘛的有点不太明白", "question"],
    ["这啥意思啊", "question"],
    ["探索示例项目", "operation"],
    ["1 2 4在我看来是需求啊 怎么没有了", "feedback"],
  ];
  for (const [message, expected] of samples) {
    assert.equal(classifyMessage(message), expected, message);
  }
});

test("服务端渲染 TaskCenter 看板", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>TaskCenter/);
  assert.match(html, /本地任务工作台/);
  assert.match(html, /Codex/);
  assert.match(html, /会话主动任务/);
  assert.doesNotMatch(html, /待整理 inbox/);
  assert.doesNotMatch(html, /需求卡片/);
  assert.doesNotMatch(html, /react-loading-skeleton/);
});
