import { resolve } from "node:path";
import { kimiTaskcenterSessionId } from "../kimi-session-identity.mjs";
import { KimiAcp, reportedUsage } from "../kimi-acp.mjs";
import { handleKimiHook } from "../kimi-context-hook.mjs";

export async function runKimi({ cwd, session, prompt, pcaRoot, permission, update = () => {}, onSessionReady = () => {}, signal, client, hook = handleKimiHook, mcpEntry = resolve(import.meta.dirname, "../taskcenter-mcp-launcher.mjs") }) {
  cwd = resolve(cwd);
  const env = { ...process.env };
  for (const key of ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "TASKCENTER_CALLER_SESSION_ID"]) delete env[key];
  env.TASKCENTER_KIMI_MANAGED = "1";
  let cancellationTimer;
  let sessionId = session, taskcenterSessionId, finalText = "", usage = null, stopReason = "unknown", cancelled = false, prompting = false;
  const onUpdate = params => {
    if (!prompting || params.sessionId !== sessionId) return;
    const value = params.update;
    const observed = reportedUsage(value);
    if (observed) usage = observed; // Snapshot, never sum cumulative updates.
    if (value?.sessionUpdate === "agent_message_chunk" && value.content?.type === "text") finalText = (finalText + value.content.text).slice(-1200);
    update(value);
  };
  const acp = client || new KimiAcp({ cwd, env, permission, update: onUpdate });
  if (client) client.update = onUpdate;
  const cancel = () => { cancelled = true; if (sessionId) acp.notify("session/cancel", { sessionId }); cancellationTimer ||= setTimeout(() => { void acp.close(); }, 5000); };
  signal?.addEventListener("abort", cancel, { once: true });
  let attached = false, opened = false;
  try {
    const initialized = await acp.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "taskcenter-kimi", version: "1" } });
    if (!initialized.agentCapabilities?.loadSession) throw new Error("Kimi ACP does not support session/load");
    if (!sessionId) {
      const created = await acp.request("session/new", { cwd, mcpServers: [] });
      sessionId = created.sessionId; opened = true;
      await acp.request("session/close", { sessionId }); opened = false;
    }
    taskcenterSessionId = kimiTaskcenterSessionId(sessionId);
    if (session) {
      let cursor, matched = false;
      for (let page = 0; page < 20; page++) {
        const listing = await acp.request("session/list", { cwd, ...(cursor ? { cursor } : {}) });
        const found = listing.sessions?.find(item => item.sessionId === sessionId);
        if (found) { matched = typeof found.cwd === "string" && resolve(found.cwd) === cwd; break; }
        cursor = listing.nextCursor;
        if (!cursor) break;
      }
      if (!matched) throw new Error("Kimi Session not found in the requested workspace; refusing to resume");
    }
    await acp.request("session/load", { sessionId, cwd, mcpServers: [{ name: "taskcenter", command: process.execPath, args: [mcpEntry], env: [{ name: "TASKCENTER_CALLER_SESSION_ID", value: taskcenterSessionId }, { name: "TASKCENTER_AGENT", value: "kimi" }] }] });
    opened = true;
    const lifecycle = (name, extra = {}) => hook({ hook_event_name: name, session_id: taskcenterSessionId, cwd, ...extra }, { pcaRoot, diagnostic: message => console.error(message) });
    await lifecycle("SessionStart"); attached = true;
    const context = await lifecycle("UserPromptSubmit", { prompt });
    if (signal?.aborted || cancelled) { cancel(); throw new Error("Kimi run cancelled before prompt"); }
    onSessionReady({ sessionId, taskcenterSessionId });
    const blocks = [{ type: "text", text: prompt }];
    const injection = context?.hookSpecificOutput?.additionalContext;
    if (injection) blocks.push({ type: "text", text: injection });
    prompting = true;
    const result = await acp.request("session/prompt", { sessionId, prompt: blocks }, 30 * 60 * 1000);
    stopReason = result.stopReason || "unknown";
    if (!cancelled && stopReason === "end_turn") await hook({ hook_event_name: "Stop", session_id: taskcenterSessionId, cwd }, { pcaRoot, summary: finalText, diagnostic: message => console.error(message) });
    return { sessionId, taskcenterSessionId, cwd, stopReason, usage, usage_status: usage ? "reported" : "unknown", cancelled };
  } finally {
    clearTimeout(cancellationTimer);
    signal?.removeEventListener("abort", cancel);
    if (attached) await hook({ hook_event_name: "SessionEnd", session_id: taskcenterSessionId, cwd }, { pcaRoot, diagnostic: message => console.error(message) }).catch(() => {});
    if (opened) await acp.request("session/close", { sessionId }, 3000).catch(() => {});
    await acp.close();
  }
}
