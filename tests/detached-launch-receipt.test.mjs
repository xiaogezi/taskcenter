import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("隔离启动器经 IPC 返回自己生成的实例身份，无 IPC 的 CLI 仍可启动", async () => {
  for (const ipc of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), "taskcenter-launch-receipt-"));
    try {
      await mkdir(join(root, "scripts"));
      // Harmless isolated child: no sockets, services or user data.
      await writeFile(join(root, "scripts/dev-live.mjs"), "process.exit(0);\n");
      const child = spawn(process.execPath, [resolve("scripts/taskcenter-detached-launch.mjs")], {
        env: { ...process.env, TASKCENTER_SOURCE_ROOT: root, TASKCENTER_RUNTIME_DIR: join(root, "runtime"),
          TASKCENTER_LOG_DIR: join(root, "logs"), TASKCENTER_RELEASE_REVISION: "fixture-revision" },
        stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
      });
      const messages = [];
      child.on("message", message => messages.push(message));
      const code = await new Promise((resolveCode, reject) => {
        child.once("error", reject); child.once("close", resolveCode);
      });
      assert.equal(code, 0);
      const state = JSON.parse(await readFile(join(root, "runtime/web-state.json"), "utf8"));
      assert.ok(state.pid > 0);
      assert.ok(state.token);
      assert.equal(state.sourceRoot, root);
      assert.equal(state.revision, "fixture-revision");
      assert.deepEqual(messages, ipc ? [{ type: "taskcenter-launched", state }] : []);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
