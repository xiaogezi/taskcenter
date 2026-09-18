// Hook/MCP integration is available; active session control has not been adapted.
export const claudeAdapter = {
  id: "claude",
  client: { label: "Claude Code", hooks: true, resume: false, usage: false },
  identity: "explicit_host_binding_required",
  usageScope: "unknown",
  operations: {},
};
