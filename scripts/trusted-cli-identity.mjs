import { createHash } from "node:crypto";
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
