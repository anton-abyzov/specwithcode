# SpecWithCode

Independent, MIT-licensed workbench for native coding agents. SpecWeave owns portable intent, claims and handoffs; the app owns sessions and control on each machine.

## Rules

- Public repository: never commit secrets, personal paths, machine names, customer data or private reports; keep them under `~/.specwithcode` or another folder outside the repository.
- Third-party code keeps its own license. Keep `THIRD_PARTY_NOTICES.md` and the notices in Settings complete; `node scripts/studio-brand-audit.mjs` checks it.
- In anything a person reads, say SpecWithCode, then "the app"; never "Studio". Code identifiers stay literal (`docs/studio/naming.md`).
- `.repos/` holds read-only reference trees: never edit, import, package or bulk-transform them.
- Production runs on Node 22.20.0 with pnpm 11.10.0; some builds need a separately scoped Node 24. Never change shared toolchains or provider installs to fix a build.
- Tests never touch live stores, credential folders or OAuth tokens: use a new private test home and a scratch repository. A check that must drive the live app creates its project with `origin: "automated"` and deletes it after.
- Never open, copy or delete a running service's database (`userdata/statev2.sqlite`, `-wal`, `-shm`), not even read-only; use `specweave-studio db query` or `db snapshot`. Server code never opens those files through `node:fs` (`docs/operations/live-database.md`).
- Browser checks run headless and save evidence to files outside the repository; a failure never authorizes a headed retry.
- Run the smallest focused test plus the web and server builds your change touches. No repo-wide tests, lint or typecheck unless asked (`docs/operations/heavy-checks.md`).
- Phone availability, restored native sessions and subscription capacity need real outcome evidence; a fixture does not prove them. Record what is unverified as a proof limit.
- Releases: `bash scripts/release/request-release.sh --by "<thread>"`; never choose a version or mark a release stable by hand (`docs/studio/releasing.md`).

## Architecture

WebSocket request -> command -> pure orchestrator -> events -> atomic sink (events, projections, receipts, outbox) -> effect worker does I/O and feeds results back as commands.

- Mutations use `createEnvironmentRpcCommand`; protected methods go in `CLIENT_GUARDED_RPC_SCOPES`; the destination machine checks grants at execution. Test both the UI gate and the server refusal.
- Read `docs/internals/effect-services.md` before adding an Effect service.
- In tests, drain `OrchestrationEffectWorkerV2` or await a persisted event; never sleep.
- Keep same-origin routing; never bake localhost `VITE_HTTP_URL`/`VITE_WS_URL` into a remote bundle.
- UI text, sizes, corners and colours come from the tokens in `docs/studio/design-guidelines.md`.
- Require manual acceptance only when the user or the increment's acceptance criteria ask for it.

## Commands

| Check                       | Command                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------- |
| Web typecheck               | `node node_modules/typescript/bin/tsc --noEmit --project apps/web/tsconfig.json`    |
| Server typecheck            | `node node_modules/typescript/bin/tsc --noEmit --project apps/server/tsconfig.json` |
| Web build (from `apps/web`) | `node ../../node_modules/vite-plus/bin/vp build`                                    |
| Server build                | `node apps/server/scripts/cli.ts build`                                             |
| One test file               | `node node_modules/vite-plus/bin/vp test run <file>`                                |

Headless fixtures and live verifiers: `docs/operations/checks.md`. Working copies: `docs/operations/worktree-cleanup.md`. Runtime identity and defaults: `docs/operations/development.md`.
