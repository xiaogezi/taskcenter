import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { listSchemaTools, schemaMetrics, checkSchemaBudget } from "../scripts/mcp-schema-budget.mjs";
import { compactSchema } from "../scripts/mcp-schema.mjs";

function expand(value, root = value) {
  if (Array.isArray(value)) return value.map(item => expand(item, root));
  if (!value || typeof value !== "object") return value;
  if (value.$ref) {
    // Kimi's router preserves only pure #/$defs/ refs; other forms expand
    // before reaching the model and can cost more than the inline schema.
    assert.match(value.$ref, /^#\/\$defs\//);
    assert.deepEqual(Object.keys(value), ["$ref"]);
    const target = root.$defs[value.$ref.split("/").at(-1)];
    assert.ok(target);
    const siblings = { ...value };
    delete siblings.$ref;
    return { ...expand(target, root), ...expand(siblings, root) };
  }
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$defs")
    .map(([key, item]) => [key, expand(item, root)]));
}

function assertStructuredObjectsAreInline(value, root = value) {
  if (Array.isArray(value)) return value.forEach(item => assertStructuredObjectsAreInline(item, root));
  if (!value || typeof value !== "object") return;
  if (value.$ref) {
    const target = root.$defs[value.$ref.split("/").at(-1)];
    assert.notEqual(target?.type, "object", "structured object references lose their fields in some hosts");
  }
  for (const [key, item] of Object.entries(value)) {
    if (key !== "$defs") assertStructuredObjectsAreInline(item, root);
  }
}

test("real tools/list: all contracts survive reference compression and stay within budget", async () => {
  const inline = await listSchemaTools("inline");
  const compact = await listSchemaTools("compact");
  assert.deepEqual(compact.map(t => t.name), inline.map(t => t.name));
  const validator = new AjvJsonSchemaValidator();
  for (let i = 0; i < inline.length; i++) {
    assertStructuredObjectsAreInline(compact[i].inputSchema);
    assert.deepEqual({ ...compact[i], inputSchema: expand(compact[i].inputSchema) }, inline[i], inline[i].name);
    // Compile every advertised schema with the MCP SDK's actual validator.
    validator.getValidator(compact[i].inputSchema);
  }
  const metrics = schemaMetrics(compact);
  assert.ok(metrics.bytes < schemaMetrics(inline).bytes);
  const budget = JSON.parse(readFileSync(new URL("../config/mcp-schema-budget.json", import.meta.url), "utf8"));
  const report = checkSchemaBudget(metrics, budget);
  console.log(report.message);
  assert.equal(report.failed, false, report.message);
  const begin = compact.find(tool => tool.name === "taskcenter_task_begin");
  const verificationItems = begin.inputSchema.properties.verification_plan.items;
  assert.deepEqual(Object.keys(verificationItems.properties), ["id", "title", "kind", "required", "suggested_command"]);
  const inflated = structuredClone(compact);
  inflated[0].description += "schema growth ".repeat(Math.ceil(budget.max_bytes / 14));
  const rejected = checkSchemaBudget(schemaMetrics(inflated), budget);
  assert.equal(rejected.failed, true);
  assert.match(rejected.message, /Action:/);
  assert.ok(rejected.message.includes(inflated[0].name));
  assert.equal(checkSchemaBudget({ ...metrics, bytes: budget.warn_bytes + 1 }, budget).warning, true);
  assert.equal(checkSchemaBudget({ ...metrics, tokens: budget.max_tokens + 1 }, budget).failed, true);
});

test("schema compaction preserves literal data and existing reference scopes", () => {
  const property = { type: "string", description: "Repeated long property description ".repeat(8) };
  const schema = { type: "object", properties: { a: property, b: property, $ref: property },
    default: { $ref: "literal", definitions: { untouched: true } } };
  const compact = compactSchema(schema);
  assert.deepEqual(compact.default, schema.default);
  for (const value of Object.values(compact.properties)) assert.deepEqual(expand(value, compact), property);
  const recursive = { type: "object", properties: { child: { $ref: "#" } } };
  assert.deepEqual(compactSchema(recursive), recursive);
});

test("compact discovery keeps successful calls and strict input rejection", async () => {
  const client = new Client({ name: "schema-compat", version: "1.0.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: ["scripts/taskcenter-mcp.mjs"], env: { TASKCENTER_MCP_SCHEMA_MODE: "compact" }, stderr: "pipe" }));
    const result = await client.callTool({ name: "taskcenter_agent_capabilities", arguments: { agent: "codex" } });
    assert.notEqual(result.isError, true);
    assert.ok(JSON.parse(result.content[0].text).clients.length);
    const invalid = await client.callTool({ name: "taskcenter_agent_capabilities", arguments: { agent: "codex", injected: true } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); }
});
