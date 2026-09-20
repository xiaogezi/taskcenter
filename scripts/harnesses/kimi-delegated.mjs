import { runKimi } from "./kimi-session.mjs";

export async function runKimiDelegated({ manifest, profile, prompt, signal, dependencies, onSessionReady, authorizeTool, update }) {
  let sessionId;
  const run = await (dependencies.runKimi || runKimi)({
    cwd: manifest.workspace, model: profile.model, thinking: profile.effort,
    mode: manifest.mode === "read-only" ? "plan" : "default", prompt, signal, update,
    onSessionReady: async value => {
      await onSessionReady(value);
      sessionId = value.taskcenterSessionId;
    },
    permission: async params => {
      const call = params.toolCall || {};
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
