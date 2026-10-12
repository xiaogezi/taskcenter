// Claude is observed through host-bound mainline sessions.
export const claudeAdapter = {
  id: "claude",
  client: { label: "Claude Code", hooks: true, resume: false, usage: false },
  identity: "explicit_host_binding_required",
  usageScope: "unknown",
  operations: {},
};
