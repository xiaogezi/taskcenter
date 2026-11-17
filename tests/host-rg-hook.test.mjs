import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const installedRg = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/codex-path/rg";
const hookScript = fileURLToPath(new URL("../scripts/taskcenter-hook.mjs", import.meta.url));

test("actual Hook accepts signed ChatGPT rg, rejects aliases, PATH shadows and shell override", {
  skip: process.platform !== "darwin" || !existsSync(installedRg), timeout: 30_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "taskcenter-host-rg-"));
  const sessionId = "019f0000-0000-7000-8000-000000000098";
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url.startsWith("/task-prepare") ? { active_task: null }
      : request.url.startsWith("/session-status") ? { sessions: [{ sessionId, status: "registered", workspace: root }] }
      : request.url.startsWith("/tasks") ? { tasks: [] } : { accepted: true }));
  });
  try {
    await mkdir(join(root, "home")); await mkdir(join(root, "sessions"));
    await mkdir(join(root, "shadow")); await mkdir(join(root, "alias"));
    await writeFile(join(root, "shadow", "rg"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await symlink(installedRg, join(root, "alias", "rg"));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const run = (cmd, extra = {}, path = `${dirname(installedRg)}:/usr/bin:/bin`) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [hookScript, "pre-tool-use", "--agent", "codex"], {
        cwd: root, env: { ...process.env, PATH: path, HOME: join(root, "home"), CODEX_HOME: join(root, "home", ".codex"),
          TASKCENTER_SESSIONS_ROOT: join(root, "sessions"), TASKCENTER_CONTROL_URL: `http://127.0.0.1:${server.address().port}` },
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", value => { stdout += value; }); child.stderr.on("data", value => { stderr += value; });
      child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify({ session_id: sessionId, cwd: root, tool_name: "exec_command", tool_input: { cmd, ...extra } }));
    });
    for (const cmd of [`${installedRg} needle README.md`, "rg needle README.md"]) {
      const result = await run(cmd);
      assert.equal(result.code, 0, `${cmd}: ${result.stderr}`); assert.match(result.stdout, /L0/);
    }
    for (const [cmd, extra, path] of [
      [`${join(root, "shadow", "rg")} needle`, {}, undefined],
      [`${join(root, "alias", "rg")} needle`, {}, undefined],
      ["rg needle", {}, `${join(root, "shadow")}:${dirname(installedRg)}:/usr/bin:/bin`],
      ["rg needle", {}, `${join(root, "alias")}:${dirname(installedRg)}:/usr/bin:/bin`],
      ["rg needle", { shell: "/tmp/custom-shell" }, undefined],
      ["pwd", { shell: "/tmp/custom-shell" }, undefined],
    ]) {
      const result = await run(cmd, extra, path);
      assert.equal(result.code, 2, `${cmd}: ${result.stdout} ${result.stderr}`); assert.doesNotMatch(result.stdout, /L0/);
    }
  } finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});
