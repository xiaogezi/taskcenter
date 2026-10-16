import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isTrustedCliEntry } from "./trusted-cli-identity.mjs";

// Pin the audited artifact: a CLI upgrade requires rechecking its read-only branches.
const sha256 = "67e73ab4e599d2c939106835852b5fe936e1b84392f2a9dcf1d65bdbad85e303";
export function isReadOnlyDcb(tokens, { cwd, workspace, home = homedir() }) {
  const installed = join(home, ".local/share/android-ui-dcb/releases/0.4.0-alpha.1-67e73ab4e599d2c9/dcb");
  if (!isTrustedCliEntry(tokens[0], { installed, sha256, aliases: [join(home, ".local/bin/dcb"), join(home, ".codex/skills/android-ui-implement/bin/dcb")] })) return false;
  const args = tokens.slice(1);
  if (args.length === 1 && ["--version", "--help"].includes(args[0])) return true;
  const interaction = args[0] === "interaction";
  if (interaction ? !["query", "graph", "check"].includes(args[1]) : args[0] !== "doctor") return false;
  const allowed = ["--project-root", ...(interaction ? ["--interaction-map", ...(args[1] === "query" ? ["--screen", "--entity", "--state", "--direction"] : [])] : [])];
  const values = new Map();
  for (let i = interaction ? 2 : 1; i < args.length; i += 2) {
    const option = args[i], value = args[i + 1];
    if (!allowed.includes(option) || values.has(option) || !value || value.startsWith("-")) return false;
    values.set(option, value);
  }
  if (!values.has("--project-root")) return false;
  try {
    const root = realpathSync(workspace);
    const location = relative(root, realpathSync(cwd));
    if (location === ".." || location.startsWith("../") || isAbsolute(location)) return false;
    if (realpathSync(resolve(cwd, values.get("--project-root"))) !== root) return false;
    if (interaction) {
      const map = values.get("--interaction-map");
      if (!map || !isAbsolute(map) || !statSync(map).isFile()) return false;
    }
  } catch { return false; }
  if (!interaction || args[1] !== "query") return true;
  return values.has("--screen") !== values.has("--entity")
    && (!values.has("--state") || values.has("--screen"))
    && ["outgoing", "incoming"].includes(values.get("--direction"));
}
