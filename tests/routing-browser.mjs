// Isolated frontend with mocked Control API; never writes live routing policy.
// PLAYWRIGHT_MODULE=/path/to/playwright TASKCENTER_PREVIEW_URL=http://127.0.0.1:4318 node tests/routing-browser.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let version = 1, fail = false, policyReads = 0;
  await page.route('**/api/control/**', async route => {
    assert.equal(route.request().method(), 'GET');
    const path = new URL(route.request().url()).pathname;
    if (fail && path.endsWith('/routing/health')) return route.fulfill({ status: 503, json: { error: '模拟断线' } });
    let json = {};
    if (path.endsWith('/routing/health')) json = { models: [{ model: 'kimi-test', active_executors: version, concurrency_limit: 3 }], roles: { model_catalog: { 'catalog-model': { description: '目录测试模型' } } } };
    if (path.endsWith('/routing/optional-astra-policy')) { policyReads++; json = { policy: { preset: 'custom', threshold_percent: 12 } }; }
    if (path.endsWith('/tasks')) json = { tasks: [{ id: 'task-test', title: `调度版本${version}`, routingHistory: [{ routeId: 'route-test', selectedExecutorModel: 'kimi-test', recordedAt: new Date().toISOString() }] }] };
    if (path.endsWith('/governance-metrics')) json = { cliRuns: { runs: 1, byModel: {}, tokens: { reported: 0 }, recentRuns: [{ id: 'run-test', executorModel: `执行器版本${version}`, taskId: 'task-test', workspace: '/test', status: 'active' }] } };
    await route.fulfill({ json });
  });
  const eventually = async predicate => {
    for (let i = 0; i < 100; i++) { if (await predicate()) return; await page.waitForTimeout(100); }
    throw new Error('condition timed out');
  };
  await page.goto(`${process.env.TASKCENTER_PREVIEW_URL || 'http://127.0.0.1:4318'}/routing`);
  await eventually(async () => (await page.locator('body').innerText()).includes('调度版本1'));
  const headings = await page.locator('h2').allTextContents();
  assert.deepEqual(headings.slice(0, 2), ['当前执行器与最近派发', '最近真实调度']);
  const catalog = page.locator('details').filter({ hasText: '可选执行器目录' });
  assert.equal(await catalog.getAttribute('open'), null);
  await catalog.locator('summary').click();
  assert.equal(await page.getByText('目录测试模型').isVisible(), true);
  await catalog.locator('summary').click();
  await page.getByRole('spinbutton').fill('37');
  version = 2;
  await eventually(async () => (await page.locator('body').innerText()).includes('调度版本2'));
  assert.match(await page.locator('body').innerText(), /当前租约：2\/3/);
  assert.match(await page.locator('body').innerText(), /执行器版本2/);
  assert.equal(await page.getByRole('spinbutton').inputValue(), '37');
  assert.equal(policyReads, 1);
  fail = true;
  await eventually(async () => (await page.locator('body').innerText()).includes('模拟断线'));
  assert.match(await page.locator('body').innerText(), /保留上次数据/);
  assert.match(await page.locator('body').innerText(), /调度版本2/);
  fail = false; version = 3;
  await eventually(async () => (await page.locator('body').innerText()).includes('调度版本3'));
  assert.equal(await page.getByRole('spinbutton').inputValue(), '37');
  if (process.env.TASKCENTER_SCREENSHOT) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: process.env.TASKCENTER_SCREENSHOT });
  }
  assert.deepEqual(errors, []);
  console.log('PASS: order, collapsed catalog, live runs/leases/routes, unsaved policy, failure retention and recovery');
} finally { await browser.close(); }
