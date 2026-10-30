# Add provider dialog fixture

Renders the real `AddProviderInstanceDialog` with fixture-only environment state: the registry search returns a fixed list of real ACP Registry IDs with fictional versions, preparing and saving always fail, and nothing is installed or signed in. It checks that the footer action stays in view with "More agents" open at desktop, short and phone sizes in light and dark, that no content is wider than the dialog, that no registry row repeats a built-in or featured provider, that Grok Build is offered only while Grok is selected, and that searching for a built-in provider points back to its tile. It does not prove installation, sign-in or the later wizard steps.

From the repository root, using the documented Node 22.20 runtime:

```sh
node node_modules/vite-plus/bin/vp build --config apps/web/tests/add-provider-dialog/vite.config.ts
STUDIO_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node apps/web/tests/add-provider-dialog/verify.mjs /absolute/owned/report-dir
```

Set `STUDIO_CHROMIUM_EXECUTABLE` when Playwright's matching Chromium is absent. The runner always uses `headless: true`, `PWDEBUG=0` and `PLAYWRIGHT_HTML_OPEN=never`, serves the build on an ephemeral loopback port, blocks external requests and saves screenshots plus `receipt.json` to the report directory (default `.artifacts/add-provider-dialog/evidence/`).
