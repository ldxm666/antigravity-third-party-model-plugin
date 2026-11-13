# Changelog / 更新记录

## 1.0.0 — 2026-11-13

正式发行从 **1.0.0** 统一编号，整合前期开发中的功能与修复。版本重新编号不撤回功能，已有提供商配置继续兼容。旧开发版下载由本正式版替代。

Official versioning starts at **1.0.0**, consolidating the earlier development builds. Existing provider configurations remain compatible; previous development downloads are superseded by this release.

### Native integration / 原生接入

- Embed provider management in the application's settings and configurable reasoning in its native model submenu.
- Support OpenAI-compatible Chat Completions, Anthropic Messages and Gemini, with provider-scoped identities and live model refresh.
- Open a selection dialog after model discovery; add only confirmed entries to the draft.
- Discover context/output limits, image support and reasoning availability from model detail/list metadata with conservative catalogue fallback and visible sources.
- Respect saved output limits and per-chat reasoning selections. Reject output ceilings that consume the entire context window before changing saved configuration.

### Streaming and error handling / 流式与错误处理

- Forward readable reasoning aliases, support JSON/full-message replies and terminate at `[DONE]` without waiting for a lingering socket.
- Keep standard `reasoning_effort` for generic OpenAI relays; restrict Google-specific extensions to Google's own compatible endpoint.
- Validate complete tool arguments and normal stream termination before execution; fail clearly on premature EOF and empty budget-exhausted responses.
- Preserve Gemini thought signatures and function-call IDs. Expose real transport phases and counts inside the native composer without logging generated text.
- End third-party API failures with visible native errors and manual retry controls, preserving Google retry behavior and native output-truncation recovery.
- Isolate provider HTTP 401/403 from Google authentication by reporting upstream `502 UNAVAILABLE` while preserving the original status and error detail. Genuine Google authentication errors remain unchanged.

### Distribution and verification / 发行与验证

- Provide a Windows x64 one-click ZIP, SHA-256 checksum, Chinese/English guides, controlled example screenshots and rollback instructions.
- Negotiate native settings compatibility separately from the public version number so the new 1.0.0 release is not mistaken for an obsolete bridge.
- Run 276 local checks: 81 unit/HTTP/UI/release-compatibility, 156 protocol and 39 fresh-configuration regressions. Isolated installation, upgrade, profile preservation and byte-exact rollback are verified separately.
- Package curated source only. Exclude provider keys, account data, logs, real captures and application binaries. Raw request capture remains disabled by default.

### Known limits / 已知边界

- Verified application: Windows x64, Antigravity Hub 2.31.2. A working Google login and authorized provider API access are required.
- Upstream latency is not guaranteed. Controlled native fixtures and one real short reply succeeded; real long tasks can still wait for provider buffering or hit the 180-second first-response deadline. Stream inactivity defaults to 120 seconds.
- Remote GitHub Actions is not enabled; published check counts describe local validation.
