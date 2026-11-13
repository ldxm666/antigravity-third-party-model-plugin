# Architecture

## Application integration

The supported target is Antigravity Hub 2.31.2, an Electron shell with a native language server. This is a version-specific application integration, not a VSIX extension.

`patch/apply.mjs` backs up `app.asar`, preserves the original preload/localization code, adds a small main-process IPC module and injects the native settings page. It changes only `--cloud_code_endpoint`; `--api_server_url` remains the Google API origin. The archive is syntax/entry/unpacked-set/critical-byte checked before replacement. Existing backup files are not overwritten.

## Control plane and inference

Authentication, onboarding, user settings, account/tier/quota and other control-plane calls go to the fixed Google upstream. Successful read-only responses may be cached briefly per full request/account hash for network/5xx failures; explicit authentication and quota failures remain failures. No fabricated account or quota is used in production.

Official model inference remains raw Google traffic. Custom inference uses a provider-scoped model/effort identity, applies local capacity/effort settings, then translates to the selected provider protocol. Provider credentials and Google OAuth have separate routing paths.

## Models and configuration discovery

Native IDs include provider, model and effort. Enabled reasoning levels are the authoritative set; neither the configured default nor a name heuristic may add a level back to an explicit set. Legacy configuration migrates idempotently while retaining its default. Removed native scope IDs return an error instead of silently switching providers.

The original native menu components group these identities. A narrow runtime adapter extends parsing for follow-app, off, minimal and budget labels; official model parsing stays in place. Even a single enabled custom effort remains selectable through the native group.

Configuration discovery uses read-only provider model endpoints. Detail responses override list metadata, then a bounded catalogue fills known missing fields. Unknown values are retained and each field has provenance. Detail requests run at concurrency four with per-request and overall deadlines. The operation only returns a draft and does not add or persist unrelated models.

Context is a local text-token estimate. Output is capped to the configured maximum and remaining context. These settings do not increase actual provider capacity; exact tokenizer and image costs can differ.

## Native UI refresh

The settings section is mounted inside the original settings column. Provider IPC validates the sender, route/method allowlist, fixed loopback destination and body sizes. It does not open another application settings window.

After saving, the page calls the native cloud model service, obtains a native protobuf UserStatus and dispatches the native Redux update. It does not reload the route or remount the conversation/input. DOM/context/action anchors are version-dependent and fail with a visible compatibility error when unavailable.

## Distribution and local data

The one-click installer copies curated files into a persistent per-user directory. If needed, it obtains a fixed official Node distribution and verifies its embedded SHA-256 before extraction. Archive tooling is pinned to `@electron/asar` 3.4.1. No Antigravity binaries, installed provider configuration or runtime secrets are distributed.

Keys remain plaintext in the separate local configuration directory. Normal API responses mask keys. Raw prompt capture is off by default and can be explicitly enabled only for local diagnostics. See [SECURITY.md](../SECURITY.md).

## Verification boundaries

Unit/HTTP tests use local upstreams and isolated config homes. Installer tests use a generated temporary application archive with integrations/start disabled. They do not modify the real application or profile. The optional real-LS fixture validates protocol parsing, not real Google login; native UI and real-account behavior are separate manual/integration checks.
