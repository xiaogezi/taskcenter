import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { resolveTrustedMcpSession } from "./mcp-session-context.mjs";

export function reviewerCommand({ promptPath, outputPath, resume, managed }, env = process.env) {
  if (!promptPath || !outputPath) throw new Error("Usage: node reviewer-cli.mjs PROMPT_FILE OUTPUT_FILE [REVIEWER_SESSION_UUID]");
  if (resume && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(resume)) throw new Error("Invalid Reviewer Session UUID");
  const { model, reasoning_effort: effort } = JSON.parse(readFileSync(new URL("../config/model-roles.json", import.meta.url), "utf8")).roles.reviewer;
  if (!model || !effort) throw new Error("Reviewer configuration unavailable");
  const args = ["exec", "-s", "read-only", "-m", model, "-c", `model_reasoning_effort=${JSON.stringify(effort)}`];
  // Per-process grants only; server-side identity and lease checks still apply.
  for (const tool of ["taskcenter_session_register", "taskcenter_review_claim", "taskcenter_task_review_report"]) args.push("-c", `mcp_servers.taskcenter.tools.${tool}.approval_mode="approve"`);
  if (resume) args.push("resume");
  args.push("--json", "-o", resolve(outputPath));
  if (resume) args.push(resume);
  args.push("-");
  const childEnv = { ...env };
  for (const key of ["TASKCENTER_CALLER_SESSION_ID", "CODEX_SESSION_ID", "CODEX_THREAD_ID"]) delete childEnv[key];
  delete childEnv.TASKCENTER_MANAGED_REVIEW;
  let input = readFileSync(resolve(promptPath), "utf8");
  let cwd;
  if (managed) {
    if (!managed.route_id || !managed.claim_token || !managed.workspace || !managed.native_unavailable_reason) throw new Error("Managed review requires route, capability, workspace and native channel unavailability evidence");
    cwd = resolve(managed.workspace);
    childEnv.TASKCENTER_MANAGED_REVIEW = JSON.stringify({ route_id: managed.route_id, claim_token: managed.claim_token, workspace: cwd, model, sandbox: "read-only", native_unavailable_reason: managed.native_unavailable_reason });
    args.splice(1, 0, "-c", 'mcp_servers.taskcenter.tools.taskcenter_review_start.approval_mode="approve"', "-c", 'mcp_servers.taskcenter.tools.taskcenter_review_finish.approval_mode="approve"');
    args.splice(1, 0, "-c", `mcp_servers.taskcenter.env.TASKCENTER_MANAGED_REVIEW=${JSON.stringify(childEnv.TASKCENTER_MANAGED_REVIEW)}`);
    input = "First call taskcenter_review_start with {}. Do not guess UUID, register manually, create tasks or cycles. Only after accepted read the exact returned Subject/Bundle/Rules and every listed file. Submit actual coverage and technical conclusions through taskcenter_review_finish. It assembles the report and releases the lease. A child process ending is not Review completion; only finish accepted with lease_released counts. Remain read-only.\n\n" + input;
  }
  return { args, env: childEnv, input, ...(cwd ? { cwd } : {}) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let [promptPath, outputPath, resume, ...extra] = process.argv.slice(2);
  let managed;
  let finished = false;
  try {
    if (extra.length) throw new Error("Unexpected CLI arguments");
    if (promptPath === "--managed") {
      managed = JSON.parse(readFileSync(resolve(outputPath), "utf8"));
      promptPath = managed.prompt_path;
      outputPath = resume;
      resume = undefined;
    }
    const invocation = reviewerCommand({ promptPath, outputPath, resume, managed });
    const child = spawnSync("codex", invocation.args, { cwd: invocation.cwd, env: invocation.env, input: invocation.input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", managed ? "pipe" : "inherit", "inherit"] });
    if (managed) {
      process.stdout.write(child.stdout || "");
      finished = (child.stdout || "").split("\n").some((line) => {
        try {
          const event = JSON.parse(line);
          if (event.type !== "item.completed" || event.item?.tool !== "taskcenter_review_finish") return false;
          return event.item.result?.content?.some((item) => { const value = JSON.parse(item.text); return value.accepted === true && value.lease_released === true; });
        } catch { return false; }
      });
    }
    if (child.error) throw child.error;
    process.exitCode = managed && !finished ? 1 : child.status ?? 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (managed && !finished) {
      const identity = resolveTrustedMcpSession(null);
      try {
        if (!identity.sessionId) throw new Error("Parent Session unavailable; parent must release route");
        const tokenPath = process.env.TASKCENTER_MCP_TOKEN_PATH || fileURLToPath(new URL("../.local/runtime/mcp-token", import.meta.url));
        const response = await fetch(`${process.env.TASKCENTER_CONTROL_URL || "http://127.0.0.1:3001"}/routing/result`, { method: "POST", headers: { "Content-Type": "application/json", "X-TaskCenter-Task": "mcp", "X-TaskCenter-MCP-Token": readFileSync(tokenPath, "utf8").trim() }, body: JSON.stringify({ route_id: managed.route_id, session_id: identity.sessionId, outcome: "failed", error_type: "review_workflow", error_code: "REVIEW_NOT_COMPLETED" }) });
        if (!response.ok) throw new Error(`Lease cleanup failed: HTTP ${response.status}`);
      } catch (error) { console.error(error.message); }
    }
  }
}
