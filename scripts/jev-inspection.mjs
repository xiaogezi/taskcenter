import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inspectionWords } from "./inspection-command.mjs";
import { isTrustedCliEntry } from "./trusted-cli-identity.mjs";

// Reviewed report and explore branches and their local imports; upgrades require re-audit.
export const jevReportArtifacts = {
  "scripts/jev-decision.mjs": "45db7f9118f8b6aa070aa0ea685781562a24b100d6e390dd71206ccd1bc54ae3",
  "mcp/client/jev-decisions.mjs": "20bffe2c3172ddde667222641900e069a36cdf4b67aa8d609e529b35075f347c",
  "mcp/runtime/file-lease.mjs": "df69cf17507b3ea7fe924854fb88e882f1b6161e16f119040301f4a0e2cd6076",
  "mcp/runtime/path-safety.mjs": "f2c42a58f1b2148a77e56ce1d1526c2ff0b10d6e89ba42931a8afa3b4efdd7d2",
};

function trustedJevEntry(entry, { home = homedir(), env = process.env, artifacts = jevReportArtifacts } = {}) {
  if (env.NODE_OPTIONS || env.NODE_PATH) return null;
  const root = join(home, "Documents/project/ProjectContextAgent");
  const installed = join(root, "scripts/jev-decision.mjs");
  if (!isTrustedCliEntry(entry, { installed, aliases: [join(home, ".local/bin/jev-decision")], sha256: artifacts["scripts/jev-decision.mjs"] })) return null;
  try {
    const canonicalRoot = realpathSync(root);
    const match = Object.entries(artifacts).every(([path, hash]) => realpathSync(join(root, path)) === join(canonicalRoot, path)
      && createHash("sha256").update(readFileSync(join(root, path))).digest("hex") === hash);
    return match ? installed : null;
  } catch { return null; }
}

export function isReadOnlyJev(tokens, options) {
  if (tokens[1] !== "report" || tokens.length < 2 || tokens.length > 3
    || tokens.length === 3 && !/^[A-Za-z0-9_:.-]{1,160}$/.test(tokens[2])
    || tokens[2]?.startsWith("-")) return false;
  return Boolean(trustedJevEntry(tokens[0], options));
}

export function explorationCommand(command, sessionId, turnId, options) {
  if (typeof command !== "string" || Buffer.byteLength(command) > 24000) return null;
  const tokens = inspectionWords(command);
  if (!tokens) return null;
  const args = ["rtk", "/opt/homebrew/bin/rtk"].includes(tokens[0]) && tokens[1] === "proxy" ? tokens.slice(2) : tokens;
  const [entry, subcommand, payload] = args;
  if (subcommand !== "explore" || args.length !== 3) return null;
  const id = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  if (!id.test(sessionId) || !id.test(turnId)) return null;
  const installed = trustedJevEntry(entry, options);
  if (!installed) return null;
  let input;
  try { input = JSON.parse(payload); } catch { return null; }
  if (!input || typeof input !== "object" || Array.isArray(input)
    || ["session_id", "turn_id", "task_id"].some(key => Object.hasOwn(input, key))) return null;
  // The host replaces the complete command. No caller-supplied path, redirection or shell expansion survives.
  return [process.execPath, installed, "explore", sessionId, turnId, JSON.stringify(input)]
    .map(value => "'" + value.replaceAll("'", "'\"'\"'") + "'").join(" ");
}
