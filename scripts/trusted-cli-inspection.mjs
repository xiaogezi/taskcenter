import { basename } from "node:path";
import { isReadOnlyDevKit } from "./devkit-inspection.mjs";
import { isReadOnlyDcb } from "./dcb-inspection.mjs";
import { isReadOnlyAws } from "./aws-inspection.mjs";
import { isReadOnlySsh } from "./ssh-inspection.mjs";
import { isReadOnlySecurity } from "./security-inspection.mjs";
import { isReadOnlyArchive } from "./archive-inspection.mjs";

// Adapters audit identity and exact arguments; unknown CLIs keep the existing L0 rules.
const adapters = { "dev-kit": isReadOnlyDevKit, dcb: isReadOnlyDcb, aws: isReadOnlyAws, ssh: isReadOnlySsh, security: isReadOnlySecurity, unzip: isReadOnlyArchive, zipinfo: isReadOnlyArchive };
export function inspectTrustedCli(words, context) {
  const tokens = [...words];
  let validWrapper = true;
  if (basename(tokens[0]) === "rtk") {
    validWrapper = ["rtk", "/opt/homebrew/bin/rtk"].includes(tokens.shift()) && tokens[0] === "proxy";
    if (tokens[0] === "proxy") tokens.shift();
  }
  const entry = ["env", "/usr/bin/env"].includes(tokens[0]) ? tokens[2] : tokens[0];
  const name = basename(entry || "");
  const adapter = Object.hasOwn(adapters, name) ? adapters[name] : null;
  return adapter ? validWrapper && adapter(tokens, context) : null;
}
