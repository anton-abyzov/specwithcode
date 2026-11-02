# Team rules headless fixture

Renders the real Team rules section, locks, permission notices, machine drift and copy against a simulated machine summary. No server and no machine rules file.

Views: `settings`, `menu`, `above`, `hold`, `reach`, `tools`, `drift`, `carried`. `reach`, `tools` and `drift` take `rules=none` for the machine without a rules file.

Build from `apps/web`: `node ../../node_modules/vite-plus/bin/vp build --config tests/team-rules/vite.config.ts`. Run from the worktree root with `PLAYWRIGHT_MODULE` and `PLAYWRIGHT_EXECUTABLE_PATH` set: `node apps/web/tests/team-rules/verify.mjs <outdir>`.
