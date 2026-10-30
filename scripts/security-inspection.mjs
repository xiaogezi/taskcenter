import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { isTrustedCliEntry } from "./trusted-cli-identity.mjs";

export function isReadOnlySecurity(tokens) {
  if (process.platform !== "darwin") return false;
  const entry = tokens[0] === "security"
    ? (process.env.PATH || "").split(delimiter).map(dir => join(dir, "security")).find(path => existsSync(path))
    : tokens[0];
  if (!isTrustedCliEntry(entry, { installed: "/usr/bin/security", aliases: [] })) return false;
  if (tokens.length === 5 && ["find-identity", "-v", "-p", "codesigning"].every((arg, index) => tokens[index + 1] === arg)) return true;
  if (tokens.length === 6 && ["find-identity", "-v", "-p", "codesigning", "/Library/Keychains/System.keychain"].every((arg, index) => tokens[index + 1] === arg)) return true;
  if (tokens.length === 4 && tokens[1] === "list-keychains" && tokens[2] === "-d" && tokens[3] === "user") return true;
  if (tokens.length !== 5 || tokens[1] !== "cms" || tokens[2] !== "-D" || tokens[3] !== "-i") return false;
  const path = tokens[4];
  if (!isAbsolute(path) || path !== resolve(path) || !path.endsWith(".mobileprovision") || /[\x00-\x1f]/.test(path)) return false;
  const directories = ["Library/Developer/Xcode/UserData/Provisioning Profiles", "Library/MobileDevice/Provisioning Profiles"];
  const directory = directories.find(dir => dirname(path) === join(homedir(), dir));
  if (!directory) return false;
  try {
    // Resolve the home alias, but reject symlinks within the profile path.
    return realpathSync(path) === join(realpathSync(homedir()), directory, basename(path)) && statSync(path).isFile();
  } catch { return false; }
}
