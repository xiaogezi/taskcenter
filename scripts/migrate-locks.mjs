#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { readRuntimeCapabilities } from "./release-runtime.mjs";
import { initializeSqliteMutex } from "./sqlite-mutex.mjs";

// An explicit operator assertion, not process-discovery or proof of quiescence.
// Never stop services, delete legacy locks, or silently migrate during acquisition.
try {
  const { values } = parseArgs({ options: {
    "offline-confirmed": { type: "boolean", default: false },
    target: { type: "string", default: "all" },
  } });
  if (!values["offline-confirmed"] || !["all", "launcher", "reuse"].includes(values.target)) {
    throw new Error("请先阅读 docs/lock-protocol-migration.md，停止所有旧写者并安排离线升级；然后使用 --offline-confirmed [--target all|launcher|reuse]。此参数不是进程已停止的证明。");
  }
  const root = resolve(import.meta.dirname, "..");
  readRuntimeCapabilities(root);
  const runtime = resolve(process.env.TASKCENTER_RUNTIME_DIR || resolve(root, ".local/runtime"));
  const decisions = resolve(process.env.TASKCENTER_TASK_REUSE_DECISIONS_PATH || resolve(root, "data/task-reuse-decisions.jsonl"));
  const targets = [
    { name: "launcher", databasePath: resolve(runtime, "launcher.mutex.sqlite"), legacyLockPath: resolve(runtime, "launcher.lock") },
    { name: "reuse", databasePath: `${decisions}.mutex.sqlite`, legacyLockPath: `${decisions}.lock` },
  ].filter(item => values.target === "all" || item.name === values.target);
  for (const target of targets) {
    initializeSqliteMutex({ ...target, offlineConfirmed: true });
    console.log(`已初始化 ${target.name} 锁协议：${target.databasePath}`);
  }
  console.log("升级已有 release：提交并检查新版源码后，在服务仍离线时运行 node scripts/taskcenter-control.mjs start --offline-upgrade --offline-confirmed。普通 start 不会绕过旧 active-release 的协议拒绝。正式 service 使用项目 data/task-reuse-decisions.jsonl；若设置自定义 decisions 路径，仍须单独初始化正式路径。");
  console.log("此工具没有停止或检测全部旧进程。只启动新协议版本；禁止旧版写者重新使用这些数据目录。多目标部分完成可在保持离线后重试。");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
