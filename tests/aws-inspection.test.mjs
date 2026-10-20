import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { inspectTrustedCli } from "../scripts/trusted-cli-inspection.mjs";
import { awsTaskQuery, awsServiceQuery } from "../scripts/aws-inspection.mjs";

test("AWS 仅可信入口、精确操作和有界查询可进入 L0", { skip: !existsSync("/opt/homebrew/opt/awscli/bin/aws") }, () => {
  const check = args => inspectTrustedCli(["/opt/homebrew/bin/aws", ...args], {});
  const logs = ["logs", "filter-log-events", "--log-group-name", "/ecs/app", "--start-time", "1700000000000", "--end-time", "1700000060000", "--limit", "100", "--no-paginate"];
  for (const args of [["--version"], ["sts", "get-caller-identity"], logs, [...logs, "--filter-pattern", '"run_id"'],
    ["logs", "get-log-events", ...logs.slice(2), "--log-stream-name", "ecs/app/id"],
    ["ecs", "describe-tasks", "--cluster", "app", "--tasks", "id", "--query", awsTaskQuery],
    ["ecs", "describe-services", "--cluster", "app", "--services", "app", "--query", awsServiceQuery],
    ["ecs", "list-tasks", "--cluster", "app", "--max-results=10", "--no-paginate", "--desired-status", "STOPPED"],
    ["--region=us-east-1", "sts", "get-caller-identity", "--output", "json"]]) assert.equal(check(args), true, args.join(" "));
  for (const args of [["--version", "--debug"], ["--version", "--output=json"], ["--version", "sts", "get-caller-identity"], ["--version=true"],
    ["sts", "assume-role"], ["configure", "export-credentials"], ["secretsmanager", "get-secret-value"],
    ["ecs", "update-service"], ["logs", "delete-log-group"], ["logs", "start-query"],
    logs.slice(0, -1), [...logs, "--limit", "1"], [...logs, "--unmask"], [...logs, "--next-token", "x"],
    logs.map(x => x === "100" ? "1001" : x), logs.map(x => x === "1700000060000" ? "1700100000000" : x),
    logs.map(x => x === "1700000060000" ? "1700000000000" : x),
    ["ecs", "describe-tasks", "--cluster", "app", "--tasks", "id"],
    ["ecs", "describe-tasks", "--cluster", "app", "--tasks", "id", "--query", "tasks"],
    ...["--endpoint-url=http://evil", "--debug", "--cli-input-json=file://secret", "--no-sign-request", "--no-verify-ssl", "--region=us-east-1", "--profile", "--out=json"].map(option => ["sts", "get-caller-identity", "--region", "us-west-2", option])]) assert.equal(check(args), false, args.join(" "));
  for (const prefix of [["rtk", "proxy"], ["/opt/homebrew/bin/rtk", "proxy"]]) assert.equal(inspectTrustedCli([...prefix, "aws", "sts", "get-caller-identity"], {}), true);
  for (const entry of ["aws", "/opt/homebrew/bin/aws", "/opt/homebrew/opt/awscli/bin/aws"]) {
    assert.equal(inspectTrustedCli([entry, "--version"], {}), true);
    assert.equal(inspectTrustedCli(["rtk", "proxy", entry, "--version"], {}), true);
  }
  assert.equal(inspectTrustedCli(["/tmp/aws", "--version"], {}), false);
  for (const words of [["/tmp/aws", "sts", "get-caller-identity"], ["/tmp/rtk", "proxy", "aws", "sts", "get-caller-identity"], ["rtk", "aws", "sts", "get-caller-identity"], ["env", "AWS_ENDPOINT_URL=http://evil", "aws", "sts", "get-caller-identity"]]) assert.notEqual(inspectTrustedCli(words, {}), true);
});
