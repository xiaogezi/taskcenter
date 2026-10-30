import { homedir } from "node:os";
import { join } from "node:path";
import { isTrustedCliEntry } from "./trusted-cli-identity.mjs";

// Reviewed local environment-only launcher; replacements require re-auditing.
export const juggEnvironmentSha256 = "0554f93000efb6136673a36b1e5b0594ee32529286edf7d951ffddb0cd82aa1d";
export function isReadOnlyJugg(tokens, { home = homedir(), sha256 = juggEnvironmentSha256 } = {}) {
  const installed = join(home, ".local/bin/jugg-env");
  if (!isTrustedCliEntry(tokens[0], { installed, aliases: [], sha256 })) return false;
  if (!["adb", join(home, "Library/Android/sdk/platform-tools/adb")].includes(tokens[1])) return false;
  const args = tokens.slice(2);
  return args.length === 1 && ["version", "devices"].includes(args[0])
    || args.length === 2 && args[0] === "devices" && args[1] === "-l";
}
