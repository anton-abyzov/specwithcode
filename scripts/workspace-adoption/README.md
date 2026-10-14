# Existing workspace adoption

In project settings → Environment, enter a SpecWeave workspace folder, preview the registered checkouts, then explicitly import the ready rows. The source is `.specweave/config.json` → `workspace.repos` (`id`, relative or absolute `path`, optional canonical `identity` or legacy `sync.github`). Folders outside the project's main folder need an existing additional-folder grant. Import does not grant access, create projects, move files, clone repositories, run providers, or change plan authority.

Preview checks the real checkout root and credential-free origin, preserves an existing attachment's ID, and treats distinct checkouts of the same remote as separate resources. Partial imports show exact ready/blocked counts and keep blocked rows after apply. Limits remain explicit: 32 attached repositories, 256 inventory rows, and a 256 KiB config. Oversized inventory is rejected, never truncated. A local-only Git checkout without an origin stays blocked as a repository; it can be used through an approved additional folder. No remote URL is invented.

Apply repeats the inspection and requires the same receipt and project revision. The normal project mutation persists only inspected additions; its internal guard rejects path normalization changes. Source/grant/symlink changes require a new preview. Planning remains independently configured: bind a canonical SpecWeave planning root in Plan after approving its folder. Revoking the grant makes plan reads fail while retaining the binding for explicit recovery.

## Reproduce verification

Use this checkout's pinned dependencies and Node 22.20.0:

```sh
node scripts/workspace-adoption/verify.mjs
STUDIO_CHROMIUM_EXECUTABLE=/absolute/installed/headless-chromium node scripts/workspace-adoption/verify.mjs --full
```

The focused tests exercise real temporary Git repositories and SQLite project events, native-plan/ID/settings preservation, repeat/stale apply, partial capacity, permissions, and symlink replacement. Coverage includes the importer, apply adapter, planning reader and import UI; its unit threshold is 60%. Production web/server builds and server type checking run with `--full`. `STUDIO_COVERAGE_MODULE` can point to a separately installed matching `@vitest/coverage-v8/dist/index.js`; the default uses the existing isolated toolchain. The runner only links that provider into this checkout's ignored dependencies; it does not alter the lockfile.

The browser fixture renders the real import component and real settings styles with synthetic callbacks. It explicitly uses headless Chromium, disables debug/HTML auto-open, blocks external requests, and checks preview/apply at 360/1280 px in light/dark themes. It proves component behavior and layout; backend persistence is covered separately by the integration tests. It does not prove a live installed app or provider session. Logs, coverage, eight screenshots, and receipts are saved under `.artifacts/workspace-adoption/`. Manual acceptance remains required before increment closure.
