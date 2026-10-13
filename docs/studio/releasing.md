# Releasing SpecWithCode

How a desktop and service release is versioned, named and published, and how rollback copies are
kept. The update mechanics are in [updates](./updates.md); the kept identities are in
[naming](./naming.md).

## Versions

The 0.1.x and 0.2.x releases were the alpha line. 1.0.0 is the first stable release and 1.x.y
follows it. `scripts/studio-projects/version.mjs` and `scripts/studio-fleet/release_policy.py`
accept exactly these; 0.3.x, 2.x and suffixed versions such as `1.0.0-rc.1` are refused by the
service installer and updater. The update agent runs the incoming release's own helpers, so a
release that widens the gate can install itself.

## Publishing

Publish every release to both repositories: the private `anton-abyzov/specwithcode` (the
service update agent's default) and the public `anton-abyzov/specwithcode` (the desktop feed for
0.2.11 and later). Take the GitHub flags from the version:

```sh
V=1.0.0
gh release create "v$V" -R anton-abyzov/specwithcode --draft ... $(node scripts/studio-projects/release-flags.mjs "$V")
# later, after the assets and update plan are attached:
gh release edit "v$V" -R anton-abyzov/specwithcode --draft=false $(node scripts/studio-projects/release-flags.mjs "$V")
```

A plain `X.Y.Z` gets `--latest --prerelease=false`, so `releases/latest` and the
`releases/latest/download/SpecWithCode-arm64.dmg` link in the README and on the website resolve to
it. A suffixed version gets `--prerelease --latest=false`. Drafts are ignored by every updater.
Signed builds that update through electron-updater never see pre-releases.

## Desktop assets

`pnpm dist:desktop:dmg:arm64` writes `SpecWithCode-<version>-arm64.dmg`, the `.zip` and their
blockmaps, `latest-mac.yml`, and `SpecWithCode-arm64.dmg`, the same installer under a name without
the version. Upload all of them. Updaters download the zip that `latest-mac.yml` names and never
read the version-free DMG.

## Rollback copies

Never leave a copy of the desktop app as a loose `.app`, anywhere. Spotlight lists it as another
SpecWithCode, Launch Services registers it, and because every copy has the bundle id
`com.specweave.studio`, `open -b` or a notification click can start an old copy that then pairs
with the running service.

Keep a rollback copy as a zip with `scripts/studio-fleet/desktop_backup.py`:

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

Official release builds must receive both `STUDIO_GOOGLE_OAUTH_CLIENT_ID` and `STUDIO_GOOGLE_OAUTH_CLIENT_SECRET`. Isolated worktrees do not inherit another checkout's ignored `.env`. Inject only this pair into the build environment from the approved release configuration; never copy the full `.env`, print its contents or put it in an artifact. The server build embeds the Desktop-app OAuth client; no Google account refresh token belongs in the build.

After building, run `STUDIO_TEST_REQUIRE_BUILTIN_GOOGLE=1 node scripts/studio-google/verify.mjs <fresh-evidence-directory>`. The private test server has no runtime Google client variables and must report its compiled Studio client as configured. The headless check also verifies the optional own-client override and that removing it restores the compiled client. An official release without this receipt must not be published. Real account access additionally requires the user's Google consent and per-project grants.
