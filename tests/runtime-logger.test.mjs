import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { createRuntimeLogger } from "../scripts/runtime-logger.mjs";
import { cpSync } from "node:fs";
import { pathToFileURL } from "node:url";

test("runtime logger rolls during execution, retains across restarts, drains and bounds lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-logger-"));
  const files = () => readdirSync(dir).filter(name => /^runtime(?:\.\d+)?\.log$/.test(name));
  try {
    for (let restart = 0; restart < 2; restart++) {
      const logger = await createRuntimeLogger(dir, { size: "2k", count: 3 });
      for (let n = 0; n < 15; n++) {
        logger.log("fixture", "stdout", JSON.stringify({ event: "sample", n, value: "a".repeat(2000) }));
        await delay(15);
      }
      const stream = new PassThrough();
      logger.attach(stream, "fixture", "stderr");
      stream.end(Buffer.from(`你好${"b".repeat(40000)}\nfinal-marker`));
      await delay(30);
      await logger.close();
      assert.ok(files().length <= 3, files().join(","));
      const rows = files().flatMap(name => readFileSync(join(dir, name), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse));
      assert.ok(rows.some(row => row.msg === "final-marker"));
      assert.ok(rows.some(row => row.truncated && row.msg.startsWith("你好") && row.msg.length <= 16384));
      assert.ok(rows.every(row => row.source === "fixture" && row.component === "supervisor"));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("built logger runs outside the installation tree with notices and no dynamic transport dependencies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "logger-production-"));
  try {
    const notices = readFileSync(new URL("../dist/runtime/THIRD-PARTY-NOTICES.txt", import.meta.url), "utf8");
    assert.match(notices, /pino@10\.4\.0/);
    assert.match(notices, /rotating-file-stream@3\.2\.10/);
    cpSync(new URL("../dist/runtime/logger.cjs", import.meta.url), join(dir, "logger.cjs"));
    const built = await import(pathToFileURL(join(dir, "logger.cjs")));
    const logger = await built.createRuntimeLogger(join(dir, "logs"));
    logger.log("fixture", "stdout", JSON.stringify({ event: "production_bundle", token: "hidden-fixture" }));
    await logger.close();
    const record = JSON.parse(readFileSync(join(dir, "logs/runtime.log"), "utf8"));
    assert.equal(record.data.event, "production_bundle");
    assert.equal(record.data.token, "[Redacted]");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
