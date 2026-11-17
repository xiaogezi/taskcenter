import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectUsage } from "../scripts/usage-report.mjs";
import { updateUsageIndex } from "../scripts/usage-index.mjs";

const at = (seconds) => new Date(Date.parse("2026-11-17T00:00:00Z") + seconds * 1000).toISOString();
const item = (seconds, payload) => ({ type: "response_item", timestamp: at(seconds), payload });
const usage = (seconds, input, capacity) => ({ type: "event_msg", timestamp: at(seconds),
  payload: { type: "token_count", model_context_window: capacity, info: { last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 1 } } } });

test("后台统计占用与响应代理值，工具回执不等于成功且不保存正文", () => {
  const records = [
    { type: "session_meta", payload: { cwd: "/work" } },
    { type: "turn_context", payload: { model: "gpt-test", model_context_window: 100 } },
    item(0, { type: "message", role: "user", content: "SECRET_PROMPT" }),
    item(.2, { type: "reasoning", content: "SECRET_REASONING" }),
    item(1, { type: "custom_tool_call", call_id: "call-1", input: "SECRET_COMMAND" }),
    item(2, { type: "custom_tool_call_output", call_id: "call-1", output: "SECRET_OUTPUT" }),
    item(2.3, { type: "message", role: "assistant", content: "done" }),
    item(3, { type: "custom_tool_call", call_id: "call-1", input: "another" }),
    usage(4, 80, 100),
  ];
  const report = collectUsage({ sessions: [{ sessionId: "s", records }], ledger: [], rates: {}, now: at(10) });
  const window = report.windows["24h"];
  assert.equal(window.contextOccupancy.sampleCount, 1);
  assert.equal(window.contextOccupancy.ratio.p50, .8);
  assert.equal(window.contextOccupancy.atLeast80Percent, 1);
  assert.deepEqual(window.responseGapProxy.durationMs, { average: 250, p50: 200, p95: 300 });
  assert.equal(window.responseGapProxy.exactModelRtt, false);
  assert.equal(window.responseGapProxy.sameTimestampPairsExcluded, 0);
  assert.deepEqual(window.toolSignals, { source: "codex_custom_tool_call", calls: 2, receiptsObserved: 1, duplicateCallIds: 1, resultSuccess: "unavailable" });
  assert.doesNotMatch(JSON.stringify(report), /SECRET|call-1/);
});

test("同时间戳不形成零耗时响应样本", () => {
  const records = [item(0, { type: "message", role: "user" }),
    item(0, { type: "reasoning" }),
    item(1, { type: "custom_tool_call_output", call_id: "missing" }),
    item(1, { type: "message", role: "assistant" })];
  const report = collectUsage({ sessions: [{ sessionId: "s", records }], ledger: [], rates: {}, now: at(2) });
  assert.equal(report.windows["24h"].responseGapProxy.inputCount, 2);
  assert.equal(report.windows["24h"].responseGapProxy.sampleCount, 0);
  assert.equal(report.windows["24h"].responseGapProxy.durationMs.p50, null);
});

test("增量索引跨刷新配对回执，重复刷新不重计且缺窗口不伪装零占用", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "taskcenter-passive-signals-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "session.jsonl");
  const indexPath = join(root, "index.json");
  const first = [
    { type: "session_meta", payload: { id: "s", cwd: "/work" } },
    item(0, { type: "message", role: "user" }),
    item(.1, { type: "custom_tool_call", call_id: "pending", input: "SECRET" }),
  ];
  await writeFile(file, first.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const options = { sessionsRoot: root, indexPath, ledger: [], rates: {}, now: Date.parse(at(10)) };
  await updateUsageIndex(options);
  await appendFile(file, [item(1, { type: "custom_tool_call_output", call_id: "pending", output: "SECRET" }),
    item(1.2, { type: "message", role: "assistant" }), usage(2, 50, 0)].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const second = await updateUsageIndex(options);
  const third = await updateUsageIndex(options);
  assert.deepEqual(second.report.windows["24h"].toolSignals, third.report.windows["24h"].toolSignals);
  assert.equal(third.report.windows["24h"].toolSignals.receiptsObserved, 1);
  assert.equal(third.report.windows["24h"].responseGapProxy.sampleCount, 2);
  assert.equal(third.report.windows["24h"].contextOccupancy.sampleCount, 0);
  assert.equal(third.report.windows["24h"].contextOccupancy.coverage, 0);
  assert.equal(third.report.windows["24h"].contextOccupancy.ratio.p50, null);
  assert.doesNotMatch(JSON.stringify(third.index), /SECRET/);
});
