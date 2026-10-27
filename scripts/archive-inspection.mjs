import { existsSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { isTrustedCliEntry } from "./trusted-cli-identity.mjs";

export function isReadOnlyArchive(tokens) {
  const name = basename(tokens[0]);
  if (!["unzip", "zipinfo"].includes(name)) return false;
  const entry = tokens[0] === name
    ? (process.env.PATH || "").split(delimiter).map(dir => join(dir, name)).find(path => existsSync(path))
    : tokens[0];
  if (!isTrustedCliEntry(entry, { installed: `/usr/bin/${name}`, aliases: [] })) return false;
  // Inherited Info-ZIP options can change an otherwise read-only invocation.
  if (["UNZIP", "UNZIPOPT", "ZIPINFO", "ZIPINFOOPT"].some(key => process.env[key])) return false;
  const args = tokens.slice(1);
  let zipinfo = name === "zipinfo", list = zipinfo, stdout = false;
  if (!zipinfo && args[0]?.startsWith("-Z")) {
    zipinfo = list = true;
    const options = args.shift().slice(2);
    if (options) args.unshift(`-${options}`);
  }
  while (args[0]?.startsWith("-")) {
    const options = args.shift();
    if (zipinfo) {
      if (!/^-[12smlvhtTz]+$/.test(options)) return false;
    } else {
      if (!/^-[lvpcq]+$/.test(options)) return false;
      list ||= /[lv]/.test(options);
      stdout ||= /[pc]/.test(options);
    }
  }
  if ((!list && !stdout) || (list && stdout) || !args.length || (stdout && args.length < 2)) return false;
  // Both archive names and member selectors are patterns to Info-ZIP; accept only explicit literals.
  return args.every(arg => arg && !arg.startsWith("-") && !/[\x00-\x1f*?\[\]\\]/.test(arg)
    && !/(?:^|[/\\])(?:auth\.json|\.env(?:\.[^/\\]+)?|id_rsa|id_ed25519)(?:$|[/\\])/.test(arg));
}
