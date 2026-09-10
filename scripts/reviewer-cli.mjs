import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function reviewerCommand({ promptPath, outputPath, resume }, env = process.env) {
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
  return { args, env: childEnv, input: readFileSync(resolve(promptPath), "utf8") };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [promptPath, outputPath, resume, ...extra] = process.argv.slice(2);
  try {
    if (extra.length) throw new Error("Unexpected CLI arguments");
    const invocation = reviewerCommand({ promptPath, outputPath, resume });
    const child = spawnSync("codex", invocation.args, { env: invocation.env, input: invocation.input, stdio: ["pipe", "inherit", "inherit"] });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
