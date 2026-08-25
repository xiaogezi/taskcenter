import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { resolveSpawnCommand } from "../scripts/platform-command.mjs";
import { vinextInvocation } from "../scripts/vinext-cli.mjs";

test("Windows npm cmd shim resolves to its Node entry without shell interpolation", async () => {
  const root = await mkdtemp(join(tmpdir(), "taskcenter-win-shim-"));
  try {
    const entry = join(root, "node_modules", "@openai", "codex", "bin", "codex.js");
    await mkdir(resolve(entry, ".."), { recursive: true });
    await writeFile(entry, "console.log('fixture')\n");
    const shim = join(root, "codex.cmd");
    await writeFile(shim, '@echo off\r\n"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');

    const resolved = resolveSpawnCommand(shim, { platform: "win32" });
    assert.equal(resolved.command, process.execPath);
    assert.deepEqual(resolved.argsPrefix, [entry]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("vinext commands execute through Node instead of platform shell wrappers", () => {
  const invocation = vinextInvocation("build");
  assert.equal(invocation.command, process.execPath);
  assert.match(invocation.args[0], /node_modules[\\/]vinext[\\/]dist[\\/]cli\.js$/);
  assert.equal(invocation.args[1], "build");
  assert.equal(invocation.env.WRANGLER_LOG_PATH, ".wrangler/wrangler.log");
});

test("cross-platform controller reports a stopped isolated runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "taskcenter-control-"));
  try {
    const result = await runNode(["scripts/taskcenter-control.mjs", "status"], {
      TASKCENTER_RUNTIME_DIR: join(root, "runtime"),
      TASKCENTER_LOG_DIR: join(root, "logs"),
      TASKCENTER_DASHBOARD_URL: "http://127.0.0.1:9",
      TASKCENTER_HEALTH_URL: "http://127.0.0.1:9/health",
      TASKCENTER_NO_OPEN: "1",
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /未运行/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cross-platform controller starts, observes, and gracefully stops an isolated stack", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "taskcenter-lifecycle-"));
  const [webPort, controlPort] = await Promise.all([freePort(), freePort()]);
  const env = {
    CODEX_HOME: resolve("tests/fixtures"),
    TASKCENTER_RUNTIME_DIR: join(root, "runtime"),
    TASKCENTER_LOG_DIR: join(root, "logs"),
    TASKCENTER_WEB_PORT: String(webPort),
    TASKCENTER_CONTROL_PORT: String(controlPort),
    TASKCENTER_DASHBOARD_URL: `http://localhost:${webPort}`,
    TASKCENTER_HEALTH_URL: `http://127.0.0.1:${controlPort}/health`,
    TASKCENTER_DASHBOARD_PATH: join(root, "dashboard.json"),
    TASKCENTER_SEED_PATH: resolve("tests/fixtures/requirements.seed.json"),
    TASKCENTER_SELECTION_PATH: resolve("tests/fixtures/session-selection-all.json"),
    TASKCENTER_TASK_EVENTS_PATH: join(root, "task-events.jsonl"),
    TASKCENTER_TASK_LEDGER_PATH: join(root, "task-ledger.json"),
    TASKCENTER_TASK_EVENT_IDS_PATH: join(root, "task-event-ids.json"),
    TASKCENTER_TASK_RECONCILE_PATH: join(root, "task-reconcile.jsonl"),
    TASKCENTER_SESSION_REGISTRY_PATH: join(root, "session-registry.json"),
    TASKCENTER_DELEGATIONS_PATH: join(root, "delegations.json"),
    TASKCENTER_WATCHER_HEARTBEAT_PATH: join(root, "watcher-heartbeat.json"),
    TASKCENTER_DISABLE_LIVE_SESSION_RECONCILIATION: "1",
    TASKCENTER_NO_OPEN: "1",
    TASKCENTER_ALLOW_LEGACY_DEV_START: "1",
  };
  try {
    const started = await runNode(["scripts/taskcenter-control.mjs", "start"], env);
    assert.equal(started.code, 0, started.stderr);
    assert.match(started.stdout, /启动成功/);

    const status = await runNode(["scripts/taskcenter-control.mjs", "status"], env);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /运行中/);

    const protectedStop = await runNode(["scripts/taskcenter-control.mjs", "stop"], env);
    assert.equal(protectedStop.code, 1);
    assert.match(protectedStop.stderr, /运行中服务保护门禁/);

    const protectedRestart = await runNode(["scripts/taskcenter-control.mjs", "restart"], env);
    assert.equal(protectedRestart.code, 1);
    assert.match(protectedRestart.stderr, /运行中服务保护门禁/);

    const stillRunning = await runNode(["scripts/taskcenter-control.mjs", "status"], env);
    assert.equal(stillRunning.code, 0, stillRunning.stderr);

    const stopped = await runNode(["scripts/taskcenter-control.mjs", "stop"], {
      ...env,
      TASKCENTER_ALLOW_SERVICE_DISRUPTION: "1",
    });
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.match(stopped.stdout, /安全停止/);

    const finalStatus = await runNode(["scripts/taskcenter-control.mjs", "status"], env);
    assert.equal(finalStatus.code, 1);
  } finally {
    await runNode(["scripts/taskcenter-control.mjs", "stop"], {
      ...env,
      TASKCENTER_ALLOW_SERVICE_DISRUPTION: "1",
    }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

function runNode(args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      cwd: new URL("../", import.meta.url),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      server.close(() => resolvePromise(address.port));
    });
  });
}
