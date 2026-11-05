import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { createRuntimeLogger } from "../scripts/runtime-logger.mjs";

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
