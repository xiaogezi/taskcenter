import { runClaudeDelegated } from "./claude-delegated.mjs";

// Managed delegation is supported; general session control remains unsupported.
export const claudeAdapter = {
  id: "claude",
  client: { label: "Claude Code", hooks: true, resume: false, usage: false },
  identity: "explicit_host_binding_required",
  usageScope: "unknown",
  operations: { runDelegatedCli: runClaudeDelegated },
};
