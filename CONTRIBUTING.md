# Contributing to TaskCenter

Thanks for improving TaskCenter.

## Development setup

1. Install Node.js `>=22.13.0`.
2. Run `npm ci`.
3. Start the local stack with `npm run dev:live`.

The supported development shells are macOS/Linux shells, WSL2, and native Windows PowerShell or Command Prompt. Keep lifecycle and test scripts in Node.js; do not add POSIX-only environment assignment or shell dependencies to cross-platform npm scripts.

Keep all session handling local and preserve the privacy boundary documented in `README.md` and `AGENTS.md`.

## Before you commit

Local checks are the source of verification for this repository. The GitHub Actions CI workflow is disabled for both pushes to `main` and pull requests. After installing dependencies with `npm ci`, run these commands from the repository root.

```sh
npm run sync
npm run lint
npm run typecheck
npm test
npm run verify:production:isolated
npm audit --omit=dev
npm pack --dry-run
git diff --check
git diff --cached --check
```

Run the last check after staging your changes so it covers the patch you will commit. The isolated production check uses the build from `npm test` and verifies it with production dependencies. If the size budget has no baseline for your OS and Node.js/npm versions, record the failed budget check and the toolchain versions.

## Pull requests

- Keep changes focused and explain user-visible behavior.
- Add or update tests for behavior changes.
- Do not commit generated dashboard data, task ledgers, session IDs, absolute home-directory paths, credentials, or local Agent state.
- Include the local check results and the platform tested in the pull request.
- Treat `done_claimed` as an implementation claim; human review remains authoritative.

## Versioning and changelog

- `package.json` is the single source of truth for the TaskCenter version. `package-lock.json` and runtime clients must resolve the same value; do not duplicate a version literal in source.
- Use Semantic Versioning. Increment PATCH for backward-compatible fixes, MINOR for backward-compatible capabilities or any intentional compatibility break while the project remains `0.x`, and MAJOR for compatibility breaks after `1.0.0`. Documentation, tests, refactors, and deployment-only changes do not require a version bump unless they change a published contract or artifact.
- Keep exactly one `## Unreleased` section at the top of `CHANGELOG.md`. In the same commit, add a concise user-facing entry for changes to user entry points, public protocols, persistence, security boundaries, model roles, or release/deployment behavior. For other changes, the task or pull request must either update the changelog or explicitly record `changelog: not required` with the reason.
- A controlled deployment is not a version release. `npm run service:deploy` identifies the immutable runtime by Git commit; routine deployments continue to accumulate under `Unreleased` until a formal release is requested.
- For a formal release: choose the SemVer value, run `npm version <version> --no-git-tag-version`, rename the current `Unreleased` section to `## <version> - YYYY-MM-DD`, add a new empty `Unreleased` section, run the required checks, and commit as `release: v<version>`.
- Deploy the clean release commit with `npm run service:deploy`. Only after the deployment succeeds, create the immutable annotated tag `v<version>`. Never move or reuse a released tag. Pushes, remote tags, pull requests, and hosted releases require explicit user authorization.

## Reporting bugs

Include reproduction steps, expected behavior, actual behavior, operating system, Node.js version, and sanitized logs. Never attach raw Codex transcripts or authentication files.
