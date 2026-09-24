import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GATE_DENIAL_BATCH_RUNS,
  GATE_DENIAL_BATCH_TASKS,
  GATE_DENIAL_CONSECUTIVE,
  classifyGateDenial,
  evaluateGateDenials,
  formatGateDenialAssessment,
  readGateDenials,
  recordGateDenial,
} from "../scripts/governance-metrics.mjs";

const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

test("拒绝即时记录只落安全分类，单次拒绝给出恢复与验证步骤", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-denial-"));
  const path = join(dir, "gate-denials.jsonl");
  try {
    const { record, assessment } = recordGateDenial(path, {
      source: "hook",
      message: "该命令不满足 L0 确定性只读规则（L0_COMMAND_NOT_RECOGNIZED），当前 Session 无活跃任务或有效 delegation；secret-token",
      session_id: "sess-a",
      task_id: "",
      run_id: "",
    }, NOW);
    assert.equal(record.category, "no_active_task");
    assert.equal(record.session_id, "sess-a");
    assert.equal(assessment.level, "single");
    assert.match(assessment.recovery, /taskcenter_task_resume/);
    assert.match(assessment.verification, /task-prepare|任务门禁通过/);
    const raw = readFileSync(path, "utf8");
    assert.doesNotMatch(raw, /secret-token|L0_COMMAND_NOT_RECOGNIZED|无活跃任务/);
    assert.equal(readGateDenials(path).length, 1);
    const lines = formatGateDenialAssessment(assessment).split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0], /拒绝评估：single/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("短窗口去重后按任务数、Run 数与单任务连续次数判定批量或连续拒绝", () => {
  // 同一身份 60s 内的重复拒绝去重：3 条紧挨的 no_active_task 只计 1，不判连续。
  const rapid = [0, 1_000, 2_000].map((offset) => ({
    at: iso(offset), category: "no_active_task", session_id: "sess-r", task_id: "task-r", run_id: "",
  }));
  assert.equal(evaluateGateDenials(rapid, { now: NOW }).level, "single");
  assert.equal(evaluateGateDenials(rapid, { now: NOW }).counts.repeated, 1);

  // 1 小时窗口内同分类触及 3 个独立任务 → batch。
  const tasks = Array.from({ length: GATE_DENIAL_BATCH_TASKS }, (_, index) => ({
    at: iso(-index * 120_000), category: "task_permission", session_id: `sess-${index}`, task_id: `task-${index}`, run_id: `run-${index}`,
  }));
  const batchTasks = evaluateGateDenials(tasks, { now: NOW });
  assert.equal(batchTasks.level, "batch");
  assert.equal(batchTasks.counts.tasks, GATE_DENIAL_BATCH_TASKS);

  // 同分类 5 个独立 CLI Run（任务数不足 3）→ batch。
  const runs = Array.from({ length: GATE_DENIAL_BATCH_RUNS }, (_, index) => ({
    at: iso(-index * 120_000), category: "task_permission", session_id: "sess-cli", task_id: "task-shared", run_id: `delegation-${index}`, failure_kind: "task_permission",
  }));
  const batchRuns = evaluateGateDenials(runs, { now: NOW });
  assert.equal(batchRuns.level, "batch");
  assert.equal(batchRuns.counts.runs, GATE_DENIAL_BATCH_RUNS);
  assert.ok(batchRuns.recovery.includes("共性根因"));
  const parallelRuns = runs.map((run) => ({ ...run, at: iso(0) }));
  assert.equal(evaluateGateDenials(parallelRuns, { now: NOW }).counts.runs, GATE_DENIAL_BATCH_RUNS);

  // 单任务去重后连续 3 次（间隔超过短窗口）→ continuous，且保留 failure_kind 分类恢复语。
  const consecutive = Array.from({ length: GATE_DENIAL_CONSECUTIVE }, (_, index) => ({
    at: iso(-(GATE_DENIAL_CONSECUTIVE - 1 - index) * 120_000), category: "task_permission", session_id: "sess-c", task_id: "task-c", run_id: `run-c-${index}`, failure_kind: "task_permission",
  }));
  const continuous = evaluateGateDenials(consecutive, { now: NOW });
  assert.equal(continuous.level, "repeated");
  assert.equal(continuous.counts.repeated, GATE_DENIAL_CONSECUTIVE);
  assert.match(continuous.reason, /重复异常/);
  assert.match(continuous.recovery, /停止对同一路径的重复重试/);
  assert.equal(classifyGateDenial({ failure_kind: "task_permission", message: "irrelevant" }), "task_permission");
});

test("大量历史拒绝压缩后仍保留窗口内批量信号", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-denial-burst-"));
  const path = join(dir, "gate-denials.jsonl");
  try {
    const old = JSON.stringify({ at: iso(-4_000_000), category: "task_permission", session_id: "old", task_id: "old-task", padding: "x".repeat(200) });
    const recent = [0, 1].map((index) => JSON.stringify({ at: iso(-index * 120_000), category: "task_permission", session_id: `sess-${index}`, task_id: `task-${index}` }));
    writeFileSync(path, `${Array(5_000).fill(old).join("\n")}\n${recent.join("\n")}\n`);
    const { assessment } = recordGateDenial(path, { source: "cli", failure_kind: "task_permission", session_id: "sess-2", task_id: "task-2", run_id: "run-2" }, NOW);
    assert.equal(assessment.level, "batch");
    assert.equal(assessment.counts.tasks, 3);
    assert.ok(statSync(path).size < 1_000_000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
