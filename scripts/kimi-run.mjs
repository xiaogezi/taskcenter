#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { invokeHarness } from "./harnesses/index.mjs";
export { runKimi } from "./harnesses/kimi-session.mjs";


export function kimiRunMetadata(result, observedAt = new Date().toISOString()) {
  // Keep answer text and future adapter fields out of the on-disk metadata report.
  const { sessionId, taskcenterSessionId, cwd, stopReason, reportedModel, reportedThinking,
    usage, usage_status, cancelled, status, usageScope } = result;
  return { sessionId, taskcenterSessionId, cwd, stopReason, reportedModel, reportedThinking,
    usage: usage ? { used: usage.used, size: usage.size, cost: usage.cost, currency: usage.currency } : null,
    usage_status, cancelled, status, usageScope, observed_at: observedAt };
}

async function main() {
  const { values } = parseArgs({ options: { cwd: { type: "string", default: process.cwd() }, session: { type: "string" }, prompt: { type: "string" }, "pca-root": { type: "string" }, help: { type: "boolean" } } });
  if (values.help) { console.log("node scripts/kimi-run.mjs --cwd PATH --prompt TEXT [--session UUID] [--pca-root PATH]\nCtrl-C cancels the current turn. Permissions require an interactive terminal; otherwise denied."); return; }
  if (!values.prompt) throw new Error("--prompt is required");
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  const terminal = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stderr }) : null;
  try {
    const result = await invokeHarness("kimi", values.session ? "resumeSession" : "createSession", { workingDirectory: values.cwd, sessionId: values.session, prompt: values.prompt, pcaRoot: values["pca-root"] || process.env.TASKCENTER_PCA_ROOT, signal: controller.signal,
      permission: async request => {
        const option = request.options?.find(item => item.kind === "allow_once");
        if (!terminal || !option) return null;
        const answer = await terminal.question(`${JSON.stringify(request.toolCall)}\nAllow once? [y/N] `, { signal: controller.signal });
        return answer.trim().toLowerCase() === "y" ? option.optionId : null;
      },
      update: value => { if (value?.sessionUpdate === "agent_message_chunk" && value.content?.type === "text") process.stdout.write(value.content.text); },
    });
    const directory = resolve(import.meta.dirname, "../.local/kimi-runs");
    await mkdir(directory, { recursive: true });
    const report = resolve(directory, `${randomUUID()}.json`);
    await writeFile(report, JSON.stringify(kimiRunMetadata(result), null, 2) + "\n", { mode: 0o600 });
    console.error(`\nSession: ${result.sessionId}; report: ${report}; usage: ${result.usage_status}`);
    if (result.cancelled || result.stopReason !== "end_turn") process.exitCode = 1;
  } finally { process.off("SIGINT", interrupt); terminal?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
