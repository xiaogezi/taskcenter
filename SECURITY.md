# Security Policy

## Supported versions

Security fixes are provided for the latest release on the default branch.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub Security Advisories for the repository. Do not open a public issue containing exploit details, raw session transcripts, credentials, API keys, cookies, or local filesystem contents.

Include affected versions, impact, reproduction steps, and a minimal sanitized proof of concept. Maintainers will acknowledge the report, assess severity, and coordinate disclosure before publishing a fix.

## Security model

TaskCenter is designed for a single user on a local machine. The control service binds to `127.0.0.1`; the application is not hardened for public-network exposure, multi-user authorization, or remote storage. Deploying it remotely requires a new threat model, authentication, authorization, and session-data redaction design.
