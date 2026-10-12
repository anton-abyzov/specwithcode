# Featured provider UI fixture

This renders the production featured-provider and configured-agent repair components with controlled registry metadata and fixture-only commands. The fixture Vite transform injects mocks only into AcpRegistryRepair; production builds keep the real environment commands. It never installs a CLI, signs in or sends a provider turn. It verifies responsive styling, keyboard interaction, exact environment/instance routing, repair error handling and the absence of automatic installation; it does not prove account entitlement or full wizard acceptance.

From the repository root, using the documented Node 22.20 runtime:

```sh
node node_modules/vite-plus/bin/vp build --config apps/web/tests/featured-providers/vite.config.ts
STUDIO_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node apps/web/tests/featured-providers/verify.mjs
```

If Playwright's matching Chromium is absent, supply `STUDIO_CHROMIUM_EXECUTABLE` pointing to an installed headless Chromium binary. The runner always uses `headless: true`, `PWDEBUG=0` and `PLAYWRIGHT_HTML_OPEN=never`; it owns an ephemeral loopback server, blocks external requests and closes both browser and server. Screenshots and the receipt are saved under `.artifacts/featured-providers/evidence/`.
