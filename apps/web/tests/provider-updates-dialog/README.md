# Provider updates dialog fixture

Renders the real `ProviderUpdatesAction` dialog for a Codex update with fixture-only machines: one connected Linux machine with a long npm installer command, one offline Mac and one machine without a provider snapshot. Nothing is installed or updated. It checks, at desktop and phone sizes in light and dark, that every line of text keeps 16px from the dialog edges, that the title and the update button keep their insets, that each machine's checkbox lines up with its first line, and that nothing overflows horizontally. It does not prove the update itself.

From the repository root, using the documented Node 22.20 runtime:

```sh
node node_modules/vite-plus/bin/vp build --config apps/web/tests/provider-updates-dialog/vite.config.ts
STUDIO_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node apps/web/tests/provider-updates-dialog/verify.mjs /absolute/owned/report-dir
```

To check Linux rendering from a Mac, run the same verifier in `mcr.microsoft.com/playwright:v1.60.0-noble` with the built site mounted and `STUDIO_FIXTURE_SITE=/site STUDIO_FIXTURE_PLATFORM=linux`. The runner always uses `headless: true`, `PWDEBUG=0` and `PLAYWRIGHT_HTML_OPEN=never`, serves the build on an ephemeral loopback port, blocks external requests and saves screenshots plus `receipt-<platform>.json` to the report directory (default `.artifacts/provider-updates-dialog/evidence/`).
