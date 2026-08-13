import { spawn } from "node:child_process";

const specs = [
  { name: "watch-codex", command: process.execPath, args: ["scripts/watch-codex.mjs"] },
  { name: "control-server", command: process.execPath, args: ["scripts/control-server.mjs"] },
  { name: "web", command: "npm", args: ["run", "dev"] },
];
const children = new Map();
const restartTimers = new Set();

let shuttingDown = false;

function start(spec) {
  if (shuttingDown) return;
  const child = spawn(spec.command, spec.args, { stdio: "inherit" });
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

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const timer of restartTimers) clearTimeout(timer);
  restartTimers.clear();
  for (const child of children.values()) child.kill("SIGTERM");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
