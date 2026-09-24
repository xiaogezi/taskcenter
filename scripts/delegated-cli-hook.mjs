import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { cliProfile } from "./cli-profile.mjs";

const exec = promisify(execFile);
export async function control(path, body) {
  const base = new URL(process.env.TASKCENTER_CONTROL_URL || "http://127.0.0.1:3001");
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error("Local TaskCenter required");
  const response = await fetch(new URL(path, base), { method: "POST", headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "hook" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const value = await response.json();
  if (!response.ok || value.accepted === false) throw new Error(value.error || `TaskCenter HTTP ${response.status}`);
  return value;
}

export async function claimCli(manifest, sessionId, request = control) {
  const profile = cliProfile(manifest.profile);
  await request("/task-events", { type: "session.register", session_id: sessionId, workspace: manifest.workspace, agent: profile.harness, provider: profile.provider, model: profile.model });
  const claimed = await request("/delegations/claim", { delegation_id: manifest.delegation_id, claim_token: manifest.claim_token, session_id: sessionId, workspace: manifest.workspace, route_id: manifest.route_id, executor_model: profile.model });
  const grant = claimed.delegation;
  if (!claimed.accepted || grant?.taskId !== manifest.task_id || grant.parentSessionId !== manifest.parent_session_id || grant.executorModel !== profile.model || grant.delegateSessionId !== sessionId || grant.workspace !== manifest.workspace || grant.status !== "active") throw new Error("CLI_GRANT_MISMATCH");
  // 幂等 claim 表示该 delegation 已被本 Session 领取过：这是重放，必须在提交 prompt 前拒绝。
  // 显式新 attempt 使用新 delegation，其首次 claim 返回 idempotent=false，不受影响。
  if (claimed.idempotent === true) throw new Error("CLI_GRANT_REPLAY");
  return grant;
}

export async function checkCliTool(manifest, sessionId, tool_name, tool_input) {
  if (manifest.mode === "read-only" && !["Read", "Glob", "Grep"].includes(tool_name)) throw new Error("CLI_READ_ONLY");
  if (!['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'].includes(tool_name)) throw new Error("CLI_TOOL_UNSUPPORTED");
  const child = exec(process.execPath, [resolve(import.meta.dirname, "taskcenter-hook.mjs"), "pre-tool-use", "--agent", cliProfile(manifest.profile).harness], { cwd: manifest.workspace, timeout: 15000, maxBuffer: 65536 });
  child.child.stdin.end(JSON.stringify({ session_id: sessionId, cwd: manifest.workspace, tool_name, tool_input }));
  await child;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const manifest = JSON.parse(readFileSync(process.env.TASKCENTER_CLI_MANIFEST, "utf8"));
    let text = "";
    for await (const chunk of process.stdin) { text += chunk; if (text.length > 1048576) throw new Error("Hook payload too large"); }
    const event = JSON.parse(text);
    if (!event.session_id || resolve(event.cwd || "") !== manifest.workspace) throw new Error("CLI_IDENTITY_MISMATCH");
    if (event.hook_event_name === "SessionStart") {
      try { await claimCli(manifest, event.session_id); }
      catch (error) {
        writeFileSync(manifest.receipt_path, JSON.stringify({ claimUnconfirmed: true }), { mode: 0o600 });
        throw error;
      }
      writeFileSync(manifest.receipt_path, JSON.stringify({ sessionId: event.session_id }), { mode: 0o600 });
    } else {
      const receipt = JSON.parse(readFileSync(manifest.receipt_path, "utf8"));
      if (receipt.sessionId !== event.session_id) throw new Error("CLI_NOT_CLAIMED");
      await checkCliTool(manifest, event.session_id, event.tool_name, event.tool_input);
    }
    process.stdout.write(JSON.stringify({ continue: true }));
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
