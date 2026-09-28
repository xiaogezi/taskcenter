import { z } from "zod";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Visit schema positions only: property names and default/example payloads are
// data, even when they happen to be named "$ref" or "properties".
function mapChildren(schema, visit) {
  const result = { ...schema };
  for (const key of ["properties", "patternProperties", "definitions", "$defs"]) {
    if (schema[key]) result[key] = Object.fromEntries(Object.entries(schema[key]).map(([name, value]) => [name, visit(value)]));
  }
  for (const key of ["items", "additionalProperties", "not", "contains", "propertyNames", "if", "then", "else"]) {
    if (schema[key] && typeof schema[key] === "object") result[key] = Array.isArray(schema[key]) ? schema[key].map(visit) : visit(schema[key]);
  }
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    if (schema[key]) result[key] = schema[key].map(visit);
  }
  return result;
}

export function compactSchema(schema) {
  // Existing reference scopes must not be moved. Current Zod inline output
  // has none; future recursive schemas safely retain their original form.
  const counts = new Map();
  let hasReferences = false;
  function count(node) {
    if (!node || typeof node !== "object") return node;
    if (node.$ref || node.$id || node.definitions || node.$defs) hasReferences = true;
    const key = JSON.stringify(node);
    counts.set(key, (counts.get(key) || 0) + 1);
    mapChildren(node, count);
    return node;
  }
  count(schema);
  if (hasReferences) return schema;
  const ids = new Map();
  const definitions = {};
  function replace(node) {
    if (!node || typeof node !== "object") return node;
    const key = JSON.stringify(node);
    const count = counts.get(key);
    if (count > 1 && (count - 1) * key.length > count * 40 + 20) {
      let id = ids.get(key);
      if (!id) {
        id = `s${ids.size}`;
        ids.set(key, id);
        definitions[id] = mapChildren(node, replace);
      }
      return { $ref: `#/definitions/${id}` };
    }
    return mapChildren(node, replace);
  }
  const result = mapChildren(schema, replace);
  if (ids.size) result.definitions = definitions;
  return JSON.stringify(result).length < JSON.stringify(schema).length ? result : schema;
}

// Only discovery is compacted. McpServer retains the original Zod validators
// and call handlers. Inline mode uses the SDK's unmodified discovery handler.
export function schemaToolRegistry(server, mode = "compact") {
  if (!["compact", "inline"].includes(mode)) throw new Error("TASKCENTER_MCP_SCHEMA_MODE must be compact or inline");
  const tools = [];
  return {
    register(name, config, handler) {
      const registered = server.registerTool(name, config, handler);
      if (mode === "compact") {
        const options = { target: "draft-7", io: "input" };
        const inline = z.toJSONSchema(config.inputSchema, options);
        const inputSchema = compactSchema(inline);
        tools.push({ ...config, name, inputSchema, execution: registered.execution });
      }
      return registered;
    },
    install() {
      if (mode === "compact") server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
    },
  };
}
