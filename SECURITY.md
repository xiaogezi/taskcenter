# Security Policy

## Supported versions

Security fixes are provided for the latest release on the default branch.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub Security Advisories for the repository. Do not open a public issue containing exploit details, raw session transcripts, credentials, API keys, cookies, or local filesystem contents.

Include affected versions, impact, reproduction steps, and a minimal sanitized proof of concept. Maintainers will acknowledge the report, assess severity, and coordinate disclosure before publishing a fix.

## Security model

TaskCenter is designed for a single user on a local machine. The control service binds to `127.0.0.1`; the application is not hardened for public-network exposure, multi-user authorization, or remote storage. Deploying it remotely requires a new threat model, authentication, authorization, and session-data redaction design.
## Hook boundary

TaskCenter Hook is a limited workflow guardrail, not a process-level security sandbox. Codex does not emit a second `PreToolUse` event for `write_stdin` on an existing unified-exec session. The integration rejects known stdin-driven shell/REPL launch forms, but cannot prove that an arbitrary command will not become long-lived. Use Codex sandboxing and operating-system permissions for enforcement against a malicious or already-running process.
