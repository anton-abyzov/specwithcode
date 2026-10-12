# Install SpecWithCode

SpecWithCode runs coding agents on your computer and lets you control them from its
desktop or web app. Set up the machine where the agents will work first.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch SpecWithCode and configure providers afterwards.

## Desktop app

Download [SpecWithCode-arm64.dmg](https://github.com/anton-abyzov/specwithcode/releases/latest/download/SpecWithCode-arm64.dmg),
the latest release, and drag SpecWithCode to Applications. It runs on Apple
silicon Macs with macOS 13 or later. The build is not notarized yet: on first launch, open
**System Settings → Privacy & Security** and choose **Open Anyway**. The desktop app starts the local
service for you.

## Command line

A one-line installer is not available yet. No site hosts `install.sh` or `install.ps1`, and the
installer scripts in `scripts/` do not yet match the release archive names. Use the desktop app, or
[build from source](#build-from-source).

Once `specweave-studio` is on your `PATH` (built from source, or from the desktop app), these commands cover the basics:

| Task                                             | Command                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| Start the server and open the web app            | `specweave-studio`                                                      |
| Start the server without a browser               | `specweave-studio serve`                                                |
| Keep it running in the background (macOS, Linux) | `specweave-studio service install` ([details](./background-service.md)) |
| Move to a newer release                          | See [Updating SpecWithCode](./updating.md)                              |
| Remove it again                                  | `specweave-studio uninstall`                                            |

Run `specweave-studio help` or `specweave-studio --help` for the full reference. To start in a new working
directory, use an explicit path such as `specweave-studio ./my-project`. A bare directory name
is accepted only if it already exists.

If `specweave-studio` or `specweave-studio start` reports an already running server, connect to that server
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

There is no `specweave-studio` executable for Intel Macs, so building from source is the only
way to run a server there.

## Desktop app

Download a release from [GitHub Releases](https://github.com/anton-abyzov/specwithcode/releases).
On Debian or Ubuntu, install the downloaded package with
`sudo apt install ./SpecWithCode-*.deb`.

The `.deb` updates itself like the other desktop builds. It asks for your
password to install each update. If your desktop has no password prompt, the
update fails. Download the new `.deb` and install it the same way.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects
there. Install the provider CLIs inside that distro. SpecWithCode installs its own
server runtime there automatically; the first launch after an app update can
take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
specweave-studio app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `specweave-studio app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Mobile app

There is no published SpecWithCode mobile app yet. It is not in the App Store or on Google
Play, and there is no TestFlight or Google Play beta. To use SpecWithCode from a phone, open
the web app in the phone's browser and follow [remote access](./remote-access.md).

The mobile app's source is in `apps/mobile`. A build you make from it connects to a server on
another machine through Studio Connect or a pairing URL. If that build crashes during launch,
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
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating SpecWithCode](./updating.md): update the app and connected servers.
