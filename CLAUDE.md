# TaskCenter Claude Code Guide

Follow [AGENTS.md](AGENTS.md) for the project safety boundary and task gate.

TaskCenter is local-only. Never read authentication material, never write to Codex session storage, and never upload session content. Before changing files, register the real Session and create a formal TaskCenter task through MCP. A completion report remains `done_claimed` until a human accepts it.

Run the complete verification before reporting completion:

```bash
npm run sync
npm run lint
npm test
git diff --check
```
