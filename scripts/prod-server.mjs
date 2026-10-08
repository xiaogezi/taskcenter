#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { startProdServer } from "vinext/server/prod-server";

// The build CLI loads optional Vite tooling even for start; use its exported production server.
for (const name of [".env.production.local", ".env.local", ".env.production", ".env"]) {
  if (existsSync(name)) process.loadEnvFile(name);
}
const { values } = parseArgs({ options: { port: { type: "string", short: "p" }, hostname: { type: "string", short: "H" } } });
const port = Number(values.port || process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid production port");
await startProdServer({ port, host: values.hostname || "0.0.0.0", outDir: resolve("dist") });
