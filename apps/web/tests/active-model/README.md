# Thread model identity

The thread summary supplies `modelIdentity.current` and its optional `preferred` model. Lists, the worker composer trigger and the fallback banner display those persisted facts. Local composer drafts continue to select the next message. An explicit choice is labeled `Next`, independently of the active chip and saved preference.

The trigger provider mark, quota, tooltip and accessibility text describe the same active model. Its menu keeps the next-message selection. Older hosts without the optional summary field retain the existing thread-selection fallback.

The headless fixture renders the real list badge and composer with synthetic providers. It compares their active and preferred labels in light and dark themes, including fallback, an old explicit draft, a running turn, and manual next-message choices. The projection test compares compact SQL shell reads against full detail projection through return, queued work, tied continuation timestamps and provider/selection mismatch.

Build with `node node_modules/vite-plus/bin/vp build --config apps/web/tests/active-model/vite.config.ts`, then run `node apps/web/tests/active-model/verify.mjs /absolute/evidence-directory` with `STUDIO_PLAYWRIGHT_MODULE` and `STUDIO_CHROMIUM_EXECUTABLE` pointing to an installed Playwright module and headless Chromium. The runner explicitly sets `headless: true`, `PWDEBUG=0` and `PLAYWRIGHT_HTML_OPEN=never` and saves screenshots and a JSON receipt.
