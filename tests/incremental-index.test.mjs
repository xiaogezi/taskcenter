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
  const usage = (time, input) => ({ timestamp: time, payload: { info: { last_token_usage: { input_tokens: input, cached_input_tokens: 10, output_tokens: 5 } } } });
  await writeFile(session, `${JSON.stringify(context)}\n${JSON.stringify(usage("2026-08-22T07:00:00.000Z", 100))}\n`);
  const options = { sessionsRoot, indexPath, ledger: [], rates: { "gpt-5.6-luna": { input: 1, cachedInput: 1, output: 1 } }, now };
  let result = await updateUsageIndex(options);
  assert.equal(result.report.windows["5h"].modelContinuations, 1);
  result = await updateUsageIndex(options);
  assert.equal(result.report.windows["5h"].modelContinuations, 1);
  await appendFile(session, `${JSON.stringify(usage("2026-08-22T07:30:00.000Z", 200))}\n`);
  result = await updateUsageIndex(options);
  assert.equal(result.report.windows["5h"].modelContinuations, 2);
  await writeFile(session, `${JSON.stringify(context)}\n${JSON.stringify(usage("2026-08-22T07:45:00.000Z", 300))}\n`);
  result = await updateUsageIndex(options);
  assert.equal(result.report.windows["5h"].modelContinuations, 1);
  const rewrittenUsage = [400, 500, 600, 700].map((input, index) => usage(`2026-08-22T07:${50 + index}:00.000Z`, input));
  await writeFile(session, `${JSON.stringify(context)}\n${rewrittenUsage.map((item) => JSON.stringify(item)).join("\n")}\n`);
  result = await updateUsageIndex(options);
  assert.equal(result.report.windows["5h"].modelContinuations, 4, "同 inode 扩容重写必须重建，不能混入旧游标状态");
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
