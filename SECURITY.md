# Security and privacy

## Report a vulnerability

Use the repository's **Security → Report a vulnerability** flow when available. Please do not include API keys, OAuth credentials, account files or complete chat captures in public issues. For ordinary bugs use the issue template and a redacted reproduction.

## Boundaries

- The bridge listens on `127.0.0.1`, with Host/Origin checks against DNS rebinding. Do not expose it through a tunnel, reverse proxy or LAN bind.
- Native settings IPC accepts only the existing Hub renderer, fixed loopback destinations, allowed routes/methods and bounded messages.
- Provider keys are local **plaintext** configuration in `%LOCALAPPDATA%\agy-bridge\config.json`. API/UI responses mask them. An empty key on edit preserves its existing value.
- Google OAuth headers are forwarded only to the fixed Google control-plane host. Third-party providers receive their own configured key.
- Raw request capture is **off by default**. Opting into `capture_requests: true` writes recent prompt bodies to local `captures/`; disable it again and remove captures after debugging.
- Short-lived read-only Google response caching never turns a 401, 403 or 429 into success. The bridge does not manufacture login identities, plans or quotas.

## Safe installation and credentials

Read `install/oneclick.ps1` before running it. It uses a pinned official Node archive and a fixed SHA-256, backs up the application archive, and does not terminate Antigravity or request administrator elevation. No `curl | shell` or remote script evaluation is used.

Keep GitHub credentials in GitHub CLI/SSH authentication, never in repository URLs, source, issues or logs. If using a PAT elsewhere, restrict repository access and permissions, use an expiration date, and keep two-factor authentication enabled. Revoke a credential that has been pasted into a public or shared context.

Use only provider accounts and application access you are authorized to use, and follow provider terms and rate limits. This project does not provide an authentication or subscription bypass. Automated retries should be bounded and failures investigated before retrying.
