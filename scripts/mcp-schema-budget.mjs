import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { getEncoding } from "js-tiktoken";

const root = fileURLToPath(new URL("../", import.meta.url));
const encoding = getEncoding("o200k_base");
export async function listSchemaTools(mode = "compact") {
  const client = new Client({ name: "schema-budget", version: "1.0.0" });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [resolve(root, "scripts/taskcenter-mcp.mjs")],
      cwd: root, env: { TASKCENTER_MCP_SCHEMA_MODE: mode }, stderr: "pipe",
    }));
    return (await client.listTools()).tools;
  } finally { await client.close(); }
}

export function schemaMetrics(tools) {
  return {
    bytes: Buffer.byteLength(JSON.stringify(tools)),
    tokens: encoding.encode(JSON.stringify(tools)).length,
    tools: Object.fromEntries(tools.map(tool => [tool.name, Buffer.byteLength(JSON.stringify(tool))])),
  };
}

export function checkSchemaBudget(metrics, budget) {
  const growth = metrics.bytes - budget.baseline.bytes;
  const largest = Object.entries(metrics.tools).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const increased = Object.entries(metrics.tools).map(([name, size]) => [name, size - (budget.baseline.tools[name] || 0)])
    .filter(([, delta]) => delta > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const toolCount = Object.keys(metrics.tools).length;
  const failed = toolCount > budget.max_tools || metrics.bytes > budget.max_bytes || metrics.tokens > budget.max_tokens;
  const warning = metrics.bytes > budget.warn_bytes || metrics.tokens > budget.warn_tokens;
  return {
    failed, warning,
    message: `${failed ? "FAIL" : warning ? "WARN" : "PASS"} MCP schema: ${toolCount}/${budget.max_tools} tools; ${metrics.bytes} bytes; baseline ${budget.baseline.bytes}; delta ${growth >= 0 ? "+" : ""}${growth}; warning ${budget.warn_bytes}; limit ${budget.max_bytes}\n`
      + `Largest: ${largest.map(([name, size]) => `${name}=${size}`).join(", ")}\n`
      + `Growth: ${increased.map(([name, delta]) => `${name}=+${delta}`).join(", ") || "none"}`
      + `\no200k_base tokens: ${metrics.tokens}; baseline ${budget.baseline.tokens}; delta ${metrics.tokens - budget.baseline.tokens}; warning ${budget.warn_tokens}; limit ${budget.max_tokens}`
      + (warning || failed ? "\nAction: avoid adding tools for existing capabilities; inspect repeated schemas and descriptions; preserve validators and call contracts. Do not auto-refresh the baseline; document any necessary budget increase and compatibility evidence." : ""),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const budget = JSON.parse(readFileSync(new URL("../config/mcp-schema-budget.json", import.meta.url), "utf8"));
  const report = checkSchemaBudget(schemaMetrics(await listSchemaTools()), budget);
  console.log(report.message);
  if (report.failed) process.exitCode = 1;
}
