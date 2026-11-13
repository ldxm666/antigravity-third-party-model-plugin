# Changelog

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
