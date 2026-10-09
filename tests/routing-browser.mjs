// Isolated frontend with mocked Control API; never mutates live routing policy.
// PLAYWRIGHT_MODULE=/path/to/playwright TASKCENTER_PREVIEW_URL=http://127.0.0.1:4318 node tests/routing-browser.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], requests = [];
  page.on("pageerror", error => errors.push(error.message));
  let fail = false;
  const now = new Date().toISOString();
  await page.route("**/api/control/**", async route => {
    requests.push(route.request().method());
    assert.equal(route.request().method(), "GET");
    const path = new URL(route.request().url()).pathname;
    let json = {};
    if (path.endsWith("/routing/health")) json = { models: [], roles: {} };
    if (path.endsWith("/routing/optional-astra-policy")) json = { policy: { preset: "saving", threshold_percent: 0 } };
    if (path.endsWith("/routing/models")) json = { content_hash: "fixture", executor_model: "", fallback_models: [], manual_only_models: [], retired_models: [], models: [] };
    if (path.endsWith("/routing/decisions")) {
      const base = { task_id: "fixture", created_at: now, channel: "direct", task_class: "implementation", preferred_model: "main", selected_model: "main", reasoning_effort: "low", reason: "main_model_fallback" };
      json = { total: 3, next_cursor: null, routes: [
        { ...base, route_id: "current", task_title: "当前恢复任务", status: "leased", recovery_applicability: "current", next_action: "确认原执行器停止后主模型继续" },
        { ...base, route_id: "history", task_title: "历史恢复任务", status: "failed", recovery_applicability: "reference_only", next_action: "旧步骤仅参考" },
        { ...base, route_id: "legacy", task_title: "旧服务成功任务", status: "succeeded" },
      ] };
    }
    if (path.endsWith("/gate-denials")) {
      if (fail) return route.fulfill({ status: 503, json: { error: "模拟拒绝查询断线" } });
      json = { generated_at: now, records: [{ at: now, category: "missing_route", source: "hook", session_id: "safe-session", task_id: "", run_id: "" }], assessments: [{ category: "missing_route", level: "single", window_ms: 3600000, reason: "<img src=x onerror=alert(1)>缺少有效路由", recovery: "先核对任务并获取有效 direct", verification: "重试原操作并核对实际结果" }] };
    }
    await route.fulfill({ json });
  });
  await page.goto(`${process.env.TASKCENTER_PREVIEW_URL || "http://127.0.0.1:4318"}/routing`);
  const card = title => page.locator("article").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  const current = card("当前恢复任务");
  await current.locator("summary").click();
  assert.match(await current.innerText(), /下一步：确认原执行器停止后主模型继续/);
  assert.match(await current.innerText(), /不代表任务完成/);
  const history = card("历史恢复任务");
  await history.locator("summary").click();
  assert.match(await history.innerText(), /本记录不构成现在接管的依据/);
  assert.match(await history.innerText(), /处理参考：旧步骤仅参考/);
  const legacy = card("旧服务成功任务");
  await legacy.locator("summary").click();
  assert.match(await legacy.innerText(), /适用性未知/);
  assert.match(await legacy.innerText(), /未提供恢复指引/);
  const denials = page.locator("section").filter({ has: page.getByRole("heading", { name: "最近拒绝与恢复步骤", exact: true }) }).last();
  await denials.locator("summary").click();
  assert.match(await denials.innerText(), /task：未绑定/);
  assert.match(await denials.innerText(), /验证：重试原操作并核对实际结果/);
  assert.equal(await denials.locator("img").count(), 0, "错误正文必须以文本显示");
  fail = true;
  await page.getByRole("button", { name: "返回最新并刷新" }).click();
  await page.getByText(/拒绝记录读取失败，保留上次数据：模拟拒绝查询断线/).waitFor();
  assert.match(await denials.innerText(), /safe-session/);
  fail = false;
  await page.getByRole("button", { name: "返回最新并刷新" }).click();
  await page.getByText(/拒绝记录读取失败，保留上次数据/).waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
  assert.ok(requests.length > 2 && requests.every(method => method === "GET"));
  if (process.env.TASKCENTER_SCREENSHOT) await page.screenshot({ path: process.env.TASKCENTER_SCREENSHOT, fullPage: true });
  console.log("PASS: current/history/legacy recovery, denial verification, text escaping, failure retention, refresh uses only GET");
} finally { await browser.close(); }
