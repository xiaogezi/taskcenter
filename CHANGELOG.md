# Changelog

All notable changes to TaskCenter are documented here.

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
