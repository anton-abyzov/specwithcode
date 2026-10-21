# Assistant per machine fixture

Renders the production `StudioSidebar` and Run on menu (`DraftMachinePicker`) with the real assistant rules (`src/studio/personalAssistant.ts`, `runOnMachineGroups` in `src/studio/addToMachine.ts`) and the real machine naming, against a simulated fleet: "Studio Mac" (this machine, `m4`) and "Anna's MacBook" (`anna`, a nickname over its host label). Every project is fictional and lives under `/fixtures/`. `mocks.tsx` stands in for stores, routing, settings and RPC only; `vite.config.ts` names what it replaces.

Query flags: `view=sidebar|menu`, `machines=1|2`, `duplicate=1` (a pre-rule personal project on `m4`, created after its own), `project=personal|code` (menu), `theme=light|dark`.

`verify.mjs` checks at 1280x900 and 390x844, light:

- two machines: the Overview lists two `Aide` rows, this machine's first, hinted "Studio Mac" and "Anna's MacBook"; no assistant is in Projects.
- duplicate: the later personal project on `m4` is hinted "Studio Mac · extra" (not clipped) and listed after both machines' own assistants; `m4`'s own is hinted "Studio Mac".
- one machine: the single row has no hint.
- Run on for the assistant lists only Studio Mac and offers no "Add to another machine".
- Run on for a code project is unchanged: Anna's MacBook is addable with "Clone it there".

From the repository root, using Node 22:

```sh
cd apps/web && node ../../node_modules/vite-plus/bin/vp build --config tests/aide-per-machine/vite.config.ts && cd ../..
PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never STUDIO_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  node apps/web/tests/aide-per-machine/verify.mjs /absolute/owned/report-dir [--prefix 0981-]
```

The runner launches Chromium with `headless: true` (set `STUDIO_TEST_CHROMIUM` to pick a binary) and serves the build on an ephemeral loopback port. A page error fails the run. Screenshots and `receipt.json` (with `--prefix`, prefixed) go to the report directory (default `.artifacts/aide-per-machine/evidence/`).
