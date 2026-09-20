const taskId = "[A-Za-z0-9._-]+";
const reflectionId = "[A-Za-z0-9._-]+";
const readPaths = new Set(["/health", "/usage-report", "/session-selection", "/gate-session-allowlist", "/session-status", "/routing/health", "/routing/optional-astra-policy", "/reflections", "/dispatches", "/context-management-pilots", "/governance-metrics"]);
const writePaths = new Set(["/sync", "/session-selection", "/gate-session-allowlist", "/gate-session-allowlist/session", "/routing/optional-astra-policy", "/reflections/run", "/context-management-pilots/intents"]);

export function isAllowedControlPath(pathname, method = "GET") {
  if (method === "GET") return pathname === "/bug-dispatches" || readPaths.has(pathname) || pathname === "/session-lifecycle" || new RegExp(`^/tasks(?:/${taskId}(?:/events|/bug-dispatch)?)?$`).test(pathname);
  if (method === "POST") return writePaths.has(pathname) || new RegExp(`^/tasks/${taskId}/(?:actions|bug|bug-acceptance|bug-merge|bug-dispatch(?:/control)?)$`).test(pathname) || new RegExp(`^/reflections/${reflectionId}/(?:actions|execute)$`).test(pathname);
  return false;
}

export function controlProxyTarget(pathname, search = "", method = "GET") {
  if (!isAllowedControlPath(pathname, method)) return null;
  const params = new URLSearchParams(search);
  const configuredPort = Number(process.env.TASKCENTER_CONTROL_PORT || 3001);
  if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65535) return null;
  const target = new URL(`http://127.0.0.1:${configuredPort}${pathname}`);
  if (pathname === "/tasks") {
    for (const key of ["view", "project", "bucket", "query", "page", "page_size"]) {
      const value = params.get(key);
      if (value !== null) target.searchParams.set(key, value);
    }
  } else if (pathname.endsWith("/events")) {
    const limit = params.get("limit");
    if (limit !== null) target.searchParams.set("limit", limit);
  }
  return target;
}
