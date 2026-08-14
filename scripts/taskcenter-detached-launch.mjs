#!/usr/bin/env node

import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = resolve(projectRoot, ".local/runtime");
const logDir = resolve(projectRoot, ".local/logs");
const logPath = resolve(logDir, "web.log");
const pidPath = resolve(runtimeDir, "web.pid");

mkdirSync(runtimeDir, { recursive: true });
mkdirSync(logDir, { recursive: true });

const log = openSync(logPath, "a");
try {
  const child = spawn(process.execPath, ["scripts/dev-live.mjs"], {
    cwd: projectRoot,
    detached: true,
    stdio: ["ignore", log, log],
  });
  writeFileSync(pidPath, `${child.pid}\n`, { mode: 0o600 });
  child.unref();
} finally {
  closeSync(log);
}
