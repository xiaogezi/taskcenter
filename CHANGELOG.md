# Changelog

All notable changes to TaskCenter are documented here.

## Unreleased

- Adds L0 registered-session deterministic read-only access with aggregate-only auditing, while keeping writes, composite shell forms, interpreters, redirects, and unregistered Sessions fail-closed.
- Defines L1 `fast`, L2 `standard`, and L3 `strict` defaults: verification is required for L2/L3, independent current-Subject review for L3, and Subject changes stale prior verification and review evidence.
- Adds `response_mode: summary|full` to task mutation/report MCP calls; summary is the compact default, while routing/delegation control calls retain full operational replies for backward compatibility.

- Adds `taskcenter_routing_select` and `taskcenter_routing_result` as a local model-routing control plane with per-model concurrency leases, TTL expiry, idempotent results, and `Closed/Open/Half-Open` circuit state.
- Keeps routing advisory and recoverable: TaskCenter never launches CLI executors, Sol can record a reasoned override, external work can use static fallback while the service is unavailable, and OCR reviewer failure cannot be auto-substituted as independent approval.
- Stores mutable routing health in ignored `data/routing-control.json` under the single control-server writer while retaining append-only `routing.decision` and `routing.health` task audit events.
- Opens the circuit immediately for explicit capacity, rate-limit, or model-unavailable responses and treats Codex `Bash` and desktop `exec_command` as the same delegation tool family.
- Adds short-lived CLI delegations so ordinary executors attach their own registered Session and auditable CLI Run to one formal parent task instead of creating duplicate formal subtasks.
- Enforces delegation workspace, TTL, optional tool allowlist, and file-tool scope boundaries; Shell execution requires explicit whole-workspace scope and never gains parent-task completion or acceptance authority.
- Adds platform-neutral v2 task contracts with structured acceptance criteria, optional execution environments, verification plans, versioned Workspace Policy, and legacy migration without rewriting history.
- Adds generic SubjectReference and ActorIdentity models, append-only Requirement Results, Verification Claims, Review Attestations, Acceptance Records, derived stale events, and machine-readable completion readiness.
- Adds Session-free core events, offline evidence import with occurrence/recording timestamps, JSON/Markdown exports, and an independently token-protected generic acceptance API; Context remains a compatibility adapter and `done_claimed` never auto-promotes to `accepted`.
- Adds MCP tools for subject updates, requirement/verification/review reporting, evidence import, readiness, export, Completion Packet, and independently authorized acceptance; TaskCenter availability is not a build/test/commit/release prerequisite.
- Replaces implicit full-session scanning with a fail-closed Session allowlist that filters files before JSONL parsing.
- Migrates only explicitly listed IDs from legacy `all` / `selected` selection files and keeps unapproved message bodies, cwd values, and summaries out of dashboard data.
- Adds a local reflection loop that derives auditable improvement proposals from aggregate allowlisted data and the task ledger without copying Session text or modifying source automatically.
- Adds manual accept, reject, and re-review actions for reflection proposals plus isolated persistence and cross-platform tests.
- Turns accepted proposals into idempotent formal tasks, then dispatches them to a selected existing or newly created Codex Session while preserving the Hook gate.
- Tracks proposal, task, Session, and dispatch linkage; Agent-completed improvements resolve when a new reflection pass no longer detects the signal, otherwise they reopen for review and can be manually returned when incomplete.
- Removes the default pending-review queue and per-task approval action: `done_claimed` appears as completed, while manual reject remains available for later corrections.
- Separates delivery deadlines (`dueAt`) from estimated active effort, tracks wall/active/blocked durations and estimate revisions, and keeps `expectedAt` as a legacy compatibility alias.
- Stops promoting legacy `expectedAt` values into delivery deadlines; only an explicitly recorded `dueAt` can produce delivery-overdue status.
- Emits idempotent Agent-facing calibration feedback for schedule lateness or active-effort overruns, while legacy tasks without segment evidence report active effort as unknown instead of reusing wall-clock time.
- Adds delivery delay, active-effort variance, and blocked ratio to aggregate planning reflection evidence and turns estimation calibration into explicit improvement-task acceptance criteria.
- Separates the empty-allowlist setup prompt from Agent improvement tasks, removes review/dispatch actions from that prompt, and dismisses it immediately after a non-empty allowlist is saved.
- Recognizes RTK-wrapped read-only inspection commands in the Hook while continuing to reject wrapped writes, shell control operators, and output-producing Git options.
- Adds a separate fail-closed Hook gate-exemption allowlist so explicitly selected Sessions may work without an active task while command safety checks remain enforced.
- Adds a Codex `UserPromptSubmit` preparation hook that tells non-allowlisted Agents to create or reactivate a formal task before their first write, while keeping exact Session allowlisting as the only task-gate exemption.
- Adds a Node-based cross-platform service controller with managed heartbeats and graceful stop requests for macOS, Linux/WSL2, and native Windows.
- Removes POSIX environment assignments and shell glob expansion from build and test scripts.
- Moves Hook recovery to the Node controller and covers PowerShell and Command Prompt interactive-process forms.
- Resolves standard Windows npm `codex.cmd` shims without interpolating prompts through a command shell.
- Adds `windows-latest` CI coverage and platform-neutral Context launcher tests.

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
