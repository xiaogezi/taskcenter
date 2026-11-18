import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildReleaseEnvironment } from "../scripts/release-runtime.mjs";

test("test fixture isolation overrides inherited production audit paths", () => {
  const directory = mkdtempSync(join(tmpdir(), "taskcenter-isolation-proof-"));
  const live = join(directory, "live.jsonl");
  writeFileSync(live, "sentinel\n");
  try {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      await import('./tests/helpers/isolate-runtime.mjs');
      const { recordGateDenial } = await import('./scripts/governance-metrics.mjs');
      recordGateDenial(process.env.TASKCENTER_GATE_DENIALS_PATH, { session_id: 'fixture', message: 'denied' });
      console.log(JSON.stringify({ path: process.env.TASKCENTER_GATE_DENIALS_PATH, url: process.env.TASKCENTER_CONTROL_URL }));
    `], { encoding: "utf8", env: { ...process.env, TASKCENTER_GATE_DENIALS_PATH: live, TASKCENTER_CONTROL_URL: "http://127.0.0.1:3001" } });
    assert.equal(readFileSync(live, "utf8"), "sentinel\n");
    assert.ok(output.includes('http://127.0.0.1:1"'));
    assert.ok(!output.includes(live));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("real fixture control server writes denials only to its temporary audit log", async () => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const directory = mkdtempSync(join(tmpdir(), "taskcenter-server-isolation-"));
  const live = join(directory, "live.jsonl");
  writeFileSync(live, "sentinel\n");
  const port = 46_000 + (process.pid % 1_000);
  const revision = randomUUID().slice(0, 12);
  // The control server reconciles the task ledger at startup even when live
  // session reconciliation is disabled. Start with isolated task data too.
  const env = buildReleaseEnvironment({
    sourceRoot: process.cwd(), revision, webPort: 0, controlPort: port,
    runtimeRoot: join(directory, "runtime"), logRoot: join(directory, "logs"),
    dataRoot: join(directory, "data"), candidateCodex: join(directory, "codex"),
  });
  env.TASKCENTER_GATE_DENIALS_PATH = live;
  env.TASKCENTER_CONTROL_URL = "http://127.0.0.1:3001";
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    await import('./tests/helpers/isolate-runtime.mjs');
    console.log('AUDIT=' + process.env.TASKCENTER_GATE_DENIALS_PATH);
    await import('./scripts/control-server.mjs');
  `], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });
  const exited = once(child, "exit");
  try {
    for (let i = 0; i < 100 && !output.includes("TaskCenter control server is listening"); i++) {
      if (child.exitCode !== null) throw new Error(errors);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(output.includes("TaskCenter control server is listening"), `own child never became ready: ${errors}`);
    assert.equal(child.exitCode, null, errors);
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.release.revision, revision, "must be our fixture service before any write");
    const response = await fetch(`http://127.0.0.1:${port}/gate-denials`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "hook" },
      body: JSON.stringify({ session_id: "confirmed-fixture", message: "当前 Session 尚未登记。", source: "hook" }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).accepted, true);
    const audit = output.match(/AUDIT=(.+)/)?.[1];
    assert.ok(audit && audit !== live, output);
    assert.equal(JSON.parse(readFileSync(audit, "utf8").trim()).session_id, "confirmed-fixture");
    assert.equal(readFileSync(live, "utf8"), "sentinel\n");
  } finally {
    child.kill("SIGTERM");
    await exited;
    rmSync(directory, { recursive: true, force: true });
  }
});
