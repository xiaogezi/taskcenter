import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildPilotPrompt,
  createPilotIntent,
  inspectProjectConfig,
  parseExperimentalMode,
  pilotSnapshot,
  readPilotEvents,
  recordPilotTrial,
  updatePilotIntent,
} from "../scripts/context-management-pilot.mjs";

test("按实际登记 workspace 读取项目级 experimental_mode，无法证明时为 unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "taskcenter-pilot-"));
  const enabled = join(root, "inStory-worktrees", "pilot");
  const missing = join(root, "inStory");
  await mkdir(join(enabled, ".codex"), { recursive: true });
  await mkdir(missing, { recursive: true });
  await writeFile(join(enabled, ".codex", "config.toml"), "[features.context_management]\nexperimental_mode = true\n");
  const registry = {
    a: { sessionId: "a", projectId: "instory", workspace: enabled },
    b: { sessionId: "b", projectId: "instory", workspace: missing },
  };
  const snapshot = pilotSnapshot({ registry, now: "2026-09-08T00:00:00.000Z" });
  assert.equal(snapshot.projects.length, 2);
  assert.equal(snapshot.projects.find((item) => item.workspace === enabled).context_management.state, "enabled");
  assert.equal(snapshot.projects.find((item) => item.workspace === missing).context_management.state, "unknown");
  assert.equal(inspectProjectConfig(enabled).applies_to, "new_tasks_only");
  assert.equal(parseExperimentalMode("[features.context_management]\nexperimental_mode = false"), false);
  assert.equal(parseExperimentalMode('description = """\n[features.context_management]\nexperimental_mode = true\n"""'), "unknown");
  assert.equal(parseExperimentalMode("[features.context_management]\nexperimental_mode = true\nexperimental_mode = false"), "unknown");
  assert.equal(parseExperimentalMode('[features.context_management]\nexperimental_mode = true\n"experimental_mode" = false'), "unknown");
  assert.equal(parseExperimentalMode("[features.context_management]\n\"experimental_mode' = true"), "unknown");
  assert.equal(parseExperimentalMode("[features.context_management]\n[other] # comment\nexperimental_mode = true"), "unknown");
  assert.equal(parseExperimentalMode("[features.context_management]\nexperimental_mode = TRUE"), "unknown");
});

test("intent 与项目回执使用 append-only 状态，三任务指标缺失保持 unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "taskcenter-pilot-events-"));
  const path = join(root, "events.jsonl");
  const requestId = "019f0000-0000-7000-8000-000000000001";
  const created = createPilotIntent(path, { request_id: requestId, project_id: "instory", workspace: root, action: "disable" });
  assert.equal(created.intent.status, "pending");
  assert.equal(createPilotIntent(path, { request_id: requestId, project_id: "instory", workspace: root, action: "disable" }).idempotent, true);
  updatePilotIntent(path, created.intent.intent_id, "processing", { message: "已唤醒主脑" });
  updatePilotIntent(path, created.intent.intent_id, "succeeded", { observed_state: "disabled", occurred_at: "2026-09-08T00:00:00.000Z" });
  const enabledIntent = createPilotIntent(path, { request_id: "019f0000-0000-7000-8000-000000000002", project_id: "instory", workspace: root, action: "enable" });
  updatePilotIntent(path, enabledIntent.intent.intent_id, "succeeded", { observed_state: "enabled", occurred_at: "2026-09-08T01:00:00.000Z" });
  recordPilotTrial(path, { project_id: "instory", workspace: root, task_id: "task-1", natural_long_task: true, qualification_evidence: ["跨越两个实现阶段并完成独立 Review"], prepare_turn: "passed", repeated_reads: null, rework_count: false });
  const snapshot = pilotSnapshot({
    registry: { a: { sessionId: "a", projectId: "instory", workspace: root } },
    tasks: [{ id: "task-1", sessionId: "a", workspace: root, model: "gpt-6-astra", createdAt: "2026-09-08T02:00:00.000Z" }],
    events: readPilotEvents(path),
  });
  assert.equal(snapshot.projects[0].latest_intent.status, "succeeded");
  assert.equal(snapshot.projects[0].trial.completed, 1);
  assert.equal(snapshot.projects[0].trial.tasks[0].repeated_reads, "unknown");
  assert.equal(snapshot.projects[0].trial.tasks[0].rework_count, "unknown");
  assert.equal(snapshot.projects[0].trial.tasks[0].review, "unknown");
  assert.deepEqual(snapshot.projects[0].trial.tasks[0].qualification_evidence, ["跨越两个实现阶段并完成独立 Review"]);
  updatePilotIntent(path, enabledIntent.intent.intent_id, "succeeded", { observed_state: "enabled", occurred_at: "2026-09-08T03:00:00.000Z" });
  assert.equal(pilotSnapshot({ registry: { a: { sessionId: "a", projectId: "instory", workspace: root } }, tasks: [{ id: "task-1", sessionId: "a", workspace: root, model: "gpt-6-astra", createdAt: "2026-09-08T02:00:00.000Z" }], events: readPilotEvents(path) }).projects[0].trial.completed, 1);
  assert.match(buildPilotPrompt(created.intent), /软停止/);
  assert.match(buildPilotPrompt(created.intent), /新建 Astra 任务/);
});

test("不存在、非 Astra 或启用前任务不能凑满三任务试点", async () => {
  const root = await mkdtemp(join(tmpdir(), "taskcenter-pilot-trials-"));
  const path = join(root, "events.jsonl");
  const intent = createPilotIntent(path, { request_id: "019f0000-0000-7000-8000-000000000003", project_id: "instory", workspace: root, action: "enable" });
  updatePilotIntent(path, intent.intent.intent_id, "succeeded", { observed_state: "enabled", occurred_at: "2026-09-08T02:00:00.000Z" });
  for (const task_id of ["missing-1", "missing-2", "missing-3"]) recordPilotTrial(path, { project_id: "instory", workspace: root, task_id });
  const snapshot = pilotSnapshot({
    registry: { a: { sessionId: "a", projectId: "instory", workspace: root } },
    tasks: [
      { id: "old", sessionId: "a", model: "gpt-6-astra", createdAt: "2026-09-08T01:00:00.000Z" },
      { id: "other-model", sessionId: "a", model: "gpt-5.6-terra", createdAt: "2026-09-08T03:00:00.000Z" },
      { id: "missing-1", sessionId: "a", model: "gpt-6-astra", createdAt: "2026-09-08T04:00:00.000Z" },
      { id: "missing-2", sessionId: "a", model: "gpt-6-astra", createdAt: "2026-09-08T05:00:00.000Z" },
      { id: "missing-3", sessionId: "a", model: "gpt-6-astra", createdAt: "2026-09-08T06:00:00.000Z" },
    ],
    events: readPilotEvents(path),
  });
  assert.equal(snapshot.projects[0].trial.completed, 0);
  assert.deepEqual(snapshot.projects[0].trial.tasks, []);
});
