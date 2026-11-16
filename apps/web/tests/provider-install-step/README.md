# Provider install step fixture

Renders the production Settings > Providers status row (`ProviderStatusRow`, and through it `ProviderInstallStep` and `CommandBox`) over synthetic `ServerProvider` objects, one labelled section per state:

- a. not installed on a Mac, from a server that reports `cli` (waiting for the install)
- b. installed, but it does not start (`cli.state: "broken"` with a found path)
- c. not installed on a Windows machine (PowerShell command)
- d. no known install command, with and without `setup.documentationUrl`
- e. an ACP registry agent, with the real `AcpRegistryRepair` block under its row
- f. an older server that sends no `cli`
- g. case a after the server reports it signed in
- h. case a over a read-only connection (the command to copy and the waiting line, no Run in terminal)
- i. signed in, with its plan (`auth.label`)
- j. installed and not signed in (`auth.status: "unauthenticated"`)

Each case's headline is read from the status row itself, not the section, so a missing headline fails the check.

Machine state, RPCs, the setup terminal and routing are simulated in `mocks.tsx`; the mocked imports are listed in `vite.config.ts`. Run in terminal and Check again are recorded, not run. It does not run the server's CLI probes or watch, so it proves the row's wording and controls, not that a real install flips it.

From the repository root, using Node 22:

```sh
node node_modules/vite-plus/bin/vp build --config apps/web/tests/provider-install-step/vite.config.ts
STUDIO_PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node apps/web/tests/provider-install-step/verify.mjs /absolute/owned/report-dir
```

The runner is always headless (`PWDEBUG=0`, `PLAYWRIGHT_HTML_OPEN=never`), blocks every request outside the fixture, and writes `install-step-{1280,390}-{light,dark}.png` and `results.json` to the report directory. It exits non-zero on any failed check or page error. `?theme=light` and `?theme=dark` choose the theme.
