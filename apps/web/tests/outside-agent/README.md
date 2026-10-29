# Outside-agent UI verification

Run from the repository root with Node 22 and installed workspace dependencies:

```sh
node_modules/.bin/vp build --config apps/web/tests/outside-agent/vite.config.ts
PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never node apps/web/tests/outside-agent/verify.mjs
```

The verifier launches headless Chrome, checks eight combinations of light/dark theme,
390/1280-pixel width and direct/relay route, and saves screenshots, traces and a JSON
receipt under `.artifacts/outside-agent/evidence`. Set `STUDIO_CHROMIUM_EXECUTABLE`
to use another Chrome/Chromium executable; it remains headless.

The badges and readiness checklist are production components. The fixture compiles
the unmodified private `SavedBackendListRow` body from `ConnectionsSettings.tsx`
with production menu, clipboard and URL-selection code. Only transport/readiness
state and unrelated controls are isolated. No installed server, real account,
provider call or live fleet operation is used. This verifies UI behavior, not
installed-device acceptance or live authentication.
