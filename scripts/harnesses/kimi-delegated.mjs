import { runKimi } from "./kimi-session.mjs";

export async function runKimiDelegated({ manifest, profile, prompt, signal, dependencies, onSessionReady, authorizeTool, update }) {
  let sessionId;
  const calls = new Map();
  const run = await (dependencies.runKimi || runKimi)({
    cwd: manifest.workspace, model: profile.model, thinking: profile.effort,
    mode: manifest.mode === "read-only" ? "plan" : "default", prompt, signal,
    update: value => {
      if (["tool_call", "tool_call_update"].includes(value.sessionUpdate) && value.toolCallId) {
        if (["completed", "failed"].includes(value.status)) calls.delete(value.toolCallId);
        else {
          const previous = calls.get(value.toolCallId) || {};
          let rawInput = value.rawInput ?? previous.rawInput;
          // Kimi emits rawInput only after permission; in-progress content carries the JSON argument snapshot.
          if (!value.rawInput && value.status === "in_progress" && value.content) {
            rawInput = undefined;
            const parts = value.content;
            if (parts.length === 1 && parts[0].type === "content" && parts[0].content?.type === "text") {
              try {
                const parsed = JSON.parse(parts[0].content.text);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) rawInput = parsed;
              } catch { /* Incomplete argument snapshots are not permission evidence. */ }
            }
          }
          calls.set(value.toolCallId, { kind: value.kind ?? previous.kind, rawInput });
        }
      }
      update?.(value);
    },
    onSessionReady: async value => {
      await onSessionReady(value);
      sessionId = value.taskcenterSessionId;
    },
    permission: async params => {
      const request = params.toolCall || {};
      const previous = calls.get(request.toolCallId) || {};
      const call = { kind: request.kind ?? previous.kind, rawInput: request.rawInput ?? previous.rawInput };
      const tool = { read: "Read", search: "Grep", edit: "Edit", execute: "Bash" }[call.kind];
      if (!await authorizeTool(tool, call.rawInput)) return null;
      return params.options?.find(option => option.kind === "allow_once")?.optionId || null;
    },
  });
  return {
    status: run.cancelled ? "cancelled" : run.stopReason === "end_turn" ? "completed" : "unknown",
    sessionId, reportedModels: run.reportedModel ? [run.reportedModel] : [],
    reportedThinking: run.reportedThinking, summary: run.finalText,
    rawStatus: run.stopReason, usage: run.usage,
  };
}
