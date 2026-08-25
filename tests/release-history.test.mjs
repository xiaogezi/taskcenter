import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendReleaseEvent, loadReleaseEvents, summarizeReleaseEvents } from "../scripts/release-history.mjs";

test("发布事件只追加并可聚合成功率、回滚率和耗时分位数", () => {
  const directory = mkdtempSync(join(tmpdir(), "taskcenter-release-history-"));
  const path = join(directory, "events.jsonl");
  try {
    appendReleaseEvent(path, { deploymentId: "d1", stage: "deployment", outcome: "succeeded", durationMs: 100 });
    appendReleaseEvent(path, { deploymentId: "d2", stage: "deployment", outcome: "rolled_back", durationMs: 300 });
    appendReleaseEvent(path, { deploymentId: "d3", stage: "deployment", outcome: "succeeded", durationMs: 200 });
    const events = loadReleaseEvents(path);
    const summary = summarizeReleaseEvents(events);
    assert.equal(events.length, 3);
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 3);
    assert.deepEqual(summary, {
      deployments: 3,
      succeeded: 2,
      rolledBack: 1,
      failed: 0,
      successRate: 2 / 3,
      rollbackRate: 1 / 3,
      durationMs: { p50: 200, p95: 300 },
      lastDeployment: events[2],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("损坏事件行不阻断历史读取", () => {
  const summary = summarizeReleaseEvents([
    { schemaVersion: "release-event/v1", outcome: "failed", durationMs: 50 },
  ]);
  assert.equal(summary.failed, 1);
  assert.equal(summary.durationMs.p50, 50);
});
