# Offline Gmail approval UI evidence

Renders the real GoogleAccountSettingsPanel and pending question/Markdown components with fictional state. Settings layout wrapper is stubbed; no account callbacks may execute. The question fixture follows the server contract; server tests exercise the actual question builder separately. This verifies rendering/disclosure, not live account or Gmail acceptance.

From repo root, Node22:

```
node node_modules/vite-plus/bin/vp build --config apps/web/tests/google-send-approval/vite.config.ts
PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never STUDIO_PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node apps/web/tests/google-send-approval/verify.mjs /absolute/evidence/directory
```

`STUDIO_CHROMIUM_EXECUTABLE` may name an installed Chrome binary. The verifier explicitly launches headless, blocks external traffic and never clicks account controls or Send. It checks desktop/narrow light/dark disclosure, all recipient fields, scrolling to the full-body tail, literal Markdown and overflow, saving screenshots and result.json.
