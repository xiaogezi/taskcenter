import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { classifyMessage } from "../scripts/classify-message.mjs";

const root = new URL("../", import.meta.url);
const dashboardPath = process.env.TASKCENTER_DASHBOARD_PATH || ".local/test-dashboard.json";
const integrationMode = process.env.TASKCENTER_TEST_MODE === "integration";

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
  assert.ok(Array.isArray(dashboard.requirements));
  assert.ok(Array.isArray(dashboard.threads));
  if (!integrationMode) {
    assert.ok(dashboard.requirements.length >= 1, `requirements: ${dashboard.requirements.length}`);
    assert.ok(dashboard.threads.length >= 1, `threads: ${dashboard.threads.length}`);
  }
  // 状态分布验证：至少存在不同状态
  const statusKeys = ["verified", "in_progress", "partial", "missing", "needs_validation", "untriaged"];
  const hasAnyStatus = statusKeys.some((status) => (dashboard.summary.statusCounts[status] ?? 0) > 0);
  if (!integrationMode) assert.ok(hasAnyStatus, "fixture 应存在至少一种状态");
  assert.equal(dashboard.source.mode, "read-only local JSONL");
  // 分类计数验证
  assert.ok(typeof dashboard.summary.excludedCount === "number");
  assert.ok(typeof dashboard.source.classificationCounts.operation === "number");
});

test("中性示例需求按专业需求和父子层级同步", { skip: integrationMode ? "集成模式读取本机数据，不使用测试 fixture" : false }, async () => {
  const dashboard = await readDashboard();
  const epic = dashboard.requirements.find((item) => item.id === "example-platform-governance");
  assert.ok(epic, "fixture 必须包含 example-platform-governance");
  assert.equal(epic.project, "ExampleProject");
  assert.equal(epic.kind, "epic");
  assert.ok(["in_progress", "needs_validation", "verified"].includes(epic.status));
  assert.ok(Array.isArray(epic.acceptanceCriteria));
  assert.ok(Array.isArray(epic.implementationStages));
  assert.ok(Array.isArray(epic.evidencePaths));

  const childIds = [
    "example-api-storage-boundary",
    "example-remove-legacy-runtime",
    "example-query-reliability",
    "example-notification-inbox",
  ];
  for (const id of childIds) {
    const requirement = dashboard.requirements.find((item) => item.id === id);
    assert.ok(requirement, `fixture 必须包含 ${id}`);
    assert.equal(requirement.project, "ExampleProject");
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

test("治理 Review 诊断默认折叠并保留完整内容", async () => {
  const source = await readFile(new URL("app/page.tsx", root), "utf8");
  assert.match(source, /<details className="governance-block governance-review-details">/);
  assert.match(source, /Review 流程诊断/);
  assert.match(source, /governance-review-content/);
  assert.doesNotMatch(source, /<details className="governance-block governance-review-details" open/);
});

test("会话主动任务只保留一套生命周期筛选", async () => {
  const source = await readFile(new URL("app/page.tsx", root), "utf8");
  assert.match(source, /aria-label="未完成任务阶段筛选"/);
  assert.match(source, /aria-label="任务终态"/);
  assert.doesNotMatch(source, /需要关注：/);
  assert.doesNotMatch(source, /aria-label="时间筛选"/);
  assert.doesNotMatch(source, /attentionCounts/);
});

test("任务表展示生命周期 Token 估算与明细维度", async () => {
  const source = await readFile(new URL("app/page.tsx", root), "utf8");
  assert.match(source, /Token（估算）/);
  assert.match(source, /last_token_usage/);
  assert.match(source, /usagePayload\.lifetime\?\.byTask/);
  assert.match(source, /usagePayload\.lifetime\?\.bySession/);
  assert.match(source, /session-token-total/);
  assert.match(source, /会话精确值：\$\{formatExactTokens\(sessionTotalTokens\)\} Token/);
  assert.match(source, /notation: "compact"/);
  assert.match(source, /maximumSignificantDigits: 3/);
  assert.match(source, /精确值：\$\{formatExactTokens\(tokenUsage\.totalTokens\)\} Token/);
  assert.match(source, /推理 \{formatTokens\(tokenUsage\.usage\.reasoning\)\}/);
});

test("页面展示可审计的模型编排策略与用量不可用态", async () => {
  const source = await readFile(new URL("app/page.tsx", root), "utf8");
  assert.match(source, /额度与证据驱动的模型编排/);
  assert.match(source, /额度快照不可用，不以猜测升级高级模型/);
  assert.match(source, /Pro 周窗口已用/);
  assert.match(source, /不等于额度百分比/);
  assert.match(source, /preferred_model=\{escalationModel/);
  assert.match(source, /Reviewer：/);
  assert.match(source, /最近真实路由/);
});

test("已完成反思提案使用单一全局复查入口并降级历史派发错误", async () => {
  const source = await readFile(new URL("app/page.tsx", root), "utf8");
  assert.match(source, /复查已完成提案/);
  assert.match(source, /proposal\.status === "accepted"/);
  assert.match(source, /历史派发记录（不影响当前完成声明）/);
  assert.doesNotMatch(source, />再次反思验证效果</);
});
