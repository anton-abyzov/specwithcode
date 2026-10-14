# Controlling-client provider device sign-in fixture

Build and run from the product root using existing dependencies:

```sh
PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never node node_modules/vite-plus/bin/vp build --config apps/web/tests/provider-device-auth/vite.config.ts
PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never STUDIO_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node apps/web/tests/provider-device-auth/verify.mjs
```

Use the toolchain supported by the installed Vite version (Node 24 in the release owner's current dependency cache). `STUDIO_CHROMIUM_EXECUTABLE` can point to an existing headless Chromium. No dependency installation is required.

This builds the real `ProviderAuthenticationSection` and its button/select/tooltip controls. The environment RPC/hooks, controlling-client browser/clipboard APIs, settings-scope container and terminal surface are fixture boundaries. The terminal fixture drives the production parent response queue. The fixture cannot call Studio, start a provider process, change credentials or launch an external browser. The runner blocks all external requests and explicitly launches headless Chromium. There is no HTML reporter to auto-open.

Coverage includes concurrent M1/M3 flows, exact destination instance/flow IDs, native terminal consent input, restoration after remount, read-only actions, standalone device-code compatibility, cancel/retry, expiry, unsupported-CLI errors, client action errors and pending/succeeded status. Desktop/mobile light/dark screenshots and the JSON receipt are saved under `.artifacts/provider-device-auth/evidence/`. These are component checks, not authenticated provider acceptance.
