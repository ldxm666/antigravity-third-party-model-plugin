# Changelog

## 1.5.6 — 2026-11-13 (local build; upstream latency unresolved)

- Follow the DSH adapter's reasoning-field compatibility: forward `reasoning_text` and readable `reasoning_details` immediately, without duplicate aliases or encrypted blocks.
- Keep standard `reasoning_effort` on generic OpenAI-compatible relays. Only Google's own compatibility endpoint uses Google's thought-summary extension; a Gemini model name alone does not establish protocol support.
- Treat premature EOF and thought-only terminal replies as failures. Do not execute tool arguments from an unterminated response. Abort a failed chunk-framed HTTP stream instead of presenting clean EOF to the native executor.
- Add an inline status inside the native composer, scoped to the current cascade: waiting for upstream headers, receiving thoughts/text, and incremental tool-argument counts. This is transport telemetry, not generated model text. It does not reduce upstream time to first byte.
- Preserve explicitly configured output ceilings and reasoning selections. The controlled native UI fixture displayed text in about one second; a DSH-inspired real-provider request still took about 128 seconds to its first bytes. Provider-side buffering remains unresolved.
- Native desktop validation: early text in 1.012 seconds; incremental tool progress in 1.006 seconds; a partial-stream failure ended with one request and a visible native error in 1.016 seconds. A real CJMS Argon task still failed after 180 seconds without headers or bytes; do not interpret fixture success as provider latency improvement.

## 1.5.5 — 2026-11-13

- Forward OpenAI-compatible JSON/full-message replies and terminate streams at `[DONE]` even when the relay keeps the socket open. Preserve early text/thought forwarding and reject incomplete tool JSON or empty output-budget exhaustion.
- Preserve Gemini thought-summary preferences and selected reasoning levels through Google's OpenAI compatibility extension, without conflicting reasoning controls.
- Honor explicitly saved native-agent output ceilings instead of a stale 8192-token request default; preserve existing capacities and use known official catalogue values before generic new-model prefill.
- Record first upstream headers/bytes/content and forwarding phases without logging generated text. Keep semantic stream inactivity bounded even when a relay sends only heartbeat comments.
- Add regression and HTTP streaming coverage. Provider response latency and native partial-output recovery remain separate limitations; this release does not promise instant first tokens.

## 1.5.4 — 2026-11-13

- Show native errors and stop hidden API retries for third-party models; leave Google retry behavior and native output-truncation recovery unchanged. Preserve protobuf message types, caller objects and native client bindings.
- Preserve original Gemini parts, including thought signatures, signature-only chunks and function-call IDs, across streaming and complete responses.
- Keep the timeout active while consuming a Gemini JSON stream fallback, and retain an explicit thought-summary preference when overriding reasoning levels.
- Add seven regression checks, an isolated native failure-path check and a live HTML file-generation acceptance check. Document that an unresponsive upstream remains an external limitation.

## 1.5.3 — 2026-11-13

- Reject maximum output equal to or larger than the context window in both settings interfaces and the provider-save API. This prevents a native planner startup failure before inference.
- Validate a detached model candidate before updating provider fields, preserving names, secrets, mappings and the configuration file on a rejected save.
- Keep inconsistent discovery metadata visible with a warning instead of silently capping output to the entire context window.
- Add boundary and persistence regression tests and document slow generation versus a stalled stream in Chinese and English.

## 1.5.2 — 2026-11-13

Branding and documentation release.

- Rename the public project to **Antigravity 第三方模型插件 / Antigravity Third-Party Model Plugin**.
- Update the repository address, bilingual banner, README, package metadata and download filename.
- Keep the existing provider configuration paths and runtime behavior.

## 1.5.1 — 2026-11-13

First public Windows release.

- Add one-click installation with pinned official Node.js download and SHA-256 validation, a persistent installation directory and rollback entry.
- Disable raw prompt capture by default; retain explicit opt-in for local diagnostics.
- Package only curated source, examples and anonymized UI screenshots; exclude local configuration, captures, account data and machine-specific paths.
- Add Chinese/English documentation, isolated installer validation and read-only CI.

## 1.5.0 — 2026-11-13

- Replace fixed reasoning presets with per-model multi-select availability and a default drawn from that set.
- Extend the native effort menu to follow-app, off, minimal, budget and existing levels; display only enabled options, including a single enabled level.
- Add configuration discovery from model detail/list metadata with bounded concurrency and conservative catalogue fallback. Preserve unrecognized values and show field provenance.
- Keep discovery changes in a draft until saved; never auto-add the provider's entire model list.
- Preserve default reasoning during legacy migration and reject removed scoped model/effort selections instead of silently rerouting.

## 1.4.0 — 2026-11-13

- Embed provider settings in the original application panel, with provider-scoped model identities and native model refresh.
- Add selection after fetching models, per-model capacity settings and blank-key preservation.
- Forward genuine Google authentication/control-plane responses; separate third-party generation deadlines from connectivity probes.
