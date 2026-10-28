# Ultracode toggle

Claude models that support Ultracode get it as a separate boolean option beside reasoning effort, the way Claude Code's own composer shows "Opus 5.5 · Medium · Ultracode". The headless fixture renders the production composer with synthetic Opus 5.5 descriptors and checks the chip in light and dark themes: on, off, and a selection saved when Ultracode was an effort level. It opens the traits menu, turns Ultracode off and on again, and confirms the effort stays Medium.

Build with `node node_modules/vite-plus/bin/vp build --config apps/web/tests/ultracode-toggle/vite.config.ts`, then run `node apps/web/tests/ultracode-toggle/verify.mjs /absolute/evidence-directory` with `STUDIO_PLAYWRIGHT_MODULE` (and optionally `STUDIO_CHROMIUM_EXECUTABLE`) pointing to an installed Playwright module and headless Chromium. The runner sets `headless: true`, `PWDEBUG=0` and `PLAYWRIGHT_HTML_OPEN=never` and saves screenshots and a JSON receipt.
