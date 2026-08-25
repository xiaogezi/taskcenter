import { spawn } from "node:child_process";

export async function terminateProcessTree(pid, options = {}) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return;
  const platform = options.platform || process.platform;
  const force = options.force === true;
  if (platform === "win32") {
    await runTaskkill(numericPid, force, options.spawnProcess || spawn);
    return;
  }
  try {
    (options.killProcess || process.kill)(-numericPid, force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export function isProcessTreeAlive(pid, options = {}) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  const platform = options.platform || process.platform;
  try {
    const target = platform === "win32" ? numericPid : -numericPid;
    (options.killProcess || process.kill)(target, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return error?.code === "EPERM";
  }
}

function runTaskkill(pid, force, spawnProcess) {
  return new Promise((resolvePromise, reject) => {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    const child = spawnProcess("taskkill.exe", args, { stdio: "ignore", windowsHide: true });
    child.once("error", (error) => {
      if (error?.code === "ENOENT") reject(new Error("Windows 进程树停止失败：taskkill.exe 不可用。"));
      else reject(error);
    });
    child.once("exit", (code) => {
      if (code === 0 || code === 128) resolvePromise();
      else reject(new Error(`Windows 进程树停止失败：taskkill exit ${code}`));
    });
  });
}
