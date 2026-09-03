const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENV_SESSION_KEYS = ["TASKCENTER_CALLER_SESSION_ID", "CODEX_SESSION_ID", "CODEX_THREAD_ID"];

function normalizeSessionId(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function resolveTrustedMcpSession(extra, env = process.env) {
  const metadata = extra?._meta;
  const hasThreadId = metadata !== null
    && typeof metadata === "object"
    && Object.hasOwn(metadata, "threadId");
  const metadataSessionId = hasThreadId ? normalizeSessionId(metadata.threadId) : "";
  const environmentSessionIds = ENV_SESSION_KEYS
    .map((key) => normalizeSessionId(env[key]))
    .filter(Boolean);
  const uniqueEnvironmentSessionIds = [...new Set(environmentSessionIds)];

  if (hasThreadId && !UUID_PATTERN.test(metadataSessionId)) {
    return {
      error: "TASKCENTER_SESSION_CONTEXT_INVALID",
      message: "Codex MCP 请求中的可信 threadId 不是有效 UUID。",
    };
  }
  if (uniqueEnvironmentSessionIds.some((sessionId) => !UUID_PATTERN.test(sessionId))) {
    return {
      error: "TASKCENTER_SESSION_CONTEXT_INVALID",
      message: "MCP 运行时注入的 Session ID 不是有效 UUID。",
    };
  }
  if (uniqueEnvironmentSessionIds.length > 1) {
    return {
      error: "TASKCENTER_SESSION_CONTEXT_MISMATCH",
      message: "MCP 运行时注入了相互冲突的 Session ID。",
    };
  }

  const environmentSessionId = uniqueEnvironmentSessionIds[0] || "";
  if (metadataSessionId && environmentSessionId && metadataSessionId !== environmentSessionId) {
    return {
      error: "TASKCENTER_SESSION_CONTEXT_MISMATCH",
      message: "Codex MCP 请求 threadId 与运行时 Session ID 不一致。",
    };
  }

  const sessionId = metadataSessionId || environmentSessionId;
  return sessionId
    ? { sessionId }
    : {
        error: "TASKCENTER_SESSION_CONTEXT_UNAVAILABLE",
        message: "MCP 运行时没有可信的当前 Codex Session ID。",
      };
}
