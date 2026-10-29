# Releasing SpecWithCode

The runbook for a desktop and service release, plus how releases are versioned, named and published
and how rollback copies are kept. The update mechanics are in [updates](./updates.md); the kept
identities are in [naming](./naming.md).

## One command

```sh
bash scripts/release/release.sh 1.0.37 --dry-run              # every stage and command; runs and writes nothing
bash scripts/release/release.sh 1.0.37 --stop-after drafts     # everything up to the drafts; nothing published
bash scripts/release/release.sh 1.0.37 --resume                # continue: publish, M4, desktop, M1/M3, merge, Linux workers
bash scripts/release/release.sh 1.0.37 --status                # stage markers and timings
```

Run it from a checkout of `anton-abyzov/specwithcode` on M4 with Node 22.20.0 installed
through nvm. A run stops at the first failing stage and prints the command to continue. `--resume`
skips every stage already done; `--self-test` checks the script itself with stubbed commands.

### macOS first, then Linux workers, then Windows and Linux apps

A release ships in three waves, so macOS is never held back by the slower platforms:

1. **macOS and the Mac fleet** (`release.sh`): the signed macOS app, every asset the fleet reads
   (including the Linux worker archives `studio-<version>-linux-{x64,arm64}-<sha>.tar.gz`), M4, the
   desktop app, M1 and M3, then the merge.
2. **Linux workers** (`fleet-linux`, the last stage): each inventory entry with `"os": "linux"` runs
   its own `specweave-studio update <version> --yes` over SSH (`scripts/studio-fleet/linux_rollout.py`).
   Best effort: a worker whose service still runs work is skipped, since the update restarts it, and
   one that is unreachable or fails only warns. An active service is restarted with `--if-idle`: right
   before the restart it atomically closes admission and waits for already admitted commands to
   persist and terminal opens/restarts to register. Running terminals refuse the conditional restart
   and are left running. It holds only an idle service, under a unique lease that is checked again immediately
   before the stop. Older services without lease acknowledgement are refused. A busy or refused
   update leaves the service selection unchanged. A worker whose service state cannot be read (no user bus, or a state
   other than active, inactive or failed) is skipped. A worker counts as updated only when its live
   server runs the version, healthy, as the launcher selected it, not when the unit names it. Workers
   on 1.0.105 or earlier cannot hold themselves this way: while their service runs, they are skipped
   until updated by hand once (docs/user/linux-worker.md). The release is already done and the stage
   never fails it. Retry with `python3 -B scripts/studio-fleet/linux_rollout.py --version <v>` once
   the worker is idle; `--dry-run` prints the SSH commands.
3. **Windows and Linux desktop apps** (Release Windows and Linux, below): built nightly at 07:00
   UTC for the newest release that lacks them, or on demand with a manual dispatch. Until then
   Windows and Linux desktop installs stay on their version (their update check finds no feed).

A Linux worker entry in `hosts.json` (kept outside the repository):

```json
"ministorm": {"os": "linux", "host": "ministorm", "sshConfig": true,
              "studioHome": "/home/<user>/.specwithcode/ministorm", "unit": "studio.service"}
```

`"sshConfig": true` reaches `host` as an alias of the M4's own `~/.ssh/config`; without it the
entry needs `user` and uses the pinned fleet key and `known_hosts`, as M1 and M3 do. `unit`
defaults to `studio.service`.

### Before the first release on a Mac

1. Copy `scripts/release/release.env.example` to `~/.config/skill-studio-release/release.env`,
   `chmod 600` it and fill in the paths and ids. It holds no secret: the certificate passphrase,
   the notarization key and the Google OAuth pair stay in their own mode-600 files that it names.
   Set `GOOGLE_OAUTH_SOURCE_ENV` once and preflight copies only the two Google lines out of that
   env file into `GOOGLE_OAUTH_ENV_FILE`.
2. The fleet inventory and key (`~/.local/share/specweave/fleet/`) and the public mirror rules
   (`~/.local/share/specweave/specwithcode-public/rules.json`) must exist.
3. The first run makes the persistent trees in `~/.specwithcode/release.noindex/` (`build`,
   `test` and a clone of the public repository; the `.noindex` folder keeps Spotlight out of their
   `node_modules`). The trees stage gives the public clone its own commit identity, the owner's
   GitHub noreply address (`PUBLIC_GIT_NAME` and `PUBLIC_GIT_EMAIL` in release.env override it);
   a noreply `user.email` already set there is kept.

### From GitHub Actions

The **Release macOS** workflow (`.github/workflows/release-macos.yml`, run by hand with the
version) runs `release.sh --ci` on a Mac runner, so a release needs neither the M4 nor anyone at
it. `--ci` needs no fleet files and skips `quit-desktop`, `fleet-m4`, `fleet-workers`, `desktop`
and `fleet-linux`: each Mac's update agent installs the release from the public feed on its next hourly
check, and `fleet_rollout.py --version <v>` on the M4 asks them at once and then updates the M1
and M3 apps ([desktop apps on M1 and M3](#desktop-apps-on-m1-and-m3)); `linux_rollout.py
--version <v>` does the same for Linux workers, which have no update agent. The workflow writes
release.env, the certificate, the notarization key, the Google pair and the mirror rules from
repository secrets into the runner's temp folder and deletes them at the end; its header lists the
secret names. It runs on GitHub's `macos-15` unless the repository variable
`RELEASE_MACOS_RUNNER` names another runner, such as a self-hosted Mac, where `resume` continues a
failed run. On GitHub's runner a failed run is simply run again: the bump stage removes the
`release/<version>` branch the failed run left when it holds only the bump and the version is not
tagged, then bumps the current `main`. Logs and timings are kept as a workflow artifact.

### Stages

State for a release lives in `~/.specwithcode/release-staging/<version>/`: `release.json`, a
marker per finished stage, `logs/<stage>.log` (appended, with a header per run, never
overwritten), `timings/stages.json` and the assets. release.sh refuses a staging folder it did not
make, and refuses to start a second run of a version without `--resume`.

| Stage           | What it does                                                                                                           | Runs again              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| preflight       | version policy, release.env and the files it names, toolchain, `gh auth`; drops anaconda from PATH; warns on high load | every run               |
| trees           | makes or checks the build, test and public trees                                                                       | every run               |
| prev            | downloads the previous release's plan, helpers manifest and `SHA256SUMS`; checks them (sums or GitHub's digest)        | once                    |
| bump            | `release/<version>` from `main`, the version bump commit                                                               | once                    |
| candidate       | pushes HEAD to `release/<version>`, checks it out in the test tree, cleans and installs both, checks Electron          | per candidate           |
| stage1          | contrast tests first, then each package's tests, the typecheck gate and fleet tests, longest first, four at a time     | per candidate           |
| server          | `test-sharded.mjs --shards 4` in the background, alongside build to drafts                                             | per candidate           |
| build           | the Electron check, the Google pair only, then `APP_VERSION=<version> vp run build:desktop`                            | per candidate           |
| bundle          | `bundle.mjs`, `verify-bundle.mjs` on the archive, the Google sign-in check, all before signing                         | per candidate           |
| sign            | `build-desktop-artifact.ts --signed --skip-build` on the verified build, `mac-signature.mjs`                           | per candidate           |
| helpers         | `make_helpers.py`, compared with the previous manifest                                                                 | per candidate           |
| plan            | copies `scripts/install.sh`, `SHA256SUMS`, `make_update_plan.py --previous-plan`, the plan added, every asset checked  | per candidate           |
| drafts          | `notes.md`, both draft releases with every asset, a `publish.mjs` check without `--tag`/`--push`                       | per candidate           |
| server-wait     | waits for the server suite; when it failed, deletes both drafts                                                        | per candidate           |
| quit-desktop    | quits `/Applications/SpecWithCode.app` (TERM to its own pid)                                                           | until the desktop stage |
| publish-private | checks the draft's `SHA256SUMS`, publishes the private release, checks the tag is the candidate                        | once                    |
| publish-public  | `publish.mjs --tag --push`, checks the draft's `SHA256SUMS`, then the public release                                   | once                    |
| fleet-m4        | `fleet_rollout.py --only m4`: drains and holds M4 as Update now does, then a forced 15-minute request                  | once                    |
| desktop         | record grants, rollback copy, swap the app in `/Applications`, check its signature, grants and version, open it        | once                    |
| fleet-workers   | `fleet_rollout.py --only workers`: M1 and M3 together, polled the same way, then each one's desktop app                | once                    |
| merge           | the `release/<version>` pull request into `main`                                                                       | once                    |
| fleet-linux     | `linux_rollout.py`: Linux workers, best effort; a skipped or failed worker only warns                                  | once                    |

Preflight checks each file and value exists without printing any. The candidate stage fails when
`pnpm install --frozen-lockfile` would change `pnpm-lock.yaml`; stage 1 runs every workspace
package with a test script except the root and `apps/server`, so a new package cannot be left out.
Nothing is public before publish-public, and nothing installs anywhere before publish-private.
The fleet stages come after publish-public, and refuse to start while the public release is not
published: the hosts' update agents read the public feed (`update_agent.DEFAULT_REPOSITORY`), so
they cannot see a release that is only private. Releases up to 1.0.39 ran the fleet first and
published public by hand; a staging folder from that order resumes at its first unmarked stage.

The desktop app is swapped right after M4 installs, before M1 and M3 (up to 1.0.41 it came last).
The M1 and M3 apps follow their own services in fleet-workers. Before that step existed only the
M4 app was updated: on October 21, 2026 the services ran 1.0.68 while the M3 app was 1.0.65 and
the M1 app 1.0.48, and the release was reported done.
From 1.0.41 the app manages the M4 service: opened against an older M4 it writes its own
normal-mode install request, which can replace fleet-m4's forced one, so it never opens before M4
runs the release. And M1 or M3 failing no longer leaves the Mac without its app (1.0.39 and 1.0.41
ended that way). When the old app's own updater already swapped the release in as it quit, the
stage keeps that app and makes no rollback copy of it, which would hold the new version and prune
the previous one. It first waits up to 60 seconds for that update to finish: an unsigned build's
swap (`SpecWithCode.app.studio-update-old` gone) or a signed build's Squirrel.Mac install (the
`ShipIt` running from the app's own `Squirrel.framework` gone). It keeps the app only when
`codesign --verify --deep --strict` passes too. An install cut short is moved aside to
`SpecWithCode.app.partial-<time>` (not deleted, not zipped, and not probed for grants) and the zip
installed again: one that reports the release but fails that check (cut short after it wrote
`Info.plist`), or one with no readable version (cut short before).

Stage 1 starts the contrast tests first, then the longest jobs by this release's or the previous
release's last times, and the fleet runner starts its longest tests first by the newest fleet
results (`run-tests.sh --history`). The server suite's shards are split by the recorded file
times in `apps/server/src/testUtils/shardWeights.json`; refresh them from a full run's reports
when the shards drift apart. The server stage prints the command; run it from the checkout you
commit the change in, since its `--out` names that checkout's file, not the test tree's.
`RELEASE_SERVER_SHARDS` (1 to 6) overrides the four shards.

Before a draft is published, its own `SHA256SUMS` is downloaded, compared with the one built and
checked to list `studio-update.json` and the helpers manifest. 1.0.38 shipped sums without the
plan: it was uploaded on its own afterwards with `make_update_plan.py --upload`, which now writes
the plan's line into `SHA256SUMS` and uploads both. A previous release whose sums leave out the
plan is still handled: the prev stage accepts the plan only when it matches the sha256 digest
GitHub recorded for that asset, and stops when there is none.

pnpm runs Electron's postinstall only when it links the package, and the build tree keeps
`node_modules`, so an Electron download that an earlier install skipped stays missing. The
candidate stage checks the runtime with `apps/desktop/scripts/ensure-electron-runtime.mjs
--check`, runs Electron's own `install.js` when it is incomplete, and stops with the missing paths
when it still is. The build stage checks again, so a folder whose candidate stage ran before the
check existed is covered when it resumes.

The plan passes `--allow-project-migrations` and `--allow-existing-browser-heartbeat` to
`update.py`, as the plans of 1.0.30 to 1.0.37 did. Without the first, a release that migrates
fails and rolls back on every host, also on one that skipped the migrating release.
`--no-project-migrations` leaves it out for `update.py`'s stricter whole-database check; give it
only when no host upgrades across a migration, on the run that reaches the plan stage.

### When a stage fails

A flaky test does not stop the run. In stage 1, when one or two jobs of the whole stage fail, each
runs once more, alone, on the same candidate; its first try is kept in `stage1/<sha>-<time>/try-1/`.
The two count across the stage: on `--resume` the last attempt's failures run first as a group of
their own, and their retries count toward the two. In the server suite, when at most five files
failed and no shard crashed or timed out, only those files run once more as one shard
(`server/<sha>-<time>/retry-1/`), and the drafts stay. A job or file that passes on its retry is a
FLAKE: the stage passes, the run goes on, and the timing table names it. A second failure fails the
stage with the usual message; more failed jobs or files than that, or a crashed shard, are a break
and get no retry. `--no-retry` turns retries off, to reproduce a flaky test; a server suite already
running for the candidate with retries on is restarted without them (and one running with
`--no-retry` is restarted with them by a run that leaves the flag out). `RELEASE_RETRY_MAX_JOBS` and
`RELEASE_RETRY_MAX_FILES` change the two limits. No other stage is retried: publishing, the fleet,
the desktop and the merge have side effects, and the rest are deterministic. Releases 1.0.39 and
1.0.40 lost about 40 minutes to four such flakes, most of it waiting for someone to run `--resume`.

Fix the cause in the build tree and commit there; the commit is the new candidate. Then run
`--resume`. The candidate stages run again for it: stage 1 runs the jobs that failed last time
first, then the rest; the signed build runs again; the server suite runs only the files vitest ties
to changes since its last green commit (`--changed`), or in full when `pnpm-lock.yaml` or
`patches/` changed. Once the private release is published the candidate is fixed: a later change
is the next version.

Commit new files with the fix: the candidate stage cleans the build tree, so a new candidate with
untracked files is refused before anything is deleted. The bump stage refuses a local
`release/<version>` that holds commits other than its own bump. Once the server suite has failed,
the release stops before the next of bundle, sign, helpers, plan and drafts, so a failed run does
not go on to sign and upload, and an earlier candidate's drafts are deleted.
`fleet_rollout.py` stops when a host reports that the install it asked for failed, and names the
receipt; that host stays on its old version. Before each request or check the host installs the
update agent its release ships when its own agent is older (`docs/studio/updates.md`), and the rollout
says so in a line, such as `m1: installed the update agent its release ships over an older one`; a host
that could not install it still gets the request, which the agent it has handles. A worker that stops
on an unexpected error fails the rollout with its host's name instead of dropping out of the results.
A worker whose app could not be updated fails fleet-workers once every service is done, and
`--resume` runs the stage again: the services are already on the release, so only the apps are
retried ([desktop apps on M1 and M3](#desktop-apps-on-m1-and-m3)). When publish-public's push failed after `publish.mjs`
tagged, `--resume` drops the tag left in the public clone, since the remote has none.

### What keeps a release from failing late

Three different failures stopped 1.0.44, each after the expensive stages had run. These guards
are there so each one fails a pull request instead:

- **main requires PR Gate and PR Gate (typecheck).** A PR merged before its gate finished put a
  failing test on main, and stage 1 then refused the release. `gh pr merge` now waits until both
  checks pass, so don't merge with `--admin`. A PR that changes only Markdown, `docs/` or issue
  templates skips both checks, which counts as passing. The release's own merge stage waits for
  the checks, which skip `release/` branches. An admin can still merge past them, so the bump
  stage stops first when the pull request that made main's head has a failed or still running
  required check.
- **Every stubbed command exists.** The self-test fails when a command a stub run recorded is not
  on PATH (a misspelled `pyhton3`), apart from the macOS tools and pnpm the release Mac provides.
- **Malformed calls are refused.** `x`, `q` and `t` stop when the command is missing or starts
  with `-`. That is how the typo `x sums --python3` reached a release: dry and stub runs only
  record commands, so they never ran it. **PR Gate (release)** runs `release.sh --self-test` on a
  Mac for every PR that touches the release scripts. The self-test exercises every stage and also
  checks the source for an option written straight after a label.
- **Signing gets a second try.** When `mac-signature.mjs` refuses the build, the sign stage signs
  once more before failing. One run produced a DMG without the stapled notarization ticket while
  the zip from the same run had it. A second refusal stops the release.

Edit `notes.md` in the staging folder while the suites run; publish-private and publish-public
take it as it is then, and the public copy is checked against the mirror's deny list.

### Timings

Each run appends per-stage start, end, result and attempt to `timings/stages.jsonl`, writes
`timings/stages.json` and prints it beside the previous release's, marking a stage `SLOWER` when it
took more than 25% and at least 10 seconds longer. Retries go to `timings/retries.jsonl` and into
`stages.json` (`retries`, and `flakes` per stage); the table notes each stage's flakes and lists
every `FLAKY (passed only on retry)` and `Failed again on retry` with its first try's log, and
`REPEAT FLAKE` when the previous release had the same one. A full green server run prints the
command that refreshes the recorded shard weights from its reports.

### By hand

`fleet_rollout.py --version <v> --dry-run` prints the rollout order and commands, with the
`service prepare-update` command that drains and holds M4 first (`--no-hold` skips it), and under
`desktopApps` the ssh command for each worker's app and where the zip's sha256 will come from
(`null` with `--no-desktop-apps`); it fetches nothing and contacts no host. A rollout
never asks M4 for a forced install it could not hold: an unheld request stops no running work and
leaves `update.py --reap` nothing it may stop, so a busy M4 waits for quiet and fails its guarded
checks as new work starts. When M4's installed release predates the command (it first shipped in
1.0.45), the rollout and its dry run say so before contacting any host, and a service that does not
answer, refuses or does not hold stops the rollout before the request. Then choose **Update now** in
the SpecWithCode app on M4, which drains and holds through the same `prepareServiceUpdate` call and
writes the forced request, wait until `fleet_rollout.py --version <v> --only m4` reports M4
installed (it joins an install of that version already under way), and run `--only workers`;
`--no-hold` is the explicit opt-in to an unheld request;
`update_request.py status --identity <id>` reads one host's updater state; its `installFinalized`
needs the agent's verified receipt. Receipts and the agent's snapshots carry the guarded rows,
which grow with the service's threads (1.2 MB on M4 at 887 threads), so the agent and `status`
read them up to 64 MiB. For a host whose agent
cannot install a release on its own, copy the assets to `<studio root>/release-staging/<version>/`
on that host and run `/usr/bin/python3 -B scripts/studio-fleet/remote_update.py --identity <id>
--version <v> --runtime <runtime archive> --helpers <helpers archive>`; it checks the staged files,
backs up the database through `live_database.py` and runs the release's own `update.py`.
A worker's app alone is updated by hand with the commands in
[desktop apps on M1 and M3](#desktop-apps-on-m1-and-m3).

## Versions

The 0.1.x and 0.2.x releases were the alpha line. 1.0.0 is the first stable release and 1.x.y
follows it. `scripts/studio-projects/version.mjs` and `scripts/studio-fleet/release_policy.py`
accept exactly these; 0.3.x, 2.x and suffixed versions such as `1.0.0-rc.1` are refused by the
service installer and updater. The update agent runs the incoming release's own helpers, so a
release that widens the gate can install itself.

## Publishing

Every release goes to both repositories: the private `anton-abyzov/specwithcode` (where the
next release's prev stage finds this one) and the public `anton-abyzov/specwithcode` (the desktop
feed for 0.2.11 and later, and the service update agent's default,
`update_agent.DEFAULT_REPOSITORY`), with the GitHub flags from the version. The public snapshot
leaves out `.github/workflows`, so no workflow runs there:

```sh
node scripts/studio-projects/release-flags.mjs 1.0.37   # --latest --prerelease=false
```

A plain `X.Y.Z` gets `--latest --prerelease=false`, so `releases/latest` and the
`releases/latest/download/SpecWithCode-arm64.dmg` link in the README and on the website resolve to
it. A suffixed version gets `--prerelease --latest=false`. Drafts are ignored by every updater.
Signed builds that update through electron-updater never see pre-releases.

### npm

`npm i -g specwithcode` installs the published runtime archive (`studio-<version>-<sha12>.tar.gz`)
as one package with the `specwithcode` and `specweave-studio` commands. It runs on Node.js 22.16 or
newer (23.11+, or 24.10+) on macOS and Linux, x64 and arm64: the archive's native dependencies carry
prebuilds for all of them. Build it from the release's own assets and publish the tarball as written:

```sh
sha=$(grep " studio-1.0.43-043e9db88a6e.tar.gz$" SHA256SUMS | cut -d' ' -f1)
node scripts/studio-fleet/npm-package.mjs --archive studio-1.0.43-043e9db88a6e.tar.gz \
  --sha256 "$sha" --output-dir "$(mktemp -d)/npm"
npm publish <output-dir>/specwithcode-1.0.43.tgz
```

The script copies pnpm's symlinked dependency store into a flat `node_modules` and leaves source
maps out; `npm publish <dir>` would drop that `node_modules`, the tarball keeps it. Before
publishing, install the tarball with `npm i -g --prefix "$(mktemp -d)" <tarball>` and check
`specwithcode --version` and `specwithcode fleet invite --help`.

## Desktop assets

The sign stage writes `SpecWithCode-<version>-arm64.dmg`, the `.zip` and their blockmaps,
`latest-mac.yml`, and `SpecWithCode-arm64.dmg`, the same installer under a name without the
version. All of them are uploaded to the public release; the private one gets all but the
version-free DMG, which only serves the public `releases/latest/download` link (`SHA256SUMS` still
lists it). Updaters download the zip that `latest-mac.yml` names and never read the version-free
DMG.

Windows and Linux come from **Release Windows and Linux**
(`.github/workflows/release-windows-linux.yml`), not from `release.sh`. Given a version, it builds
the commit tagged `v<version>` on GitHub's `windows-2025` and `ubuntu-24.04`: the unsigned NSIS
installer with its blockmap and `latest.yml`, the AppImage and `.deb` with `latest-linux.yml`, and
`studio-<version>-win32-x64.zip`, the CLI archive `scripts/install.ps1` installs. It checks that
each package's `app-update.yml` polls `anton-abyzov/specwithcode` and that every file the feeds
name matches its hash, then adds the files and `SHA256SUMS-windows-linux` to both releases once
they are published. It never uploads or replaces a name `release.sh` uses and checks afterwards
that `latest-mac.yml` and `SHA256SUMS` are unchanged. A manual dispatch is a dry run (assets kept
as a workflow artifact) unless `dry_run` is off. Every night at 07:00 UTC it runs by itself for the
newest published `X.Y.Z` release when neither copy of that release has its assets yet and the
public one is published; otherwise it stops in the plan job within seconds. Versions released in
between are skipped, since the feeds only need the newest. A nightly run never replaces an asset:
a release holding only some of them gets a warning to dispatch it with `replace`. Running on every
published release is opt-in (repository variable `RELEASE_WINDOWS_LINUX_ON_PUBLISH` set to `true`)
and off, because each run holds a Windows and a Linux runner for about an hour,
and building several releases a day consumes capacity needed by pull request CI. Until it has run, Windows
and Linux desktop installs find no `latest.yml` or `latest-linux.yml` on the new Latest release,
report a failed update check and stay on their version.

Release DMGs are built with `--signed`: Developer ID Application, team `NMCB2JZ7QG`, hardened
runtime, notarized and stapled. The environment is in
[desktop app](./desktop-app.md#signing-and-notarization). macOS ties the `studio Safe Storage`
Keychain item and the privacy grants to the app's designated requirement. An unsigned build is
signed ad hoc, its requirement is its code hash, and every update then asks for the login keychain
password again. `mac-signature.mjs` checks both the DMG and the zip; never publish a macOS build it
refuses. Keep the team and bundle id fixed: changing either makes the next update a different app
to macOS.

Computer use needs Accessibility and Screen Recording, and the user grants them once. They carry
over to every release because each one has the same designated requirement:

```
identifier "com.specweave.studio" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = NMCB2JZ7QG
```

`mac-signature.mjs` refuses a build whose requirement differs from that text, or whose nested
code (the Electron helpers, frameworks, `studio-voice`, `studio-resource-monitor`) is ad hoc or
signed by another team. The desktop stage runs
`mac-upgrade-grant.mjs before` on the installed app and `after` on the new one. It launches each
app's own executable in Node mode through Launch Services and asks only `AXIsProcessTrusted` and
`CGPreflightScreenCaptureAccess`, so it shows no prompt and captures nothing. It stops the release
when the new app fails the old app's requirement, or when a grant that was on is now off. It never
writes the TCC database. macOS still asks again after the user revokes a grant or resets TCC, and
it periodically shows its own screen-capture reminder for every app that records the screen.

## Swapping the desktop app

The desktop stage never leaves `/Applications/SpecWithCode.app` broken or in the Trash. It unpacks
the zip into `/Applications/.SpecWithCode.app-<version>-unpack` (same volume, hidden from Launch
Services) and checks its signature there. Only then does it rename the installed app to
`SpecWithCode.app.release-old`, rename the new one in, and move the old one to the Trash. A ditto
cut short, for example by a full disk, stops the stage with the installed app untouched. A run
stopped between the two renames is repaired on `--resume`: the old app goes back when nothing
took its place, or to the Trash when the new one did.

Never install the desktop app by hand by trashing the installed bundle and then unzipping over
`/Applications`. On October 27, 2026 that order, with 239 MB free, trashed 1.0.101 and left a
three-file `SpecWithCode.app`, so macOS refused to open it ("in the Trash"). Run the desktop stage,
or follow the same order: unpack elsewhere on the volume, `codesign --verify --deep --strict`, then
rename.

## Desktop apps on M1 and M3

`fleet_rollout.py` updates `/Applications/SpecWithCode.app` on each worker once it has confirmed
that worker's service on the version, whether this run installed it or it already ran it. M4's app
is the desktop stage's. The step uses the same pinned fleet ssh as the service request: it streams
`scripts/studio-fleet/desktop_app_update_remote.sh` to the worker's `/bin/bash -s`, with the
version, the zip's sha256 and the public repository in a preamble. Each value is checked before it
reaches a shell (digits and dots, 64 hex digits, owner/name) and again on the worker.

The sha256 is the zip's line in the release's `SHA256SUMS`, found the way the desktop stage finds
its zip: `<staging root>/<version>/published.sha` names the published candidate, and its
`assets-<sha12>/SHA256SUMS` is the file publish-private and publish-public checked against both
releases. A rollout run on its own for a release with no staging folder on this Mac (a `--ci`
release, or one pruned) reads `SHA256SUMS` from the public release instead. On the worker the
script follows the desktop stage's order:

1. Repairs a run cut short: an unpack folder left behind is removed, and
   `SpecWithCode.app.release-old` goes back when nothing took its place, or to the Trash when the
   new app did.
2. Waits while the app's own update runs (its Squirrel `ShipIt`, or an unsigned build's swap), and
   stops when the installed app is already the version and passes the checks of step 4. A copy of
   the version that fails one (an ad hoc build, say) is replaced like an older one. Squirrel.Mac
   starts `ShipIt` as soon as the app has staged an update, and that `ShipIt` waits for the app to
   quit: while the app runs, the script does not wait for it here but lets it install at the quit
   of step 5. A previous app still at `SpecWithCode.app.release-old` (step 1 could not move it to
   the Trash) stops the run here, before anything is downloaded or quit.
3. Downloads `SpecWithCode-<version>-arm64.zip` from the public release, over https only, into
   `~/.specwithcode/backups/desktop-app-updates/` (a rerun reuses a zip whose sha256 matches; a
   finished run removes it). Nothing changes until its sha256 matches and there is room for the
   unpacked app plus 512 MiB.
4. Unpacks it into `/Applications/.SpecWithCode.app-<version>-unpack` and checks that copy: its
   version, `codesign --verify --deep --strict`, the designated requirement above, and Gatekeeper
   (`spctl -a -t exec`). A copy that fails is removed and the installed app stays as it was.
5. Quits the app when it runs: TERM to the processes running its own executable, then up to 60
   seconds, and waits up to 90 seconds for the app's own updater. When that installs the version
   as the app quits and the app passes the same checks, it is kept.
6. Otherwise renames the installed app to `SpecWithCode.app.release-old`, renames the checked copy
   in and checks it there (a failure puts the previous app back), then moves the previous app to
   the Trash, never `rm`. A previous app that cannot go to the Trash stays where it is, and the next
   run retries it first and stops at step 2 when it still cannot.
7. Reopens the app only when it was running. A run that fails after it quit the app opens
   whichever app is in place again, unless the app's own updater is still running, or a copy that
   failed its check after the rename could not be moved aside (the reason then says which app to
   move to the Trash and which to rename back).

One run at a time holds `~/.specwithcode/backups/desktop-app-updates/.lock`, which names the run by
its pid and start time. A lock whose record is not all written yet is a run that is starting, for
10 seconds. A lock left by a run that is gone (a power loss, a reboot that gave its pid to another
process) is taken over, and one its run releases meanwhile is taken, but a lock another run made
while this one judged it stays with that run. Each run reads its record again 2 seconds after
writing it and stops (exit 4) when another run's record replaced it, or when its lock went before it
wrote its record, so of two runs that take over the same lock at once only one goes on, unless one
of them stalls for more than those 2 seconds. A run with no room to make the lock, the folder it
goes in or its record stops with exit 5 and says so. A dropped ssh session does not stop a run halfway, and the
lines it could not print reach nothing the run reads. The rollout prints the worker's lines as
`m1: app: <line>`, then one result per worker:

```
m1: desktop app 1.0.40 -> 1.0.41: unpacked and checked beside the app, then swapped in; reopened, as it was running
m3: desktop app 1.0.40 -> 1.0.41: its own updater installed it as the app quit; reopened, as it was running
```

For an app already on the release it prints `m1: desktop app already on 1.0.41`. Each worker's
JSON result has `desktopApp`: `result` (`already-current`, `updater-on-quit`, `swapped`, or
`failed` with an `error`), `before`, `after` and `relaunched`. A worker whose app could not be
updated (unreachable, no sums or a checksum mismatch, a copy that fails a check, an app that does
not quit, 30 minutes passed) fails the rollout once every service is done: it prints
`fleet_rollout: every service is on <v>, but m3: desktop app not updated to <v>: <reason>` and
exits 1. Continue the release with `bash scripts/release/release.sh <v> --resume`: the services
are already on the release, so only the apps are retried, and the merge stage still runs. Outside
a release, `--only workers` retries them the same way. `--no-desktop-apps` leaves the apps alone.

To update one worker's app by hand, take the zip's line from the release's `SHA256SUMS`:

```sh
sha=$(curl -fsSL https://github.com/anton-abyzov/specwithcode/releases/download/v1.0.41/SHA256SUMS |
  awk '$2 == "SpecWithCode-1.0.41-arm64.zip" { print $1 }')
ssh <worker> "DRY_RUN=1 V=1.0.41 SHA=$sha /bin/bash -s" < scripts/studio-fleet/desktop_app_update_remote.sh
ssh <worker> "V=1.0.41 SHA=$sha /bin/bash -s" < scripts/studio-fleet/desktop_app_update_remote.sh
```

`DRY_RUN=1` reads and reports only: nothing is downloaded, quit, renamed, trashed or opened. The
last line is `RESULT before=<v> after=<v> how=<how> relaunched=<yes|no|failed>`, or `FAIL <reason>`
with exit 2 for a bad value or missing tool, 3 for the download or its sha256, 4 when another run,
the app, its own updater or a previous app left at `SpecWithCode.app.release-old` is in the way, 5
for no room or a copy that cannot be unpacked or fails a check (before the rename, or after it with
the previous app back in place), and 6 when a rename failed; its reason says where each app is.
The update cache or its lock that `mkdir` refuses for another reason than no room (a permission, a
file in the way) ends with exit 1 and `mkdir`'s own reason; a stop nobody planned says
`stopped unexpectedly (exit <n>) at: <command>`.

## Rollback copies

Never leave a copy of the desktop app as a loose `.app`, anywhere. Spotlight lists it as another
SpecWithCode, Launch Services registers it, and because every copy has the bundle id
`com.specweave.studio`, `open -b` or a notification click can start an old copy that then pairs
with the running service.

Keep a rollback copy with `scripts/studio-fleet/desktop_backup.py`. The desktop stage of
`scripts/release/release.sh` runs both commands before it replaces the installed app; nothing in
the app or its updater does.

```sh
python3 -B scripts/studio-fleet/desktop_backup.py snapshot "/Applications/SpecWithCode.app"
python3 -B scripts/studio-fleet/desktop_backup.py prune --keep 1
```

`snapshot` clones the bundle with `cp -c` into
`~/.specwithcode/backups/desktop.noindex/<version>-<time>.noindex`. On APFS that takes well under a
second and uses no new disk space until the installed app changes. The folder holds the bundle's
`Contents` under a name without `.app`, so Launch Services does not take it for an app, and the
`.noindex` folders keep Spotlight out. Where APFS cannot clone it there (another volume or file
system), it writes `<version>-<time>.zip` with `ditto` instead. `prune` keeps the most recently
made copy of either kind by default; the copy `snapshot` just wrote is never pruned. `--keep` goes
before or after the command.

To restore, quit the app and move the installed bundle to the Trash first, then restore either
kind of copy:

```sh
osascript -e 'tell application "Finder" to delete POSIX file "/Applications/SpecWithCode.app"'
python3 -B scripts/studio-fleet/desktop_backup.py restore <copy>
```

`restore` refuses while that app still exists, because extracting over the current app leaves a
mix of both versions with a broken signature. A zip comes back under the name it was zipped
under: a 0.2.x copy comes back as `SpecWeave Studio (Alpha).app`, and the next 1.x update renames
it again. A clone comes back under its `CFBundleName`. Leave no `SpecWithCode.app` beside an older
copy, or that copy's next launch moves the older one to the Trash.

To clean up copies that earlier release sessions left behind, run `migrate` once. It clones or zips
every loose `.app` under `~/.specwithcode/backups/` (top level and `desktop-*` folders) and any
`--extra` path, deletes the loose copy, removes it from Launch Services and prunes:

```sh
python3 -B scripts/studio-fleet/desktop_backup.py migrate \
  --extra "/Applications/.specweave-studio-backup-<version>-<time>"
```

It only handles bundles with the id `com.specweave.studio`, and never touches an app directly in
`/Applications` or `~/Applications`, or one that is running. A copy it archived but could not delete
is listed under `failed` with its archive; the rest still run.
The service updater's `pre-*` database backups are separate and stay where they are.

## Google sign-in packaging gate

Official release builds must receive both `STUDIO_GOOGLE_OAUTH_CLIENT_ID` and `STUDIO_GOOGLE_OAUTH_CLIENT_SECRET`. Isolated worktrees do not inherit another checkout's ignored `.env`. Inject only this pair into the build environment from the approved release configuration (release.sh reads only those two names from `GOOGLE_OAUTH_ENV_FILE`); never copy the full `.env`, print its contents or put it in an artifact. The server build embeds the Desktop-app OAuth client; no Google account refresh token belongs in the build.

After building, run `STUDIO_TEST_REQUIRE_BUILTIN_GOOGLE=1 node scripts/studio-google/verify.mjs <fresh-evidence-directory>` (the bundle stage does, before signing). The private test server has no runtime Google client variables and must report its compiled SpecWithCode client as configured. The headless check also verifies the optional own-client override and that removing it restores the compiled client. An official release without this receipt must not be published. Real account access additionally requires the user's Google consent and per-project grants.
