import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSpawnCommand } from "./platform-command.mjs";

export function parseInferenceJson(text) {
  const fenced = typeof text === "string" && text.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  return JSON.parse(fenced ? fenced[1] : text);
}

// Inference has no tools, project context, persistent session, or delegation authority.
export async function runClaudeInference({ profile, prompt, signal }) {
  const cwd = await mkdtemp(join(tmpdir(), "taskcenter-inference-"));
  try {
    const executable = resolveSpawnCommand("claude");
    const args = [...executable.argsPrefix, "--print", "--safe-mode", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--no-session-persistence", "--output-format", "json", "--max-turns", "1", "--model", profile.model, "--effort", profile.effort];
    const completed = promisify(execFile)(executable.command, args, { cwd, signal, timeout: 120_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024 });
    completed.child.stdin.on("error", () => {});
    completed.child.stdin.end(prompt);
    const { stdout } = await completed;
    const receipt = JSON.parse(stdout);
    if (receipt.is_error || receipt.subtype !== "success" || receipt.permission_denials?.length) throw new Error("CLI_FAILED");
    if (!Object.hasOwn(receipt.modelUsage || {}, profile.model) || Object.keys(receipt.modelUsage).some(model => model !== profile.model)) throw new Error("CLI_MODEL_MISMATCH");
    return { text: receipt.result, model: profile.model, usage: receipt.usage || null, session_id: receipt.session_id || "", duration_ms: receipt.duration_ms };
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
