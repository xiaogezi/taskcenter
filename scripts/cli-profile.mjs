import { readFileSync } from "node:fs";
import { loadModelRoleConfig, modelRoleConfigPath } from "./model-role-config.mjs";

export function cliProfile(name) {
  const config = loadModelRoleConfig();
  const profile = JSON.parse(readFileSync(modelRoleConfigPath, "utf8")).cli_profiles?.[name];
  if (!profile || !["kimi", "claude"].includes(profile.harness) || typeof profile.model !== "string" || !profile.model.trim() || config.retiredModels.includes(profile.model)) throw new Error("CLI_PROFILE_INVALID");
  if (!['low', 'medium'].includes(profile.reasoning_effort)) throw new Error("CLI_EFFORT_INVALID");
  return { harness: profile.harness, model: profile.model, provider: profile.provider || "unknown", role: "executor", effort: profile.reasoning_effort };
}
