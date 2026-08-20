import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectUsage } from "../scripts/usage-report.mjs";

const session = [
  { type: "session_meta", payload: { cwd: "/repo/app" } },
  { type: "turn_context", payload: { model: "gpt-test", model_context_window: 100 } },
  { type: "event_msg", timestamp: "2026-08-20T00:00:00Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 80, cached_input_tokens: 20, output_tokens: 10 }, total_token_usage: { input_tokens: 999999 } } } },
  { type: "event_msg", timestamp: "2026-08-20T01:00:00Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 5 } } } },
];

test("只累计 last_token_usage，区分缓存输入并按模型计费", () => {
  const report = collectUsage({ sessions: [{ sessionId: "s1", records: session }], ledger: [{ id: "t1", session_id: "s1" }], rates: { "gpt-test": { input: 1, cachedInput: .5, output: 2 } }, now: "2026-08-20T02:00:00Z" });
  const total = report.windows["24h"].totals;
  assert.deepEqual(total.usage, { input: 100, cachedInput: 25, output: 15 });
  assert.ok(Math.abs(total.cost - (75 + 12.5 + 30) / 1_000_000) < 1e-12);
  assert.equal(report.windows["24h"].byTask[0].id, "t1");
});

test("多任务 Session 不重复分摊 Token，续调按次数预警", () => {
  const records = [{ type: "turn_context", payload: { model: "gpt-test" } }];
  for (let index = 0; index < 81; index++) records.push({
    type: "event_msg", timestamp: `2026-08-20T01:${String(index % 60).padStart(2, "0")}:00Z`,
    payload: { type: "token_count", info: { last_token_usage: { input_tokens: index + 1, cached_input_tokens: 0, output_tokens: 1 } } },
  });
  const report = collectUsage({
    sessions: [{ sessionId: "shared", records }],
    ledger: [{ id: "one", sessionId: "shared" }, { id: "two", sessionId: "shared" }],
    rates: { "gpt-test": { input: 1, cachedInput: .5, output: 2 } }, now: "2026-08-20T03:00:00Z",
  });
  assert.deepEqual(report.windows["24h"].byTask.map((item) => item.id), ["unattributed"]);
  assert.ok(report.alerts.some((item) => item.code === "MODEL_CONTINUATIONS_HIGH" && item.count === 81));
  assert.ok(report.alerts.some((item) => item.code === "MULTIPLE_INDEPENDENT_TASKS"));
});

test("Spark 无费率标记 unestimable，缺任务归属标记 unattributed", () => {
  const report = collectUsage({ sessions: [{ sessionId: "spark", records: [{ type: "turn_context", payload: { model: "gpt-5.3-codex-spark" } }, { type: "event_msg", timestamp: "2026-08-20T01:00:00Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } } } }] }], ledger: [], rates: {}, now: "2026-08-20T02:00:00Z" });
  assert.equal(report.windows["24h"].byModel[0].unestimable, true);
  assert.equal(report.windows["24h"].byTask[0].id, "unattributed");
  assert.equal(report.overall.creditsEstimation, "unestimable");
});

test("混合可估算与无费率模型时保留可估算 Credits 并标记 partial", () => {
  const records = [
    { type: "turn_context", payload: { model: "gpt-test" } },
    { type: "event_msg", timestamp: "2026-08-20T00:00:00Z", payload: { info: { last_token_usage: { input_tokens: 100, output_tokens: 10 } } } },
    { type: "turn_context", payload: { model: "gpt-5.3-codex-spark" } },
    { type: "event_msg", timestamp: "2026-08-20T01:00:00Z", payload: { info: { last_token_usage: { input_tokens: 200, output_tokens: 20 } } } },
  ];
  const report = collectUsage({ sessions: [{ sessionId: "mixed", records }], ledger: [], rates: { "gpt-test": { input: 1, cachedInput: .5, output: 2 } }, now: "2026-08-20T02:00:00Z" });
  assert.ok(report.overall.estimatedCredits > 0);
  assert.equal(report.overall.creditsEstimation, "partial");
  assert.equal(report.windows["24h"].bySession[0].unestimable, true);
  assert.ok(report.alerts.some((alert) => alert.code === "SESSION_CREDIT_SHARE_HIGH"));
});

test("Token 事件兼容 created_at 与 payload.timestamp，缺失时间戳显式告警", () => {
  const records = [
    { type: "turn_context", payload: { model: "gpt-test" } },
    { type: "event_msg", created_at: "2026-08-20T00:00:00Z", payload: { info: { last_token_usage: { input_tokens: 10 } } } },
    { type: "event_msg", payload: { timestamp: "2026-08-20T01:00:00Z", info: { last_token_usage: { input_tokens: 20 } } } },
    { type: "event_msg", payload: { info: { last_token_usage: { input_tokens: 30 } } } },
  ];
  const report = collectUsage({ sessions: [{ sessionId: "timestamps", records }], ledger: [], rates: { "gpt-test": { input: 1 } }, now: "2026-08-20T02:00:00Z" });
  assert.equal(report.windows["24h"].totals.usage.input, 30);
  assert.ok(report.alerts.some((alert) => alert.code === "USAGE_TIMESTAMP_MISSING" && alert.count === 1));
});

test("真实 rollout 文件名提取 Codex Session UUID 并按可估算 Credits 预警", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "taskcenter-usage-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = "019f0000-0000-7000-8000-000000000123";
  const file = join(root, `rollout-2026-08-20T09-00-00-${sessionId}.jsonl`);
  await writeFile(file, [
    JSON.stringify({ type: "session_meta", payload: { cwd: "/repo" } }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-test" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-08-20T01:00:00Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 } } } }),
  ].join("\n"));
  const report = collectUsage({ sessionsRoot: root, ledger: [{ id: "task", sessionId }], rates: { "gpt-test": { input: 1, cachedInput: .5, output: 2 } }, now: "2026-08-20T02:00:00Z" });
  assert.equal(report.windows["24h"].bySession[0].sessionId, sessionId);
  assert.equal(report.windows["24h"].byTask[0].id, "task");
  assert.ok(report.alerts.some((alert) => alert.code === "SESSION_CREDIT_SHARE_HIGH" && alert.sessionId === sessionId));
});
