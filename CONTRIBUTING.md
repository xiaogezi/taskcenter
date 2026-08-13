# Contributing to TaskCenter

Thanks for improving TaskCenter.

## Development setup

1. Install Node.js `>=22.13.0`.
2. Run `npm ci`.
3. Start the local stack with `npm run dev:live`.

Keep all session handling local and preserve the privacy boundary documented in `README.md` and `AGENTS.md`.

## Pull requests

- Keep changes focused and explain user-visible behavior.
- Add or update tests for behavior changes.
- Do not commit generated dashboard data, task ledgers, session IDs, absolute home-directory paths, credentials, or local Agent state.
- Run `npm run lint`, `npm test`, `git diff --check`, and `npm audit --omit=dev`.
- Treat `done_claimed` as an implementation claim; human review remains authoritative.

## Reporting bugs

Include reproduction steps, expected behavior, actual behavior, operating system, Node.js version, and sanitized logs. Never attach raw Codex transcripts or authentication files.
