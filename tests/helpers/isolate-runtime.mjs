// Imported before integration fixtures: never inherit production audit destinations.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const root = mkdtempSync(join(tmpdir(), "taskcenter-test-runtime-"));
Object.assign(process.env, {
  TASKCENTER_RUNTIME_DIR: root,
  TASKCENTER_LOG_DIR: join(root, "logs"),
  TASKCENTER_GATE_DENIALS_PATH: join(root, "gate-denials.jsonl"),
  TASKCENTER_TASK_EVENT_INDEX_PATH: join(root, "task-event-index.json"),
  TASKCENTER_USAGE_HEALTH_PATH: join(root, "usage-worker-health.json"),
  TASKCENTER_GOVERNANCE_HEALTH_PATH: join(root, "governance-worker-health.json"),
  TASKCENTER_MCP_TOKEN_PATH: join(root, "mcp-token"),
  TASKCENTER_CONTROL_URL: "http://127.0.0.1:1",
  TASKCENTER_DISABLE_LIVE_SESSION_RECONCILIATION: "1",
});
// Individual fixtures own their child lifetimes. Cleanup after their after hooks.
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
