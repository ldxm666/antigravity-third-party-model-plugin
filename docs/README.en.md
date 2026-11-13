# Antigravity Third-Party Model Plugin

**Antigravity 第三方模型插件**

[中文](../README.md) · [Releases](https://github.com/ldxm666/antigravity-third-party-model-plugin/releases)

Native third-party provider settings and configurable reasoning menus for **Antigravity Hub 2.31.2 on Windows x64**. This independent community project requires a working Google login and your own authorized provider API access. It does not fabricate identities, subscriptions or quotas.

## Features

- Embedded provider settings inside the existing application settings panel.
- OpenAI-compatible Chat Completions, Anthropic Messages and Gemini adapters.
- A selection dialog after model discovery: new entries are unchecked, existing ones are marked, and only confirmed entries enter the draft.
- Per-model reasoning availability as a checkbox set. The native chat submenu shows exactly the enabled levels, rather than a fixed Low/Medium/High list.
- Model configuration discovery: detail endpoint → list metadata → conservative capability catalogue → preserve unknown values.
- Context/output limits, image support, per-model defaults and provider-scoped model identities.
- Native model refresh after saving, without reloading the conversation.
- Inline transport status in the native composer, matched to the current cascade: actual provider, waiting for upstream headers, text/thought reception and incremental tool-argument counts.

The local v1.5.6 build references [DeepSeek Harness's stream adapter](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-pi-ai/src/stream.ts) and [pi-ai's OpenAI adapter](https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/openai-completions.ts). It adds reasoning-field compatibility and checks for premature EOF. Transport status is separate from model output, and tools still require complete, validated arguments and a terminal response. Native fixtures showed text and incremental tool progress in about one second; a partial-stream failure ended with one request and a visible error. A real CJMS Argon task still failed after 180 seconds without headers or bytes, so upstream latency remains unresolved. The published download remains v1.5.4.

![Reasoning settings](screenshots/effort-settings.png)

## Install

1. Download and fully extract the Windows ZIP from Releases. Compare its SHA-256 with the release checksum file.
2. Run `install-oneclick.cmd`. It detects Node.js 24.5+ or downloads a pinned official runtime with checksum validation.
3. For the first application integration, fully quit Antigravity from its tray and reopen it once.
4. Open **Settings → 模型提供商**. Add your endpoint, protocol and key; fetch/select models, configure capabilities and save.

The installed files live under `%LOCALAPPDATA%\Programs\agy-bridge`. Provider configuration lives separately under `%LOCALAPPDATA%\agy-bridge` and contains plaintext API keys. Keep it private. Original request capture is disabled by default in v1.5.1.

Day-to-day model changes refresh without an application restart. Updating bridge code may require running `restart-bridge.cmd`. Application updates can break the version-specific native integration; check compatibility before patching again.

**Maximum output must be strictly smaller than the context window**, leaving space for input, conversation history and agent instructions. Equal values can stop the native planner before any provider request is sent. Since v1.5.3, both settings interfaces and the save API reject that combination without changing saved settings. Discovery preserves inconsistent endpoint values in the draft and warns you to review them.

Long-running tasks may involve several provider calls. A successful model-list request does not measure generation speed; compare a short reply and check redacted request durations before diagnosing a stuck bridge.

Since v1.5.4, API failures for third-party models end the current execution with the native error and manual retry controls instead of silently repeating a failed request. Google retry behavior and native output-truncation recovery remain unchanged. Default limits are 180 seconds for the first upstream response and 120 seconds of stream inactivity. This bounds failed attempts; it cannot make an unresponsive provider complete a task. The native Gemini adapter also preserves thought signatures and function-call IDs, and bounds JSON fallback bodies after early headers.

v1.5.6 forwards genuine text and readable reasoning aliases as they arrive, handles JSON/full-message replies, and ends at `[DONE]`. Generic OpenAI-compatible relays retain standard `reasoning_effort`; only Google's own endpoint opts into its thought-summary extension. Premature EOF, incomplete tool arguments and empty budget-exhausted replies fail explicitly. Failed local inference streams use aborted chunk framing so the native executor sees a transport error rather than successful EOF. Phase logs contain counts and timings, not generated content. Other native recovery paths, including intentional continuation after output truncation, remain unchanged.

Saved output limits take priority for native third-party agent requests, bounded by remaining context. A stale native 8192-token default no longer lowers an explicit saved setting. Direct API callers retain their smaller explicit request limits. Loading an existing model preserves its configured capacity; automatic configuration shows endpoint or known-catalogue sources, and generic prefill values are not claims about provider support.

For a custom application path, pass `-AsarPath` to `install/oneclick.ps1`. For rollback, use `uninstall-keep-config.cmd`; custom paths must be restored explicitly first. Read the [full tutorial](QUICKSTART.md), [security policy](../SECURITY.md) and [architecture](ARCHITECTURE.md).

## Develop

```text
npm ci
npm test
npm run test:installer   # Windows, isolated archive fixture
npm run build:release    # Windows ZIP and SHA256SUMS.txt
```

MIT licensed. Protocol-bridge design reference: [Cute-chen/agy-bridge](https://github.com/Cute-chen/agy-bridge). See [third-party notices](../THIRD_PARTY_NOTICES.md). No application binaries or provider credentials are distributed.
