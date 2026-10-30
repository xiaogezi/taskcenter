import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { isTrustedCliEntry } from "./trusted-cli-identity.mjs";
import { inspectionBatch } from "./inspection-command.mjs";
import { isTrustedSystemQuery } from "./network-inspection.mjs";

const root = "/Users/instory/Services/instory-lan";
const directories = [root, ...["src", "src/instory", "src/instory-admin", "releases", "launch", "run"].map(path => `${root}/${path}`)];
const repos = ["instory", "instory-admin"].map(name => `${root}/src/${name}`);

// SSH joins argv into a remote shell command: validate that exact text, not only local argv.
export function isReadOnlySsh(tokens, context = {}) {
  if (isLegacyReadOnlySsh(tokens)) return true;
  if (!context.inspectRemote || !isTrustedSystemQuery(tokens[0], "ssh")) return false;
  const home = context.home || homedir();
  const options = new Set();
  let index = 1, noConfig = false, batchMode = false, strict = false, timeout = false;
  while (tokens[index]?.startsWith("-")) {
    const option = tokens[index++];
    if (["-n", "-T"].includes(option)) continue;
    if (["-i", "-F"].includes(option)) {
      if (options.has(option)) return false;
      options.add(option);
      const value = tokens[index++];
      if (option === "-F") { if (value !== "/dev/null") return false; noConfig = true; }
      else if (!value?.startsWith(`${home}/.ssh/`) || /[\x00-\x20]/.test(value) || value.split("/").includes("..")) return false;
      continue;
    }
    if (option !== "-o") return false;
    const value = tokens[index++];
    const key = value?.split("=")[0];
    if (options.has(key)) return false;
    options.add(key);
    if (value === "BatchMode=yes") batchMode = true;
    else if (value === "StrictHostKeyChecking=yes") strict = true;
    else if (/^ConnectTimeout=\d{1,2}$/.test(value) && Number(value.split("=")[1]) >= 1 && Number(value.split("=")[1]) <= 30) timeout = true;
    else if (value !== "IdentitiesOnly=yes") return false;
  }
  if (!batchMode || !strict || !timeout || (!noConfig && existsSync(join(home, ".ssh/config")))) return false;
  if (!/^[A-Za-z0-9_.-]+@[A-Za-z0-9][A-Za-z0-9.-]*$/.test(tokens[index++] || "")) return false;
  // Validate the text SSH actually gives the remote shell, including every batch member.
  const commands = inspectionBatch(tokens.slice(index).join(" "));
  return Boolean(commands?.every(command => !command.heredoc && context.inspectRemote(command.words)));
}

function isLegacyReadOnlySsh(tokens) {
  const entry = tokens[0] === "ssh"
    ? (process.env.PATH || "").split(delimiter).map(dir => join(dir, "ssh")).find(path => existsSync(path))
    : tokens[0];
  if (!isTrustedCliEntry(entry, { installed: "/usr/bin/ssh", aliases: [] })) return false;
  if (tokens.length === 2 && tokens[1] === "-V") return true;
  const options = new Set();
  let index = 1;
  while (tokens[index]?.startsWith("-")) {
    const option = tokens[index++];
    if (["-n", "-T"].includes(option)) {
      if (options.has(option)) return false;
      options.add(option);
      continue;
    }
    if (option !== "-o") return false;
    const value = tokens[index++];
    if (!["BatchMode=yes", "ConnectTimeout=10", "StrictHostKeyChecking=yes"].includes(value) || options.has(value)) return false;
    options.add(value);
  }
  if (!options.has("BatchMode=yes") || !options.has("ConnectTimeout=10") || tokens[index++] !== "instory@instoryMacmini.local") return false;
  const text = tokens.slice(index).join(" ");
  // Fixed container projections contain braces but cannot contain shell input.
  if (/^(?:docker|\/usr\/local\/bin\/docker|\/opt\/homebrew\/bin\/docker) ps(?: -a)? --format=\{\{\.(?:Names|Status|Ports)\}\}$/.test(text)) return true;
  if (!text || !/^[A-Za-z0-9_./:=, -]+$/.test(text)) return false;
  const words = text.split(/ +/);
  const command = words.shift();
  const same = args => words.length === args.length && words.every((word, i) => word === args[i]);
  if (["hostname", "/bin/hostname", "uptime", "/usr/bin/uptime"].includes(command)) return words.length === 0;
  if (["ps", "/bin/ps"].includes(command)) return same(["-axo", "pid,ppid,comm"]);
  if (["pgrep", "/usr/bin/pgrep"].includes(command)) return words.length === 2 && words[0] === "-x" && ["instory", "instory-admin"].includes(words[1]);
  if (["ls", "/bin/ls"].includes(command)) {
    if (["-l", "-la", "-ld"].includes(words[0])) words.shift();
    return words.length > 0 && words.length <= directories.length && words.every(path => directories.includes(path.replace(/\/$/, "")));
  }
  if (["git", "/usr/bin/git"].includes(command)) {
    // Status must not refresh the index or execute a repository's fsmonitor hook.
    if (words[0] !== "--no-optional-locks" || words[1] !== "-c" || words[2] !== "core.fsmonitor=false" || words[3] !== "-C" || !repos.includes(words[4])) return false;
    words.splice(0, 5);
    return same(["status", "--short"]) || same(["rev-parse", "HEAD"]);
  }
  if (["curl", "/usr/bin/curl"].includes(command)) {
    return words.length === 4 && words[0] === "-q" && words[1] === "--max-time" && words[2] === "10"
      && /^http:\/\/127\.0\.0\.1:850[01]\/(?:healthz|readyz)$/.test(words[3]);
  }
  return false;
}
