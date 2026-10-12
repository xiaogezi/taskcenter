import { runKimi } from "./kimi-session.mjs";

async function run({ workingDirectory, sessionId, onEvent = () => {}, ...input }) {
  let nativeId = sessionId;
  const result = await runKimi({ ...input, cwd: workingDirectory, session: sessionId,
    onSessionReady: value => { nativeId = value.sessionId; onEvent({ status: "accepted", ...value }); },
    update: value => {
      onEvent({ status: "running", sessionId: nativeId });
      input.update?.(value);
    },
  });
  return { ...result, status: result.cancelled ? "cancelled" : result.stopReason === "end_turn" ? "completed" : "unknown",
    usageScope: "context_snapshot" };
}

export const kimiAdapter = {
  id: "kimi",
  client: { label: "Kimi Code CLI", hooks: true, resume: true, usage: true, integration_mode: "managed_acp", usage_scope: "context_snapshot", native_hooks_require_configuration: true },
  identity: "explicit_host_binding_required",
  usageScope: "context_snapshot",
  operations: { createSession: run, resumeSession: run },
};
