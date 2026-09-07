import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { consumeJsonl } from "../scripts/jsonl-stream.mjs";
import { updateTaskEventIndex } from "../scripts/task-event-index.mjs";
import { updateUsageIndex } from "../scripts/usage-index.mjs";

test("JSONL 游标只提交完整行，并在追加后续读", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taskcenter-jsonl-"));
  const path = join(dir, "events.jsonl");
  await writeFile(path, '{"id":1}\n{"id":2');
  const seen = [];
  const first = await consumeJsonl(path, { onLine: (line) => seen.push(JSON.parse(line)) });
  assert.deepEqual(seen, [{ id: 1 }]);
  assert.equal(first.offset, Buffer.byteLength('{"id":1}\n'));
  await appendFile(path, '}\n');
  const second = await consumeJsonl(path, { start: first.offset, onLine: (line) => seen.push(JSON.parse(line)) });
  assert.deepEqual(seen, [{ id: 1 }, { id: 2 }]);
  assert.equal(second.offset, Buffer.byteLength(await readFile(path, "utf8")));
});

test("JSONL 超长单行被有界跳过，不进入回调", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taskcenter-jsonl-large-"));
  const path = join(dir, "events.jsonl");
  await writeFile(path, `${"x".repeat(4096)}\n{\"ok\":true}\n`);
  const seen = [];
  const result = await consumeJsonl(path, { maxLineBytes: 1024, onLine: (line) => seen.push(JSON.parse(line)) });
  assert.equal(result.skippedOversizedLines, 1);
  assert.deepEqual(seen, [{ ok: true }]);
});

test("Session 用量增量索引不重复累计并处理截断", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taskcenter-usage-index-"));
  const sessionsRoot = join(dir, "sessions");
  const sessionDir = join(sessionsRoot, "2026", "08", "22");
  await mkdir(sessionDir, { recursive: true });
  const session = join(sessionDir, "rollout-019ffa8c-c737-72f1-b7f7-4566e77c057d.jsonl");
  const indexPath = join(dir, "usage-index.json");
  const now = Date.parse("2026-08-22T08:00:00.000Z");
  const context = { type: "turn_context", payload: { model: "gpt-5.6-luna", model_context_window: 100000 } };
  const usage = (time, input, usedPercent) => ({ timestamp: time, payload: { rate_limits: { primary: { used_percent: usedPercent, window_minutes: 10080, resets_at: 1780000000 } }, info: { last_token_usage: { input_tokens: input, cached_input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 2, total_tokens: input + 5 } } } });
  await writeFile(session, `${JSON.stringify(context)}\n${JSON.stringify(usage("2026-08-22T07:00:00.000Z", 100, 12))}\n`);
  const options = { sessionsRoot, indexPath, ledger: [], rates: { "gpt-5.6-luna": { input: 1, cachedInput: 1, output: 1 } }, now };
  let result = await updateUsageIndex(options);
  assert.equal(result.report.windows["5h"].modelContinuations, 1);
  assert.equal(result.report.lifetime.totals.totalTokens, 105);
  assert.equal(result.report.lifetime.bySession[0].totalTokens, 105);
  assert.equal(result.report.lifetime.totals.usage.reasoning, 2);
  assert.equal(result.report.rate_limits.primary.used_percent, 12);
  result = await updateUsageIndex(options);
  assert.equal(result.report.windows["5h"].modelContinuations, 1);
  assert.equal(result.report.lifetime.totals.totalTokens, 105, "重复扫描不能重复累计生命周期 Token");
  await appendFile(session, `${JSON.stringify(usage("2026-08-22T07:30:00.000Z", 200, 34))}\n`);
  result = await updateUsageIndex(options);
  assert.equal(result.report.windows["5h"].modelContinuations, 2);
  assert.equal(result.report.rate_limits.primary.used_percent, 34);
  await writeFile(session, `${JSON.stringify(context)}\n${JSON.stringify(usage("2026-08-22T07:45:00.000Z", 300))}\n`);
  result = await updateUsageIndex(options);
  assert.equal(result.report.windows["5h"].modelContinuations, 1);
  const rewrittenUsage = [400, 500, 600, 700].map((input, index) => usage(`2026-08-22T07:${50 + index}:00.000Z`, input));
  await writeFile(session, `${JSON.stringify(context)}\n${rewrittenUsage.map((item) => JSON.stringify(item)).join("\n")}\n`);
  result = await updateUsageIndex(options);
  assert.equal(result.report.windows["5h"].modelContinuations, 4, "同 inode 扩容重写必须重建，不能混入旧游标状态");
  assert.equal(result.report.lifetime.totals.totalTokens, 400 + 500 + 600 + 700 + 4 * 5, "文件重写后生命周期累计必须随文件状态重建");
});

test("任务生命周期累计在七日原始事件裁剪后仍保留", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taskcenter-lifetime-usage-"));
  const sessionsRoot = join(dir, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  const sessionId = "019ffa8c-c737-72f1-b7f7-4566e77c0999";
  const session = join(sessionsRoot, `rollout-${sessionId}.jsonl`);
  const indexPath = join(dir, "usage-index.json");
  await writeFile(session, [
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-test" } }),
    JSON.stringify({ timestamp: "2026-08-01T00:30:00.000Z", payload: { info: { last_token_usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 3, total_tokens: 130 } } } }),
  ].join("\n") + "\n");
  const options = {
    sessionsRoot,
    indexPath,
    ledger: [{ id: "old-task", sessionId, status: "done_claimed", firstStartedAt: "2026-08-01T00:00:00.000Z", actualAt: "2026-08-01T01:00:00.000Z" }],
    rates: {},
    now: Date.parse("2026-08-22T08:00:00.000Z"),
  };
  let result = await updateUsageIndex(options);
  assert.equal(result.report.windows["7d"].modelContinuations, 0);
  assert.equal(result.report.lifetime.byTask[0].id, "old-task");
  assert.equal(result.report.lifetime.byTask[0].totalTokens, 130);
  assert.equal(result.report.lifetime.bySession[0].totalTokens, 130, "会话累计在原始事件裁剪后仍保留");
  result = await updateUsageIndex(options);
  assert.equal(result.report.lifetime.byTask[0].totalTokens, 130);
});

test("任务事件索引仅追加新事件并保留窗口内记录", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taskcenter-event-index-"));
  const sourcePath = join(dir, "task-events.jsonl");
  const indexPath = join(dir, "task-event-index.json");
  const now = Date.parse("2026-08-22T08:00:00.000Z");
  const event = (id, at) => ({ event_id: id, task_id: "task", type: "task.update", recorded_at: at });
  await writeFile(sourcePath, `${JSON.stringify(event("old", "2026-08-20T08:00:00.000Z"))}\n${JSON.stringify(event("new", "2026-08-22T07:00:00.000Z"))}\n`);
  let index = await updateTaskEventIndex({ sourcePath, indexPath, now });
  assert.deepEqual(index.events.map((item) => item.event_id), ["new"]);
  assert.deepEqual(index.byTask.task.map((item) => item.event_id), ["old", "new"], "详情索引保留每个任务最近事件，不受指标窗口裁剪");
  index = await updateTaskEventIndex({ sourcePath, indexPath, now });
  assert.deepEqual(index.events.map((item) => item.event_id), ["new"]);
  await appendFile(sourcePath, `${JSON.stringify(event("next", "2026-08-22T07:30:00.000Z"))}\n`);
  index = await updateTaskEventIndex({ sourcePath, indexPath, now });
  assert.deepEqual(index.events.map((item) => item.event_id), ["new", "next"]);
  assert.deepEqual(index.byTask.task.map((item) => item.event_id), ["old", "new", "next"]);
  const rewritten = Array.from({ length: 6 }, (_, itemIndex) => event(`rewrite-${itemIndex}`, `2026-08-22T07:${40 + itemIndex}:00.000Z`));
  await writeFile(sourcePath, `${rewritten.map((item) => JSON.stringify({ ...item, reason: "x".repeat(80) })).join("\n")}\n`);
  index = await updateTaskEventIndex({ sourcePath, indexPath, now });
  assert.deepEqual(index.events.map((item) => item.event_id), rewritten.map((item) => item.event_id));
  assert.deepEqual(index.byTask.task.map((item) => item.event_id), rewritten.map((item) => item.event_id), "同 inode 扩容重写必须丢弃旧详情索引");
});
