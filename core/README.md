# Bridge core

Node.js 24.5+ / ESM / built-in modules only. The top-level [README](../README.md) and [architecture](../docs/ARCHITECTURE.md) describe installation and integration.

## Run and test

```sh
node core/index.js
npm test
npm run test:installer   # Windows, isolated temporary application archive
npm run test:ls          # Optional: requires a locally installed language server
```

Tests use temporary configuration homes and local HTTP fixtures. The optional LS test verifies protocol handling under a controlled fixture; it does not establish genuine Google login acceptance. Test fixtures are never imported by the production bridge.

## Responsibilities

| File | Responsibility |
|---|---|
| `index.js` | Startup, shutdown and loopback listener |
| `server.js` | Generation routing, local configuration API and static diagnostic UI |
| `bootstrap.js` | Genuine Google control-plane forwarding, scoped cache and model catalogue extension |
| `config.js` | Configuration normalization, atomic persistence, masking and model resolution |
| `model-schema.js` | Enabled reasoning levels and valid defaults |
| `model-capabilities.js` | Read-only metadata discovery, conservative catalogue and field provenance |
| `model-settings.js` | Context estimates, output limits and protocol-specific reasoning settings |
| `providers/` | OpenAI-compatible, Anthropic and Gemini adapters |
| `translate.js`, `sse.js` | Wire-format conversion and incremental streaming |
| `capture.js`, `log.js` | Optional raw capture and bounded diagnostic logging |

## Routing and identity

Google login, account, tier, quota and unsupported control-plane methods are forwarded to Google. Successful short-lived cache entries are scoped to the same identity and request; authentication errors invalidate them. The production bridge does not generate local account or entitlement responses.

Configured models extend the original model catalogue. Native picker IDs include provider, model and effort, so equally named models from different providers remain distinct. A removed scoped model or reasoning level fails explicitly rather than silently selecting a different provider.

Third-party generation uses only that provider's API key. Google credentials are not sent to provider adapters. The context estimate is a local guard, not an exact provider tokenizer or an increase to upstream capacity.

## Local API

- `GET /api/health`: readiness and version.
- `GET /api/state`, `GET /api/providers`: masked configuration views.
- `POST /api/providers`, `PATCH /api/providers/:id`, `DELETE /api/providers/:id`: explicit configuration writes.
- `POST /api/providers/preview`: test, fetch models or configure a draft before saving.
- `POST /api/providers/:id/test`, `POST /api/providers/:id/fetch-models`: saved-provider discovery.
- `POST /api/active`, `POST /api/model-map`, `POST /api/reload`: default route, manual aliases and disk reload.
- `GET /api/logs`: bounded diagnostic entries.

Blank or masked keys on an existing provider preserve the stored key. Draft discovery does not save, add unselected models or generate a test conversation. See `server.js` for exact response shapes.

The data directory is `%LOCALAPPDATA%\agy-bridge`; `AGY_BRIDGE_HOME` overrides it for isolated testing. Provider keys are stored in plaintext locally. Raw request capture is **off by default** and requires `capture_requests: true`. Do not publish configuration files, raw captures or unredacted logs.
