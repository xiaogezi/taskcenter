import { readFileSync } from "node:fs";
import { loadModelRoleConfig, modelRoleConfigPath } from "./model-role-config.mjs";
import { requireHarnessOperation } from "./harnesses/index.mjs";

export function cliProfile(name) {
  const config = loadModelRoleConfig();
  const input = JSON.parse(readFileSync(modelRoleConfigPath, "utf8"));
  const profile = input.cli_profiles?.[name];
  const client = input.cli_clients?.[profile?.harness];
  const keyedModel = profile?.model_key && client?.models && Object.hasOwn(client.models, profile.model_key) ? client.models[profile.model_key] : "";
  const model = profile?.model || keyedModel;
  const efforts = client?.reasoning_efforts || ["low", "medium"];
  if (!profile || (input.cli_clients && !client) || typeof model !== "string" || !model.trim() || config.retiredModels.includes(model)) throw new Error("CLI_PROFILE_INVALID");
  requireHarnessOperation(profile.harness, "runDelegatedCli");
  if (!Array.isArray(efforts) || !efforts.includes(profile.reasoning_effort)) throw new Error("CLI_EFFORT_INVALID");
  if ((profile.model_key && keyedModel !== model) || (client && (!client.models || !Object.values(client.models).includes(model)))) throw new Error("CLI_MODEL_UNCONFIGURED");
  return { harness: profile.harness, model, provider: profile.provider || client?.provider || "unknown", role: "executor", effort: profile.reasoning_effort };
}
