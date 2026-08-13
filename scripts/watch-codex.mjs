import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const sessionsRoot = join(codexHome, "sessions");
const configuredThreadIds = process.env.TASKCENTER_THREADS
  ? process.env.TASKCENTER_THREADS.split(",").map((value) => value.trim()).filter(Boolean)
  : null;
let lastFingerprint = "";
let pendingFingerprint = "";
let pendingSince = 0;
let syncing = false;
const pollIntervalMs = Number(process.env.TASKCENTER_POLL_INTERVAL_MS || 5_000);
const quietPeriodMs = Number(process.env.TASKCENTER_QUIET_PERIOD_MS || 20_000);
const heartbeatPath = process.env.TASKCENTER_WATCHER_HEARTBEAT_PATH || join(import.meta.dirname, "..", ".local", "runtime", "watcher-heartbeat.json");
function heartbeat(status = "watching") {
  try {
    mkdirSync(join(heartbeatPath, ".."), { recursive: true });
    writeFileSync(heartbeatPath, JSON.stringify({ status, pid: process.pid, updatedAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
  } catch (error) {
    console.error(`TaskCenter watcher heartbeat 写入失败：${error instanceof Error ? error.message : error}`);
  }
}

function findWatchedFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...findWatchedFiles(path));
    if (
      entry.isFile() &&
      entry.name.endsWith(".jsonl") &&
      (!configuredThreadIds || configuredThreadIds.some((threadId) => entry.name.includes(threadId)))
    ) {
      files.push(path);
    }
  }
  return files;
}

function fingerprint() {
  return findWatchedFiles(sessionsRoot)
    .sort()
    .map((path) => {
      const stat = statSync(path);
      return `${path}:${stat.size}:${stat.mtimeMs}`;
    })
    .join("|");
}

function sync() {
  if (syncing) return;
  syncing = true;
  heartbeat("syncing");
  const child = spawn(process.execPath, [join(import.meta.dirname, "sync-codex.mjs")], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", () => {
    syncing = false;
    heartbeat("watching");
  });
}

sync();
heartbeat();
setInterval(() => {
  heartbeat(syncing ? "syncing" : "watching");
  const currentFingerprint = fingerprint();
  if (currentFingerprint !== pendingFingerprint) {
    pendingFingerprint = currentFingerprint;
    pendingSince = Date.now();
    return;
  }
  if (
    currentFingerprint !== lastFingerprint &&
    Date.now() - pendingSince >= quietPeriodMs
  ) {
    lastFingerprint = currentFingerprint;
    sync();
  }
}, pollIntervalMs);

lastFingerprint = fingerprint();
pendingFingerprint = lastFingerprint;
console.log(
  `TaskCenter is watching ${configuredThreadIds ? `${configuredThreadIds.length} configured Codex task(s)` : "all local Codex tasks"}; ` +
  `updates sync after ${Math.round(quietPeriodMs / 1000)} quiet seconds.`,
);
