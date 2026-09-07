const taskId = "[A-Za-z0-9._-]+";

export function isAllowedControlPath(pathname) {
  return new RegExp(`^/tasks(?:/${taskId}(?:/events)?)?$`).test(pathname);
}

export function controlProxyTarget(pathname, search = "") {
  if (!isAllowedControlPath(pathname)) return null;
  const params = new URLSearchParams(search);
  const target = new URL(`http://127.0.0.1:3001${pathname}`);
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
