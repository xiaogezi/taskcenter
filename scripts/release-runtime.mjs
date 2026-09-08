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
    TASKCENTER_TASK_REUSE_DECISIONS_PATH: join(dataRoot, "task-reuse-decisions.jsonl"),
    TASKCENTER_SESSION_REGISTRY_PATH: join(dataRoot, "session-registry.json"),
    TASKCENTER_SESSION_MERGES_PATH: join(dataRoot, "session-merges.json"),
    TASKCENTER_DELEGATIONS_PATH: join(dataRoot, "delegations.json"),
    TASKCENTER_ROUTING_CONTROL_PATH: join(dataRoot, "routing-control.json"),
    TASKCENTER_CONTEXT_TASK_MAP_PATH: join(dataRoot, "context-task-map.json"),
    TASKCENTER_CONTEXT_AUDIT_PATH: join(dataRoot, "context-sync-events.jsonl"),
    TASKCENTER_CONTEXT_MANAGEMENT_PILOT_EVENTS_PATH: join(dataRoot, "context-management-pilot-events.jsonl"),
    TASKCENTER_SEED_PATH: join(sourceRoot, "data", "requirements.seed.json"),
    TASKCENTER_MODEL_RATES_PATH: join(sourceRoot, "config", "model-rates.json"),
    TASKCENTER_MCP_TOKEN_PATH: join(runtimeRoot, "mcp-token"),
    TASKCENTER_WATCHER_HEARTBEAT_PATH: join(runtimeRoot, "watcher-heartbeat.json"),
    TASKCENTER_USAGE_INDEX_PATH: join(runtimeRoot, "usage-index.json"),
    TASKCENTER_USAGE_REPORT_PATH: join(runtimeRoot, "usage-report.json"),
    TASKCENTER_USAGE_HEALTH_PATH: join(runtimeRoot, "usage-worker-health.json"),
    TASKCENTER_GOVERNANCE_METRICS_PATH: join(runtimeRoot, "governance-metrics.json"),
    TASKCENTER_GOVERNANCE_HEALTH_PATH: join(runtimeRoot, "governance-worker-health.json"),
    TASKCENTER_TASK_EVENT_INDEX_PATH: join(runtimeRoot, "task-event-index.json"),
    TASKCENTER_CONTEXT_ROOT: resolve(controllerRoot, "..", "ProjectContextAgent"),
    TASKCENTER_MODEL_ROLE_CONFIG_PATH: process.env.TASKCENTER_MODEL_ROLE_CONFIG_PATH
      || join(controllerRoot, "config", "model-roles.json"),
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

const requiredManagedChildren = ["watch-codex", "metrics-worker", "control-server", "web"];

export function resolveManagedProcessState(state, heartbeat, childSnapshot, options = {}) {
  if (!Number.isInteger(state?.pid) || state.pid <= 0 || typeof state.token !== "string" || !state.token) return null;
  const now = Number(options.now ?? Date.now());
  const heartbeatAt = Date.parse(heartbeat?.updatedAt || "");
  const heartbeatMatches = heartbeat?.pid === state.pid && heartbeat?.token === state.token;
  if (
    heartbeatMatches
    && Number.isFinite(heartbeatAt)
    && now - heartbeatAt <= 5_000
    && options.isPidAlive?.(state.pid) === true
  ) {
    return { ...state, supervision: "healthy" };
  }

  // Windows 没有可验证的持久 process group / Job Object 身份，保持 fail-closed。
  if ((options.platform || process.platform) === "win32") return null;
  if (childSnapshot?.parentPid !== state.pid || childSnapshot?.token !== state.token) return null;
  if (options.isTreeAlive?.(state.pid) !== true) return null;
  const children = Array.isArray(childSnapshot.children) ? childSnapshot.children : [];
  const byName = new Map(children.map((child) => [child?.name, child]));
  if (requiredManagedChildren.some((name) => !byName.has(name))) return null;
  const required = requiredManagedChildren.map((name) => byName.get(name));
  if (new Set(required.map((child) => child?.pid)).size !== required.length) return null;
  if (required.some((child) => !Number.isInteger(child?.pid) || child.pid <= 0 || options.isPidAlive?.(child.pid) !== true)) return null;
  if (required.some((child) => options.isExpectedChild?.(child, state.pid) !== true)) return null;
  return { ...state, supervision: "orphaned" };
}
