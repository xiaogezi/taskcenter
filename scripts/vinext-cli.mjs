#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function vinextInvocation(command, args = [], root = projectRoot) {
  const cli = resolve(root, "node_modules", "vinext", "dist", "cli.js");
  if (!existsSync(cli)) {
    throw new Error("找不到 vinext CLI，请先运行 npm ci。");
  }
  return {
    command: process.execPath,
    args: [cli, command, ...args],
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || ".wrangler/wrangler.log",
    },
  };
}

export function runVinext(command, args = []) {
  const invocation = vinextInvocation(command, args);
  const child = spawn(invocation.command, invocation.args, {
    cwd: projectRoot,
    env: invocation.env,
    stdio: "inherit",
  });
  child.once("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
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
