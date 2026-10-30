import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { isTrustedCliEntry } from "./trusted-cli-identity.mjs";

export function isTrustedSystemQuery(entry, name, installed = `/usr/bin/${name}`) {
  const resolved = entry === name
    ? (process.env.PATH || "").split(delimiter).map(dir => join(dir, name)).find(path => existsSync(path))
    : entry;
  return isTrustedCliEntry(resolved, { installed, aliases: [] });
}

export function isReadOnlyCurl(tokens, { home = homedir(), env = process.env } = {}) {
  if (!isTrustedSystemQuery(tokens[0], "curl") || env.SSLKEYLOGFILE) return false;
  const args = tokens.slice(1);
  const noConfig = ["-q", "--disable"].includes(args[0]);
  // Do not read personal configuration: its mere presence requires explicit -q.
  if (!noConfig && [join(home, ".curlrc"), ...(env.CURL_HOME ? [join(env.CURL_HOME, ".curlrc")] : []),
    join(env.XDG_CONFIG_HOME || join(home, ".config"), "curlrc")].some(path => existsSync(path))) return false;
  const urls = [];
  for (let i = noConfig ? 1 : 0; i < args.length; i++) {
    const arg = args[i];
    if (/^-[fsSIL]+$/.test(arg)) continue;
    if (["--fail", "--silent", "--show-error", "--head", "--location"].includes(arg)) continue;
    if (["--max-time", "--connect-timeout"].includes(arg)) {
      if (!/^\d+(?:\.\d+)?$/.test(args[++i] || "") || Number(args[i]) <= 0 || Number(args[i]) > 60) return false;
    } else if (arg === "--noproxy") {
      if (!/^[A-Za-z0-9.*,:_-]+$/.test(args[++i] || "")) return false;
    } else if (["--proto", "--proto-redir"].includes(arg)) {
      if (!["=https", "=http,https", "=https,http"].includes(args[++i])) return false;
    } else if (arg.startsWith("-")) return false;
    else {
      try {
        const url = new URL(arg);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || /[\x00-\x20{}\[\]\\]/.test(arg)) return false;
      } catch { return false; }
      urls.push(arg);
    }
  }
  // No files, request bodies, cookies, auth, local protocols or output files.
  return urls.length === 1;
}

export function isReadOnlyBrew(tokens) {
  const name = tokens[0] === "brew" ? "/opt/homebrew/bin/brew" : tokens[0];
  if (tokens[0] === "brew") {
    const resolved = (process.env.PATH || "").split(delimiter).map(dir => join(dir, "brew")).find(path => existsSync(path));
    if (resolved !== name) return false;
  }
  if (!isTrustedCliEntry(name, { installed: "/opt/homebrew/bin/brew", aliases: [] })) return false;
  const [command, ...args] = tokens.slice(1);
  // These built-in commands do not enter Homebrew's install/update dispatch.
  if (["--version", "config", "--prefix", "--cellar"].includes(command)) return args.length === 0;
  const flags = command === "info" ? ["--formula", "--cask", "--json", "--json=v1", "--json=v2", "--installed", "-v", "--verbose"]
    : command === "search" ? ["--formula", "--cask", "--desc"]
      : command === "list" ? ["--formula", "--cask", "--versions", "-1"] : null;
  if (!flags) return false;
  return (command !== "search" || args.some(arg => !arg.startsWith("-"))) && args.every(arg => flags.includes(arg) || /^[A-Za-z0-9][A-Za-z0-9+_.@-]*$/.test(arg));
}

export function isReadOnlyNc(tokens) {
  if (!isTrustedSystemQuery(tokens[0], "nc")) return false;
  const args = tokens.slice(1);
  let zeroIo = false, timeout = false, i = 0;
  while (args[i]?.startsWith("-")) {
    const arg = args[i++];
    if (/^-[vz]+$/.test(arg)) { zeroIo ||= arg.includes("z"); continue; }
    if (!["-G", "-w"].includes(arg) || !/^\d{1,2}$/.test(args[i] || "") || Number(args[i]) < 1 || Number(args[i]) > 30) return false;
    timeout = true; i++;
  }
  return zeroIo && timeout && args.length === i + 2 && /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(args[i])
    && /^\d{1,5}$/.test(args[i + 1]) && Number(args[i + 1]) > 0 && Number(args[i + 1]) <= 65535;
}
