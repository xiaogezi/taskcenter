import { spawn } from "node:child_process";
import { resolveSpawnCommand } from "../platform-command.mjs";
import { codexAppServerInvocation } from "./codex-delegated.mjs";

let cached;
let pending;

// 只查询元数据，不创建 thread/turn；选择器目录不代表本轮 spawn 能力。
export function codexModelCatalog() {
  if (cached && Date.now() - cached.at < 60_000) return Promise.resolve(cached.value);
  if (pending) return pending;
  pending = readCatalog().catch(() => ({ source: "codex/model/list", status: "unavailable", models: [], error: "会话模型目录读取失败，请检查本机 Codex 服务后重新读取。", observed_at: null }))
    .then(value => { cached = { at: Date.now(), value }; return value; })
    .finally(() => { pending = undefined; });
  return pending;
}

async function readCatalog() {
  const { args, env } = codexAppServerInvocation();
  const executable = env.TASKCENTER_CODEX_COMMAND
    ? { command: env.TASKCENTER_CODEX_COMMAND, argsPrefix: JSON.parse(env.TASKCENTER_CODEX_PREFIX_ARGS || "[]") }
    : resolveSpawnCommand("codex", { env });
  if (!Array.isArray(executable.argsPrefix) || executable.argsPrefix.some(arg => typeof arg !== "string")) throw new Error("Invalid Codex invocation");
  const child = spawn(executable.command, [...executable.argsPrefix, ...args], { env, stdio: ["pipe", "pipe", "ignore"] });
  const requests = new Map();
  let nextId = 0;
  let buffer = "";
  let failure;
  let closed = false;
  const fail = error => { failure = error; for (const entry of requests.values()) entry.reject(error); requests.clear(); child.kill(); };
  const timer = setTimeout(() => fail(new Error("Catalog timeout")), 10_000);
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.on("close", () => { closed = true; fail(new Error("Catalog process exited")); });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    if (buffer.length > 2 * 1024 * 1024) { fail(new Error("Catalog response too large")); return; }
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { fail(new Error("Invalid catalog response")); return; }
      if (message.method) {
        if (message.id != null) child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "Metadata only" } }) + "\n");
        continue;
      }
      const entry = requests.get(message.id);
      if (!entry) continue;
      requests.delete(message.id);
      if (message.error) entry.reject(new Error("Catalog RPC failed")); else entry.resolve(message.result);
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++nextId; requests.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  try {
    await request("initialize", { clientInfo: { name: "taskcenter-model-catalog", version: "1" } });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const models = new Map();
    const cursors = new Set();
    let cursor;
    do {
      const page = await request("model/list", { includeHidden: false, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page?.data)) throw new Error("Missing model data");
      for (const entry of page.data) {
        if (entry.hidden) continue;
        const id = entry.model;
        if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(id)) throw new Error("Invalid model ID");
        if (!Array.isArray(entry.supportedReasoningEfforts)) throw new Error("Missing model efforts");
        models.set(id, { id, runtime_model: id, display_name: String(entry.displayName || id).slice(0, 120), description: String(entry.description || id).slice(0, 300), reasoning_efforts: entry.supportedReasoningEfforts.map(item => item.reasoningEffort).filter(effort => ["low", "medium", "high"].includes(effort)) });
      }
      cursor = page.nextCursor;
      if (models.size > 100 || (cursor && (typeof cursor !== "string" || cursors.has(cursor) || cursors.size >= 10))) throw new Error("Catalog page limit");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return { source: "codex/model/list", status: "succeeded", models: [...models.values()], observed_at: new Date().toISOString(), error: null };
  } finally {
    clearTimeout(timer);
    child.kill();
    const escalation = setTimeout(() => child.kill("SIGKILL"), 1000);
    escalation.unref();
    if (!closed) await new Promise(resolve => child.once("close", resolve));
    clearTimeout(escalation);
  }
}
