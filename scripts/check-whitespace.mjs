#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const base = process.env.BASE_SHA || "";
const emptyTree = git(["hash-object", "-t", "tree", "--stdin"], { input: "" }).stdout.trim();
const validBase = base
  && !/^0+$/.test(base)
  && gitOk(["cat-file", "-e", `${base}^{commit}`])
  && gitOk(["merge-base", base, "HEAD"]);
const range = validBase ? `${base}...HEAD` : emptyTree;
const result = spawnSync("git", ["diff", "--check", range, ...(validBase ? [] : ["HEAD"])], {
  encoding: "utf8",
  stdio: ["ignore", "inherit", "inherit"],
});
process.exitCode = result.status ?? 1;

function gitOk(args) {
  return spawnSync("git", args, { stdio: "ignore" }).status === 0;
}

function git(args, options = {}) {
  const result = spawnSync("git", args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} 失败`);
  return result;
}
