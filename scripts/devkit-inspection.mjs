import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isTrustedCliEntry } from "./trusted-cli-identity.mjs";

// Only the reviewed uv installation is trusted; PATH and arbitrary same-name scripts are not.
export function isReadOnlyDevKit(tokens, { cwd, workspace, home = homedir() }) {
  if (!["env", "/usr/bin/env"].includes(tokens[0]) || tokens[1] !== "PYTHONDONTWRITEBYTECODE=1") return false;
  const installed = join(home, ".local/share/uv/tools/devkit-assets/bin/dev-kit");
  if (!isTrustedCliEntry(tokens[2], { installed, aliases: [join(home, ".local/bin/dev-kit")] })) return false;
  let root;
  try {
    root = realpathSync(workspace);
    const location = relative(root, realpathSync(cwd));
    if (location === ".." || location.startsWith("../") || isAbsolute(location)) return false;
  } catch { return false; }
  const args = tokens.slice(3);
  let action, start;
  if (args[0] === "doctor") { action = "doctor"; start = 1; }
  else if (args[0] === "asset" && args[1] === "status") { action = "status"; start = 2; }
  else if (args[0] === "asset" && args[1] === "capture" && args[2] === "preview") { action = "preview"; start = 3; }
  else return false;
  const values = new Map();
  const flags = new Set();
  const scopes = [];
  for (let i = start; i < args.length; i++) {
    const token = args[i];
    if (action === "preview" && ["--baseline", "--all-sources"].includes(token)) {
      if (flags.has(token)) return false;
      flags.add(token);
      continue;
    }
    const separator = token.indexOf("=");
    const option = separator < 0 ? token : token.slice(0, separator);
    const allowed = ["--repo", "--format", ...(action !== "doctor" ? ["--base"] : []), ...(action === "preview" ? ["--check", "--scope"] : [])];
    if (!allowed.includes(option) || (values.has(option) && option !== "--scope")) return false;
    const value = separator < 0 ? args[++i] : token.slice(separator + 1);
    if (!value || value.startsWith("-")) return false;
    if (option === "--format" && !["json", "text"].includes(value)) return false;
    if (option === "--check" && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) return false;
    if (option === "--base" && (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(value) || value.includes(".."))) return false;
    if (option === "--scope") {
      if (isAbsolute(value) || value.split(/[\\/]/).includes("..")) return false;
      try {
        const scope = relative(root, realpathSync(resolve(root, value)));
        if (!scope || scope === ".." || scope.startsWith("../") || isAbsolute(scope)) return false;
      } catch { return false; }
      scopes.push(value);
    }
    values.set(option, value);
  }
  if (!values.has("--repo")) return false;
  try { if (realpathSync(resolve(cwd, values.get("--repo"))) !== root) return false; }
  catch { return false; }
  if (action !== "preview") return true;
  if (flags.has("--baseline")) return !values.has("--base") && (flags.has("--all-sources") || scopes.length > 0);
  return values.has("--base") && !flags.has("--all-sources") && scopes.length === 0;
}
