#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export const ALGORITHM = "artifact-size/v1";
const outputMetrics = ["client_bytes", "client_gzip_bytes", "largest_js_bytes", "server_bytes"];
const buildMetrics = [...outputMetrics, "development_dependency_bytes"];
const releaseMetrics = [...outputMetrics, "production_dependency_bytes", "release_bytes"];
export const FORBIDDEN_PACKAGES = ["@openai/codex-sdk", "@openai/codex", "@cloudflare/vite-plugin", "@cloudflare/workerd", "wrangler", "workerd", "miniflare", "next", "@next/swc", "drizzle-orm", "drizzle-kit"];
const developmentCachePaths = [".package-lock.json", ".vite", ".vite-temp", ".cache"];
const hash = value => createHash("sha256").update(value).digest("hex");
const json = path => JSON.parse(readFileSync(path, "utf8"));
const sum = files => files.reduce((total, file) => total + file.bytes, 0);
function fail(message) { throw new Error(`ARTIFACT_MEASUREMENT: ${message}`); }

// Hard links count per path. Symlink targets count once; escaping and cyclic links fail.
export function scanTree(root, excluded = new Set()) {
  root = realpathSync(root);
  const files = [], seen = new Set();
  function visit(path, ancestors = new Set()) {
    const actual = realpathSync(path);
    if (actual !== root && !actual.startsWith(root + sep)) fail(`escaping link: ${path}`);
    const stat = lstatSync(actual);
    if (ancestors.has(actual)) fail(`cyclic link: ${path}`);
    if (seen.has(actual)) return;
    seen.add(actual);
    if (stat.isDirectory()) {
      const next = new Set([...ancestors, actual]);
      for (const name of readdirSync(actual).sort()) {
        if (excluded.has(relative(root, join(actual, name)).split(sep).join("/"))) continue;
        visit(join(actual, name), next);
      }
    } else if (stat.isFile()) files.push({ path: relative(root, actual).split(sep).join("/"), actual, bytes: stat.size, allocated_bytes: (stat.blocks || 0) * 512 });
    else fail(`unsupported entry: ${path}`);
  }
  visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function fingerprint(files) {
  const digest = createHash("sha256");
  for (const file of files) digest.update(file.path + "\0").update(readFileSync(file.actual)).update("\0");
  return digest.digest("hex");
}

export function buildInputHash(root) {
  const inputs = ["app", "features", "lib", "public", "scripts", "package.json", "package-lock.json", "vite.config.ts", "tsconfig.json", "postcss.config.mjs"];
  const files = [];
  for (const input of inputs) {
    const path = join(root, input);
    if (!existsSync(path)) continue;
    if (lstatSync(path).isDirectory()) files.push(...scanTree(path).map(file => ({ ...file, path: `${input}/${file.path}` })));
    else files.push({ path: input, actual: path });
  }
  return fingerprint(files.filter(file => !file.path.endsWith(".DS_Store")).sort((a, b) => a.path.localeCompare(b.path)));
}

function outputFiles(root) {
  const files = scanTree(join(root, "dist"), new Set([".taskcenter-build.json"]));
  if (!files.some(file => file.path.startsWith("client/") && file.path.endsWith(".js")) || !files.some(file => file.path.startsWith("server/") && file.path.endsWith(".js"))) fail("missing client/server JS output");
  return files;
}

function gitRevision(root) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

export function recordBuild(root, inputHash, revision = gitRevision(root), env = environment()) {
  if (buildInputHash(root) !== inputHash) fail("build inputs changed during build");
  const stamp = { algorithm: ALGORITHM, revision, environment: env, input_hash: inputHash, output_hash: fingerprint(outputFiles(root)), generated_at: new Date().toISOString() };
  writeFileSync(join(root, "dist", ".taskcenter-build.json"), JSON.stringify(stamp) + "\n");
  return stamp;
}

function packageName(path) { return path.split("node_modules/").at(-1); }
export function checkPackages(root, forbidden, production = false) {
  const lock = json(join(root, "package-lock.json"));
  if (!lock.packages || lock.lockfileVersion < 2) fail("lockfile packages required");
  const banned = name => forbidden.some(prefix => name === prefix || name.startsWith(prefix + "-") || name.startsWith(prefix + "/"));
  const manifest = json(join(root, "package.json"));
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const name of Object.keys(manifest[field] || {})) if (banned(name)) fail(`forbidden manifest package: ${name}`);
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (banned(entry.name || packageName(path)) || /@openai\/codex(?:-sdk)?(?:[/-]|$)/.test(entry.resolved || "")) fail(`forbidden lockfile package: ${path}`);
  }
  const files = scanTree(join(root, "node_modules"));
  for (const file of files.filter(file => file.path.endsWith("/package.json") || file.path === "package.json")) {
    const manifest = json(file.actual);
    if (banned(manifest.name || "")) fail(`forbidden installed package: ${file.path}`);
    // Only package installation roots are compared; nested package metadata is not an installed node.
    const key = `node_modules/${file.path.slice(0, -"/package.json".length)}`;
    const entry = lock.packages[key];
    if (production && entry && (entry.dev || entry.devOptional || entry.optional)) fail(`development/optional package in production: ${key}`);
    if (production && /^(?:@[^/]+\/)?[^/]+\/package\.json$/.test(file.path) && !entry) fail(`unlocked production package: ${key}`);
  }
  return files;
}

export function compareMetrics(metrics, limits, required) {
  const rows = required.map(name => {
    const limit = limits[name], measured = metrics[name];
    if (!limit || ![limit.baseline_bytes, limit.warn_bytes, limit.max_bytes, measured].every(value => Number.isSafeInteger(value) && value > 0) || limit.warn_bytes < limit.baseline_bytes || limit.max_bytes < limit.warn_bytes) fail(`invalid metric/budget: ${name}`);
    if (limit.warn_bytes !== Math.floor(limit.baseline_bytes * 1.02) || limit.max_bytes > Math.floor(limit.baseline_bytes * 1.05)) fail(`invalid cumulative thresholds: ${name}`);
    return { name, ...limit, measured_bytes: measured, delta_bytes: measured - limit.baseline_bytes, delta_percent: (measured / limit.baseline_bytes - 1) * 100, status: measured > limit.max_bytes ? "FAIL" : measured > limit.warn_bytes ? "WARN" : "PASS" };
  });
  return { rows, failed: rows.some(row => row.status === "FAIL"), warning: rows.some(row => row.status === "WARN") };
}

export function environment() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  // npm.cmd must be invoked through Node on Windows, without a shell.
  let npmVersion;
  if (process.env.npm_execpath) npmVersion = execFileSync(process.execPath, [process.env.npm_execpath, "--version"], { encoding: "utf8" }).trim();
  else if (process.platform === "win32") fail("npm_execpath required on Windows; use npm run size:check");
  else npmVersion = execFileSync(npm, ["--version"], { encoding: "utf8" }).trim();
  return { platform: process.platform, arch: process.arch, node: process.version, npm: npmVersion };
}

export function checkArtifacts({ root, mode = "build", budgetPath, expectedRevision, previousReport, env = environment() }) {
  if (!["build", "release"].includes(mode)) fail(`unknown mode: ${mode}`);
  root = resolve(root);
  const configPath = budgetPath || join(root, "config", "artifact-size-budget.json");
  const budget = json(configPath);
  if (budget.algorithm !== ALGORITHM || !Array.isArray(budget.forbidden_packages) || FORBIDDEN_PACKAGES.some(name => !budget.forbidden_packages.includes(name))) fail("invalid algorithm/forbidden policy");
  const key = `${env.platform}-${env.arch}/${env.node}/${env.npm}`;
  const profile = budget.profiles[key];
  const stamp = json(join(root, "dist", ".taskcenter-build.json"));
  const output = outputFiles(root);
  if (JSON.stringify(stamp.environment) !== JSON.stringify(env)) fail("build environment mismatch");
  if (stamp.algorithm !== ALGORITHM || stamp.input_hash !== buildInputHash(root) || stamp.output_hash !== fingerprint(output) || !Number.isFinite(Date.parse(stamp.generated_at)) || (expectedRevision && stamp.revision !== expectedRevision)) fail("stale build or revision mismatch");
  const deps = checkPackages(root, budget.forbidden_packages, mode === "release");
  const client = output.filter(file => file.path.startsWith("client/"));
  const server = output.filter(file => file.path.startsWith("server/"));
  const metrics = {
    client_bytes: sum(client),
    client_gzip_bytes: client.filter(file => /\.(js|css)$/.test(file.path)).reduce((total, file) => total + gzipSync(readFileSync(file.actual), { level: 9, mtime: 0 }).length, 0),
    largest_js_bytes: Math.max(...client.filter(file => file.path.endsWith(".js")).map(file => file.bytes)),
    server_bytes: sum(server),
  };
  if (mode === "build") metrics.development_dependency_bytes = sum(deps.filter(file => !developmentCachePaths.some(path => file.path === path || file.path.startsWith(path + "/"))));
  let releaseFiles;
  if (mode === "release") {
    metrics.production_dependency_bytes = sum(deps);
    releaseFiles = scanTree(root, new Set([".git", ".local", ".wrangler", ".taskcenter-release.json", ".taskcenter-size-report.json"]));
    metrics.release_bytes = sum(releaseFiles);
  }
  if (!profile?.baseline_revision || profile.install_strategy !== "npm ci; build; npm prune --omit=dev --omit=optional") {
    const error = new Error(`ARTIFACT_MEASUREMENT: uncalibrated environment: ${key}`);
    error.measurement = { algorithm: ALGORITHM, mode, environment: env, revision: stamp.revision, metrics, passed: false };
    throw error;
  }
  const result = compareMetrics(metrics, profile.metrics, mode === "release" ? releaseMetrics : buildMetrics);
  const report = {
    algorithm: ALGORITHM, mode, revision: stamp.revision, generated_at: new Date().toISOString(), environment: env,
    lock_hash: hash(readFileSync(join(root, "package-lock.json"))), config_hash: hash(readFileSync(configPath)),
    input_hash: stamp.input_hash, output_hash: stamp.output_hash, dependency_hash: mode === "release" ? fingerprint(deps) : undefined,
    release_hash: releaseFiles ? fingerprint(releaseFiles) : undefined, metrics, ...result,
    allocated_bytes: { output: output.reduce((n, f) => n + f.allocated_bytes, 0), dependencies: deps.reduce((n, f) => n + f.allocated_bytes, 0) },
    largest_files: [...output, ...(mode === "release" ? deps.map(f => ({ ...f, path: `node_modules/${f.path}` })) : [])].sort((a, b) => b.bytes - a.bytes).slice(0, 10).map(({ path, bytes }) => ({ path, bytes })),
    packages: Object.entries(deps.reduce((packages, file) => { const name = file.path.startsWith("@") ? file.path.split("/").slice(0, 2).join("/") : file.path.split("/")[0]; packages[name] = (packages[name] || 0) + file.bytes; return packages; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, bytes]) => ({ name, bytes, investigate: `npm explain ${name}` })),
  };
  if (previousReport) {
    if (previousReport.algorithm !== ALGORITHM || previousReport.mode !== mode || JSON.stringify(previousReport.environment) !== JSON.stringify(env)) fail("incompatible previous report");
    report.previous_deltas = Object.fromEntries(Object.entries(metrics).map(([name, bytes]) => [name, bytes - previousReport.metrics[name]]));
  }
  return report;
}

export function verifySavedReport(saved, current) {
  if (!Number.isFinite(Date.parse(saved.generated_at)) || JSON.stringify(saved.environment) !== JSON.stringify(current.environment)) fail("stale report environment/time");
  for (const key of ["algorithm", "mode", "revision", "lock_hash", "config_hash", "input_hash", "output_hash", "dependency_hash", "release_hash"]) if (saved[key] !== current[key]) fail(`stale report: ${key}`);
  if (saved.failed || current.failed || JSON.stringify(saved.metrics) !== JSON.stringify(current.metrics)) fail("stale/failed report metrics");
  return current;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const mode = args.includes("--release") ? "release" : "build";
    const rootIndex = args.indexOf("--root");
    const root = rootIndex < 0 ? resolve(dirname(fileURLToPath(import.meta.url)), "..") : resolve(args[rootIndex + 1]);
    const report = checkArtifacts({ root, mode });
    console.log(JSON.stringify(report, null, 2));
    if (report.failed) process.exitCode = 1;
  } catch (error) { if (error.measurement) console.log(JSON.stringify(error.measurement, null, 2)); console.error(error.message); process.exitCode = 1; }
}
