import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyGateDenial, evaluateGateDenials, gateDenialSnapshot } from "../scripts/governance-metrics.mjs";
import { boundedResponse } from "../scripts/bounded-response.mjs";
import { controlProxyTarget, isAllowedControlPath } from "../lib/control-proxy.mjs";

const dir = mkdtempSync(join(tmpdir(), "taskcenter-recovery-"));
process.env.TASKCENTER_ROUTING_CONTROL_PATH = join(dir, "routing.json");
process.env.TASKCENTER_RUNTIME_DIR = dir;
test.after(() => rmSync(dir, { recursive: true, force: true }));
const now = "2026-10-09T10:00:00Z";

test("具体拒绝优先分类，恢复不绕过 RTK、权限或原生执行边界", () => {
  const samples = {
    no_active_task: "TaskCenter 门禁：当前 Session 无活跃任务",
    session_unregistered: "TaskCenter 门禁：当前 Session 尚未登记",
    missing_route: "TaskCenter 门禁：执行阶段缺少有效路由",
    interactive_command: "TaskCenter 门禁：交互式命令",
    tool_approval: "TaskCenter 门禁：MCP tool call requires approval",
    filesystem_permission: "TaskCenter 门禁：EACCES sandbox",
    scheduled_readonly_scope: "TaskCenter 门禁：scheduled_readonly 范围外",
    reviewer_readonly: "TaskCenter 门禁：Reviewer Session 只读",
    task_permission: "CLI_GRANT_MISMATCH claim rejected",
    taskcenter_unavailable: "TASKCENTER_UNAVAILABLE fetch failed",
    gate_other: "unknown",
  };
  for (const [category, message] of Object.entries(samples)) {
    assert.equal(classifyGateDenial({ message }), category);
    const assessment = evaluateGateDenials([], { category });
    assert.ok(assessment.reason && assessment.recovery && assessment.verification);
    assert.doesNotMatch(assessment.recovery, /去掉包装后重试|重跑该 CLI Run|--stdin|manifest|退出 scheduled_readonly/);
  }
  assert.match(evaluateGateDenials([], { category: "no_active_task" }).recovery, /明确允许.*同一 Hook/);
  assert.match(evaluateGateDenials([], { category: "task_permission" }).recovery, /主线任务所有权/);
});

test("拒绝查询限量、去除敏感字段且保留空任务和历史记录，读失败不当空数据", () => {
  const path = join(dir, "denials.jsonl");
  const record = { at: now, category: "missing_route", session_id: "s", task_id: "", command: "secret", message: "token", claim_token: "secret", source: "native", run_id: "<script>" };
  writeFileSync(path, `${JSON.stringify(record)}\ninvalid\n${JSON.stringify({ ...record, at: "2026-10-08T00:00:00Z", category: "__proto__" })}\n`);
  const snapshot = gateDenialSnapshot(path, { now: Date.parse(now), limit: 50 });
  assert.equal(snapshot.records.length, 2);
  assert.equal(snapshot.records[0].task_id, "");
  assert.equal(snapshot.records[0].run_id, "");
  assert.equal(snapshot.records[1].category, "gate_other");
  assert.equal(snapshot.assessments.find(x => x.category === "gate_other").counts.events, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|claim_token|command|<script>/);
  assert.equal(gateDenialSnapshot(path, { limit: 1 }).records.length, 1);
  for (const limit of [0, 51, 1.5, NaN]) assert.throws(() => gateDenialSnapshot(path, { limit }), RangeError);
  assert.deepEqual(gateDenialSnapshot(join(dir, "missing.jsonl")).records, []);
  const unreadable = join(dir, "directory"); mkdirSync(unreadable);
  assert.throws(() => gateDenialSnapshot(unreadable));
  assert.equal(isAllowedControlPath("/gate-denials", "GET"), true);
  assert.equal(isAllowedControlPath("/gate-denials", "POST"), false);
  assert.equal(controlProxyTarget("/gate-denials", "?limit=1&claim_token=secret&task_id=wrong").search, "?limit=1");
});

test("超长路由回执保留身份、有效期和安全下一步，完整原文留在 continuation", () => {
  const route = { route_id: "route", task_id: "task", selected_model: "main", channel: "direct", status: "leased", available: true, expires_at: now, next_action: "核对原执行器已停止后继续", result: { request_id: "x".repeat(9000) } };
  const response = boundedResponse({ accepted: true, route, message: "x".repeat(9000) });
  assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 4096);
  for (const key of ["route_id", "task_id", "selected_model", "channel", "status", "available", "expires_at", "next_action"]) assert.equal(response.route[key], route[key]);
  let cursor = response.continuation_cursor, restored = "";
  while (cursor) { const part = boundedResponse({}, { cursor }); restored += part.fragment; cursor = part.continuation_cursor; }
  assert.equal(JSON.parse(restored).route.result.request_id, route.result.request_id);
  const error = boundedResponse({ accepted: false, error: "TASKCENTER_REQUEST_FAILED", assessment: evaluateGateDenials([], { category: "missing_route" }), padding: "x".repeat(9000) });
  assert.equal(error.assessment.category, "missing_route");
  assert.ok(error.assessment.recovery);
  assert.equal(boundedResponse({}, { cursor: "gone:0" }).next_action, "repeat_original_query");
});
