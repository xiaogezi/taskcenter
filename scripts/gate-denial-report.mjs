#!/usr/bin/env node
// Offline, read-only report. Exclusions must be explicit, confirmed fixture IDs;
// never infer test traffic from ID prefixes or remove the original audit trail.
import { readGateDenials } from "./governance-metrics.mjs";
import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function summarizeGateDenials(events, { since, until, excludeSessions = [] } = {}) {
  const start = Date.parse(since), end = Date.parse(until);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error("since/until must define an explicit time window");
  const excludedIds = new Set(excludeSessions);
  if ([...excludedIds].some(id => typeof id !== "string" || !id.trim())) throw new Error("excluded Session IDs must be non-empty exact values");
  let total = 0, excluded = 0;
  const categories = {};
  for (const event of events) {
    const at = Date.parse(event.at);
    if (!Number.isFinite(at) || at < start || at >= end) continue;
    total++;
    if (excludedIds.has(event.session_id)) { excluded++; continue; }
    const category = typeof event.category === "string" ? event.category : "gate_other";
    Object.defineProperty(categories, category, { value: (Object.hasOwn(categories, category) ? categories[category] : 0) + 1, enumerable: true, configurable: true });
  }
  return { since: new Date(start).toISOString(), until: new Date(end).toISOString(), total, excluded, included: total - excluded, categories,
    excluded_session_ids: [...excludedIds], exclusion_basis: "operator-confirmed exact Session IDs; original audit unchanged" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), options = { excludeSessions: [] };
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i], value = args[i + 1];
      if (!value || !["--path", "--since", "--until", "--exclude-session"].includes(key)) throw new Error("usage: --path FILE --since ISO --until ISO [--exclude-session CONFIRMED_ID]");
      if (key === "--exclude-session") options.excludeSessions.push(value);
      else options[key.slice(2)] = value;
    }
    if (!options.path) throw new Error("explicit --path required");
    if (!statSync(options.path).isFile()) throw new Error("audit path must be a file");
    console.log(JSON.stringify(summarizeGateDenials(readGateDenials(options.path), options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
