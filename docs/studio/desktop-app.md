# Desktop app (macOS and Windows)

The desktop app wraps the same web UI as the browser workbench in an Electron
shell, so every browser feature is available on desktop. macOS is the first
target; Windows builds from the same code as an unsigned x64 installer.

## One server per SpecWithCode home

The desktop never runs a second server on data another SpecWithCode process owns.
On launch it looks for a live server, in this order:

1. Its own home: `STUDIO_HOME`, or `~/.specweave-studio` by default.
2. When `STUDIO_HOME` is not set, every home the fleet installer created beside
   it, read from `~/.specweave-studio/<identity>/installation.json`. The
   installed launchd service runs from there (for example
   `~/.specweave-studio/m4`), not from the default home.

If one answers, the desktop uses it as **This Mac** and starts nothing. It
pairs once through that installation's own `specweave-studio pair` command,
so a newer desktop never writes an older server's database. An installed
service that is still starting gets a few seconds' grace. Only when no server
answers does the desktop start its own backend on its own home.

## Build on a Mac

Prerequisites: Node 22.20, pnpm 11.10.0, Xcode Command Line Tools and a current
Rust toolchain (`rustup update stable`; the resource monitor needs rustc 1.95
or newer).

```sh
pnpm install
pnpm dist:desktop:dmg:arm64      # release/SpecWithCode-<version>-arm64.dmg and .zip, plus SpecWithCode-arm64.dmg
```

The build is unsigned unless `--signed` is passed. To open an unsigned or
unnotarized app the first time, open it once, then open **System Settings →
Privacy & Security** and choose **Open Anyway** (macOS 15 and later no longer
offer Open from the Finder right-click menu for this), or run
`xattr -dr com.apple.quarantine "/Applications/SpecWithCode.app"`.

Known build issues:

- With the macOS 27 SDK, Xcode's `ld` cannot read the SDK's arm64e `.tbd`
  files. Build with `DEVELOPER_DIR=/Library/Developer/CommandLineTools`.
- A `ld` earlier on `PATH` (for example from Anaconda) shadows the system
  linker; remove it from `PATH` for the build.

Without a Mac, run the **Desktop macOS unsigned build** workflow
(`.github/workflows/desktop-macos-unsigned.yml`) from the Actions tab. It
builds on a GitHub-hosted Apple silicon runner, needs no secrets and keeps the
dmg and zip as a workflow artifact for 14 days.

## Build for Windows

On a Windows PC with Node 22.20, pnpm 11.10.0, Rust (`rustup target add
x86_64-pc-windows-msvc`) and Visual Studio Build Tools with the C++ workload
and the Spectre-mitigated libraries:

```sh
pnpm install
node scripts/build-desktop-artifact.ts --platform win --target nsis --arch x64
```

The installer lands in `release/SpecWithCode-<version>-x64.exe`. It is
unsigned, so SmartScreen warns on first run: choose More info, then Run anyway.

Without a Windows PC, run the **Desktop Windows unsigned build** workflow
(`.github/workflows/desktop-windows-unsigned.yml`) from the Actions tab. It
builds on a GitHub-hosted Windows runner, smoke-tests the packaged app and
keeps the installer for 14 days.

A Linux machine can also cross-build a test installer. The resource monitor
cross-compiles with MinGW in place of MSVC, and NSIS needs 32-bit Wine to
write the uninstaller (`wine32:i386` on Ubuntu, with `wine` on `PATH`). The
cross build cannot load the Windows sidecar on Linux, so it skips that check;
smoke-test the installer on a Windows PC before handing it out:

```sh
sudo apt-get install mingw-w64
rustup target add x86_64-pc-windows-gnu
cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml --target x86_64-pc-windows-gnu
mkdir -p native/resource-monitor/target/x86_64-pc-windows-msvc/release
cp native/resource-monitor/target/x86_64-pc-windows-gnu/release/studio-resource-monitor.exe \
  native/resource-monitor/target/x86_64-pc-windows-msvc/release/
STUDIO_DESKTOP_REUSE_RESOURCE_MONITOR=true STUDIO_DESKTOP_WINDOWS_CROSS_BUILD=true PATH="$PWD/node_modules/.bin:$PATH" \
  node scripts/build-desktop-artifact.ts --platform win --target nsis --arch x64
```

Windows differences:

- The WSL backend is left out of these builds; it embeds the Linux CLI archive
  that only a release run produces. The native Windows backend works without
  it.
- Attaching to a running service pairs through that service's own CLI on macOS
  and Linux. Windows does not expose another process's command line here, so
  the desktop attaches only to a service of its own version and otherwise
  explains why it cannot.
- Keep-awake uses the same Electron power blocker on Windows.

## Smoke test

```sh
pnpm --filter @specweave-studio/desktop smoke-test
```

It launches the built app with a throwaway home, Electron profile and mock
keychain, passes only after the backend answers and the main window opens,
and fails on early exit, a fatal startup error or a renderer error. It never
touches `~/.specweave-studio`.

## Signing and notarization

Signed builds need these repository secrets (names only; values stay with the
owner): `CSC_LINK` and `CSC_KEY_PASSWORD` for the Developer ID Application
certificate, and `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` for
notarization with an App Store Connect API key. A local signed build reads the same
variables: `CSC_LINK` is the path to the `.p12`, `APPLE_API_KEY` the path to the `.p8`, and
`pnpm dist:desktop:dmg:arm64 --signed` signs, notarizes and staples. Release builds must be
signed this way; see [releasing](releasing.md#desktop-assets). Clerk passkey entitlements are
optional: a build without `STUDIO_CLERK_PUBLISHABLE_KEY` or
`STUDIO_CLERK_PASSKEY_RP_DOMAINS` signs without an Associated Domains
provisioning profile.

## Security rules

These follow [security.md](security.md) where it covers the desktop:

- The embedded server stays on loopback. Reach other devices through Tailscale
  Serve, not the `0.0.0.0` exposure mode.
- The connection catalog is encrypted with the OS secure store (Keychain on
  macOS) and kept in the SpecWithCode state folder, never in web storage.
- The CLIProxyAPI management key and provider tokens stay server-side; the
  renderer never receives them.
- Hosted relay and telemetry stay off. Self-update is on by default and
  reads only SpecWithCode's own releases; see [updates.md](updates.md).
