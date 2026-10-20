import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { isTrustedCliEntry } from "./trusted-cli-identity.mjs";

// DescribeTasks can contain plaintext environment overrides; only these projections leave L0.
export const awsTaskQuery = "tasks[].{taskArn:taskArn,lastStatus:lastStatus,desiredStatus:desiredStatus,stopCode:stopCode,stoppedReason:stoppedReason,containers:containers[].{name:name,lastStatus:lastStatus,exitCode:exitCode,reason:reason}}";
export const awsServiceQuery = "services[].{serviceName:serviceName,status:status,desiredCount:desiredCount,runningCount:runningCount,pendingCount:pendingCount,events:events[:10]}";

export function isReadOnlyAws(tokens) {
  const installed = "/opt/homebrew/opt/awscli/bin/aws";
  const entry = tokens[0] === "aws"
    ? (process.env.PATH || "").split(delimiter).map(dir => join(dir, "aws")).find(path => existsSync(path))
    : tokens[0];
  if (!isTrustedCliEntry(entry, { installed, aliases: ["/opt/homebrew/bin/aws"] })) return false;
  const args = tokens.slice(1), values = new Map(), positionals = [];
  const flags = new Set(["--no-cli-pager", "--no-paginate"]);
  const options = new Set(["--region", "--profile", "--output", "--query", "--log-group-name", "--log-stream-name", "--filter-pattern", "--start-time", "--end-time", "--limit", "--cluster", "--tasks", "--services", "--service-name", "--desired-status", "--max-results"]);
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith("--")) { positionals.push(token); continue; }
    const [option, ...parts] = token.split("=");
    if (values.has(option)) return false;
    if (flags.has(option)) { if (parts.length) return false; values.set(option, true); continue; }
    if (!options.has(option)) return false;
    const value = parts.length ? parts.join("=") : args[++i];
    if (!value || value.startsWith("-") || value.includes("://") || /[\x00-\x1f]/.test(value)) return false;
    values.set(option, value);
  }
  if (positionals.length !== 2) return false;
  const action = positionals.join(" ");
  const common = ["--region", "--profile", "--output", "--no-cli-pager"];
  const policies = {
    "sts get-caller-identity": [],
    "logs filter-log-events": ["--log-group-name", "--start-time", "--end-time", "--limit", "--no-paginate", "--filter-pattern"],
    "logs get-log-events": ["--log-group-name", "--log-stream-name", "--start-time", "--end-time", "--limit", "--no-paginate"],
    "ecs describe-tasks": ["--cluster", "--tasks", "--query"],
    "ecs describe-services": ["--cluster", "--services", "--query"],
    "ecs list-tasks": ["--cluster", "--service-name", "--desired-status", "--max-results", "--no-paginate"],
  };
  if (!Object.hasOwn(policies, action) || [...values.keys()].some(key => ![...common, ...policies[action]].includes(key))) return false;
  for (const key of ["--region", "--profile"]) if (values.has(key) && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(values.get(key))) return false;
  if (values.has("--output") && !["json", "text", "table"].includes(values.get("--output"))) return false;
  const has = key => values.has(key);
  const bounded = (key, max) => /^\d+$/.test(values.get(key) || "") && Number(values.get(key)) >= 1 && Number(values.get(key)) <= max;
  if (action.startsWith("logs ")) {
    const start = Number(values.get("--start-time")), end = Number(values.get("--end-time"));
    if (!["--log-group-name", "--start-time", "--end-time", "--limit", "--no-paginate"].every(has)
      || !bounded("--limit", 1000) || ![start, end].every(Number.isSafeInteger) || start < 0 || end <= start || end - start > 86400000
      || !/^\d+$/.test(values.get("--start-time")) || !/^\d+$/.test(values.get("--end-time"))) return false;
    return action !== "logs get-log-events" || has("--log-stream-name");
  }
  if (action.startsWith("ecs ")) {
    if (!has("--cluster")) return false;
    if (action === "ecs describe-tasks") return has("--tasks") && values.get("--query") === awsTaskQuery;
    if (action === "ecs describe-services") return has("--services") && values.get("--query") === awsServiceQuery;
    return has("--no-paginate") && bounded("--max-results", 100) && (!has("--desired-status") || ["RUNNING", "PENDING", "STOPPED"].includes(values.get("--desired-status")));
  }
  return true;
}
