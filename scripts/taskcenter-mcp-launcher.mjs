#!/usr/bin/env node

import { spawn } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultProjectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const maxMetadataBytes = 64 * 1024;
const forwardedSignals = ["SIGINT", "SIGTERM"];

export function resolveActiveMcp(options = {}) {
  const projectRoot = resolve(options.projectRoot || defaultProjectRoot);
  const releasesRoot = resolve(options.releasesRoot || resolve(projectRoot, ".local/releases"));
  const activeReleasePath = resolve(options.activeReleasePath || resolve(projectRoot, ".local/runtime/active-release.json"));
  const activeRelease = readJsonFile(activeReleasePath, "active release");

  if (!activeRelease || typeof activeRelease !== "object" || Array.isArray(activeRelease)) {
    throw new Error("active release 必须是 JSON object");
  }
  const { sourceRoot, revision, releaseId } = activeRelease;
  if (typeof sourceRoot !== "string" || !sourceRoot) throw new Error("active release 缺少 sourceRoot");
  if (!isAbsolute(sourceRoot)) throw new Error("active release sourceRoot 必须是绝对路径");
  if (typeof revision !== "string" || !/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error("active release revision 必须是完整 Git SHA");
  }
  if (typeof releaseId !== "string" || releaseId !== revision.slice(0, 12)) {
    throw new Error("active release releaseId 与 revision 不一致");
  }

  const resolvedSourceRoot = resolve(sourceRoot);
  requireContainedPath(releasesRoot, resolvedSourceRoot, "active release sourceRoot");
  requireDirectory(resolvedSourceRoot, "active release sourceRoot");
  requireUnchangedRealPath(resolvedSourceRoot, "active release sourceRoot");

  const markerPath = resolve(resolvedSourceRoot, ".taskcenter-release.json");
  const marker = readJsonFile(markerPath, "release marker");
  if (
    marker?.schemaVersion !== "taskcenter-release/v1"
    || marker.revision !== revision
    || marker.releaseId !== releaseId
  ) {
    throw new Error("release marker 与 active release 不一致");
  }

  const entryPath = resolve(resolvedSourceRoot, "scripts/taskcenter-mcp.mjs");
  requireContainedPath(resolvedSourceRoot, entryPath, "MCP entry");
  const entryStat = requireRegularFile(entryPath, "MCP entry");
  if (entryStat.size === 0) throw new Error("MCP entry 不能为空文件");
  requireUnchangedRealPath(entryPath, "MCP entry");
  return { entryPath, sourceRoot: resolvedSourceRoot, revision, releaseId };
}

export function launchActiveMcp(options = {}) {
  const release = resolveActiveMcp(options);
  const spawnProcess = options.spawnProcess || spawn;
  const child = spawnProcess(process.execPath, [release.entryPath], {
    cwd: release.sourceRoot,
    env: options.environment || process.env,
    stdio: "inherit",
  });
  const signalHandlers = new Map();
  for (const signal of forwardedSignals) {
    const handler = () => child.kill(signal);
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  const cleanup = () => {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  };
  child.once("error", (error) => {
    cleanup();
    console.error(`TaskCenter MCP launcher 启动失败：${error.message}`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    cleanup();
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
  return child;
}

function readJsonFile(path, label) {
  requireRegularFile(path, label);
  const stat = lstatSync(path);
  if (stat.size > maxMetadataBytes) throw new Error(`${label} 超过大小限制`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON：${error.message}`, { cause: error });
  }
}

function requireRegularFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new Error(`${label} 不可读取：${error.message}`, { cause: error });
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} 必须是非符号链接的普通文件`);
  return stat;
}

function requireDirectory(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new Error(`${label} 不可读取：${error.message}`, { cause: error });
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} 必须是非符号链接目录`);
}

function requireContainedPath(parent, child, label) {
  const pathFromParent = relative(resolve(parent), resolve(child));
  if (!pathFromParent || pathFromParent.startsWith("..") || pathFromParent.includes(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`${label} 必须位于 ${resolve(parent)} 内`);
  }
}

function requireUnchangedRealPath(path, label) {
  if (realpathSync(path) !== resolve(path)) throw new Error(`${label} 不能经过符号链接`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    launchActiveMcp();
  } catch (error) {
    console.error(`TaskCenter MCP launcher 拒绝启动：${error.message}`);
    process.exitCode = 1;
  }
}
