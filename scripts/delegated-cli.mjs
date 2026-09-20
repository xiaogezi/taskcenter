import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { cliProfile } from "./cli-profile.mjs";
import { claimCli, checkCliTool, control } from "./delegated-cli-hook.mjs";
import { runKimi } from "./harnesses/kimi-session.mjs";
import { resolveSpawnCommand } from "./platform-command.mjs";

export function validateCliManifest(input) {
  for (const key of ["profile", "task_id", "parent_session_id", "route_id", "delegation_id", "claim_token", "workspace", "prompt_path", "output_path"]) if (typeof input[key] !== "string" || !input[key].trim()) throw new Error(`Missing ${key}`);
  for (const key of ["workspace", "prompt_path", "output_path"]) if (!isAbsolute(input[key])) throw new Error(`${key} must be absolute`);
  if (!['read-only', 'workspace-write'].includes(input.mode)) throw new Error("Explicit mode required");
  const timeout_ms = input.timeout_ms ?? 300000;
  if (!Number.isInteger(timeout_ms) || timeout_ms < 1000 || timeout_ms > 1800000) throw new Error("Invalid timeout_ms");
  cliProfile(input.profile);
  return { ...input, workspace: resolve(input.workspace), timeout_ms };
}

export function claudeInvocation(manifest, manifestPath, profile, env = process.env) {
  const command = [process.execPath, resolve(import.meta.dirname, "delegated-cli-hook.mjs")].map(value => `'${value.replaceAll("'", "'\\''")}'`).join(" ");
  const hooks = Object.fromEntries(["SessionStart", "PreToolUse"].map(name => [name, [{ matcher: "", hooks: [{ type: "command", command }] }]]));
  const tools = manifest.mode === "read-only" ? "Read,Glob,Grep" : "Read,Glob,Grep,Write,Edit,Bash";
  const childEnv = { ...env, TASKCENTER_CLI_MANIFEST: manifestPath };
  for (const key of ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "TASKCENTER_CALLER_SESSION_ID", "TASKCENTER_MANAGED_REVIEW"]) delete childEnv[key];
  return { args: ["--print", "--verbose", "--output-format", "stream-json", "--model", profile.model, "--effort", profile.effort, "--permission-mode", "dontAsk", "--tools", tools, "--allowedTools", tools, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--settings", JSON.stringify({ hooks })], env: childEnv };
}

export function claudeReceipt(event) {
  if (event?.type !== "result") return null;
  return { status: event.is_error || event.subtype !== "success" || event.permission_denials?.length ? "failed" : "completed", sessionId: event.session_id, reportedModels: Object.keys(event.modelUsage || {}), summary: String(event.result || "").slice(-1200), rawStatus: event.subtype || "unknown", usage: event.usage || null };
}

async function runClaude(manifest, manifestPath, profile, prompt, signal, logPath) {
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

export async function runDelegatedCli(input, dependencies = {}) {
  const manifest = validateCliManifest(input), profile = cliProfile(manifest.profile);
  const request = dependencies.control || control;
  const temporary = mkdtempSync(join(tmpdir(), "taskcenter-cli-"));
  const manifestPath = join(temporary, "manifest.json");
  manifest.receipt_path = join(temporary, "claimed.json");
  writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  const logPath = `${manifest.output_path}.log`;
  let sessionId, result, failure, reportError;
  const controller = new AbortController(), signal = controller.signal;
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, manifest.timeout_ms);
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  try {
    // No prompt is submitted to Kimi before claim; Claude tools require the SessionStart receipt.
    const prompt = readFileSync(manifest.prompt_path, "utf8");
    writeFileSync(logPath, "", { mode: 0o600, flag: "wx" });
    if (existsSync(manifest.output_path)) throw new Error("CLI_OUTPUT_EXISTS");
    if (profile.harness === "claude") {
      result = await (dependencies.runClaude || runClaude)(manifest, manifestPath, profile, prompt, signal, logPath);
      if (existsSync(manifest.receipt_path)) sessionId = JSON.parse(readFileSync(manifest.receipt_path, "utf8")).sessionId;
      if (!sessionId || result.sessionId !== sessionId) throw new Error("CLI_NOT_CLAIMED");
    } else {
      let logBytes = 0;
      const run = await (dependencies.runKimi || runKimi)({ cwd: manifest.workspace, model: profile.model, thinking: profile.effort, mode: manifest.mode === "read-only" ? "plan" : "default", prompt, signal,
        onSessionReady: async value => { await claimCli(manifest, value.taskcenterSessionId, request); sessionId = value.taskcenterSessionId; },
        permission: async params => {
          const call = params.toolCall || {};
          const tool = { read: "Read", search: "Grep", edit: "Edit", execute: "Bash" }[call.kind];
          if (!sessionId || !tool || !call.rawInput) return null;
          try { await checkCliTool(manifest, sessionId, tool, call.rawInput); return params.options?.find(option => option.kind === "allow_once")?.optionId || null; } catch { return null; }
        },
        update: value => { const text = JSON.stringify(value) + "\n"; logBytes += Buffer.byteLength(text); if (logBytes <= 16 * 1024 * 1024) appendFileSync(logPath, text); },
      });
      result = { status: run.cancelled ? "cancelled" : run.stopReason === "end_turn" ? "completed" : "unknown", sessionId, reportedModels: run.reportedModel ? [run.reportedModel] : [], reportedThinking: run.reportedThinking, summary: run.finalText, rawStatus: run.stopReason, usage: run.usage };
    }
    if (result.status === "completed" && (!result.reportedModels.length || !result.reportedModels.includes(profile.model))) result.status = "unknown";
  } catch (error) { failure = error.message; result = { status: signal.aborted ? "cancelled" : "failed" }; }
  finally {
    clearTimeout(timeout); process.off("SIGINT", abort); process.off("SIGTERM", abort);
    if (!sessionId && existsSync(manifest.receipt_path)) sessionId = JSON.parse(readFileSync(manifest.receipt_path, "utf8")).sessionId;
    const outcome = result?.status === "completed" ? "succeeded" : result?.status === "cancelled" ? "cancelled" : "failed";
    const evidence = { ...result, error: failure || null, task_id: manifest.task_id, route_id: manifest.route_id, delegation_id: manifest.delegation_id, role: profile.role, harness: profile.harness, requested_model: profile.model, requested_effort: profile.effort, effective_effort: result?.reportedThinking || null, observed_at: new Date().toISOString(), log_path: logPath };
    try {
      if (sessionId) await request("/delegations/report", { delegation_id: manifest.delegation_id, session_id: sessionId, workspace: manifest.workspace, status: outcome, summary: String(result?.summary || outcome).slice(-1000), evidence: [JSON.stringify(evidence).slice(0, 1000)], error: failure || (outcome === "failed" ? result?.rawStatus || "CLI_OUTCOME_UNKNOWN" : "") });
      else await request("/delegations/revoke", { delegation_id: manifest.delegation_id, parent_session_id: manifest.parent_session_id });
    } catch (error) { reportError = error.message; }
    try { await request("/routing/result", { route_id: manifest.route_id, session_id: manifest.parent_session_id, outcome, ...(outcome === "failed" ? { error_type: "cli_execution", error_code: failure || "CLI_OUTCOME_UNKNOWN" } : {}) }); } catch (error) { reportError = [reportError, error.message].filter(Boolean).join("; "); }
    try { writeFileSync(manifest.output_path, JSON.stringify({ ...evidence, report_error: reportError || null }, null, 2) + "\n", { mode: 0o600, flag: "wx" }); }
    finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  if (failure || reportError || result.status !== "completed") throw new Error(failure || reportError || `CLI_${result.status.toUpperCase()}`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { if (process.argv.length !== 3) throw new Error("Usage: node scripts/delegated-cli.mjs MANIFEST.json"); await runDelegatedCli(JSON.parse(readFileSync(process.argv[2], "utf8"))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
