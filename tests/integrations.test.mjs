import assert from "node:assert/strict";
import test from "node:test";
import { join, resolve } from "node:path";
import {
  claudeMcp,
  claudeSettings,
  cliCommands,
  codexHooks,
  codexToml,
  shellQuote,
} from "../scripts/print-integrations.mjs";

const root = resolve("Task Center");

test("integration config generators use the selected absolute root", () => {
  assert.ok(codexToml(root).includes(join(root, "scripts", "taskcenter-mcp.mjs").replaceAll("\\", "\\\\")));
  assert.equal(
    claudeMcp(root).mcpServers.taskcenter.args[0],
    join(root, "scripts", "taskcenter-mcp.mjs"),
  );
  assert.match(
    codexHooks(root).hooks.SessionStart[0].hooks[0].command,
    /taskcenter-hook\.mjs.*--agent codex/,
  );
  assert.match(
    claudeSettings(root).hooks.PreToolUse[0].hooks[0].command,
    /taskcenter-hook\.mjs.*--agent claude/,
  );
  assert.match(cliCommands(root).codex, /^codex mcp add taskcenter/);
  assert.match(cliCommands(root).claude, /^claude mcp add --scope user/);
});

test("shellQuote preserves a POSIX path containing a quote", () => {
  assert.equal(shellQuote("/tmp/user's app"), "'/tmp/user'\"'\"'s app'");
});

test("checked-in JSON integration examples are valid", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const path of [
    "integrations/codex/hooks.json.example",
    "integrations/claude/mcp.json.example",
    "integrations/claude/settings.json.example",
  ]) {
    const content = await readFile(path, "utf8");
    assert.doesNotThrow(() => JSON.parse(content));
  }
});
