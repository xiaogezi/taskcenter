import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateUsageIndex } from "../scripts/usage-index.mjs";
import { createTaskUsageAttributor } from "../scripts/usage-report.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "taskcenter-attribution-refresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionsRoot = join(root, "sessions");
  await mkdir(sessionsRoot);
  const file = join(sessionsRoot, "session.jsonl");
  const source = [
    { type: "session_meta", payload: { id: "s" } },
    { timestamp: "2026-11-01T11:00:00Z", payload: { info: { last_token_usage: { input_tokens: 100, output_tokens: 5 } } } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(file, source);
  return { file, source, options: { sessionsRoot, indexPath: join(root, "index.json"), ledger: [], rates: {}, now: Date.parse("2026-11-17T12:00:00Z") } };
}
const task = { id: "t", sessionId: "s", status: "in_progress", createdAt: "2026-11-01T10:00:00Z" };

test("账本补录触发完整来源重算，超过七日的累计不丢失且重试不重复计数", async t => {
  const { file, options } = await fixture(t);
  await updateUsageIndex(options);
  const result = await updateUsageIndex({ ...options, ledger: [task] });
  assert.deepEqual(result.report.lifetime.byTask.map(row => [row.id, row.totalTokens]), [["t", 105]]);
  assert.equal(result.index.files[file].events.length, 0, "不能依赖已裁剪的七日事件重建 lifetime");
  assert.equal((await updateUsageIndex({ ...options, ledger: [task] })).report.lifetime.totals.totalTokens, 105);
});

test("生命周期边界修正重新归属，普通进展更新不使索引失效", async t => {
  const { options } = await fixture(t);
  await updateUsageIndex({ ...options, ledger: [task] });
  const closed = { ...task, status: "done_claimed", actualAt: "2026-11-01T10:30:00Z" };
  const result = await updateUsageIndex({ ...options, ledger: [closed] });
  assert.deepEqual(result.report.lifetime.byTask.map(row => [row.id, row.totalTokens]), [["unattributed", 105]]);
  assert.equal(createTaskUsageAttributor([task]).fingerprint("s"), createTaskUsageAttributor([{ ...task, title: "new", updatedAt: "2026-11-18" }]).fingerprint("s"));
});

test("来源日志缺失不凭裁剪事件重算历史，并显式报告既有删除语义", async t => {
  const { file, source, options } = await fixture(t);
  await updateUsageIndex(options);
  await rm(file);
  const missing = await updateUsageIndex({ ...options, ledger: [task] });
  assert.equal(missing.index.files[file], undefined, "不引入新的历史累计留存策略");
  assert.ok(missing.report.warnings.some(row => row.code === "LIFETIME_SOURCE_UNAVAILABLE"));
  await writeFile(file, source);
  const restored = await updateUsageIndex({ ...options, ledger: [task] });
  assert.deepEqual(restored.report.lifetime.byTask.map(row => [row.id, row.totalTokens]), [["t", 105]]);
  assert.equal(restored.report.warnings.some(row => row.code === "LIFETIME_SOURCE_UNAVAILABLE"), false);
});
