const taskId = "[A-Za-z0-9._-]+";
const reflectionId = "[A-Za-z0-9._-]+";
const readPaths = new Set(["/health", "/usage-report", "/session-selection", "/gate-session-allowlist", "/session-status", "/gate-denials", "/reflections", "/dispatches", "/context-management-pilots", "/governance-metrics", "/reconciliation"]);
const writePaths = new Set(["/sync", "/session-selection", "/gate-session-allowlist", "/gate-session-allowlist/session", "/reflections/run"]);

export function isAllowedControlPath(pathname, method = "GET") {
  if (method === "GET" && ["/ai/activity", "/ai/snapshot"].includes(pathname)) return true;
  if (method === "POST" && ["/ai/analyze", "/ai/work"].includes(pathname)) return true;
  if (method === "GET") return readPaths.has(pathname) || pathname === "/session-lifecycle" || new RegExp(`^/tasks(?:/${taskId}(?:/events)?)?$`).test(pathname);
  if (method === "POST") return writePaths.has(pathname) || new RegExp(`^/tasks/${taskId}/actions$`).test(pathname) || new RegExp(`^/reflections/${reflectionId}/actions$`).test(pathname);
  return false;
}

export function controlProxyTarget(pathname, search = "", method = "GET") {
  if (!isAllowedControlPath(pathname, method)) return null;
  const params = new URLSearchParams(search);
  const configuredPort = Number(process.env.TASKCENTER_CONTROL_PORT || 3001);
  if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65535) return null;
  const target = new URL(`http://127.0.0.1:${configuredPort}${pathname}`);
  if (pathname.startsWith("/ai/")) {
    for (const key of ["task_id", "kind", "source", "before", "limit"]) {
      const value = params.get(key);
      if (value !== null) target.searchParams.set(key, value);
    }
  } else if (pathname === "/tasks") {
    for (const key of ["view", "project", "bucket", "query", "page", "page_size"]) {
      const value = params.get(key);
      if (value !== null) target.searchParams.set(key, value);
    }
  } else if (pathname.endsWith("/events") || pathname === "/gate-denials") {
    const limit = params.get("limit");
    if (limit !== null) target.searchParams.set("limit", limit);
  }
  return target;
}

// Do not trust forwarded headers: this proxy carries local Control API authority.
export function isLocalControlRequest(request, { requireOrigin = false } = {}) {
  try {
    const url = new URL(request.url);
    const host = request.headers.get("host");
    if (!["http:", "https:"].includes(url.protocol) || !host || host !== url.host) return false;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return false;
    const origin = request.headers.get("origin");
    if (origin === null) return !requireOrigin;
    return origin === url.origin;
  } catch { return false; }
}
