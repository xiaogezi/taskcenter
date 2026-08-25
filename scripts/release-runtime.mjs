import { join, resolve } from "node:path";

export function buildReleaseEnvironment(config, options = {}) {
  const controllerRoot = resolve(options.controllerRoot || process.cwd());
  const sourceRoot = resolve(config.sourceRoot);
  const runtimeRoot = resolve(config.runtimeRoot);
  const dataRoot = resolve(config.dataRoot);
  const environment = {
    ...(options.baseEnvironment || process.env),
    TASKCENTER_SOURCE_ROOT: sourceRoot,
    TASKCENTER_RELEASE_REVISION: config.revision || "",
    TASKCENTER_RELEASE_ID: config.releaseId || "",
    TASKCENTER_WEB_MODE: config.webMode || "start",
    TASKCENTER_RUNTIME_DIR: runtimeRoot,
    TASKCENTER_LOG_DIR: resolve(config.logRoot),
    TASKCENTER_WEB_PORT: String(config.webPort),
    TASKCENTER_CONTROL_PORT: String(config.controlPort),
    TASKCENTER_CONTROL_URL: `http://127.0.0.1:${config.controlPort}`,
    TASKCENTER_DASHBOARD_PATH: join(dataRoot, "dashboard.json"),
    TASKCENTER_DISPATCHES_PATH: join(dataRoot, "dispatches.json"),
    TASKCENTER_OVERRIDES_PATH: join(dataRoot, "requirement-overrides.json"),
    TASKCENTER_INBOX_DECISIONS_PATH: join(dataRoot, "inbox-decisions.json"),
    TASKCENTER_SELECTION_PATH: join(dataRoot, "session-selection.json"),
    TASKCENTER_SESSION_SELECTION_PATH: join(dataRoot, "session-selection.json"),
    TASKCENTER_GATE_SESSION_ALLOWLIST_PATH: join(dataRoot, "gate-session-allowlist.json"),
    TASKCENTER_REFLECTION_PROPOSALS_PATH: join(dataRoot, "reflection-proposals.json"),
    TASKCENTER_TASK_EVENTS_PATH: join(dataRoot, "task-events.jsonl"),
    TASKCENTER_TASK_LEDGER_PATH: join(dataRoot, "task-ledger.json"),
    TASKCENTER_TASK_EVENT_IDS_PATH: join(dataRoot, "task-event-ids.json"),
    TASKCENTER_TASK_RECONCILE_PATH: join(dataRoot, "task-reconcile.jsonl"),
    TASKCENTER_SESSION_REGISTRY_PATH: join(dataRoot, "session-registry.json"),
    TASKCENTER_SESSION_MERGES_PATH: join(dataRoot, "session-merges.json"),
    TASKCENTER_DELEGATIONS_PATH: join(dataRoot, "delegations.json"),
    TASKCENTER_ROUTING_CONTROL_PATH: join(dataRoot, "routing-control.json"),
    TASKCENTER_CONTEXT_TASK_MAP_PATH: join(dataRoot, "context-task-map.json"),
    TASKCENTER_CONTEXT_AUDIT_PATH: join(dataRoot, "context-sync-events.jsonl"),
    TASKCENTER_SEED_PATH: join(sourceRoot, "data", "requirements.seed.json"),
    TASKCENTER_MODEL_RATES_PATH: join(sourceRoot, "config", "model-rates.json"),
    TASKCENTER_MCP_TOKEN_PATH: join(runtimeRoot, "mcp-token"),
    TASKCENTER_WATCHER_HEARTBEAT_PATH: join(runtimeRoot, "watcher-heartbeat.json"),
    TASKCENTER_CONTEXT_ROOT: resolve(controllerRoot, "..", "ProjectContextAgent"),
  };
  if (config.candidateCodex) {
    environment.CODEX_HOME = resolve(config.candidateCodex);
    environment.TASKCENTER_SESSIONS_ROOT = resolve(config.candidateCodex, "sessions");
    environment.TASKCENTER_DISPATCH_DRY_RUN = "1";
    environment.TASKCENTER_DISABLE_LIVE_SESSION_RECONCILIATION = "1";
  }
  return environment;
}

export function resolveStartupRelease(activeRelease, options = {}) {
  if (activeRelease?.sourceRoot && activeRelease?.revision) return { mode: "release", release: activeRelease };
  if (options.allowLegacyDev === true) {
    return {
      mode: "legacy_test_only",
      release: { sourceRoot: options.projectRoot, revision: "", releaseId: "legacy-worktree", webMode: "dev" },
    };
  }
  return { mode: "bootstrap", release: null };
}

export function resolveStopTarget(state) {
  if (!Number.isInteger(state?.pid) || state.pid <= 0 || typeof state.token !== "string" || !state.token) return null;
  return state;
}
