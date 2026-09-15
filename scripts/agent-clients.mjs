// TaskCenter integration support, not vendor features or authorization grants.
export const AGENT_CLIENTS = Object.freeze({
  codex: { label: "Codex", hooks: true, resume: true, usage: true },
  claude: { label: "Claude Code", hooks: true, resume: false, usage: false },
  workbuddy: { label: "WorkBuddy", hooks: false, resume: false, usage: false },
  kimi: { label: "Kimi Code CLI", hooks: true, resume: true, usage: true, integration_mode: "managed_acp", usage_scope: "context_snapshot", native_hooks_require_configuration: true },
  unknown: { label: "Unknown", hooks: false, resume: false, usage: false },
});
export const AGENT_IDS = Object.keys(AGENT_CLIENTS);

export function agentCapabilities(agent) {
  return {
    agent,
    ...AGENT_CLIENTS[agent],
    task_protocol: true,
    trusted_identity: agent === "codex" ? "host_metadata_or_environment" : "explicit_host_binding_required",
  };
}
