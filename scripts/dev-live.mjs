import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vinextInvocation } from "./vinext-cli.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtimeDir = resolve(process.env.TASKCENTER_RUNTIME_DIR || resolve(projectRoot, ".local/runtime"));
const heartbeatPath = resolve(runtimeDir, "web-heartbeat.json");
const stopPath = resolve(runtimeDir, "web-stop.json");
const launchToken = process.env.TASKCENTER_LAUNCH_TOKEN || "";
const webArgs = process.env.TASKCENTER_WEB_PORT ? ["--port", process.env.TASKCENTER_WEB_PORT] : [];
const web = vinextInvocation("dev", webArgs);

const specs = [
  { name: "watch-codex", command: process.execPath, args: ["scripts/watch-codex.mjs"] },
  { name: "metrics-worker", command: process.execPath, args: ["--expose-gc", "--max-old-space-size=128", "scripts/metrics-worker.mjs"] },
  { name: "control-server", command: process.execPath, args: ["--max-old-space-size=128", "scripts/control-server.mjs"] },
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
    stdio: "inherit",
  });
  children.set(spec.name, child);
  child.once("exit", (code, signal) => {
    if (children.get(spec.name) === child) children.delete(spec.name);
    if (shuttingDown) return;
    console.error(`[dev-live] ${spec.name} exited (${signal || code}); restarting in 1s`);
    const timer = setTimeout(() => {
      restartTimers.delete(timer);
      start(spec);
    }, 1_000);
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

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  for (const timer of restartTimers) clearTimeout(timer);
  restartTimers.clear();
  for (const child of children.values()) child.kill("SIGTERM");
  if (launchToken) {
    const heartbeat = readJson(heartbeatPath);
    if (heartbeat?.pid === process.pid && heartbeat?.token === launchToken) {
      rmSync(heartbeatPath, { force: true });
      rmSync(stopPath, { force: true });
    }
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
