import assert from "node:assert/strict";
import test from "node:test";
import { summarizeGateDenials } from "../scripts/gate-denial-report.mjs";

test("historical report excludes only confirmed Session in explicit half-open window", () => {
  const options = { since: "2026-11-17T00:00:00+08:00", until: "2026-11-18T00:00:00+08:00", excludeSessions: ["fixture-id"] };
  const events = [
    { at: options.since, session_id: "fixture-id", category: "scheduled_readonly" },
    { at: options.since, session_id: "test-looking-real", category: "scheduled_readonly" },
    { at: options.until, session_id: "fixture-id", category: "gate_other" },
  ];
  const original = JSON.stringify(events);
  const result = summarizeGateDenials(events, options);
  assert.equal(result.total, 2); assert.equal(result.included, 1); assert.equal(result.excluded, 1);
  assert.deepEqual(result.categories, { scheduled_readonly: 1 });
  assert.equal(JSON.stringify(events), original);
  assert.equal(summarizeGateDenials(events, { ...options, excludeSessions: [] }).included, 2);
  assert.throws(() => summarizeGateDenials(events), /explicit time window/);
});
