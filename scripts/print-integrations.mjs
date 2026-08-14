#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

export function codexHooks(root = defaultRoot) {
  const script = shellQuote(resolve(root, "scripts", "taskcenter-hook.mjs"));
  return {
    description: "TaskCenter session registration and task lifecycle guardrail",
    hooks: {
      SessionStart: [
        {
          matcher: "^(startup|resume|clear|compact)$",
          hooks: [
            {
              type: "command",
              command: `node ${script} session-start --agent codex`,
              timeout: 10,
              statusMessage: "Registering TaskCenter session",
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: "^(Bash|apply_patch|exec_command|Edit|Write)$",
          hooks: [
            {
              type: "command",
              command: `node ${script} pre-tool-use --agent codex`,
              timeout: 10,
              statusMessage: "Checking TaskCenter task lifecycle",
            },
          ],
        },
      ],
    },
  };
}

export function claudeSettings(root = defaultRoot) {
  const script = shellQuote(resolve(root, "scripts", "taskcenter-hook.mjs"));
  return {
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume|clear|compact",
          hooks: [
            {
              type: "command",
              command: `node ${script} session-start --agent claude`,
              timeout: 10,
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: "Bash|Edit|Write|NotebookEdit",
          hooks: [
            {
              type: "command",
              command: `node ${script} pre-tool-use --agent claude`,
              timeout: 10,
            },
          ],
        },
      ],
    },
  };
}

export function codexToml(root = defaultRoot) {
  const mcp = resolve(root, "scripts", "taskcenter-mcp.mjs");
  return `[features]
hooks = true

[mcp_servers.taskcenter]
command = "node"
args = [${tomlString(mcp)}]
enabled = true
startup_timeout_sec = 10
tool_timeout_sec = 60`;
}

export function claudeMcp(root = defaultRoot) {
  return {
    mcpServers: {
      taskcenter: {
        type: "stdio",
        command: "node",
        args: [resolve(root, "scripts", "taskcenter-mcp.mjs")],
        env: {},
      },
    },
  };
}

export function cliCommands(root = defaultRoot) {
  const mcp = shellQuote(resolve(root, "scripts", "taskcenter-mcp.mjs"));
  return {
    codex: `codex mcp add taskcenter -- node ${mcp}`,
    claude: `claude mcp add --scope user --transport stdio taskcenter -- node ${mcp}`,
  };
}

function tomlString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function printSection(title, value) {
  console.log(`\n## ${title}\n`);
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag >= 0 && process.argv[rootFlag + 1]
    ? resolve(process.argv[rootFlag + 1])
    : defaultRoot;
  const commands = cliCommands(root);

  console.log(`TaskCenter root: ${root}`);
  console.log("These values are printed only. Merge them with existing user configuration; do not overwrite unrelated hooks.");
  printSection("Codex MCP CLI", commands.codex);
  printSection("Codex config.toml snippet", codexToml(root));
  printSection("Codex hooks.json entries", codexHooks(root));
  printSection("Claude Code MCP CLI", commands.claude);
  printSection("Claude Code settings.json entries", claudeSettings(root));
  printSection("Claude Code project .mcp.json", claudeMcp(root));
}
