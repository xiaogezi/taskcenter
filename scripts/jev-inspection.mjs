import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isTrustedCliEntry } from "./trusted-cli-identity.mjs";

// Reviewed report branch and its entire local import graph; upgrades require re-audit.
export const jevReportArtifacts = {
  "scripts/jev-decision.mjs": "8d35625e727d1075933dfdd46efb50d1d69c07dc4c2516f8b4df3003e7a29031",
  "mcp/client/jev-decisions.mjs": "d5a265bab61789fdd1d6622069ad3eae4e8b5e1e602c999bba5a19f416b98a70",
  "mcp/runtime/file-lease.mjs": "501822e9946d7da2e08adf5b4333e24328d3033dbbbede20b7a621b4fa95c12f",
  "mcp/runtime/path-safety.mjs": "620c396fcc7ca41dfb6c289e8e0b2b57b2c476c52104630ae587b0c95b2310cd",
};

export function isReadOnlyJev(tokens, { home = homedir(), env = process.env, artifacts = jevReportArtifacts } = {}) {
  if (env.NODE_OPTIONS || env.NODE_PATH) return false;
  const root = join(home, "Documents/project/ProjectContextAgent");
  const installed = join(root, "scripts/jev-decision.mjs");
  if (!isTrustedCliEntry(tokens[0], { installed, aliases: [join(home, ".local/bin/jev-decision")], sha256: artifacts["scripts/jev-decision.mjs"] })) return false;
  if (tokens[1] !== "report" || tokens.length < 2 || tokens.length > 3
    || tokens.length === 3 && !/^[A-Za-z0-9_:.-]{1,160}$/.test(tokens[2])
    || tokens[2]?.startsWith("-")) return false;
  try {
    const canonicalRoot = realpathSync(root);
    return Object.entries(artifacts).every(([path, hash]) => realpathSync(join(root, path)) === join(canonicalRoot, path)
      && createHash("sha256").update(readFileSync(join(root, path))).digest("hex") === hash);
  } catch { return false; }
}
