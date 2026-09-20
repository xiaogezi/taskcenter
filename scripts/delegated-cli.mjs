import { accessSync, constants, mkdtempSync, readFileSync, writeFileSync, rmSync, appendFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { cliProfile } from "./cli-profile.mjs";
import { claimCli, checkCliTool, control } from "./delegated-cli-hook.mjs";
import { requireHarnessOperation } from "./harnesses/index.mjs";
export { claudeInvocation, claudeReceipt } from "./harnesses/claude-delegated.mjs";

export function validateCliManifest(input) {
  for (const key of ["profile", "task_id", "parent_session_id", "route_id", "delegation_id", "claim_token", "workspace", "prompt_path", "output_path"]) if (typeof input[key] !== "string" || !input[key].trim()) throw new Error(`Missing ${key}`);
  for (const key of ["workspace", "prompt_path", "output_path"]) if (!isAbsolute(input[key])) throw new Error(`${key} must be absolute`);
  if (!['read-only', 'workspace-write'].includes(input.mode)) throw new Error("Explicit mode required");
  const timeout_ms = input.timeout_ms ?? 300000;
  if (!Number.isInteger(timeout_ms) || timeout_ms < 1000 || timeout_ms > 1800000) throw new Error("Invalid timeout_ms");
  cliProfile(input.profile);
  return { ...input, workspace: resolve(input.workspace), timeout_ms };
}

export function cliFailureKind(message) {
  if (/MCP tool call requires approval|approval policy is never/i.test(message)) return "tool_approval";
  if (/EACCES|EPERM|sandbox|read.only file system/i.test(message)) return "filesystem_permission";
  if (/CLI_(?:PERMISSION_DENIED|READ_ONLY|TOOL_UNSUPPORTED|NOT_CLAIMED|GRANT_MISMATCH)|claim rejected|TaskCenter.*门禁/i.test(message)) return "task_permission";
  return "cli_execution";
}

const quotaLikePattern = /rate.?limit|quota|429|retry.?after/i;
function isQuotaLike(value) { return quotaLikePattern.test(String(value || "")); }

export async function runDelegatedCli(input, dependencies = {}) {
  const manifest = validateCliManifest(input), profile = cliProfile(manifest.profile);
  const request = dependencies.control || control;
  const temporary = mkdtempSync(join(tmpdir(), "taskcenter-cli-"));
  const manifestPath = join(temporary, "manifest.json");
  manifest.receipt_path = join(temporary, "claimed.json");
  writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  const logPath = `${manifest.output_path}.log`;
  let sessionId, result, failure, reportError, permissionFailure;
  let lastPermissionReportAt = 0;
  const controller = new AbortController(), signal = controller.signal;
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, manifest.timeout_ms);
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  // 心跳：领取后定期 touch 更新 lastObservedAt，作为执行中/失联的观测依据；失败不影响执行。
  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        if (!sessionId && existsSync(manifest.receipt_path)) {
          const receipt = JSON.parse(readFileSync(manifest.receipt_path, "utf8"));
          if (receipt?.sessionId) sessionId = receipt.sessionId;
        }
        if (!sessionId) return;
        await request("/delegations/touch", { delegation_id: manifest.delegation_id, session_id: sessionId, workspace: manifest.workspace });
      } catch { /* 心跳失败不中断 CLI 执行 */ }
    })();
  }, 60_000);
  try {
    if (!statSync(manifest.workspace).isDirectory()) throw new Error("CLI_WORKSPACE_INVALID");
    accessSync(manifest.prompt_path, constants.R_OK);
    accessSync(dirname(manifest.output_path), constants.W_OK);
    if (manifest.mode === "workspace-write") accessSync(manifest.workspace, constants.W_OK);
    // No prompt is submitted to Kimi before claim; Claude tools require the SessionStart receipt.
    const prompt = readFileSync(manifest.prompt_path, "utf8");
    writeFileSync(logPath, "", { mode: 0o600, flag: "wx" });
    if (existsSync(manifest.output_path)) throw new Error("CLI_OUTPUT_EXISTS");
    let logBytes = 0;
    result = await requireHarnessOperation(profile.harness, "runDelegatedCli")({ manifest, manifestPath, profile, prompt, signal, logPath, dependencies,
      onSessionReady: async value => {
        await claimCli(manifest, value.taskcenterSessionId, request);
        sessionId = value.taskcenterSessionId;
        await request("/delegations/report", { delegation_id: manifest.delegation_id, session_id: sessionId, workspace: manifest.workspace, status: "running", summary: "CLI 会话已领取，开始执行" }).catch(() => {});
        await request("/delegations/touch", { delegation_id: manifest.delegation_id, session_id: sessionId, workspace: manifest.workspace }).catch(() => {});
      },
      authorizeTool: async (tool, rawInput) => {
        if (!sessionId || !tool || !rawInput) { permissionFailure = "CLI_NOT_CLAIMED_OR_INVALID_TOOL"; return false; }
        try {
          const nowMs = Date.now();
          if (nowMs - lastPermissionReportAt >= 60_000) {
            lastPermissionReportAt = nowMs;
            void request("/delegations/report", { delegation_id: manifest.delegation_id, session_id: sessionId, workspace: manifest.workspace, status: "waiting_permission", summary: `等待权限：${tool}` }).catch(() => {});
          }
          await checkCliTool(manifest, sessionId, tool, rawInput);
          return true;
        } catch (error) { permissionFailure = String(error.message).slice(0, 1000); return false; }
      },
      update: value => { const text = JSON.stringify(value) + "\n"; logBytes += Buffer.byteLength(text); if (logBytes <= 16 * 1024 * 1024) appendFileSync(logPath, text); },
    });
    if (existsSync(manifest.receipt_path)) sessionId = JSON.parse(readFileSync(manifest.receipt_path, "utf8")).sessionId;
    if (!sessionId || result.sessionId !== sessionId) throw new Error("CLI_NOT_CLAIMED");
    if (permissionFailure || result.permissionDenied) throw new Error(`CLI_PERMISSION_DENIED: ${permissionFailure || "客户端拒绝工具授权"}`);
    if (result.status === "completed" && (!result.reportedModels.length || !result.reportedModels.includes(profile.model))) result.status = "unknown";
  } catch (error) {
    failure = error.message;
    result = { status: signal.aborted ? "cancelled" : "failed" };
    if (sessionId && !signal.aborted && isQuotaLike(failure)) {
      try { await request("/delegations/report", { delegation_id: manifest.delegation_id, session_id: sessionId, workspace: manifest.workspace, status: "waiting_quota", summary: String(failure).slice(-400) }); } catch { /* 限流中间态上报失败不影响原错误 */ }
    }
  }
  finally {
    clearTimeout(timeout); clearInterval(heartbeat); process.off("SIGINT", abort); process.off("SIGTERM", abort);
    if (!sessionId && existsSync(manifest.receipt_path)) sessionId = JSON.parse(readFileSync(manifest.receipt_path, "utf8")).sessionId;
    const outcome = result?.status === "completed" ? "succeeded" : result?.status === "cancelled" ? "cancelled" : "failed";
    const failureKind = failure ? cliFailureKind(failure) : null;
    const evidence = { ...result, error: failure || null, failure_kind: failureKind, task_id: manifest.task_id, route_id: manifest.route_id, delegation_id: manifest.delegation_id, role: profile.role, harness: profile.harness, requested_model: profile.model, requested_effort: profile.effort, effective_effort: result?.reportedThinking || null, observed_at: new Date().toISOString(), log_path: logPath };
    try {
      if (sessionId) await request("/delegations/report", { delegation_id: manifest.delegation_id, session_id: sessionId, workspace: manifest.workspace, status: outcome, summary: String(result?.summary || outcome).slice(-1000), evidence: [JSON.stringify(evidence).slice(0, 1000)], error: failure || (outcome === "failed" ? result?.rawStatus || "CLI_OUTCOME_UNKNOWN" : "") });
      else await request("/delegations/revoke", { delegation_id: manifest.delegation_id, parent_session_id: manifest.parent_session_id });
    } catch (error) { reportError = error.message; }
    try { await request("/routing/result", { route_id: manifest.route_id, session_id: manifest.parent_session_id, outcome, ...(outcome === "failed" ? { error_type: failureKind || "cli_execution", error_code: failure || "CLI_OUTCOME_UNKNOWN" } : {}) }); } catch (error) { reportError = [reportError, error.message].filter(Boolean).join("; "); }
    try { writeFileSync(manifest.output_path, JSON.stringify({ ...evidence, report_error: reportError || null }, null, 2) + "\n", { mode: 0o600, flag: "wx" }); }
    finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  if (failure || reportError || result.status !== "completed") throw new Error(failure || reportError || `CLI_${result.status.toUpperCase()}`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { if (process.argv.length !== 3) throw new Error("Usage: node scripts/delegated-cli.mjs MANIFEST.json"); await runDelegatedCli(JSON.parse(readFileSync(process.argv[2], "utf8"))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
