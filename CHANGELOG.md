# Changelog

All notable changes to TaskCenter are documented here.

## 0.1.5 - 2026-08-14

- Automatically restarts the local control service once when a Hook request finds it offline, then retries the original governance check.
- Adds an exact, project-root-only break-glass allowlist for the fixed `start` and `status` commands while continuing to block arbitrary writes.
- Launches the managed service in a detached process group so it survives the shell session that started it.

## 0.1.4 - 2026-08-14

- Removes the vulnerable `image-size` development dependency by temporarily pinning `vinext` to the last compatible release before it was introduced.
- Overrides Drizzle Kit's deprecated loader chain to use patched `esbuild` 0.25 or newer.
- Restores a clean full `npm audit` while keeping production dependencies unchanged.

## 0.1.3 - 2026-08-14

- Rejects single `&` and the remaining shell control operators before the Hook read-only fast path.
- Blocks additional stdin/interactive interpreter forms, including `env --`, script-plus-interactive flags, and `-` stdin markers.
- Restores terminating interpreter queries such as `--version` and `--help`.
- Treats non-JSON or non-object Context MCP success responses as protocol failures so compensation remains eligible.

## 0.1.2 - 2026-08-14

- Removes `git grep` from the Hook read-only allowlist because its pager options can execute external commands.
- Uses the canonical Codex `Bash` Hook payload and rejects known stdin-driven shell/REPL launch forms while documenting the guardrail boundary.
- Retries Context observation idempotency conflicts with the exact `543cf19` payload shape and keeps tests off the runtime map.
- Reads MCP and Context client versions from the package version and reports `0.1.2` consistently.
- Compares the empty tree to `HEAD` when the CI base is zero, missing, or disconnected.

## 0.1.1 - 2026-08-14

- Withdraws the affected `0.1.0` release and publishes the reviewed open-source tree under a new version.
- Preserves the complete legacy Context idempotency request, including `reqradar-context-*` event IDs and `reqradar_task_id` observation payloads.
- Removes `sed` from the read-only Hook allowlist and rejects interactive PTY or bare shell/REPL commands that could be continued through `write_stdin`.
- Isolates unit-test dashboard output while keeping `test:integration` pointed at the real synchronized dashboard.
- Handles missing or all-zero GitHub push base SHAs and standardizes the lockfile on the official npm registry.
- Replaces project-specific test roadmap data with explicitly synthetic fixtures.

## 0.1.0 - 2026-08-13 (withdrawn)

This release was withdrawn. Do not use or republish its tag or artifacts.

### Breaking migration from ReqRadar

- MCP server name changed from `reqradar` to `taskcenter`.
- Hook and MCP entrypoints changed to `scripts/taskcenter-hook.mjs` and `scripts/taskcenter-mcp.mjs`.
- MCP tools changed from `reqradar_session_register`, `reqradar_session_status`, `reqradar_task_create`, `reqradar_task_query`, `reqradar_task_update`, and `reqradar_task_report` to their `taskcenter_*` equivalents.
- All `REQRADAR_*` environment variables were renamed to `TASKCENTER_*`. Legacy names are not read; replace them before startup, especially session filters such as `REQRADAR_THREADS`, otherwise the default scan scope is `all`.
- Remove the old `reqradar` MCP server and Hook entries, then run `npm run integrations:print` and merge the generated `taskcenter` entries with the Codex and Claude Code configuration.
- Replace old absolute paths, restart Codex and Claude Code, verify `/mcp` and `/hooks`, and confirm the Session selection in the local dashboard before scanning.
- Remove the old ReqRadar desktop shortcut and run `npm run desktop:install` again. Runtime files remain local under the clone's `data/` directory and are not migrated automatically between clone locations.
- Context bridge external idempotency keys intentionally retain the legacy `reqradar-context-*` prefix so upgrades and compensation retries do not duplicate downstream effects.

- Initial open-source source release.
- Local task dashboard and Codex session discovery.
- TaskCenter MCP task protocol and task ledger.
- Codex and Claude Code Hook/MCP configuration templates.
- macOS desktop launcher.
- Local-only privacy and acceptance boundaries.
