# Changelog

All notable changes to TaskCenter are documented here.

## 0.1.0 - 2026-08-13

### Breaking migration from ReqRadar

- MCP server name changed from `reqradar` to `taskcenter`.
- Hook and MCP entrypoints changed to `scripts/taskcenter-hook.mjs` and `scripts/taskcenter-mcp.mjs`.
- Re-run `npm run integrations:print`, replace old absolute paths in Codex and Claude Code configuration, then restart the clients.
- Context bridge external idempotency keys intentionally retain the legacy `reqradar-context-*` prefix so upgrades and compensation retries do not duplicate downstream effects.

- Initial open-source source release.
- Local task dashboard and Codex session discovery.
- TaskCenter MCP task protocol and task ledger.
- Codex and Claude Code Hook/MCP configuration templates.
- macOS desktop launcher.
- Local-only privacy and acceptance boundaries.
