# Provider auto-enable notice fixture

Renders the production provider card for a provider the server turned on at startup, in list and editor modes. It checks that the notice shows, that the row's select overlay does not swallow the Undo click, and that Undo turns the provider off and hides the notice. It does not run the server's CLI probes; those are covered by `apps/server/src/provider/providerDiscovery.test.ts`.

From the repository root, using Node 22:

```sh
node node_modules/vite-plus/bin/vp build --config apps/web/tests/provider-auto-enable/vite.config.ts
STUDIO_PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node apps/web/tests/provider-auto-enable/verify.mjs
```

The runner is always headless (`PWDEBUG=0`, `PLAYWRIGHT_HTML_OPEN=never`), blocks external requests, and saves screenshots and a receipt under `.artifacts/provider-auto-enable/evidence/`.
