import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveSpawnCommand } from "../platform-command.mjs";

export function claudeInvocation(manifest, manifestPath, profile, env = process.env) {
  const command = [process.execPath, resolve(import.meta.dirname, "../delegated-cli-hook.mjs")].map(value => `'${value.replaceAll("'", "'\\''")}'`).join(" ");
  const hooks = Object.fromEntries(["SessionStart", "PreToolUse"].map(name => [name, [{ matcher: "", hooks: [{ type: "command", command }] }]]));
  const tools = manifest.mode === "read-only" ? "Read,Glob,Grep" : "Read,Glob,Grep,Write,Edit,Bash";
  const childEnv = { ...env, TASKCENTER_CLI_MANIFEST: manifestPath };
  for (const key of ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "TASKCENTER_CALLER_SESSION_ID", "TASKCENTER_MANAGED_REVIEW"]) delete childEnv[key];
  return { args: ["--print", "--verbose", "--output-format", "stream-json", "--model", profile.model, "--effort", profile.effort, "--permission-mode", "dontAsk", "--tools", tools, "--allowedTools", tools, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--settings", JSON.stringify({ hooks })], env: childEnv };
}

export function claudeReceipt(event) {
  if (event?.type !== "result") return null;
  return { status: event.is_error || event.subtype !== "success" || event.permission_denials?.length ? "failed" : "completed", permissionDenied: Boolean(event.permission_denials?.length), sessionId: event.session_id, reportedModels: Object.keys(event.modelUsage || {}), summary: String(event.result || "").slice(-1200), rawStatus: event.subtype || "unknown", usage: event.usage || null };
}

export async function runClaude(manifest, manifestPath, profile, prompt, signal, logPath) {
  const invocation = claudeInvocation(manifest, manifestPath, profile);
  const executable = resolveSpawnCommand("claude", { env: invocation.env });
  const child = spawn(executable.command, [...executable.argsPrefix, ...invocation.args], { cwd: manifest.workspace, env: invocation.env, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "", receipt = null, bytes = 0, parseError;
  const stop = () => child.kill("SIGTERM");
  signal.addEventListener("abort", stop, { once: true });
  const timer = setInterval(() => { if (signal.aborted) child.kill("SIGKILL"); }, 5000);
  const log = chunk => { bytes += Buffer.byteLength(chunk); if (bytes > 16 * 1024 * 1024) { parseError = new Error("CLI_LOG_LIMIT"); stop(); } else appendFileSync(logPath, chunk); };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    log(chunk); buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) { parseError = new Error("CLI_FRAME_LIMIT"); stop(); return; }
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try { receipt = claudeReceipt(JSON.parse(line)) || receipt; } catch { parseError = new Error("CLI_INVALID_JSON"); stop(); }
    }
  });
  child.stderr.on("data", log);
  child.stdin.on("error", () => {});
  try {
    const exited = new Promise((accept, reject) => { child.once("error", reject); child.once("close", (code, sig) => accept({ code, signal: sig })); });
    child.stdin.end(prompt);
    const exit = await exited;
    if (parseError) throw parseError;
    return { ...(receipt || { status: "unknown", reportedModels: [] }), ...exit, status: signal.aborted ? "cancelled" : exit.code === 0 ? receipt?.status || "unknown" : "failed" };
  } finally { clearInterval(timer); signal.removeEventListener("abort", stop); }
}

export async function runClaudeDelegated({ manifest, manifestPath, profile, prompt, signal, logPath, dependencies }) {
  return (dependencies.runClaude || runClaude)(manifest, manifestPath, profile, prompt, signal, logPath);
}
