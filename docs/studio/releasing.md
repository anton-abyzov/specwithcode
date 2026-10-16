# Releasing SpecWithCode

The runbook for a desktop and service release, plus how releases are versioned, named and published
and how rollback copies are kept. The update mechanics are in [updates](./updates.md); the kept
identities are in [naming](./naming.md).

## One command

```sh
bash scripts/release/release.sh 1.0.37 --dry-run              # every stage and command; runs and writes nothing
bash scripts/release/release.sh 1.0.37 --stop-after drafts     # everything up to the drafts; nothing published
bash scripts/release/release.sh 1.0.37 --resume                # continue: publish, fleet, desktop, merge
bash scripts/release/release.sh 1.0.37 --status                # stage markers and timings
```

Run it from a checkout of `anton-abyzov/specwithcode` on M4 with Node 22.20.0 installed
through nvm. A run stops at the first failing stage and prints the command to continue. `--resume`
skips every stage already done; `--self-test` checks the script itself with stubbed commands.

### Before the first release on a Mac

1. Copy `scripts/release/release.env.example` to `~/.config/skill-studio-release/release.env`,
   `chmod 600` it and fill in the paths and ids. It holds no secret: the certificate passphrase,
   the notarization key and the Google OAuth pair stay in their own mode-600 files that it names.
   Set `GOOGLE_OAUTH_SOURCE_ENV` once and preflight copies only the two Google lines out of that
   env file into `GOOGLE_OAUTH_ENV_FILE`.
2. The fleet inventory and key (`~/.local/share/specweave/fleet/`) and the public mirror rules
   (`~/.local/share/specweave/specwithcode-public/rules.json`) must exist.
3. The first run makes the persistent trees in `~/Projects/github/release.noindex/` (`build`,
   `test` and a clone of the public repository; the `.noindex` folder keeps Spotlight out of their
   `node_modules`). Set a GitHub noreply `user.email` in the public clone when preflight asks.

### Stages

State for a release lives in `~/.specwithcode/release-staging/<version>/`: `release.json`, a
marker per finished stage, `logs/<stage>.log` (appended, with a header per run, never
overwritten), `timings/stages.json` and the assets. release.sh refuses a staging folder it did not
make, and refuses to start a second run of a version without `--resume`.

| Stage           | What it does                                                                                                           | Runs again              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| preflight       | version policy, release.env and the files it names, toolchain, `gh auth`; drops anaconda from PATH; warns on high load | every run               |
| trees           | makes or checks the build, test and public trees                                                                       | every run               |
| prev            | downloads and checks the previous release's plan, helpers manifest and `SHA256SUMS`                                    | once                    |
| bump            | `release/<version>` from `main`, the version bump commit                                                               | once                    |
| candidate       | pushes the build tree's HEAD to `release/<version>`, checks it out in the test tree, cleans and installs both          | per candidate           |
| stage1          | contrast tests, every other package's tests, the typecheck gate and fleet tests, four at a time                        | per candidate           |
| server          | `test-sharded.mjs --shards 3` in the background, alongside build to drafts                                             | per candidate           |
| build           | the Google pair only, then `APP_VERSION=<version> vp run build:desktop`                                                | per candidate           |
| bundle          | `bundle.mjs`, `verify-bundle.mjs` on the archive, the Google sign-in check, all before signing                         | per candidate           |
| sign            | `build-desktop-artifact.ts --signed --skip-build` on the verified build, `mac-signature.mjs`                           | per candidate           |
| helpers         | `make_helpers.py`, compared with the previous manifest                                                                 | per candidate           |
| plan            | `SHA256SUMS`, `make_update_plan.py --previous-plan`, the plan added to `SHA256SUMS`                                    | per candidate           |
| drafts          | `notes.md`, both draft releases with every asset, a `publish.mjs` check without `--tag`/`--push`                       | per candidate           |
| server-wait     | waits for the server suite; when it failed, deletes both drafts                                                        | per candidate           |
| quit-desktop    | quits `/Applications/SpecWithCode.app` (TERM to its own pid)                                                           | until the desktop stage |
| publish-private | publishes the private release and checks the tag is the candidate                                                      | once                    |
| fleet-m4        | `fleet_rollout.py --only m4`: forced, held 15 minutes, until M4 runs the release                                       | once                    |
| fleet-workers   | `fleet_rollout.py --only workers`: M1 and M3 together, polled the same way                                             | once                    |
| publish-public  | `publish.mjs --tag --push`, then the public release                                                                    | once                    |
| desktop         | rollback zip, swap the app in `/Applications`, check its signature and version, open it                                | once                    |
| merge           | the `release/<version>` pull request into `main`                                                                       | once                    |

Preflight checks each file and value exists without printing any. The candidate stage fails when
`pnpm install --frozen-lockfile` would change `pnpm-lock.yaml`; stage 1 runs every workspace
package with a test script except the root and `apps/server`, so a new package cannot be left out.
Nothing is public before publish-public, and nothing installs anywhere before publish-private.

The plan passes `--allow-project-migrations` and `--allow-existing-browser-heartbeat` to
`update.py`, as the plans of 1.0.30 to 1.0.37 did. Without the first, a release that migrates
fails and rolls back on every host, also on one that skipped the migrating release.
`--no-project-migrations` leaves it out for `update.py`'s stricter whole-database check; give it
only when no host upgrades across a migration, on the run that reaches the plan stage.

### When a stage fails

Fix the cause in the build tree and commit there; the commit is the new candidate. Then run
`--resume`. The candidate stages run again for it: stage 1 runs the jobs that failed last time
first, then the rest; the signed build runs again; the server suite runs only the files vitest ties
to changes since its last green commit (`--changed`), or in full when `pnpm-lock.yaml` or
`patches/` changed. Once the private release is published the candidate is fixed: a later change
is the next version.

Commit new files with the fix: the candidate stage cleans the build tree, so a new candidate with
untracked files is refused before anything is deleted. The bump stage refuses a local
`release/<version>` that holds commits other than its own bump. When the server suite has already
failed, the drafts stage stops before any upload and deletes an earlier candidate's drafts.
`fleet_rollout.py` stops when a host reports that the install it asked for failed, and names the
receipt; that host stays on its old version. When publish-public's push failed after `publish.mjs`
tagged, `--resume` drops the tag left in the public clone, since the remote has none.

Edit `notes.md` in the staging folder while the suites run; publish-private and publish-public
take it as it is then, and the public copy is checked against the mirror's deny list.

### Timings

Each run appends per-stage start, end, result and attempt to `timings/stages.jsonl`, writes
`timings/stages.json` and prints it beside the previous release's, marking a stage `SLOWER` when it
took more than 25% and at least 10 seconds longer. A full green server run prints the command that
refreshes the recorded shard weights from its reports.

### By hand

`fleet_rollout.py --version <v> --dry-run` prints the rollout order and commands;
`update_request.py status --identity <id>` reads one host's updater state. For a host whose agent
cannot install a release on its own, copy the assets to `<studio root>/release-staging/<version>/`
on that host and run `/usr/bin/python3 -B scripts/studio-fleet/remote_update.py --identity <id>
--version <v> --runtime <runtime archive> --helpers <helpers archive>`; it checks the staged files,
backs up the database through `live_database.py` and runs the release's own `update.py`.

## Versions

The 0.1.x and 0.2.x releases were the alpha line. 1.0.0 is the first stable release and 1.x.y
follows it. `scripts/studio-projects/version.mjs` and `scripts/studio-fleet/release_policy.py`
accept exactly these; 0.3.x, 2.x and suffixed versions such as `1.0.0-rc.1` are refused by the
service installer and updater. The update agent runs the incoming release's own helpers, so a
release that widens the gate can install itself.

## Publishing

Every release goes to both repositories: the private `anton-abyzov/specwithcode` (the
service update agent's default) and the public `anton-abyzov/specwithcode` (the desktop feed for
0.2.11 and later), with the GitHub flags from the version:

```sh
node scripts/studio-projects/release-flags.mjs 1.0.37   # --latest --prerelease=false
```

A plain `X.Y.Z` gets `--latest --prerelease=false`, so `releases/latest` and the
`releases/latest/download/SpecWithCode-arm64.dmg` link in the README and on the website resolve to
it. A suffixed version gets `--prerelease --latest=false`. Drafts are ignored by every updater.
Signed builds that update through electron-updater never see pre-releases.

## Desktop assets

The sign stage writes `SpecWithCode-<version>-arm64.dmg`, the `.zip` and their blockmaps,
`latest-mac.yml`, and `SpecWithCode-arm64.dmg`, the same installer under a name without the
version. All of them are uploaded. Updaters download the zip that `latest-mac.yml` names and never
read the version-free DMG.

Release DMGs are built with `--signed`: Developer ID Application, team `NMCB2JZ7QG`, hardened
runtime, notarized and stapled. The environment is in
[desktop app](./desktop-app.md#signing-and-notarization). macOS ties the `studio Safe Storage`
Keychain item and the privacy grants to the app's designated requirement. An unsigned build is
signed ad hoc, its requirement is its code hash, and every update then asks for the login keychain
password again. `mac-signature.mjs` checks both the DMG and the zip; never publish a macOS build it
refuses. Keep the team and bundle id fixed: changing either makes the next update a different app
to macOS.

## Rollback copies

Never leave a copy of the desktop app as a loose `.app`, anywhere. Spotlight lists it as another
SpecWithCode, Launch Services registers it, and because every copy has the bundle id
`com.specweave.studio`, `open -b` or a notification click can start an old copy that then pairs
with the running service.

Keep a rollback copy as a zip with `scripts/studio-fleet/desktop_backup.py` (the desktop stage
does this):

```sh
python3 -B scripts/studio-fleet/desktop_backup.py snapshot "/Applications/SpecWithCode.app"
python3 -B scripts/studio-fleet/desktop_backup.py prune --keep 1
```

It writes `~/.specweave-studio/backups/desktop.noindex/<version>-<time>.zip` (the `.noindex`
folder is not indexed) and keeps the most recently made one by default; the copy it just wrote is
never pruned. `--keep` goes before or after the command.

To restore, quit the app and move the installed bundle to the Trash first, then extract:

```sh
osascript -e 'tell application "Finder" to delete POSIX file "/Applications/SpecWithCode.app"'
ditto -x -k <zip> /Applications
```

`ditto -x` merges into an existing bundle, so extracting over the current app leaves a mix of
both versions with a broken signature. The restored bundle keeps the name it was zipped under: a
0.2.x copy comes back as `SpecWeave Studio (Alpha).app`, and the next 1.x update renames it again.
Leave no `SpecWithCode.app` beside it, or that copy's next launch moves the older one to the Trash.

To clean up copies that earlier release sessions left behind, run `migrate` once. It zips every
loose `.app` under `~/.specweave-studio/backups/` (top level and `desktop-*` folders) and any
`--extra` path, deletes the loose copy, removes it from Launch Services and prunes:

```sh
python3 -B scripts/studio-fleet/desktop_backup.py migrate \
  --extra "/Applications/.specweave-studio-backup-<version>-<time>"
```

It only handles bundles with the id `com.specweave.studio`, and never touches an app directly in
`/Applications` or `~/Applications`, or one that is running. A copy it zipped but could not delete
is listed under `failed` with its archive; the rest still run.
The service updater's `pre-*` database backups are separate and stay where they are.

## Google sign-in packaging gate

Official release builds must receive both `STUDIO_GOOGLE_OAUTH_CLIENT_ID` and `STUDIO_GOOGLE_OAUTH_CLIENT_SECRET`. Isolated worktrees do not inherit another checkout's ignored `.env`. Inject only this pair into the build environment from the approved release configuration (release.sh reads only those two names from `GOOGLE_OAUTH_ENV_FILE`); never copy the full `.env`, print its contents or put it in an artifact. The server build embeds the Desktop-app OAuth client; no Google account refresh token belongs in the build.

After building, run `STUDIO_TEST_REQUIRE_BUILTIN_GOOGLE=1 node scripts/studio-google/verify.mjs <fresh-evidence-directory>` (the bundle stage does, before signing). The private test server has no runtime Google client variables and must report its compiled SpecWithCode client as configured. The headless check also verifies the optional own-client override and that removing it restores the compiled client. An official release without this receipt must not be published. Real account access additionally requires the user's Google consent and per-project grants.
