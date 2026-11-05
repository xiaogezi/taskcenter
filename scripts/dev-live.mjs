import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vinextInvocation } from "./vinext-cli.mjs";
import { createRuntimeLogger } from "./runtime-logger.mjs";
import { migrateTaskEvents } from "./task-event-migration.mjs";

const projectRoot = resolve(process.env.TASKCENTER_SOURCE_ROOT || fileURLToPath(new URL("..", import.meta.url)));
const runtimeDir = resolve(process.env.TASKCENTER_RUNTIME_DIR || resolve(projectRoot, ".local/runtime"));
const heartbeatPath = resolve(runtimeDir, "web-heartbeat.json");
const stopPath = resolve(runtimeDir, "web-stop.json");
const childrenPath = resolve(runtimeDir, "web-children.json");
if (process.env.TASKCENTER_EVENT_STORAGE === "sqlite-v1") migrateTaskEvents(resolve(process.env.TASKCENTER_TASK_EVENTS_PATH || resolve(projectRoot, "data/task-events.jsonl")));
const runtimeLogger = await createRuntimeLogger(resolve(process.env.TASKCENTER_LOG_DIR || resolve(projectRoot, ".local/logs"), "runtime"));
const launchToken = process.env.TASKCENTER_LAUNCH_TOKEN || "";
const webArgs = process.env.TASKCENTER_WEB_PORT ? ["--port", process.env.TASKCENTER_WEB_PORT] : [];
const webMode = process.env.TASKCENTER_WEB_MODE === "start" ? "start" : "dev";
const web = vinextInvocation(webMode, webArgs, projectRoot);

const specs = [
  { name: "watch-codex", command: process.execPath, args: ["scripts/watch-codex.mjs"] },
  { name: "metrics-worker", command: process.execPath, args: ["--expose-gc", "--max-old-space-size=128", "scripts/metrics-worker.mjs"] },
  { name: "event-retention", command: process.execPath, args: ["scripts/task-event-retention.mjs"], optional: true },
  { name: "control-server", command: process.execPath, args: ["--max-old-space-size=128", "scripts/control-server.mjs"] },
  { name: "ai-observer", command: process.execPath, args: ["--max-old-space-size=128", "scripts/ai-observer.mjs"], optional: true },
  { name: "web", command: web.command, args: web.args, env: web.env },
];
const children = new Map();
const restartTimers = new Set();

let shuttingDown = false;

function start(spec) {
  if (shuttingDown) return;
  const child = spawn(spec.command, spec.args, {
    cwd: projectRoot,
    env: spec.env || process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  runtimeLogger.attach(child.stdout, spec.name, "stdout");
  runtimeLogger.attach(child.stderr, spec.name, "stderr");
  child.once("close", () => { child.closed = true; });
  children.set(spec.name, child);
  persistChildren();
  child.once("exit", (code, signal) => {
    if (children.get(spec.name) === child) children.delete(spec.name);
    persistChildren();
    if (shuttingDown) return;
    if (spec.optional && spec.name !== "event-retention") return;
    const delayMs = spec.name === "event-retention" ? 60_000 : 1_000;
    runtimeLogger.log(spec.name, "supervisor", JSON.stringify({ event: "child_restart", code, signal, delay_ms: delayMs }));
    const timer = setTimeout(() => {
      restartTimers.delete(timer);
      start(spec);
    }, delayMs);
    restartTimers.add(timer);
  });
}

for (const spec of specs) start(spec);

let heartbeatTimer;
if (launchToken) {
  mkdirSync(runtimeDir, { recursive: true });
  const updateHeartbeat = () => {
    writeFileSync(heartbeatPath, `${JSON.stringify({
      pid: process.pid,
      token: launchToken,
      updatedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    const request = readJson(stopPath);
    if (request?.token === launchToken) shutdown();
  };
  updateHeartbeat();
  heartbeatTimer = setInterval(updateHeartbeat, 1_000);
  heartbeatTimer.unref();
}

let shutdownPromise;
function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  if (shuttingDown) return;
  shuttingDown = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  for (const timer of restartTimers) clearTimeout(timer);
  restartTimers.clear();
  shutdownPromise = finishShutdown([...children.values()]);
  return shutdownPromise;
}

async function finishShutdown(runningChildren) {
  for (const child of runningChildren) child.kill("SIGTERM");
  const exitedGracefully = await waitForChildren(runningChildren, 5_000);
  if (!exitedGracefully) {
    for (const child of runningChildren) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.all(runningChildren.map(waitForChildExit));
  }
  const drained = await Promise.race([
    Promise.all(runningChildren.filter(child => !child.closed).map(child => new Promise(resolve => child.once("close", resolve)))).then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 1_000)),
  ]);
  if (!drained) {
    runtimeLogger.log("supervisor", "shutdown", JSON.stringify({ event: "child_output_drain_timeout" }));
    for (const child of runningChildren) { child.stdout.destroy(); child.stderr.destroy(); }
  }
  if (launchToken) {
    const heartbeat = readJson(heartbeatPath);
    if (heartbeat?.pid === process.pid && heartbeat?.token === launchToken) {
      rmSync(heartbeatPath, { force: true });
      rmSync(stopPath, { force: true });
      rmSync(childrenPath, { force: true });
    }
  }
  await runtimeLogger.close();
  process.exit(0);
}

process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });

function persistChildren() {
  if (!launchToken) return;
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(childrenPath, `${JSON.stringify({
    parentPid: process.pid,
    token: launchToken,
    children: [...children.entries()].map(([name, child]) => ({ name, pid: child.pid })),
    updatedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
}

function waitForChildren(runningChildren, timeoutMs) {
  return Promise.race([
    Promise.all(runningChildren.map(waitForChildExit)).then(() => true),
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), timeoutMs)),
  ]);
}

function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => child.once("exit", resolvePromise));
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
