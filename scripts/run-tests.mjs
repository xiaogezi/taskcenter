#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const integration = process.argv.includes("--integration");
const files = integration
  ? ["tests/dashboard.test.mjs"]
  : readdirSync(resolve(projectRoot, "tests"))
      .filter((name) => name.endsWith(".test.mjs"))
      .sort()
      .map((name) => `tests/${name}`);
const env = {
  ...process.env,
  TASKCENTER_JEV_ROUTING: "0",
  TASKCENTER_DASHBOARD_PATH: integration ? "data/dashboard.json" : ".local/test-dashboard.json",
  ...(integration ? { TASKCENTER_TEST_MODE: "integration" } : {}),
};
// Test subprocesses must never inherit the live Jev credential.
delete env.TYPESAFE_API_KEY;
const child = spawn(process.execPath, ["--test", ...files], {
  cwd: projectRoot,
  env,
  stdio: "inherit",
});
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
