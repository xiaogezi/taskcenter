#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { appendReleaseEvent, loadReleaseEvents, summarizeReleaseEvents } from "./release-history.mjs";
import { buildReleaseEnvironment } from "./release-runtime.mjs";
import { cutoverWithRollback, verifyBeforeServiceCutover } from "./service-deployment-policy.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtimeDir = resolve(process.env.TASKCENTER_RUNTIME_DIR || resolve(projectRoot, ".local/runtime"));
const logDir = resolve(process.env.TASKCENTER_LOG_DIR || resolve(projectRoot, ".local/logs"));
const statePath = resolve(runtimeDir, "web-state.json");
const heartbeatPath = resolve(runtimeDir, "web-heartbeat.json");
const stopPath = resolve(runtimeDir, "web-stop.json");
const lockDir = resolve(runtimeDir, "launcher.lock");
const logPath = resolve(logDir, "web.log");
const releasesDir = resolve(projectRoot, ".local/releases");
const candidatesDir = resolve(projectRoot, ".local/candidates");
const activeReleasePath = resolve(runtimeDir, "active-release.json");
const releaseHistoryPath = resolve(projectRoot, ".local/release-events.jsonl");
const dashboardUrl = process.env.TASKCENTER_DASHBOARD_URL || `http://localhost:${process.env.TASKCENTER_WEB_PORT || 3000}`;
const healthUrl = process.env.TASKCENTER_HEALTH_URL || `http://127.0.0.1:${process.env.TASKCENTER_CONTROL_PORT || 3001}/health`;
const dashboardPort = portOf(dashboardUrl);
const controlPort = portOf(healthUrl);
const action = process.argv[2] || "status";
const disruptionOverride = process.env.TASKCENTER_ALLOW_SERVICE_DISRUPTION === "1";

mkdirSync(runtimeDir, { recursive: true });
mkdirSync(logDir, { recursive: true });

try {
  await withLock(async () => {
    if (action === "start") await startService();
    else if (action === "stop") await stopService();
    else if (action === "restart") {
      await requireDisruptionAuthorization("restart");
      await stopService({ allowMissing: true });
      await sleep(500);
      await startService();
    } else if (action === "deploy") await deployService();
    else if (action === "history") await showReleaseHistory();
    else if (action === "status") await statusService();
    else throw usageError();
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = Number(error.exitCode || 1);
}

async function startService(options = {}) {
  if (await healthCheck()) {
    await openDashboard();
    console.log("TaskCenter 已在运行：http://localhost:3000");
    return;
  }
  const release = options.release || readJson(activeReleasePath) || {
    sourceRoot: projectRoot,
    revision: "",
    releaseId: "legacy-worktree",
    webMode: "dev",
  };
  if (!existsSync(resolve(release.sourceRoot, "node_modules"))) {
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
    env: buildReleaseEnvironment({
      sourceRoot: release.sourceRoot,
      revision: release.revision,
      releaseId: release.releaseId,
      webMode: release.webMode || "start",
      runtimeRoot: runtimeDir,
      logRoot: logDir,
      dataRoot: resolve(projectRoot, "data"),
      webPort: dashboardPort,
      controlPort,
    }, { controllerRoot: projectRoot }),
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
  if (!options.authorized) await requireDisruptionAuthorization("stop");
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

async function deployService() {
  const deploymentId = `release-${randomUUID()}`;
  const startedAtMs = Date.now();
  const original = readManagedProcess();
  if (!original || !(await healthCheck())) {
    throw new Error("部署已阻止：当前 TaskCenter 未处于健康运行状态。请先恢复原服务，不要用部署流程掩盖运行故障。");
  }
  const revision = await gitOutput(["rev-parse", "HEAD"]);
  const previousRevision = original.revision || await inferRunningRevision(original.startedAt, revision);
  const record = (stage, outcome, detail = {}) => appendReleaseEvent(releaseHistoryPath, {
    deploymentId,
    revision,
    previousRevision,
    stage,
    outcome,
    ...detail,
  });

  console.log(`TaskCenter 受控部署：保持现有 PID ${original.pid} 运行并验证 ${revision.slice(0, 12)}。`);
  record("deployment", "started", { originalPid: original.pid });
  try {
  await verifyBeforeServiceCutover({
    original,
    revision,
    stages: ["lint", "test"],
    runStage: async (stage) => {
      const stageStartedAt = Date.now();
      await runNpmScript(stage);
      record(stage, "passed", { durationMs: Date.now() - stageStartedAt });
    },
    assertOriginalService: requireOriginalService,
    readRevision: () => gitOutput(["rev-parse", "HEAD"]),
    readStatus: () => gitOutput(["status", "--porcelain"]),
  });

  const releaseStartedAt = Date.now();
  const release = await prepareRelease(revision);
  record("artifact", "passed", { durationMs: Date.now() - releaseStartedAt, sourceRoot: release.sourceRoot });
  await requireOriginalService(original, "release artifact");

  const previousRelease = await resolvePreviousRelease(original, previousRevision);
  await requireOriginalService(original, "rollback artifact");

  const candidateStartedAt = Date.now();
  const candidate = await validateCandidateRelease(release);
  record("candidate", "passed", {
    durationMs: Date.now() - candidateStartedAt,
    webPort: candidate.webPort,
    controlPort: candidate.controlPort,
  });
  await requireOriginalService(original, "candidate");

  console.log("候选实例验证通过，开始受控切换 TaskCenter 运行实例。");
  await cutoverWithRollback({
      stopOriginal: () => stopService({ authorized: true }),
      startCandidate: () => startService({ release }),
      assertCandidateHealthy: async () => {
        if (!(await healthCheck())) throw new Error("新版本未通过稳定端口健康检查");
      },
      restoreOriginal: async () => {
        await stopService({ authorized: true, allowMissing: true });
        await sleep(300);
        await startService({ release: previousRelease });
        writeJson(activeReleasePath, previousRelease);
      },
  });
  writeJson(activeReleasePath, release);
  record("deployment", "succeeded", { durationMs: Date.now() - startedAtMs });
  console.log(`TaskCenter 已部署不可变版本 ${revision.slice(0, 12)}。`);
  } catch (error) {
    const rolledBack = error.code === "TASKCENTER_RELEASE_ROLLED_BACK";
    record("deployment", rolledBack ? "rolled_back" : "failed", {
      durationMs: Date.now() - startedAtMs,
      error: error.message,
    });
    throw error;
  }
}

async function requireDisruptionAuthorization(requestedAction) {
  if (disruptionOverride) return;
  if (!(await healthCheck())) return;
  throw new Error(
    `运行中服务保护门禁：禁止直接 ${requestedAction} 健康的 TaskCenter。`
      + "开发或修复完成并提交后请运行 npm run service:deploy；"
      + "人工明确停机可临时设置 TASKCENTER_ALLOW_SERVICE_DISRUPTION=1。",
  );
}

async function requireOriginalService(original, stage) {
  const current = readManagedProcess();
  if (!current || current.pid !== original.pid || current.token !== original.token || !(await healthCheck())) {
    throw new Error(`部署已中止：${stage} 验证期间原 TaskCenter 服务发生变化，未执行切换。`);
  }
}

async function runNpmScript(script) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("部署已阻止：请通过 npm run service:deploy 执行受控部署。");
  const child = spawn(process.execPath, [npmCli, "run", script], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
  });
  await childResult(child, `npm run ${script}`);
}

async function prepareRelease(revision) {
  const releaseId = revision.slice(0, 12);
  const sourceRoot = resolve(releasesDir, releaseId);
  const markerPath = resolve(sourceRoot, ".taskcenter-release.json");
  const marker = readJson(markerPath);
  if (marker?.revision === revision && existsSync(resolve(sourceRoot, "dist")) && existsSync(resolve(sourceRoot, "node_modules"))) {
    return { sourceRoot, revision, releaseId, webMode: "start", builtAt: marker.builtAt };
  }

  const active = readJson(activeReleasePath);
  if (active?.sourceRoot === sourceRoot) {
    throw new Error("部署已阻止：当前激活 release 的构建标记损坏，不能原地覆盖。");
  }
  mkdirSync(releasesDir, { recursive: true });
  if (existsSync(sourceRoot)) await runGit(["worktree", "remove", "--force", sourceRoot], projectRoot, "清理不完整 release");
  await runGit(["worktree", "add", "--detach", sourceRoot, revision], projectRoot, "创建不可变 release worktree");
  try {
    await runNpmAt(["ci"], sourceRoot, "release npm ci");
    await runNpmAt(["run", "build"], sourceRoot, "release build");
    const builtAt = new Date().toISOString();
    writeJson(markerPath, { schemaVersion: "taskcenter-release/v1", revision, releaseId, builtAt });
    return { sourceRoot, revision, releaseId, webMode: "start", builtAt };
  } catch (error) {
    await runGit(["worktree", "remove", "--force", sourceRoot], projectRoot, "清理失败 release").catch(() => {});
    throw error;
  }
}

async function resolvePreviousRelease(original, previousRevision) {
  if (
    original.sourceRoot &&
    original.sourceRoot !== projectRoot &&
    original.revision === previousRevision &&
    existsSync(resolve(original.sourceRoot, ".taskcenter-release.json"))
  ) {
    return {
      sourceRoot: original.sourceRoot,
      revision: original.revision,
      releaseId: original.releaseId || original.revision.slice(0, 12),
      webMode: "start",
    };
  }
  return prepareRelease(previousRevision);
}

async function inferRunningRevision(startedAt, headRevision) {
  const revision = await gitOutput(["rev-list", "-1", `--before=${startedAt}`, headRevision]);
  if (!revision) throw new Error("部署已阻止：无法确定当前运行实例对应的 Git revision，不能保证回滚。");
  return revision;
}

async function validateCandidateRelease(release) {
  const candidateRoot = resolve(candidatesDir, release.releaseId);
  const candidateRuntime = resolve(candidateRoot, "runtime");
  const candidateLogs = resolve(candidateRoot, "logs");
  const candidateData = resolve(candidateRoot, "data");
  const candidateCodex = resolve(candidateRoot, "codex-home");
  rmSync(candidateRoot, { recursive: true, force: true });
  for (const path of [candidateRuntime, candidateLogs, candidateData, resolve(candidateCodex, "sessions")]) {
    mkdirSync(path, { recursive: true });
  }
  writeJson(resolve(candidateData, "session-selection.json"), { mode: "allowlist", threadIds: [] });
  writeJson(resolve(candidateData, "session-merges.json"), []);

  const webPort = await allocatePort();
  const controlPort = await allocatePort();
  const config = {
    sourceRoot: release.sourceRoot,
    revision: release.revision,
    releaseId: release.releaseId,
    webMode: "start",
    runtimeRoot: candidateRuntime,
    logRoot: candidateLogs,
    dataRoot: candidateData,
    webPort,
    controlPort,
    candidateCodex,
  };
  try {
    await launchDetached(config);
    await waitForHealth(candidateRuntime, webPort, controlPort);
    return { webPort, controlPort };
  } finally {
    await stopManagedAt(candidateRuntime, webPort, controlPort).catch(() => {});
    rmSync(candidateRoot, { recursive: true, force: true });
  }
}

async function launchDetached(config) {
  if (await isPortBusy(config.webPort) || await isPortBusy(config.controlPort)) {
    throw new Error(`候选启动失败：${config.webPort} 或 ${config.controlPort} 端口已被占用。`);
  }
  const child = spawn(process.execPath, ["scripts/taskcenter-detached-launch.mjs"], {
    cwd: projectRoot,
    env: buildReleaseEnvironment(config, { controllerRoot: projectRoot }),
    stdio: "inherit",
  });
  await childResult(child, "TaskCenter 候选后台启动器");
}

async function waitForHealth(targetRuntimeDir, webPort, targetControlPort) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = readManagedProcessAt(targetRuntimeDir);
    if (state && await healthCheckAt(webPort, targetControlPort)) return;
    await sleep(500);
  }
  throw new Error("候选实例未在 30 秒内通过 Dashboard 与 Control 健康检查。");
}

async function stopManagedAt(targetRuntimeDir, webPort, targetControlPort) {
  const state = readManagedProcessAt(targetRuntimeDir);
  if (!state) return;
  writeJson(resolve(targetRuntimeDir, "web-stop.json"), { token: state.token, requestedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!isProcessAlive(state.pid) && !(await healthCheckAt(webPort, targetControlPort))) return;
    await sleep(200);
  }
  throw new Error("候选实例停止超时，未强制结束进程。");
}

function readManagedProcessAt(targetRuntimeDir) {
  const state = readJson(resolve(targetRuntimeDir, "web-state.json"));
  const heartbeat = readJson(resolve(targetRuntimeDir, "web-heartbeat.json"));
  if (!state?.pid || !state?.token || heartbeat?.pid !== state.pid || heartbeat?.token !== state.token) return null;
  const updatedAt = Date.parse(heartbeat.updatedAt || "");
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > 5_000) return null;
  return isProcessAlive(state.pid) ? state : null;
}

async function healthCheckAt(webPort, targetControlPort) {
  return await fetchOk(`http://127.0.0.1:${targetControlPort}/health`) && await fetchOk(`http://127.0.0.1:${webPort}`);
}

async function allocatePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePromise(port));
    });
  });
}

async function runNpmAt(args, cwd, label) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("部署已阻止：请通过 npm run service:deploy 执行受控部署。");
  const child = spawn(process.execPath, [npmCli, ...args], { cwd, env: process.env, stdio: "inherit" });
  await childResult(child, label);
}

async function runGit(args, cwd, label) {
  const child = spawn("git", args, { cwd, env: process.env, stdio: "inherit" });
  await childResult(child, label);
}

function showReleaseHistory() {
  console.log(JSON.stringify(summarizeReleaseEvents(loadReleaseEvents(releaseHistoryPath)), null, 2));
}

async function gitOutput(args) {
  const child = spawn("git", args, {
    cwd: projectRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await childResult(child, `git ${args.join(" ")}`).catch((error) => {
    if (stderr.trim()) error.message += `：${stderr.trim()}`;
    throw error;
  });
  return stdout.trim();
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
  const error = new Error("用法：node scripts/taskcenter-control.mjs {start|stop|restart|deploy|status|history}");
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
