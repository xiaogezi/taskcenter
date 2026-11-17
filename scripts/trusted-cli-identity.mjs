import { createHash } from "node:crypto";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { readFileSync, realpathSync, statSync } from "node:fs";

// A same-name PATH executable or replacement symlink is not an installation identity.
export function isTrustedCliEntry(entry, { installed, aliases, sha256 }) {
  if (![installed, ...aliases].includes(entry)) return false;
  try {
    const target = realpathSync(installed);
    const stat = statSync(target);
    return realpathSync(entry) === target && stat.isFile() && Boolean(stat.mode & 0o111)
      && (!sha256 || createHash("sha256").update(readFileSync(target)).digest("hex") === sha256);
  } catch { return false; }
}

// Fixed installation locations, not an arbitrary executable's basename. Homebrew
// symlinks may resolve into Cellar; the selected entry must still be the installed alias.
export function isTrustedInspectionEntry(entry, { cwd = process.cwd(), path = process.env.PATH || "" } = {}) {
  // No trusted Windows installation inventory is defined yet. Use the normal
  // task gate there rather than guessing executable identities from names.
  if (process.platform === "win32") return false;
  if (typeof entry !== "string" || !entry) return false;
  if (["command", "type", "pwd"].includes(entry)) return true; // shell builtins, never a path
  const name = basename(entry);
  const locations = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"].map(dir => join(dir, name));
  const candidates = entry.includes("/") ? [isAbsolute(entry) ? entry : resolve(cwd, entry)]
    : path.split(delimiter).map(dir => resolve(cwd, dir || ".", entry));
  // Shell PATH lookup skips non-executable files, but stops at the first executable.
  const selected = candidates.find(candidate => {
    try { const stat = statSync(candidate); return stat.isFile() && Boolean(stat.mode & 0o111); }
    catch { return false; }
  });
  return Boolean(selected && locations.some(installed => isTrustedCliEntry(selected, { installed, aliases: [] })));
}
