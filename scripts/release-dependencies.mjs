import { spawn } from "node:child_process";
import { terminateProcessTree } from "./process-tree.mjs";

export async function installReleaseDependencies(run) {
  const common = ["ci", "--no-audit", "--no-fund"];
  try {
    await run([...common, "--offline"], 60_000);
    return "offline";
  } catch (error) {
    if (error.code !== "ENOTCACHED") throw error;
  }
  console.log("依赖缓存缺失：尝试一次联网安装（总时限 180 秒）；原服务保持运行。");
  await run([...common, "--offline=false", "--prefer-offline", "--fetch-retries=1", "--fetch-timeout=30000"], 180_000);
  return "network";
}

export function runDependencyInstall(command, args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, detached: process.platform !== "win32", stdio: ["ignore", "inherit", "pipe"] });
    let stderr = "", timedOut = false;
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      stderr = (stderr + chunk.toString()).slice(-64 * 1024);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child.pid, { force: true }).catch(reject);
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) return resolve();
      const error = new Error(timedOut
        ? `依赖安装超过 ${timeoutMs / 1000} 秒，已终止候选安装进程树；原服务未切换。请恢复网络或补齐 npm 缓存后重试部署。`
        : `release npm ci 失败（${signal || code}）`);
      error.code = timedOut ? "DEPENDENCY_INSTALL_TIMEOUT" : /\bENOTCACHED\b/.test(stderr) ? "ENOTCACHED" : "DEPENDENCY_INSTALL_FAILED";
      reject(error);
    });
  });
}
