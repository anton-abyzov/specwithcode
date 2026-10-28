# Install SpecWithCode

Replace `<main-machine-environment-id>` with the environment ID from Settings > Connections on your main machine. This explicitly approves that machine to manage access here.

SpecWithCode runs coding agents on your computer and lets you control them from its
desktop or web app. Set up the machine where the agents will work first.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch SpecWithCode and configure providers afterwards.

## Desktop app

Public desktop installers support macOS 13 or later on Apple silicon, Windows 10 and 11
on x64, and Linux x64 with glibc. Choose your platform below. There is no Intel Mac desktop build.
The desktop app starts the local service for you.

### macOS

Download [SpecWithCode-arm64.dmg](https://github.com/anton-abyzov/specwithcode/releases/latest/download/SpecWithCode-arm64.dmg),
the latest release, and drag SpecWithCode to Applications. It runs on Apple
silicon Macs with macOS 13 or later. Releases are signed with an Apple Developer ID and notarized,
so the app opens without a security override. The desktop app starts the local service for you.
There is no Intel Mac build.

### Windows

Download `SpecWithCode-<version>-x64.exe` from the
[verified Windows/Linux release](https://github.com/anton-abyzov/specwithcode/releases/tag/v1.0.94) and run it. It
installs for your user only, so it needs no administrator, into
`%LOCALAPPDATA%\Programs\studio`, and adds Start menu and desktop shortcuts. It runs on
64-bit Windows 10 and 11. For a silent install, run it with `/S`.

The installer is not code-signed yet, so Microsoft Defender SmartScreen shows **Windows protected
your PC** the first time. Choose **More info**, then **Run anyway**. Releases list each file's
SHA-256 in `SHA256SUMS-windows-linux`; check a download with
`Get-FileHash .\SpecWithCode-<version>-x64.exe` before you run it.

### Linux

Download one of these from the [verified Windows/Linux release](https://github.com/anton-abyzov/specwithcode/releases/tag/v1.0.94)
(x64, glibc):

- `SpecWithCode-<version>-amd64.deb` for Debian and Ubuntu:
  `sudo apt install ./SpecWithCode-<version>-amd64.deb`. The app goes to `/opt/SpecWithCode`
  with a menu entry; the package is named `studio`, so remove it with `sudo apt remove studio`.
- `SpecWithCode-<version>-x86_64.AppImage` for other distributions: `chmod +x` it and run it.
  AppImages need FUSE 2 (`libfuse2`, or `libfuse2t64` on Ubuntu 24.04).

### What differs on Windows and Linux

Threads, the project coordinator, providers, pairing other devices, adding machines, the
terminal and source control work as on macOS. These do not:

- [Computer use](./computer-use.md) controls a Mac's screen and is macOS only. Windows and Linux
  apps say so instead of offering it.
- Updates: the Windows app, the AppImage and the `.deb` install update themselves from the
  release, as on macOS; the `.deb` update asks for your password. A background service installed
  from the command line on Linux is updated with `specwithcode update`, not from the app.
- The background service is a scheduled task for your user on Windows and a systemd user service
  on Linux ([Running in the background](./background-service.md)). The tray keeps it running when
  you close the window.
- Windows has no `install.sh` one-liner; use the desktop app, or [npm](#npm) for the command line.

To use this computer as a worker for a main machine you already have, see
[Add a machine](./add-a-machine.md). From 1.0.44 the first screen offers **Join my existing
machines**; on 1.0.43, [one Terminal command](./add-a-machine.md#desktop-app-1043) makes the line.

## Command line

On an Apple silicon Mac, or on Linux (x64 or arm64, with glibc and systemd), install SpecWithCode
and start it as a [background service](./background-service.md) with one line:

```bash
curl -fsSL https://github.com/anton-abyzov/specwithcode/releases/latest/download/install.sh | bash
```

It downloads the server archive and `SHA256SUMS` from the latest release, checks the archive,
and unpacks it under `~/.specwithcode/runtime`. The archive needs Node.js 22, so a private copy
of Node.js 22.20.0 from nodejs.org, checked against a pinned SHA-256, goes beside it; pass
`--node /path/to/node` to use your own Node.js 22.20 or later 22.x instead. It puts `specwithcode`
in `~/.local/bin` and tells you if that folder is not on your `PATH`. Your projects, threads and
settings are not touched, and it leaves a Mac alone that already runs the desktop app or a managed
service. Run the same line again to move to a newer release. Add `-s -- --dry-run` after `bash`
to see what it would do, or `-s -- --no-service` to skip the service. Releases up to 1.0.43 do not
carry `install.sh`; for those use [npm](#npm) or the desktop app. On Windows, use the desktop app or npm.

### Join your existing machines from the terminal

To let your main machine start work on this one, run the installer with `--join` (1.0.44 and
later). To only reach this machine from your other devices, run `specwithcode connect` instead;
see [Remote access](./remote-access.md#specwithcode-connect).

```bash
curl -fsSL https://github.com/anton-abyzov/specwithcode/releases/latest/download/install.sh | bash -s -- --join --coordinator '<main-machine-environment-id>'
```

1. It sets up [Tailscale](https://tailscale.com/download) first, the route this installer uses.
   (SpecWithCode Connect alone is also enough; see [Add a machine](./add-a-machine.md) for
   joining without Tailscale.) If Tailscale is missing, it asks
   to install it (Tailscale's signed package on macOS, Tailscale's own installer on Linux; both
   ask for your password). If Tailscale is signed out, it opens the sign-in page in your
   browser and waits. Sign in with the account your main machine uses. Add `--yes` to install
   Tailscale without the question.
2. It installs and starts SpecWithCode as above, then runs `specwithcode fleet invite --coordinator '<main-machine-environment-id>'`, which
   publishes this machine on its Tailscale name and prints one line starting with `swc-machine-`.
   On a machine that already runs SpecWithCode, it only prints that line. Treat it like a password.
3. On your main machine, run the `specwithcode fleet add <line>` it shows, or paste the line into
   **Settings > Connections > Add a machine**.

Later you can print a new line with `specwithcode fleet invite --coordinator '<main-machine-environment-id>'` on its own. Every other way to
join, including over SpecWithCode Connect, the optional Tailscale settings and troubleshooting are in
[Add a machine](./add-a-machine.md).

### npm

With Node.js 22.16 or later (23.11+ or 24.10+) on macOS or Linux, install the server and its command from npm:

```bash
npm i -g specwithcode
```

Then start it with `specwithcode serve`, or make a line for your main machine with
`specwithcode fleet invite --coordinator '<main-machine-environment-id>'` ([Add a machine](./add-a-machine.md#with-npm)). On a Mac that already
runs the desktop app, do not start a second server: run only `specwithcode fleet invite --coordinator '<main-machine-environment-id>'`, which
uses the server the app is running. To keep an npm install running after you close
Terminal or restart, run `specwithcode service install` (1.0.46 and later): the service pins a
copy of the installed package under `~/.specwithcode/runtime/versions/<version>` and runs it with
the Node.js that ran the install.

Once `specwithcode` is on your `PATH` (from the installer, npm, or built from source; the desktop
app does not add it), these commands cover the basics.
The same tool is also installed under its original name, `specweave-studio`, so older scripts keep working.

| Task                                                      | Command                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------- |
| Start the server and open the web app                     | `specwithcode`                                                      |
| Start the server without a browser                        | `specwithcode serve`                                                |
| Keep it running in the background (macOS, Windows, Linux) | `specwithcode service install` ([details](./background-service.md)) |
| Move to a newer release                                   | Run the installer again, or see [Updating](./updating.md)           |
| Remove it again                                           | `specwithcode uninstall`                                            |

Run `specwithcode help` or `specwithcode --help` for the full reference. To start in a new working
directory, use an explicit path such as `specwithcode ./my-project`. A bare directory name
is accepted only if it already exists.

If SpecWithCode already runs on this machine (the desktop app, the service or another terminal),
`specwithcode` and `specwithcode start` open that server in your browser rather than starting a
second one; with `--no-browser` they print where it runs. Versions 1.0.43 and 1.0.44 instead stop
with "A SpecWithCode server is already running for …": open the app or run `specwithcode pair`. Use a
different `--base-dir` for an independent server.

The npm package is `specwithcode`; there is no `specweave-studio` package on npm.

### Build from source

Build the server with Node.js 22.20 or a later 22.x
release and pnpm 11.10.0. `package.json` pins both, and Corepack runs that pnpm. The
[AGENTS.md](../../AGENTS.md#commands) lists the build commands:

```bash
git clone https://github.com/anton-abyzov/specwithcode
cd specwithcode
corepack pnpm install --frozen-lockfile
(cd apps/web && node ../../node_modules/vite-plus/bin/vp build)
node apps/server/scripts/cli.ts build
node apps/server/dist/bin.mjs
```

The background service does not apply to a server run this way; update it with
`git pull` and a rebuild.

There is no `specwithcode` executable for Intel Macs, so building from source is the only
way to run a server there.

## Linux server

Releases ship a server archive for Linux x64 and arm64 (`studio-<version>-linux-<arch>-<commit>.tar.gz`).
It runs on Node.js 22.20 or later 22.x and needs no compiler. For a server-only install,
control it from the desktop app on another computer, the web app or a phone. [Linux worker](./linux-worker.md)
walks through install, the user service and pairing it with your main computer as a fleet worker.
To only reach it from your other devices, [SpecWithCode Connect](./remote-access.md#specwithcode-connect)
needs no Tailscale.

## Windows Subsystem for Linux

In the Windows desktop app, choose a WSL distro in **Settings → Connections** to run agents and projects
there. Install the provider CLIs inside that distro. SpecWithCode installs its own
server runtime there automatically; the first launch after an app update can
take longer.

## Open a project from a terminal

With the desktop app already running on the same machine:

```bash
specwithcode app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `specwithcode app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Mobile app

There is no published SpecWithCode mobile app yet. It is not in the App Store or on Google
Play, and there is no TestFlight or Google Play beta. To use SpecWithCode from a phone, open
the web app in the phone's browser and follow [remote access](./remote-access.md).

The mobile app's source is in `apps/mobile`. A build you make from it connects to a server on
another machine through SpecWithCode Connect or a pairing URL. If that build crashes during launch,
open Settings → Diagnostics on the next launch that succeeds. It lists startup crashes from the
last 7 days with the error and component stack. Copy the report and paste it into a GitHub
issue. Error messages can quote values from the app, so read it over before sharing.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Sign in from **Settings → Providers → Cursor**, or set `CURSOR_API_KEY`. No CLI needed.                                                                   |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from SpecWithCode's provider settings.                                                                                    |
| Pi          | Install [Pi](https://pi.dev), then run `pi` once to finish its login or API-key setup.                                                                    |

Provider CLIs must be on the server's `PATH`. If SpecWithCode cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor runs through its SDK as a local agent, so it needs no CLI. Install the
[Cursor CLI](https://cursor.com/cli) and run `agent login` with the same account only if you
want Cursor history and limits on **Usage**. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

SpecWithCode warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or the
CLI's own update command when SpecWithCode cannot tell. Update a CLI installed with
mise through mise. Cursor and Antigravity update with SpecWithCode. Homebrew installs
compare against the version Homebrew offers, which can trail the npm release by
a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, SpecWithCode does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), and [Pi](./providers-pi.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Add a machine](./add-a-machine.md): let your main machine start work on your other computers.
- [Linux worker](./linux-worker.md): run workers on a Linux machine or VPS.
- [Running in the background](./background-service.md): keep a Windows, Linux or macOS host available.
- [Updating SpecWithCode](./updating.md): update the app and connected servers.
