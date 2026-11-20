# Failed provider check fixture

Renders the production Settings > Providers status row (`ProviderStatusRow`) for a Codex whose check failed: (a) only an exit code, (b) Codex's own reason for a broken install, (c) an expired sign-in. The command is shown from an fnm per-shell folder. Machine state and RPCs are the stand-ins from `../provider-install-step/mocks.tsx`; Check again and the repair buttons are recorded, not run.

From the repository root, using Node 22:

```sh
node node_modules/vite-plus/bin/vp build --config apps/web/tests/provider-probe-repair/vite.config.ts
STUDIO_PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node apps/web/tests/provider-probe-repair/shoot.mjs /absolute/owned/report-dir after
```

It is always headless and writes `<tag>-{light,dark}.png`, `<tag>-checking.png` (150 ms after Check again), `<tag>-checked.png` and `<tag>.json`.
