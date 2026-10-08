import { inspectSessionState } from "./codex-session.mjs";

export const codexAdapter = {
  id: "codex",
  client: { label: "Codex", hooks: true, resume: false, usage: true },
  identity: "host_metadata_or_environment",
  usageScope: "token_usage",
  operations: {
    inspectSession: ({ sessionId, sessionsRoot }) => inspectSessionState(sessionId, sessionsRoot),
  },
};
