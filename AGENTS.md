# TaskCenter Agent Rules

## Safety boundaries

- TaskCenter is a local-only task governance tool. Do not add remote upload of session content without a separate privacy and authentication design.
- Read Codex session data only from `~/.codex/sessions/**/*.jsonl` and `~/.codex/session_index.jsonl`.
- Never read `~/.codex/auth.json`, API keys, cookies, or other credentials.
- Never modify files under `~/.codex`; user-owned integration config changes require explicit user action.
- Treat an assistant's `done_claimed` status as an implementation claim, not acceptance.

## Required workflow

Before changing project files in an MCP-enabled session:

1. Call `taskcenter_session_register` with the real session ID, workspace, agent, provider, and model.
2. Call `taskcenter_task_create` with a goal, plan, and acceptance criteria.
3. Continue only after `accepted=true` and a distinct `task_id` are returned.

If TaskCenter MCP is unavailable, restrict work to read-only inspection and report `TASKCENTER_UNAVAILABLE`.

## Verification

```bash
npm run sync
npm run lint
npm test
git diff --check
```
