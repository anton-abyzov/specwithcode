# Release Checklist

> For maintainers. Using SpecWithCode? See [docs/user](../user/).

Releases are cut by `scripts/release/release.sh` (on the M4, or through `release-macos.yml`), which
publishes the signed macOS app, the fleet assets and the npm package, and by
`.github/workflows/release-windows-linux.yml`, which adds the Windows and Linux desktop apps to the
same release. The runbook for both, including Windows code signing and the Linux glibc floor, is
[Releasing SpecWithCode](../studio/releasing.md). This page keeps the pieces that sit beside it.

The upstream six-target pipeline (`.github/workflows/release.yml` with `release-desktop.yml`:
nightly and preview channels every 30 minutes, npm OIDC publishing, the Vercel hosted web app and
marketing deployments, Discord announcements) was disabled and has been removed. None of those
channels, aliases or announcements are produced any more.

## Pull request macOS previews

There is no per-PR signed preview. For a Mac build of a branch, run
`gh workflow run desktop-macos-unsigned.yml -f ref=<branch>`; signed builds come only from
`release-macos.yml` through `scripts/release/release.sh`.

## SpecWithCode Connect relay deployment

The relay is a shared control plane versioned separately from client releases. Every client build
must point at the same relay so users see the same linked environments on every device and
version.

`.github/workflows/deploy-relay.yml` deploys Alchemy stage `prod` on every push to `main`. Client
releases do not read that environment: `release.sh` and `release-macos.yml` build with the public
relay URL and Clerk identifiers from `release.env` or the repository variables
`STUDIO_RELAY_URL`, `STUDIO_CLERK_PUBLISHABLE_KEY`, `STUDIO_CLERK_JWT_TEMPLATE` and
`STUDIO_CLERK_CLI_OAUTH_CLIENT_ID` (see the header of `release-macos.yml`).

Required repository variables shared by relay deployments:

- `CLOUDFLARE_ACCOUNT_ID`

Required repository secrets shared by relay deployments:

- `CLOUDFLARE_API_TOKEN`

Required `production` environment variables:

- `RELAY_API_ZONE_NAME`
- `RELAY_TUNNEL_ZONE_NAME`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_AUDIENCE`
- `CLERK_JWT_TEMPLATE`
- `CLERK_CLI_OAUTH_CLIENT_ID`
- `APNS_ENVIRONMENT`
- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_BUNDLE_ID`

Optional `production` environment variables:

- `RELAY_DOMAIN` when overriding the derived `relay.<RELAY_API_ZONE_NAME>` domain
- `RELAY_TUNNEL_CLEANUP_MODE` with `off`, `dry-run`, or `enabled`. Missing and blank values use
  `off`.
- `RELAY_LEGACY_TUNNEL_CLEANUP_MODE` with the same values, for tunnels whose host never registered
  recovery. Missing and blank values use `off`.

Required `production` environment secrets:

- `CLERK_SECRET_KEY`
- `APNS_PRIVATE_KEY`

After changing a variable or secret, run the **Deploy Studio Connect relay** workflow manually from
`main` with **force** unchecked. Alchemy compares the values the Worker reads and redeploys it when
one changed. Check **force** only to redeploy resources with no detected change.

The account-scoped repository credentials are consumed by Alchemy while provisioning relay stages; they
are not bound into the relay Worker. Each stage owns its own D1 database; the `prod` database is
retained. Local personal stages are never deployed by CI.
Production adopts the configured relay API and tunnel DNS zones as retained Cloudflare resources.
Personal stages reference the production-owned zones.

Developers deploy personal stages locally rather than through pull-request automation:

```sh
vp run --filter studio-relay deploy -- --stage "$USER" --env-file .env.local
```

### Managed tunnel cleanup rollout

Keep `RELAY_TUNNEL_CLEANUP_MODE=off` for the first production deploy. That deploy applies the
nullable allocation migration and adds the recovery endpoints. Web and mobile clients need no
coordinated release. CLI and desktop server builds must reach users before cleanup is enabled,
because those builds register recovery and replace a deleted tunnel after wake.

1. Deploy the relay and migration with cleanup `off`.
2. Release the server build and confirm current hosts register recovery. Older hosts stay marked
   legacy and are only candidates under the legacy switch below.
3. Set `dry-run`, run a relay deploy, and read the sweep counters (`scanned`, `wouldDelete`,
   `skippedLegacy`, `skippedOrphan`, `failed`, `truncated`) across several sweeps. Each sweep that
   finds candidates logs them, and the active `mode`, on a `Finished managed tunnel cleanup` line
   in the relay Worker's Workers Logs.
4. Run the disposable-host canary below.
5. Set `enabled` only after the canary recovers without a server restart.

The job runs every five minutes with a five-minute grace period for tunnels that lost their
connector, so a candidate is usually removed five to ten minutes after it goes down. Tunnels that
never connected wait an hour. One sweep attempts at most 200 deletions, so a backlog takes longer.
Changing `RELAY_TUNNEL_CLEANUP_MODE`, including turning cleanup off during an incident, needs a relay
deploy without force. Confirm the new `mode` on the next sweep span.

To roll back, set cleanup to `off` and run a relay deploy before downgrading any host. Keep the
recovery endpoints deployed while current server builds are in use. The nullable columns can stay.

### Legacy tunnel cleanup

A legacy tunnel belongs to a host that never registered recovery, usually one that went offline
before the recovery build shipped. `RELAY_LEGACY_TUNNEL_CLEANUP_MODE` deletes these once Cloudflare
reports them down, or never connected, for more than 7 days. It is independent of
`RELAY_TUNNEL_CLEANUP_MODE`, and every other check still applies.

A deleted legacy tunnel keeps its allocation, so its hostname is kept. When the host comes back:

- On a build with recovery, the connector is rejected and the host requests a replacement tunnel at
  the same hostname.
- On an older build with a CLI link, startup provisions a new tunnel.
- On an older build linked from web or mobile, the host stays offline until SpecWithCode on that computer
  is updated.

Ship the web and mobile builds that show the offline reason before enabling legacy cleanup, so a
user whose host is affected sees what to do. The relay adds the `tunnel_released_at` allocation
column in its first deploy with this change; the legacy switch stays `off` until you set it.

1. Run `vp run --filter studio-relay tunnels:census` with a read-only Cloudflare token. It counts
   tunnels in every relay stage. The reaper only sees its own stage's tunnels, so clean up the rest
   by hand.
2. Set the legacy mode to `dry-run`, deploy, and read `wouldDeleteLegacy`, `legacyOver30Days`,
   `totalDown`, and `totalInactive` on the sweep spans for a day. `wouldDeleteLegacy` counts only the
   tunnels a sweep inspected, at most 500 per status. `totalDown` and `totalInactive` are Cloudflare's
   counts of this stage's tunnels down for over five minutes and never connected for over an hour.
   They include ones the reaper skips, so they are an upper bound on the backlog. The share of `wouldDeleteLegacy` in each sweep's `scanned` estimates how
   much of that total is eligible.
3. Run the legacy steps of the disposable-host canary below.
4. Before enabling, confirm the web and mobile builds that show the "update SpecWithCode on that computer"
   message are live. Without them, a user whose older host lost its tunnel only sees it as offline.
5. Set the legacy mode to `enabled`. One sweep deletes at most 200 tunnels, four at a time, and
   stops starting new deletions after 90 seconds. A backlog of 20,000 takes about 8 hours if each
   sweep finishes its 200. Watch `deletedLegacy`, `attempted`, `failed`, and `truncated`. An
   `attempted` well under 200 with `truncated` set means the sweep stopped early: either the time
   budget ran out or Cloudflare rate-limited a deletion. The counters don't say which; the relay
   logs a warning with the Cloudflare error for each failed deletion.

In the relay Worker's Workers Logs, filter on `Finished managed tunnel cleanup` and compare these
fields across sweeps.

Set the legacy mode back to `off` and deploy if any of these happen:

- `failed` stays above a few per sweep. Read the warning log for the Cloudflare error.
- Users report an environment that is offline with the update message after they have updated SpecWithCode
  Code on that computer and restarted it.
- Relay request errors rise while sweeps run. Deletions share the D1 database with request
  handlers.

Turning the legacy mode off stops new legacy deletions; `RELAY_TUNNEL_CLEANUP_MODE` keeps deleting
tunnels of hosts with recovery while it is `enabled`. Deleted tunnels stay deleted; their hosts
recover as described above.

### Disposable-host canary

This test has not been run against a real Cloudflare account. Run it against a disposable relay
stage, test Cloudflare account, disposable host, and disposable SpecWithCode home. Keep production cleanup at
`off` or `dry-run` until it passes. Do not stop a daily-use SpecWithCode server.

1. Deploy the disposable stage with cleanup `dry-run`. Link a first disposable environment through
   web or mobile settings and confirm its tunnel is healthy and recovery is registered.
2. Stop that host and restart the same SpecWithCode home on a different local port. Confirm the public
   hostname reaches the new port and sends nothing to the old one.
3. Link a second disposable environment with a server build that predates recovery registration.
   Capture its managed `cloudflared` child PID, confirm it belongs to that host, and pause only that
   child with `kill -STOP <legacy-pid>`. Wait until Cloudflare reports it down for over five minutes.
4. Capture the first environment's `cloudflared` child PID from its server logs, confirm ownership,
   and pause it with `kill -STOP <first-pid>`. Wait until Cloudflare reports it down for over five
   minutes.
5. Confirm dry-run counts the first tunnel in `wouldDelete` and the second in `skippedLegacy`.
6. Set cleanup `enabled` on the disposable stage and deploy. Confirm in the test Cloudflare account
   that the first tunnel is deleted and the legacy tunnel still exists.
7. Resume the first child with `kill -CONT <first-pid>`. Confirm the running server detects the
   repeated rejection, requests recovery, and becomes reachable at the same hostname without a
   restart.
8. Resume the legacy child with `kill -CONT <legacy-pid>` and confirm its tunnel reconnects.
9. Repeat with a physical sleep and wake cycle on a disposable laptop before broad rollout.

Legacy cleanup, on the same disposable stage:

10. Set `RELAY_LEGACY_TUNNEL_GRACE_MINUTES=10` and the legacy mode to `dry-run`, then deploy. The
    override shortens the 7-day grace period and is ignored on `prod`. Pause the legacy child again
    and wait until Cloudflare reports it down for over ten minutes.
11. Confirm the sweep counts it in `wouldDeleteLegacy`, then set the legacy mode to `enabled` and
    deploy. Confirm the legacy tunnel is deleted and its allocation row remains.
12. With the legacy host still on its old build, resume the child. A CLI-linked host provisions a
    new tunnel on its next restart; a web- or mobile-linked host stays offline.
13. Update that host to the current build and start it. Confirm it requests recovery and is
    reachable at the same hostname.
14. Remove `RELAY_LEGACY_TUNNEL_GRACE_MINUTES` from the disposable stage.

## Server self-update and npm

The removed `release.yml` published `specweave-studio@<version>` (and its
`@specweave-studio/studio-<platform>-<arch>` packages) to npm before exposing a client, because
connected servers updated to the client's exact npm version. No workflow publishes those packages
any more. Runtimes are installed from the release's CLI archives, verified against `SHA256SUMS`,
and the `specwithcode` npm package is published by hand from the release's runtime archive
([npm](../studio/releasing.md#npm)). Before relying on the **Update server** action for a new
version, confirm which source it installs from on that version.

## Desktop auto-update notes

- Updater runtime: `apps/desktop/src/updates/DesktopUpdates.ts`.
- `electron-updater` adapter: `apps/desktop/src/electron/ElectronUpdater.ts`.
- `apps/desktop/src/main.ts` only wires the updater layers into the desktop runtime.
- Update UX:
  - Background checks run on startup delay + interval.
  - No automatic download or install.
  - The desktop UI shows a rocket update button when an update is available; click once to download, click again after download to restart/install.
- Provider: GitHub Releases (`provider: github`) configured at build time.
- Repository slug source:
  - `STUDIO_DESKTOP_UPDATE_REPOSITORY` (format `owner/repo`), if set. Release builds set it to
    the public `anton-abyzov/specwithcode`.
  - otherwise `GITHUB_REPOSITORY` from GitHub Actions (`resolveGitHubPublishConfig` maps
    `specwithcode-dev` to the public repository).
- Required release assets for updater:
  - platform installers (`.exe`, `.dmg`, `.AppImage`, `.deb`, plus macOS `.zip` for Squirrel.Mac update payloads)
  - channel metadata: `latest-mac.yml` (from `release.sh`), `latest.yml`, `latest-linux.yml` and
    `latest-linux-arm64.yml` (from `release-windows-linux.yml`)
  - `*.blockmap` files (used for differential downloads)
- macOS metadata note: `electron-updater` reads `latest-mac.yml`. Releases ship Apple silicon only
  (`SpecWithCode-<version>-arm64.dmg` and `.zip`); there is no Intel Mac desktop build.
- Windows metadata note: one `latest.yml` lists both the x64 and the arm64 installer
  (`release-windows-linux.ts merge-feeds`); electron-updater picks the entry whose name holds the
  running arch.

### Windows payload topology and update validation

Windows packages the bundled server and only its runtime-external/native
dependency closure in `resources/server.asar`. Native modules and helper
executables declared as unpacked by that archive must be present at the matching
paths below `resources/server.asar.unpacked`. The Windows-native backend reads
the archive in place through Electron. Packaged Windows builds also ship
`resources/wsl-runtime.tar.gz` plus its SHA-256 sidecar when the build is given
`--wsl-runtime`: the Linux CLI archive (`studio-<version>-linux-<arch>.tar.gz`,
the same arch as the Windows host), copied in verbatim so WSL runs the exact
bytes a Linux user downloads. `release-windows-linux.yml` does not pass it yet,
so released Windows builds have no WSL backend. WSL verifies and extracts that archive
into `~/.specweave-studio/wsl-runtime/sha256-<archive-digest>` inside the selected distro,
then reuses it for later launches of the same update.

Windows keeps JavaScript and package metadata inside `app.asar` and unpacks only
native libraries and helper executables. Avoid enabling whole-package smart
unpacking: each loose file adds work to NSIS installation and counts against
the payload limit.

The artifact builder rejects a Windows package when any of these invariants
break:

- `resources/server.asar` is absent or does not contain the server entry.
- Any file marked unpacked in the ASAR header is absent from
  `resources/server.asar.unpacked`.
- On same-architecture Windows builds, the packaged primary cannot load the fff
  native library from inside `server.asar` through its `.unpacked` sibling.
- The isolated, extracted sidecar cannot load the server entry with plain Node.
- A Windows build given `--wsl-runtime` omits the WSL archive or SHA-256
  sidecar, or the sidecar digest does not match the emitted archive.
- The emitted WSL archive is not a Linux CLI release archive: it must unpack to
  a single `studio-<version>-linux-<arch>` directory holding `specweave-studio`, `client/`, and
  `node_modules/` with the Linux node-pty binary, and must not carry a loose
  server bundle (`bin.mjs`).
- The external Windows resource monitor is absent.
- The unpacked Windows application contains more than 80 files.

Cross-architecture Windows builds retain every structural and extracted-sidecar
check, but skip executing the target Electron binary. A same-architecture build
for each release target must exercise the primary native-load probe.

NSIS differential packaging remains enabled. A sidecar layout transition can
produce a larger one-time download; subsequent small releases retain their
blockmaps, with a 60 MB maximum for a representative sidecar-to-sidecar update.

## Signing

- macOS: Developer ID, hardened runtime and notarization in `release.sh`'s sign stage; see
  [desktop app](../studio/desktop-app.md#signing-and-notarization).
- Windows: Azure Trusted Signing in `release-windows-linux.yml`, on when all seven `AZURE_*`
  secrets exist; setup and secret names in
  [Releasing SpecWithCode](../studio/releasing.md#windows-code-signing).
- Linux: AppImage and `.deb` are not signed; `SHA256SUMS-windows-linux` on the release lists their
  digests.
