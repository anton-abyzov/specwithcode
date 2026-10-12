# Usage limit recovery card fixture

This renders the production `usageLimitRecoveryBannerItem` in the production `ComposerBannerStack`, inside the composer's own column and with the app's compiled CSS. The card has the most crowded real shape: a fallback provider, armed auto-resume, Check now, Snooze until reset and a status line. Its callbacks are no-ops; it never reaches a server or provider.

`verify.mjs` checks, at 320, 375, 768, 1024, 1440 and 1920 px in light and dark and with and without the status line, that "Usage limit reached" stays wider than 100 px and unclipped, that the reset text keeps its width and is shown in full (clock time included, nothing clipped, no details button needed), that no button covers the title or leaves the card, that the buttons sit below the title on phone widths, that the status line is under the buttons, and that the page has no horizontal overflow.

From the repository root, using Node 22.20:

```sh
node node_modules/vite-plus/bin/vp build --config apps/web/tests/usage-limit-recovery/vite.config.ts
STUDIO_PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node apps/web/tests/usage-limit-recovery/verify.mjs
```

If Playwright's matching Chromium is absent, set `STUDIO_CHROMIUM_EXECUTABLE` to an installed headless Chromium. The runner always uses `headless: true`, `PWDEBUG=0` and `PLAYWRIGHT_HTML_OPEN=never`, serves the build on an ephemeral loopback port, blocks other requests, and closes both browser and server. Card screenshots and `receipt.json` go to `.artifacts/usage-limit-recovery/evidence/`, or to `USAGE_LIMIT_UI_OUTPUT`.
