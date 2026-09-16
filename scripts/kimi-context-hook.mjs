#!/usr/bin/env node
import { kimiTaskcenterSessionId } from "./kimi-session-identity.mjs";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const events = { SessionStart: "session-start", UserPromptSubmit: "user-prompt-submit", Stop: "stop", SessionEnd: "session-end" };

// Kimi 0.43 的 UserPromptSubmit 载荷里 prompt 是内容块数组（[{"type":"text","text":"..."}]），
// PCA 共享桥接只接受字符串；在此归一化，否则 prepare_turn 会被空 prompt 静默跳过。
function promptText(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map(part => (part && typeof part === "object" && typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();
  }
  return "";
}

export async function handleKimiHook(payload, options = {}) {
  if (!events[payload?.hook_event_name]) return { continue: true };
  if (!payload.session_id || !payload.cwd) throw new Error("Kimi Hook 缺少真实 session_id/cwd");
  payload = { ...payload, session_id: kimiTaskcenterSessionId(payload.session_id), prompt: promptText(payload.prompt) };
  const messages = [];
  const diagnostic = options.diagnostic || (() => {});
  // Each dependency fails independently; context availability never grants acceptance.
  if (["SessionStart", "UserPromptSubmit"].includes(payload.hook_event_name)) {
    try {
      const output = await (options.taskcenter || taskcenterHook)(payload);
      if (output) messages.push(output);
    } catch (error) { diagnostic(`TaskCenter: ${error.message}`); }
  }
  const pcaRoot = options.pcaRoot || process.env.TASKCENTER_PCA_ROOT;
  if (pcaRoot || options.pca) {
    let connection;
    try {
      const pca = options.pca || await import(pathToFileURL(resolve(pcaRoot, "scripts/codex-context-hook.mjs")));
      connection = await pca.createConnectedCallTool({
        ...(options.pca ? {} : { transport: new StdioClientTransport({ command: process.platform === "darwin" ? resolve(pcaRoot, "scripts/mac-node.sh") : process.execPath, args: [resolve(pcaRoot, "mcp/server.mjs")], cwd: payload.cwd, env: { ...process.env }, stderr: "pipe" }) }),
        cwd: payload.cwd, clientName: "kimi-context-hook", ...pca.connectionTimeoutsForEvent(events[payload.hook_event_name]) });
      const output = await pca.handleHook(payload, {
        callTool: connection.callTool, diagnostic,
        client: pca.createClientIdentity({ id: "kimi", hookName: "kimi-context-hook", displayName: "Kimi", reqRadarAgent: "kimi" }),
        // Only the managed ACP runtime supplies a bounded final response, never a transcript path.
        stopSummaryProvider: options.summary ? async () => ({ summary: options.summary }) : undefined,
      });
      if (output?.hookSpecificOutput?.additionalContext) messages.push(output.hookSpecificOutput.additionalContext);
    } catch (error) { diagnostic(`ProjectContext: ${error.message}`); }
    finally { await connection?.close().catch(error => diagnostic(error.message)); }
  } else diagnostic("ProjectContext 未配置 TASKCENTER_PCA_ROOT，跳过上下文桥接");
  return { continue: true, ...(messages.length ? { hookSpecificOutput: { hookEventName: payload.hook_event_name, additionalContext: messages.join("\n") } } : {}) };
}

async function taskcenterHook(payload) {
  const child = exec(process.execPath, [resolve(import.meta.dirname, "taskcenter-hook.mjs"), events[payload.hook_event_name], "--agent", "kimi"], { cwd: payload.cwd, timeout: 15000, maxBuffer: 65536 });
  child.child.stdin.end(JSON.stringify(payload));
  const { stdout } = await child;
  try { return JSON.parse(stdout).hookSpecificOutput?.additionalContext || ""; }
  catch { return stdout.trim(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let input = "";
  try {
    for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 1048576) throw new Error("Hook payload 超过 1 MiB"); }
    const output = process.env.TASKCENTER_KIMI_MANAGED === "1" ? { continue: true } : await handleKimiHook(JSON.parse(input), { diagnostic: message => console.error(message) });
    console.log(JSON.stringify(output));
  } catch (error) { console.error(error.message); console.log(JSON.stringify({ continue: true })); }
}
