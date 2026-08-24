#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reportPath = readArg("--report");
  try {
    if (!reportPath) throw new Error("缺少 --report。");
    const result = inspectManagedReport(resolve(reportPath));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.valid) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`scheduled-report-probe: ${error.message}\n`);
    process.exitCode = 2;
  }
}

export function inspectManagedReport(path) {
  return inspectManagedReportContent(readFileSync(path), path);
}

export function inspectManagedReportContent(content, path = "") {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  const begin = Buffer.from("<!-- AUTO-MANAGED-BEGIN -->");
  const end = Buffer.from("<!-- AUTO-MANAGED-END -->");
  const hashPrefix = Buffer.from("- managed_payload_sha256：");
  const beginAt = uniqueIndex(bytes, begin, "BEGIN marker");
  const endAt = uniqueIndex(bytes, end, "END marker");
  if (beginAt >= endAt) return invalid("marker_order_invalid");
  const payloadStart = beginAt + begin.length;
  const payload = bytes.subarray(payloadStart, endAt);
  const hashAt = uniqueIndex(payload, hashPrefix, "managed hash line");
  if (hashAt > 0 && payload[hashAt - 1] !== 0x0a) return invalid("hash_line_not_at_line_start");
  const lineEnd = payload.indexOf(0x0a, hashAt);
  if (lineEnd < 0) return invalid("hash_line_missing_lf");
  const hashLine = payload.subarray(hashAt, lineEnd).toString("utf8");
  const expected = hashLine.match(/\b([0-9a-f]{64})\b/)?.[1] || "";
  if (!expected) return invalid("hash_value_invalid");
  const managed = Buffer.concat([payload.subarray(0, hashAt), payload.subarray(lineEnd + 1)]);
  const actual = createHash("sha256").update(managed).digest("hex");
  return {
    valid: actual === expected,
    reason: actual === expected ? "ok" : "managed_payload_hash_mismatch",
    algorithm: "sha256-v1",
    expected,
    actual,
    report: path,
  };
}

export function repairManagedReportHash(content) {
  const value = Buffer.isBuffer(content) ? content.toString("utf8") : String(content);
  const begin = "<!-- AUTO-MANAGED-BEGIN -->";
  const end = "<!-- AUTO-MANAGED-END -->";
  const beginAt = uniqueStringIndex(value, begin, "BEGIN marker");
  const endAt = uniqueStringIndex(value, end, "END marker");
  if (beginAt >= endAt) throw new Error("marker_order_invalid");
  const payloadStart = beginAt + begin.length;
  const payload = value.slice(payloadStart, endAt);
  const matches = [...payload.matchAll(/(^|\n)(- managed_payload_sha256：[^\n]*?)([0-9a-f]{64})([^\n]*)(?=\n)/g)];
  if (matches.length !== 1) throw new Error("managed hash line missing or duplicated");
  const match = matches[0];
  const lineStart = match.index + match[1].length;
  const lineEnd = payload.indexOf("\n", lineStart);
  const managed = `${payload.slice(0, lineStart)}${payload.slice(lineEnd + 1)}`;
  const actual = createHash("sha256").update(managed).digest("hex");
  const hashAt = payloadStart + match.index + match[1].length + match[2].length;
  return `${value.slice(0, hashAt)}${actual}${value.slice(hashAt + 64)}`;
}

function uniqueIndex(haystack, needle, label) {
  const first = haystack.indexOf(needle);
  if (first < 0) throw new Error(`${label} missing`);
  if (haystack.indexOf(needle, first + needle.length) >= 0) throw new Error(`${label} duplicated`);
  return first;
}

function uniqueStringIndex(haystack, needle, label) {
  const first = haystack.indexOf(needle);
  if (first < 0) throw new Error(`${label} missing`);
  if (haystack.indexOf(needle, first + needle.length) >= 0) throw new Error(`${label} duplicated`);
  return first;
}

function invalid(reason) {
  return { valid: false, reason, algorithm: "sha256-v1", expected: "", actual: "" };
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}
