# Install SpecWithCode

SpecWithCode runs coding agents on your computer and lets you control them from its
desktop or web app. Set up the machine where the agents will work first.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch SpecWithCode and configure providers afterwards.

## Desktop app

Download [SpecWithCode-arm64.dmg](https://github.com/anton-abyzov/specwithcode/releases/latest/download/SpecWithCode-arm64.dmg),
the latest release, and drag SpecWithCode to Applications. It runs on Apple
silicon Macs with macOS 13 or later. Releases are signed with an Apple Developer ID and notarized,
so the app opens without a security override. The desktop app starts the local service for you.
Windows, Linux and Intel Mac builds are not published yet.

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
carry `install.sh` yet. There is no Windows or Intel Mac build.

### Join your existing machines from the terminal

To add this machine to the ones you already use, run the installer with `--join`:

```bash
curl -fsSL https://github.com/anton-abyzov/specwithcode/releases/latest/download/install.sh | bash -s -- --join
```

1. It sets up [Tailscale](https://tailscale.com/download) first. If Tailscale is missing, it asks
   to install it (Tailscale's signed package on macOS, Tailscale's own installer on Linux; both
   ask for your password). If Tailscale is signed out, it opens the sign-in page in your
   browser and waits. Sign in with the account your main machine uses. Add `--yes` to install
   Tailscale without the question.
2. It installs and starts SpecWithCode as above, then runs `specwithcode fleet invite`, which
   publishes this machine on its Tailscale name and prints one line starting with `swc-machine-`.
   On a machine that already runs SpecWithCode, it only prints that line. Treat it like a password.
3. On your main machine, run the `specwithcode fleet add <line>` it shows, or paste the line into
   **Settings > Connections > Add a machine**.

Later you can print a new line with `specwithcode fleet invite` on its own.

Once `specwithcode` is on your `PATH` (from the installer, or built from source; the desktop app
does not add it), these commands cover the basics.
The same tool is also installed under its original name, `specweave-studio`, so older scripts keep working.

| Task                                             | Command                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| Start the server and open the web app            | `specwithcode`                                                      |
| Start the server without a browser               | `specwithcode serve`                                                |
| Keep it running in the background (macOS, Linux) | `specwithcode service install` ([details](./background-service.md)) |
| Move to a newer release                          | Run the installer again, or see [Updating](./updating.md)           |
| Remove it again                                  | `specwithcode uninstall`                                            |

Run `specwithcode help` or `specwithcode --help` for the full reference. To start in a new working
directory, use an explicit path such as `specwithcode ./my-project`. A bare directory name
is accepted only if it already exists.

If `specwithcode` or `specwithcode start` reports an already running server, connect to that server
instead. Stop it before starting a replacement, or use a different `--base-dir`
for an independent server.

The `specweave-studio` npm package is not published yet, so `npx specweave-studio@latest` is not
available either.

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
It runs on Node.js 22.20 or later 22.x and needs no compiler. There is no Linux desktop app;
control the server from the Mac desktop app, the web app or a phone. [Linux worker](./linux-worker.md)
walks through install, Tailscale, the user service and pairing it with your Mac as a fleet worker.

## Windows Subsystem for Linux

Windows builds are not published yet; this applies to a Windows desktop app built from source.
Choose a WSL distro in **Settings → Connections** to run agents and projects
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
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from SpecWithCode's provider settings.                                                                                    |
| Pi          | Install [Pi](https://pi.dev), then run `pi` once to finish its login or API-key setup.                                                                    |

Provider CLIs must be on the server's `PATH`. If SpecWithCode cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
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
- [Linux worker](./linux-worker.md): run workers on a Linux machine or VPS.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating SpecWithCode](./updating.md): update the app and connected servers.
