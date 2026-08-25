#!/usr/bin/env node

import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const controllerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = resolve(process.env.TASKCENTER_SOURCE_ROOT || controllerRoot);
const runtimeDir = resolve(process.env.TASKCENTER_RUNTIME_DIR || resolve(projectRoot, ".local/runtime"));
const logDir = resolve(process.env.TASKCENTER_LOG_DIR || resolve(projectRoot, ".local/logs"));
const logPath = resolve(logDir, "web.log");
const pidPath = resolve(runtimeDir, "web.pid");
const statePath = resolve(runtimeDir, "web-state.json");
const launchIntentPath = resolve(runtimeDir, "web-launch-intent.json");
const token = randomUUID();

mkdirSync(runtimeDir, { recursive: true });
mkdirSync(logDir, { recursive: true });

const log = openSync(logPath, "a");
let child;
try {
  writeFileSync(launchIntentPath, `${JSON.stringify({ token, startedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  child = spawn(process.execPath, [resolve(projectRoot, "scripts/dev-live.mjs")], {
    cwd: projectRoot,
    env: { ...process.env, TASKCENTER_LAUNCH_TOKEN: token, TASKCENTER_RUNTIME_DIR: runtimeDir },
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  writeFileSync(pidPath, `${child.pid}\n`, { mode: 0o600 });
  writeFileSync(statePath, `${JSON.stringify({
    pid: child.pid,
    token,
    startedAt: new Date().toISOString(),
    sourceRoot: projectRoot,
    revision: process.env.TASKCENTER_RELEASE_REVISION || "",
    releaseId: process.env.TASKCENTER_RELEASE_ID || "",
    webMode: process.env.TASKCENTER_WEB_MODE || "dev",
  }, null, 2)}\n`, { mode: 0o600 });
  rmSync(launchIntentPath, { force: true });
  child.unref();
} catch (error) {
  child?.kill("SIGTERM");
  rmSync(launchIntentPath, { force: true });
  throw error;
} finally {
  closeSync(log);
}
