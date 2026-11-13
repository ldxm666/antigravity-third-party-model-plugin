# Contributing

Thanks for helping improve the Windows integration. Keep changes focused and explain the problem, resulting behavior and validation in your pull request.

1. Install Node.js 24.5+ and run `npm ci`.
2. Run `npm test`; it uses isolated homes and local mock upstreams, without your provider key.
3. On Windows, run `npm run test:installer` to exercise an isolated application-archive fixture. This must not install into your real profile, create shortcuts or terminate processes.
4. For UI changes, use a disposable provider, verify the native menu, check a screenshot and remove the fixture afterward. Confirm the original provider configuration and input draft are preserved.

Do not commit `node-path.txt`, runtime configuration, tokens, OAuth files, raw captures, application binaries or account screenshots. All production Google authentication and quota responses must remain genuine. Do not add identity fabrication or quota-bypass behavior.

The Hub integration currently targets 2.31.2. A new application version needs explicit anchor, native context and rollback validation; do not silently replace the entire application window to hide a compatibility failure.

Pull requests are licensed under the repository's MIT license. Preserve third-party attribution and report security issues privately.
