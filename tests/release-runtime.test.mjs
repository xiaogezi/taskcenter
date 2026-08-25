import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { buildReleaseEnvironment, resolveStartupRelease, resolveStopTarget } from "../scripts/release-runtime.mjs";
import { isProcessTreeAlive, terminateProcessTree } from "../scripts/process-tree.mjs";

test("正式 release 从不可变源码运行但继续绑定正式数据目录", () => {
  const environment = buildReleaseEnvironment({
    sourceRoot: "/release/abc",
    runtimeRoot: "/taskcenter/runtime",
    logRoot: "/taskcenter/logs",
    dataRoot: "/taskcenter/data",
    revision: "abc",
    releaseId: "abc",
    webMode: "start",
    webPort: 3000,
    controlPort: 3001,
  }, { controllerRoot: "/taskcenter", baseEnvironment: {} });
  assert.equal(environment.TASKCENTER_SOURCE_ROOT, "/release/abc");
  assert.equal(environment.TASKCENTER_WEB_MODE, "start");
  assert.equal(environment.TASKCENTER_TASK_LEDGER_PATH, "/taskcenter/data/task-ledger.json");
  assert.equal(environment.TASKCENTER_DASHBOARD_PATH, "/taskcenter/data/dashboard.json");
});

test("候选 release 隔离 Codex、账本、runtime、端口并强制 dry-run", () => {
  const environment = buildReleaseEnvironment({
    sourceRoot: "/release/def",
    runtimeRoot: "/candidate/runtime",
    logRoot: "/candidate/logs",
    dataRoot: "/candidate/data",
    candidateCodex: "/candidate/codex",
    revision: "def",
    releaseId: "def",
    webMode: "start",
    webPort: 4100,
    controlPort: 4101,
  }, { controllerRoot: "/taskcenter", baseEnvironment: {} });
  assert.equal(environment.CODEX_HOME, "/candidate/codex");
  assert.equal(environment.TASKCENTER_SESSIONS_ROOT, "/candidate/codex/sessions");
  assert.equal(environment.TASKCENTER_TASK_LEDGER_PATH, "/candidate/data/task-ledger.json");
  assert.equal(environment.TASKCENTER_RUNTIME_DIR, "/candidate/runtime");
  assert.equal(environment.TASKCENTER_CONTROL_URL, "http://127.0.0.1:4101");
  assert.equal(environment.TASKCENTER_DISPATCH_DRY_RUN, "1");
  assert.equal(environment.TASKCENTER_DISABLE_LIVE_SESSION_RECONCILIATION, "1");
});

test("缺少 active release 时正式启动进入 bootstrap 而不是开发模式", () => {
  assert.deepEqual(resolveStartupRelease(null, { projectRoot: "/taskcenter" }), { mode: "bootstrap", release: null });
  const testOnly = resolveStartupRelease(null, { projectRoot: "/taskcenter", allowLegacyDev: true });
  assert.equal(testOnly.mode, "legacy_test_only");
  assert.equal(testOnly.release.webMode, "dev");
});

test("候选停止使用持久化 PID 和 token，不依赖 heartbeat 新鲜度", () => {
  const state = { pid: 42, token: "candidate", startedAt: "2026-08-25T00:00:00.000Z" };
  assert.equal(resolveStopTarget(state), state);
  assert.equal(resolveStopTarget({ pid: 42, token: "" }), null);
  assert.equal(resolveStopTarget({ pid: 0, token: "candidate" }), null);
});

test("Unix 候选停止针对完整进程组而不是单个 PID", async () => {
  const calls = [];
  const killProcess = (pid, signal) => calls.push([pid, signal]);
  await terminateProcessTree(42, { platform: "darwin", killProcess });
  await terminateProcessTree(42, { platform: "linux", force: true, killProcess });
  assert.deepEqual(calls, [[-42, "SIGTERM"], [-42, "SIGKILL"]]);
});

test("Windows 候选停止使用 taskkill 的进程树模式", async () => {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const listeners = new Map();
    queueMicrotask(() => listeners.get("exit")?.(0));
    return { once: (event, listener) => { listeners.set(event, listener); } };
  };
  await terminateProcessTree(42, { platform: "win32", force: true, spawnProcess });
  assert.deepEqual(calls[0].args, ["/PID", "42", "/T", "/F"]);
});

test("Unix 存活探针检查完整进程组", () => {
  const calls = [];
  assert.equal(isProcessTreeAlive(42, {
    platform: "darwin",
    killProcess: (pid, signal) => calls.push([pid, signal]),
  }), true);
  assert.deepEqual(calls, [[-42, 0]]);
});

test("Unix 停止完整进程组会清理派生孙进程", { skip: process.platform === "win32" }, async () => {
  const parentScript = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "console.log(child.pid);",
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const parent = spawn(process.execPath, ["-e", parentScript], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const childPid = Number(await firstLine(parent.stdout));
  try {
    assert.equal(Number.isInteger(childPid), true);
    assert.equal(processAlive(parent.pid), true);
    assert.equal(processAlive(childPid), true);
    await terminateProcessTree(parent.pid);
    await waitUntil(() => !isProcessTreeAlive(parent.pid) && !processAlive(childPid), 3_000);
  } finally {
    await terminateProcessTree(parent.pid, { force: true });
  }
});

function firstLine(stream) {
  return new Promise((resolvePromise, reject) => {
    let buffered = "";
    const timeout = setTimeout(() => reject(new Error("等待孙进程 PID 超时")), 2_000);
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      resolvePromise(buffered.slice(0, newline).trim());
    });
  });
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  assert.fail("进程树未在超时前停止");
}
