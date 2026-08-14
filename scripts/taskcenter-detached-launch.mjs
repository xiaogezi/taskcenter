#!/usr/bin/env node

import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = resolve(process.env.TASKCENTER_RUNTIME_DIR || resolve(projectRoot, ".local/runtime"));
const logDir = resolve(process.env.TASKCENTER_LOG_DIR || resolve(projectRoot, ".local/logs"));
const logPath = resolve(logDir, "web.log");
const pidPath = resolve(runtimeDir, "web.pid");
const statePath = resolve(runtimeDir, "web-state.json");
const token = randomUUID();

mkdirSync(runtimeDir, { recursive: true });
mkdirSync(logDir, { recursive: true });

const log = openSync(logPath, "a");
try {
  const child = spawn(process.execPath, ["scripts/dev-live.mjs"], {
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
  }, null, 2)}\n`, { mode: 0o600 });
  child.unref();
} finally {
  closeSync(log);
}
