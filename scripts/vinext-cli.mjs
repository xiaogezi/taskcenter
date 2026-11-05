#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildInputHash, recordBuild } from "./artifact-size-budget.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function vinextInvocation(command, args = [], root = projectRoot) {
  const cli = command === "start" ? resolve(root, "scripts", "prod-server.mjs") : resolve(root, "node_modules", "vinext", "dist", "cli.js");
  if (!existsSync(cli)) {
    throw new Error("找不到 vinext CLI，请先运行 npm ci。");
  }
  return {
    command: process.execPath,
    args: [cli, ...(command === "start" ? [] : [command]), ...args],
    env: { ...process.env },
  };
}

export function runVinext(command, args = []) {
  const invocation = vinextInvocation(command, args);
  const inputHash = command === "build" ? buildInputHash(projectRoot) : null;
  // vinext copies every cached font into client output, including fonts removed from source.
  if (command === "build") rmSync(resolve(projectRoot, ".vinext", "fonts"), { recursive: true, force: true });
  if (command === "build") rmSync(resolve(projectRoot, "dist"), { recursive: true, force: true });
  const child = spawn(invocation.command, invocation.args, {
    cwd: projectRoot,
    env: invocation.env,
    stdio: "inherit",
  });
  child.once("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once("exit", async (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
    if (process.exitCode === 0 && inputHash) {
      try {
        const { buildRuntimeLogger } = await import("./build-runtime-logger.mjs");
        await buildRuntimeLogger(projectRoot);
        recordBuild(projectRoot, inputHash);
      }
      catch (error) { console.error(error.message); process.exitCode = 1; }
    }
  });
  return child;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (!command) {
    console.error("用法：node scripts/vinext-cli.mjs <dev|build|start> [...args]");
    process.exitCode = 2;
  } else {
    runVinext(command, process.argv.slice(3));
  }
}
