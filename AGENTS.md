# SpecWithCode

SpecWithCode is an independent private workbench for native coding agents. SpecWeave owns portable intent, task claims and handoffs; the app owns environment-local sessions and control. MIT provenance remains in LICENSE and UPSTREAM.md.

## Naming

In anything a person reads (UI copy, docs, reports, commit and PR text), call the product SpecWithCode on first mention and "the app" after that, never "Studio" or "SpecWeave Studio". Branch, repo, path, package and tool names stay literal (`feat/studio-plan-progress`, `specweave-studio`, `studio_thread_list`). The identities that must not be renamed are listed in `docs/studio/naming.md`.

## Isolation and ownership

- Production runs use Node 22.20. Build tools may require a separately scoped Node 24 runtime; report that distinction. Never change shared toolchains or provider installs to fix a build.
- CLI: specweave-studio. Default loopback port: 8319. Private home: ~/.specwithcode for new installs; true legacy standalone ~/.specweave-studio/userdata or dev keeps precedence, otherwise an existing branded root survives managed identity installation; legacy-only roots and explicit STUDIO_HOME remain supported. Runtime options use `STUDIO_*` only; environment variables inherited from the upstream product are ignored and must never select an original install/store.
- Check active owners, branch, increment and ledger before claiming work. Preserve native sessions, services, schedules and dirty worktrees. Idle-looking metadata does not authorize takeover.
- Never point test servers at live stores, symlink credential folders, copy OAuth tokens or start provider turns while importing history. Use a new private test home and scratch repository; omit credentials, pending work and auth sessions from any explicitly authorized snapshot.
- Stop only the exact PID you spawned or an exact newly owned launchd service after verifying its identity. Never pattern-stop providers, apps or dev servers.
- Never open a running service's database (`userdata/statev2.sqlite`, `-wal`, `-shm`) with sqlite3, Python or Node, not even read-only, and never copy or delete those files while it runs: that can crash the service or lose its newest writes. Use `specweave-studio db query` or `db snapshot`, `scripts/studio-fleet/live_database.py` or `scripts/lib/live-database.mjs`. Server code never opens those files through node:fs. See docs/operations/live-database.md.
- Hosted relay/cloud and telemetry are disabled by default. Self-update is on by default but reads only the app's own release feed (never the upstream one); Settings > About and `SPECWITHCODE_DISABLE_AUTO_UPDATE=true` (legacy `STUDIO_DISABLE_AUTO_UPDATE`) turn it off. Direct private pairing remains. Never introduce upstream product endpoints or infer subscription entitlement.

## Browser verification

All automated browser tests, E2E, screenshots, recordings and scrapers explicitly use headless: true (Python: headless=True). Set PWDEBUG=0 and PLAYWRIGHT_HTML_OPEN=never; reporter open: never. Save evidence to files. No visible automation, Inspector, DevTools windows or personal browser. A failure never authorizes a headed retry.

## Focused checks

- Read the canonical SpecWeave increment, claim only the assigned task under your own identity and edit its files. One branch/worktree per lane.
- Run the smallest focused behavior/contract test and relevant production web/server build. No repo-wide tests, lint or typecheck unless requested.
- Physical-phone availability, restored native continuity and authenticated subscription capacity require actual outcome evidence; viewport fixtures, a fresh session and prepared slots do not prove them.

## Architecture

Typed WebSocket requests become commands. The pure orchestrator serializes commands and chooses events. The event sink atomically commits events, projections, command receipts and outbox effects. The effect worker performs I/O such as provider turns and checkpoints, feeding results back as commands. Git checkpoints support diff/restore.

- apps/server: auth/API/WebSocket, native adapters, orchestration and checkpoints. Read docs/internals/effect-services.md before adding Effect services.
- apps/web: React/Vite; desktop wraps web via Electron/IPC; mobile is separate React Native.
- packages/contracts: typed wire schemas and small derived helpers.
- packages/client-runtime: shared client commands, permissions, state and connections.
- packages/shared: focused utilities with subpath exports.
- .repos: inherited read-only references. Never edit, import, package or bulk-transform them.

Keep side effects at adapter/service boundaries, orchestration pure and transports thin. Mutations use createEnvironmentRpcCommand; protected methods belong in CLIENT_GUARDED_RPC_SCOPES. Destination environments authoritatively check grants at execution. Test UI permission availability and server rejection.

Drain OrchestrationEffectWorkerV2 or await a specific persisted event/Deferred in tests; do not hide races with sleeps. Preserve same-origin routing for local, SSH and private HTTPS clients. Do not bake localhost VITE_HTTP_URL/VITE_WS_URL into remote bundles.

Check chat, Settings, command palette, keybindings and reverse actions. Preserve native plans, approvals, queues, steering and checkpoints. Keep unknown quota/offline/errors explicit. Avoid continuously repainting animations and gratuitous state payloads. Use existing semantic UI variants; layout belongs to the parent.

Document changes to user tasks and durable architectural constraints, not copies of types. No publication, remote push or release service is implied by local implementation. New UI/auth needs concrete manual acceptance before increment closure.

## Commands

Releases: `bash scripts/release/release.sh <version>` (try `--dry-run` first); the runbook is docs/studio/releasing.md.

Focused ACP permission regression: `node node_modules/vite-plus/bin/vp test run apps/server/src/provider/acp/AcpPermissions.test.ts apps/server/src/provider/acp/AcpPermissions.lifecycle.test.ts apps/web/src/components/chat/unifiedPermissions.test.tsx`. Headless composer check: `node apps/web/tests/unified-permissions/check.mjs` (set `PLAYWRIGHT_MODULE` / `PLAYWRIGHT_EXECUTABLE` for a scoped installed runtime).

Use Node 22.20.0 explicitly and the isolated pnpm 11.10.0 toolchain. Paths below are relative to this repository unless a working directory is specified. Verification of saved receipts requires their retained local evidence; it is not live acceptance or a fresh build.

| Check                                               | Verified command                                                                                                                                                                                                                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native MCP matrix headless fixture                  | `node node_modules/vite-plus/bin/vp build --config apps/web/tests/connections-library/vite.config.ts`, then `node scripts/studio-verify/connections-library.mjs` (Node22; synthetic machine data, real matrix components)                                                                      |
| Headless isolated workspace/settings verification   | `node scripts/studio-workspaces/verify.mjs /absolute/owned/report-dir` (Node22; optional `STUDIO_TEST_CHROMIUM` points to an installed headless executable)                                                                                                                                    |
| Logical project behavior and focused coverage       | `node scripts/studio-logical-projects/check.mjs /absolute/owned/coverage-dir`                                                                                                                                                                                                                  |
| Logical project headless three-server verification  | `node scripts/studio-logical-projects/verify.mjs /absolute/owned/report-dir` (build web and server first; isolated synthetic stores, disabled providers)                                                                                                                                       |
| Run on: add to another machine, two real servers    | `node scripts/studio-fleet/add-to-machine-live.mjs /absolute/owned/report-dir` (build web and server first; paired with `fleet invite`/`fleet add` over a fixture Tailscale name, local bare origins, headless light and dark captures)                                                        |
| Headless provider picker fixture                    | `node node_modules/vite-plus/bin/vp build --config apps/web/tests/provider-usability/vite.config.ts` (Node24), then `node scripts/studio-verify/provider-usability.mjs` (Node22; optional `STUDIO_CHROMIUM_EXECUTABLE`)                                                                        |
| Headless question/decision card fixture             | `node node_modules/vite-plus/bin/vp build --config apps/web/tests/question-cards/vite.config.ts`, then `node scripts/studio-verify/question-cards.mjs /absolute/owned/report-dir` (Node22; optional `STUDIO_CHROMIUM_EXECUTABLE`, `STUDIO_PLAYWRIGHT_MODULE`)                                  |
| Headless inline shell code run fixture              | `node node_modules/vite-plus/bin/vp build --config apps/web/tests/shell-code-run/vite.config.ts`, then `node scripts/studio-verify/shell-code-run.mjs /absolute/owned/report-dir` (Node22; in-memory terminal)                                                                                 |
| Headless live activity fixture                      | `node node_modules/vite-plus/bin/vp build --config apps/web/tests/live-activity/vite.config.ts`, then `node apps/web/tests/live-activity/verify.mjs /absolute/owned/report-dir` (Node22; `STUDIO_PLAYWRIGHT_MODULE`)                                                                           |
| Headless sidebar live-update fixture                | `node node_modules/vite-plus/bin/vp build --config apps/web/tests/sidebar-stable-order/vite.config.ts`, then `node apps/web/tests/sidebar-stable-order/verify.mjs /absolute/owned/report-dir` (Node22; real StudioSidebar under 40 ms simulated updates; `--baseline` reports without failing) |
| Headless Status page fixture                        | `node node_modules/vite-plus/bin/vp build --config apps/web/tests/status-page/vite.config.ts`, then `node scripts/studio-verify/status-page.mjs /absolute/owned/report-dir` (Node22; synthetic history through the real catalog, feed parsers and history fold)                                |
| Light/dark text contrast (WCAG AA) headless audit   | `node scripts/studio-verify/theme-contrast.mjs /absolute/owned/report-dir` (build web and server first; optional `STUDIO_TEST_CHROMIUM`, `PLAYWRIGHT_MODULE`, `THEME_CONTRAST_PAGES=/a,/b`; `--baseline` reports without failing)                                                              |
| Web supported typecheck                             | `node node_modules/typescript/bin/tsc --noEmit --project apps/web/tsconfig.json`                                                                                                                                                                                                               |
| Server supported typecheck                          | `node node_modules/typescript/bin/tsc --noEmit --project apps/server/tsconfig.json`                                                                                                                                                                                                            |
| Web production build, working directory `apps/web`  | `node ../../node_modules/vite-plus/bin/vp build`                                                                                                                                                                                                                                               |
| Server production build                             | `node apps/server/scripts/cli.ts build`                                                                                                                                                                                                                                                        |
| Guarded private network-record transition tests     | `python3 -B scripts/studio-fleet/test-network-transition.py`                                                                                                                                                                                                                                   |
| Offline preload rollout provenance                  | `python3 -B scripts/studio-fleet/verify-preload-rollout-receipts.py --evidence-dir /absolute/retained/t20`                                                                                                                                                                                     |

Live workflow/browser runners live in scripts/studio-verify/. Run them only in assigned private test homes with exact ownership and cleanup. Saved browser/native receipts are not permission to issue another paid turn or alter a live account.
