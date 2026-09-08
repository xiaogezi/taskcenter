import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  contextManagementPilotSnapshot,
  createContextManagementIntent,
  inspectProjectConfig,
  inspectProjectConfigs,
  parseExperimentalMode,
  updateContextManagementIntent,
} from "../scripts/context-management-pilot.mjs";

test("parses only the context_management experimental flag", () => {
  assert.equal(parseExperimentalMode("[features.context_management]\nexperimental_mode = true\n"), true);
  assert.equal(parseExperimentalMode("[features.context_management]\nexperimental_mode = false # rollback\n"), false);
  assert.equal(parseExperimentalMode("[features]\nexperimental_mode = true\n"), "unknown");
});

test("reads every registered workspace and keeps missing or conflicting evidence unknown", () => {
  const root = mkdtempSync(join(tmpdir(), "taskcenter-context-"));
  const enabled = join(root, "main"); const missing = join(root, "worktree"); const disabled = join(root, "other");
  mkdirSync(join(enabled, ".codex"), { recursive: true }); mkdirSync(missing, { recursive: true }); mkdirSync(join(disabled, ".codex"), { recursive: true });
  writeFileSync(join(enabled, ".codex", "config.toml"), "[features.context_management]\nexperimental_mode = true\n");
  writeFileSync(join(disabled, ".codex", "config.toml"), "[features.context_management]\nexperimental_mode = false\n");
  assert.equal(inspectProjectConfig(missing).state, "unknown");
  const partial = inspectProjectConfigs([enabled, missing]);
  assert.equal(partial.state, "unknown"); assert.equal(partial.evidence.length, 2); assert.match(partial.error, /部分 workspace/);
  const conflict = inspectProjectConfigs([enabled, disabled]);
  assert.equal(conflict.state, "unknown"); assert.match(conflict.error, /冲突/);
});

test("snapshot preserves actual registered workspaces and unknown trial fields", () => {
  const root = mkdtempSync(join(tmpdir(), "taskcenter-context-snapshot-"));
  const main = join(root, "inStory"); const worktree = join(root, "inStory-worktrees", "pilot");
  mkdirSync(main, { recursive: true }); mkdirSync(join(worktree, ".codex"), { recursive: true });
  writeFileSync(join(worktree, ".codex", "config.toml"), "[features.context_management]\nexperimental_mode = true\n");
  const events = [{ type: "context_management.trial.reported", event_id: "e1", project_id: "instory", task_id: "long-1", prepare_turn: "unknown", repeated_reads: "unknown", recovery_cost_tokens: "unknown", rework_count: "unknown", authority_violations: "unknown", occurred_at: "2026-09-08T00:00:00.000Z" }];
  const snapshot = contextManagementPilotSnapshot({ registry: { a: { projectId: "instory", workspace: main }, b: { projectId: "instory", workspace: worktree } }, tasks: [], events });
  assert.deepEqual(snapshot.projects[0].workspaces, [main, worktree].sort());
  assert.equal(snapshot.projects[0].context_management.state, "unknown");
  assert.equal(snapshot.projects[0].context_management.evidence.find(item => item.workspace === worktree).state, "enabled");
  assert.equal(snapshot.projects[0].trial.tasks[0].input_tokens, "unknown");
});

test("intent creation is idempotent and project mismatch cannot append a result", () => {
  const root = mkdtempSync(join(tmpdir(), "taskcenter-context-intent-")); const path = join(root, "events.jsonl");
  const request = { request_id: "123e4567-e89b-42d3-a456-426614174000", project_id: "instory", workspace: root, action: "disable" };
  const first = createContextManagementIntent(path, request); const replay = createContextManagementIntent(path, request);
  assert.equal(replay.idempotent, true); assert.equal(replay.intent.intent_id, first.intent.intent_id);
  assert.throws(() => updateContextManagementIntent(path, first.intent.intent_id, "succeeded", { project_id: "other" }), /不匹配/);
  const result = updateContextManagementIntent(path, first.intent.intent_id, "succeeded", { project_id: "instory", observed_state: "disabled" });
  assert.equal(result.status, "succeeded");
});
