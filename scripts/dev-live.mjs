import { spawn } from "node:child_process";

const children = [
  spawn(process.execPath, ["scripts/watch-codex.mjs"], { stdio: "inherit" }),
  spawn(process.execPath, ["scripts/control-server.mjs"], { stdio: "inherit" }),
  spawn("npm", ["run", "dev"], { stdio: "inherit" }),
];

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  children.forEach((child) => child.kill("SIGTERM"));
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
