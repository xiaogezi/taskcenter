import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join } from "node:path";

export function resolveSpawnCommand(command, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") return { command, argsPrefix: [] };

  const env = options.env || process.env;
  const exists = options.exists || existsSync;
  const readFile = options.readFile || readFileSync;
  const resolved = resolveWindowsExecutable(command, { env, exists });
  if (!resolved) return { command, argsPrefix: [] };
  if (![".cmd", ".bat"].includes(extname(resolved).toLowerCase())) {
    return { command: resolved, argsPrefix: [] };
  }

  const shim = resolveNodeShim(resolved, { exists, readFile });
  if (shim) return shim;
  throw new Error(
    `Windows 命令 ${resolved} 是无法安全解析的批处理启动器；请将 TASKCENTER_CODEX_COMMAND 指向 codex.exe，`
      + "或通过 TASKCENTER_CODEX_PREFIX_ARGS 配置 Node 入口。",
  );
}

export function resolveWindowsExecutable(command, options = {}) {
  const env = options.env || process.env;
  const exists = options.exists || existsSync;
  const extensions = windowsExtensions(command, env.PATHEXT);
  const hasPath = isAbsolute(command) || /[\\/]/.test(command);
  const directories = hasPath ? [""] : String(env.PATH || "").split(options.pathDelimiter || ";").filter(Boolean);

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = directory ? join(directory, `${command}${extension}`) : `${command}${extension}`;
      if (exists(candidate)) return candidate;
    }
  }
  return "";
}

function windowsExtensions(command, pathExt = ".COM;.EXE;.BAT;.CMD") {
  if (extname(command)) return [""];
  const values = String(pathExt).split(";").filter(Boolean).map((value) => value.toLowerCase());
  const preferred = [".exe", ".com", ...values.filter((value) => ![".exe", ".com"].includes(value))];
  return ["", ...new Set(preferred)];
}

function resolveNodeShim(path, options) {
  let content;
  try {
    content = options.readFile(path, "utf8");
  } catch {
    return null;
  }
  const match = content.match(/["']%dp0%[\\/]([^"']+\.m?js)["']/i);
  if (!match) return null;
  const entry = join(dirname(path), ...match[1].split(/[\\/]+/));
  if (!options.exists(entry)) return null;
  const bundledNode = join(dirname(path), "node.exe");
  return {
    command: options.exists(bundledNode) ? bundledNode : process.execPath,
    argsPrefix: [entry],
  };
}
