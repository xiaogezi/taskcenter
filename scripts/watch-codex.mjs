import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createWatcherSyncState } from "./watcher-sync-state.mjs";

const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const sessionsRoot = join(codexHome, "sessions");
const sessionIndexPath = join(codexHome, "session_index.jsonl");
const configuredThreadIds = process.env.TASKCENTER_THREADS
  ? process.env.TASKCENTER_THREADS.split(",").map((value) => value.trim()).filter(Boolean)
  : null;
const pollIntervalMs = Number(process.env.TASKCENTER_POLL_INTERVAL_MS || 5_000);
const quietPeriodMs = Number(process.env.TASKCENTER_QUIET_PERIOD_MS || 20_000);
const maxSyncDelayMs = Number(process.env.TASKCENTER_MAX_SYNC_DELAY_MS || 30_000);
const syncState = createWatcherSyncState({ quietPeriodMs, maxSyncDelayMs });
const heartbeatPath = process.env.TASKCENTER_WATCHER_HEARTBEAT_PATH || join(import.meta.dirname, "..", ".local", "runtime", "watcher-heartbeat.json");
const configuredPathCache = new Map();
function heartbeat(observationError = "") {
  try {
    mkdirSync(join(heartbeatPath, ".."), { recursive: true });
    writeFileSync(heartbeatPath, JSON.stringify({ ...syncState.heartbeat(),
      ...(observationError ? { status: "failed", refreshOk: false, lastRefreshError: observationError } : {}),
      pid: process.pid, updatedAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
  } catch (error) {
    console.error(`TaskCenter watcher heartbeat 写入失败：${error instanceof Error ? error.message : error}`);
  }
}

function findWatchedFiles(directory, seenPaths = new Set()) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...findWatchedFiles(path, seenPaths));
    if (entry.isFile() && entry.name.endsWith(".jsonl")) seenPaths.add(path);
    if (
      entry.isFile() &&
      entry.name.endsWith(".jsonl") &&
      belongsToConfiguredSession(path)
    ) {
      files.push(path);
    }
  }
  return files;
}

function belongsToConfiguredSession(path) {
  if (!configuredThreadIds) return true;
  if (configuredThreadIds.some((threadId) => path.includes(threadId))) return true;
  let stats;
  try {
    stats = statSync(path);
  } catch {
    configuredPathCache.delete(path);
    return false;
  }
  const cached = configuredPathCache.get(path);
  if (cached?.matches || (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs)) return cached.matches;
  let descriptor;
  try {
    descriptor = openSync(path, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    const header = buffer.toString("utf8", 0, bytesRead);
    const matches = configuredThreadIds.some((threadId) =>
      header.includes(`"session_id":"${threadId}"`) || header.includes(`"parent_thread_id":"${threadId}"`));
    configuredPathCache.set(path, { matches, size: stats.size, mtimeMs: stats.mtimeMs });
    return matches;
  } catch {
    configuredPathCache.set(path, { matches: false, size: stats.size, mtimeMs: stats.mtimeMs });
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function fingerprint() {
  const seenPaths = new Set();
  const watchedFiles = findWatchedFiles(sessionsRoot, seenPaths);
  for (const cachedPath of configuredPathCache.keys()) {
    if (!seenPaths.has(cachedPath)) configuredPathCache.delete(cachedPath);
  }
  if (existsSync(sessionIndexPath)) watchedFiles.push(sessionIndexPath);
  return watchedFiles
    .sort()
    .map((path) => {
      const stat = statSync(path);
      return `${path}:${stat.size}:${stat.mtimeMs}`;
    })
    .join("|");
}

function sync() {
  if (syncState.start(Date.now()) === null) return;
  heartbeat();
  let finished = false;
  const finish = (ok, error = "") => {
    if (finished) return;
    finished = true;
    syncState.finish(ok, Date.now(), error);
    heartbeat();
  };
  try {
    const child = spawn(process.execPath, [join(import.meta.dirname, "sync-codex.mjs")], {
      stdio: "inherit", env: process.env,
    });
    child.once("error", error => finish(false, error.message));
    child.once("close", (code, signal) => finish(code === 0, `sync exited: ${signal || code}`));
  } catch (error) { finish(false, error instanceof Error ? error.message : String(error)); }
}

function poll() {
  try {
    syncState.observe(fingerprint(), Date.now());
    sync();
    heartbeat();
  } catch (error) {
    heartbeat(error instanceof Error ? error.message : String(error));
  }
}
poll();
setInterval(poll, pollIntervalMs);
console.log(
  `TaskCenter is watching all local Codex session metadata${configuredThreadIds ? `; sync remains limited to ${configuredThreadIds.length} configured Session(s)` : ""}; ` +
  `updates sync after ${Math.round(quietPeriodMs / 1000)} quiet seconds.`,
);
