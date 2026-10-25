# Thread row meta line

The headless fixture renders the production Threads pane with synthetic threads like the October 23 report: a Codex thread running on a usage-limit fallback for Opus 5.5, another whose turn runs on a model other than its saved one, and plan, Unplanned, pull request and machine chips. Increment progress and the host's provider config are answered by `incrementProgress.ts` and `serverConfigs.ts` (wired in `vite.config.ts`); no host is involved.

At 360, 520 and 900 px, light and dark, `verify.mjs` checks that the chips of every meta line never overlap and stay inside the line, that the model name reads in full from 520 px, that the fallback or preferred state reads as text with an icon (no pill border, the full sentence as its accessible name and tooltip) and drops to the icon alone on narrow rows. It saves screenshots and a JSON receipt. `THREAD_ROW_MEASURE_ONLY=1` records a build without asserting, for a before capture.

Build with `node node_modules/vite-plus/bin/vp build --config apps/web/tests/thread-row-meta/vite.config.ts` from the repository root, then run `node apps/web/tests/thread-row-meta/verify.mjs /absolute/evidence-directory` with `STUDIO_PLAYWRIGHT_MODULE` (and optionally `STUDIO_CHROMIUM_EXECUTABLE`). The runner sets `headless: true`, `PWDEBUG=0` and `PLAYWRIGHT_HTML_OPEN=never`.
