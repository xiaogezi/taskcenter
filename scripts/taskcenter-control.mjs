#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtimeDir = resolve(process.env.TASKCENTER_RUNTIME_DIR || resolve(projectRoot, ".local/runtime"));
const logDir = resolve(process.env.TASKCENTER_LOG_DIR || resolve(projectRoot, ".local/logs"));
const statePath = resolve(runtimeDir, "web-state.json");
const heartbeatPath = resolve(runtimeDir, "web-heartbeat.json");
const stopPath = resolve(runtimeDir, "web-stop.json");
const lockDir = resolve(runtimeDir, "launcher.lock");
const logPath = resolve(logDir, "web.log");
const dashboardUrl = process.env.TASKCENTER_DASHBOARD_URL || `http://localhost:${process.env.TASKCENTER_WEB_PORT || 3000}`;
const healthUrl = process.env.TASKCENTER_HEALTH_URL || `http://127.0.0.1:${process.env.TASKCENTER_CONTROL_PORT || 3001}/health`;
const dashboardPort = portOf(dashboardUrl);
const controlPort = portOf(healthUrl);
const action = process.argv[2] || "status";

mkdirSync(runtimeDir, { recursive: true });
mkdirSync(logDir, { recursive: true });

try {
  await withLock(async () => {
    if (action === "start") await startService();
    else if (action === "stop") await stopService();
    else if (action === "restart") {
      await stopService({ allowMissing: true });
      await sleep(500);
      await startService();
    } else if (action === "status") await statusService();
    else throw usageError();
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = Number(error.exitCode || 1);
}

async function startService() {
  if (await healthCheck()) {
    await openDashboard();
    console.log("TaskCenter 已在运行：http://localhost:3000");
    return;
  }
  if (!existsSync(resolve(projectRoot, "node_modules"))) {
    throw new Error("启动失败：项目依赖未安装，请先在 TaskCenter 目录运行 npm ci。");
  }

  const running = readManagedProcess();
  if (running) {
    throw new Error("TaskCenter 管理进程仍在启动或异常，请稍后重试；若持续失败请查看 .local/logs/web.log。");
  }
  cleanupRuntimeFiles();
  if (await isPortBusy(dashboardPort) || await isPortBusy(controlPort)) {
    throw new Error(`启动失败：${dashboardPort} 或 ${controlPort} 端口已被其他程序占用。`);
  }
  rotateLog();

  const launched = spawn(process.execPath, ["scripts/taskcenter-detached-launch.mjs"], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
  });
  await childResult(launched, "TaskCenter 后台启动器");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await healthCheck()) {
      await openDashboard();
      console.log("TaskCenter 启动成功：http://localhost:3000");
      return;
    }
    await sleep(500);
  }
  throw new Error(`TaskCenter 启动失败，请查看日志：${logPath}`);
}

async function stopService(options = {}) {
  const state = readManagedProcess();
  if (!state) {
    cleanupRuntimeFiles();
    if (await healthCheck()) {
      throw new Error("当前服务不是由 TaskCenter 控制器管理，未停止未知进程。");
    }
    if (!options.allowMissing) console.log("TaskCenter 当前没有运行。");
    return;
  }
  writeJson(stopPath, { token: state.token, requestedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!isProcessAlive(state.pid) && !(await healthCheck())) {
      cleanupRuntimeFiles();
      console.log("TaskCenter 已安全停止。");
      return;
    }
    await sleep(200);
  }
  throw new Error("停止超时，未强制结束进程。");
}

async function statusService() {
  if (await healthCheck()) {
    console.log("运行中：http://localhost:3000");
    return;
  }
  const error = new Error("未运行");
  error.exitCode = 1;
  throw error;
}

function readManagedProcess() {
  const state = readJson(statePath);
  const heartbeat = readJson(heartbeatPath);
  if (!state?.pid || !state?.token || heartbeat?.pid !== state.pid || heartbeat?.token !== state.token) return null;
  const updatedAt = Date.parse(heartbeat.updatedAt || "");
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > 5_000) return null;
  return isProcessAlive(state.pid) ? state : null;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function healthCheck() {
  return await fetchOk(healthUrl) && await fetchOk(dashboardUrl);
}

async function fetchOk(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function isPortBusy(port) {
  if (await canConnect(port)) return true;
  return !(await canBind(port));
}

function canConnect(port) {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (value) => {
      socket.destroy();
      resolvePromise(value);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function canBind(port) {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolvePromise(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolvePromise(true));
    });
  });
}

async function openDashboard() {
  if (process.env.TASKCENTER_NO_OPEN === "1") return;
  let command;
  let args;
  if (process.platform === "darwin") {
    command = "open";
    args = [dashboardUrl];
  } else if (process.platform === "win32") {
    command = process.env.ComSpec || "cmd.exe";
    args = ["/d", "/s", "/c", "start", "", dashboardUrl];
  } else {
    command = "xdg-open";
    args = [dashboardUrl];
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => {});
    child.unref();
  } catch {
    // Opening the browser is optional; service health remains authoritative.
  }
}

async function withLock(operation) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      mkdirSync(lockDir);
      writeJson(resolve(lockDir, "owner.json"), { pid: process.pid, createdAt: new Date().toISOString() });
      try {
        return await operation();
      } finally {
        rmSync(lockDir, { recursive: true, force: true });
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = readJson(resolve(lockDir, "owner.json"));
      if (owner?.pid && !isProcessAlive(owner.pid)) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      await sleep(100);
    }
  }
  throw new Error("另一个 TaskCenter 启停操作正在执行，请稍后重试。");
}

function rotateLog() {
  if (!existsSync(logPath) || statSync(logPath).size <= 10 * 1024 * 1024) return;
  const rotated = `${logPath}.1`;
  rmSync(rotated, { force: true });
  renameSync(logPath, rotated);
}

function cleanupRuntimeFiles() {
  for (const path of [statePath, heartbeatPath, stopPath, resolve(runtimeDir, "web.pid")]) {
    rmSync(path, { force: true });
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function childResult(child, label) {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${label} 失败（${signal || code}）`));
    });
  });
}

function usageError() {
  const error = new Error("用法：node scripts/taskcenter-control.mjs {start|stop|restart|status}");
  error.exitCode = 2;
  return error;
}

function portOf(value) {
  const url = new URL(value);
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
