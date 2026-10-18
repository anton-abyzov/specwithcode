# Linux worker

Add a Linux machine, such as a small VPS, to your private fleet so coordinators on
your Mac can start workers there. It runs the same SpecWithCode server as a Mac
worker; only the install differs. Cloud compute stays yours: you rent the VPS and
sign its provider CLIs in with your own accounts. This is how SpecWithCode runs
work off your own computers; it does not start sessions on a provider's VMs.

SpecWithCode does not use provider cloud sessions; a Linux VPS you rent is the
replacement.

> **Use API keys on a VPS, never a subscription.** We do not recommend signing
> Claude Code (Pro or Max) or Codex (ChatGPT) subscriptions in on Hetzner, AWS
> or any other rented server or VPN. Providers treat sign-ins from datacenter
> addresses, and one account active on several machines at once, as signs of
> reselling, and accounts get locked. A VPS worker is for API keys only: an
> Anthropic Console key or an OpenAI API key, billed per token. Keep your
> subscription sign-ins on your own computers at home or in the office. Never
> route a subscription through a proxy to a server; Anthropic does not allow its
> subscription credentials to be held or relayed by other tools.

## Where it can run

Any Linux virtual machine you control works the same way, whoever rents it to
you: Hetzner, Hostinger, DigitalOcean, AWS EC2, Azure, Google Cloud or a box at
home. The fleet only needs the host to join your tailnet; it never looks at the
provider. Pick an Ubuntu 24.04 or Debian 12 image on x64 or arm64 (AWS Graviton,
Hetzner CAX and Azure Dpsv5 machines are arm64).

Tailscale connects outward, so the host needs no open inbound port: leave the
provider's firewall or security group closed to everything but SSH, or close SSH
too and use Tailscale SSH. Windows hosts cannot run workers, because the
background service is Linux and macOS only.

On a fresh Ubuntu or Debian VM, as a regular user with `sudo`:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --operator="$(id -un)"
```

On a host where Tailscale is already up, run
`sudo tailscale set --operator="$(id -un)"` instead. Making your user the
operator lets SpecWithCode set up Tailscale Serve without root.

Sign in with the Tailscale account your Mac uses, then in the Tailscale admin
console turn off key expiry for this machine so it does not drop out of the fleet
after a few months. HTTPS certificates must be enabled for the tailnet: in the
admin console, open **DNS** and turn on **HTTPS Certificates**. Install Node.js
22 from your distribution's NodeSource or `fnm` instructions, then follow the
steps below.

## What you need

- A Linux host on x64 or arm64 with glibc (Debian 12, Ubuntu 22.04 or later,
  Fedora 40 or later) and a systemd user session.
- Node.js 22.20 or a later 22.x release on that host. The archive holds
  JavaScript and the native builds for Linux; it needs no compiler.
- The same Tailscale tailnet as your Mac, with MagicDNS. The fleet only accepts
  private `*.ts.net` HTTPS addresses.
- The provider CLIs you want to run there (`claude`, `codex`), using API keys
  only (see [Give the agents API keys](#give-the-agents-api-keys) and
  [Add a machine](./add-a-machine.md#keep-your-provider-accounts-safe)).
- A `specwithcode` release that ships Linux archives:
  `studio-<version>-linux-<arch>-<commit>.tar.gz` next to `SHA256SUMS`.

## Install the server

On the Linux host, download the archive and its checksums from the release and
verify them. Use 1.0.44 or later: in 1.0.43, `service install` cannot fetch
its own Linux archive.

```bash
VERSION=$(curl -fsSL https://api.github.com/repos/anton-abyzov/specwithcode/releases/latest \
  | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p')
ARCH=$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')
BASE=https://github.com/anton-abyzov/specwithcode/releases/download/v$VERSION
curl -fsSLO "$BASE/SHA256SUMS"
ARCHIVE=$(grep -o "studio-$VERSION-linux-$ARCH-[0-9a-f]*\.tar\.gz" SHA256SUMS | head -n1)
curl -fsSLO "$BASE/$ARCHIVE"
grep "$ARCHIVE" SHA256SUMS | sha256sum -c -
```

Unpack it into a temporary folder and run its `bin.mjs` once to bootstrap the
background service:

```bash
mkdir -p /tmp/swc && tar -xzf "$ARCHIVE" -C /tmp/swc
sudo loginctl enable-linger "$(id -un)"
node /tmp/swc/bin.mjs service install
```

`service install` pins this version under
`~/.specwithcode/runtime/versions/$VERSION`, downloading it from the release,
and writes the systemd user unit; lingering keeps it running after you log out
and starts it at boot. Then put the command on your `PATH` and remove the
temporary copy:

```bash
mkdir -p ~/.local/bin
ln -sf ~/.specwithcode/runtime/versions/$VERSION/specweave-studio ~/.local/bin/specwithcode
rm -rf /tmp/swc
specwithcode service status
specwithcode --version
```

The service takes the `PATH` of your login shell when it starts. Install
`claude` and `codex` so they run in a new SSH session, then run
`specwithcode service restart`.

To update, run `STUDIO_ENABLE_SELF_UPDATE=true specwithcode update --yes` on the
host, or update it from the Mac. It installs the next release the same way,
under `~/.specwithcode/runtime/versions/<version>`, switches the `specwithcode`
command to it and restarts the service; `--yes` allows the restart from a
script.

[Running in the background](./background-service.md) covers the systemd
details and troubleshooting.

## Give the agents API keys

Create a key in the [Claude Console](https://platform.claude.com/settings/keys)
(set a spend limit on its workspace) and save it in a file only you can read.
From your Mac, run this, then paste the key at the prompt; it is not shown:

```bash
ssh -t you@your-vps 'umask 077; mkdir -p ~/.config/specwithcode; printf "Paste the API key, then Enter: "; read -rs K; printf "%s\n" "$K" > ~/.config/specwithcode/anthropic.key; echo; echo saved'
```

Copy the key only after this command is waiting, so copying the command does
not replace the key on your clipboard. Never paste a key into a chat.

Then let Claude Code read it on the VPS, so nothing is ever signed in:

```bash
curl -fsSL https://claude.ai/install.sh | bash
mkdir -p ~/.claude
cat > ~/.claude/settings.json <<'EOF'
{ "apiKeyHelper": "tr -d '[:space:]' < ~/.config/specwithcode/anthropic.key" }
EOF
claude -p "Reply with OK"
```

Create the key inside a workspace (Default is fine). A personal key that
belongs to no workspace fails with "This API key is not scoped to a
workspace"; if you keep one, add its workspace ID (`wrkspc_…`, from **Settings >
Workspaces**) to the same file:

```json
{
  "apiKeyHelper": "tr -d '[:space:]' < ~/.config/specwithcode/anthropic.key",
  "env": { "ANTHROPIC_CUSTOM_HEADERS": "anthropic-workspace-id: wrkspc_…" }
}
```

For Codex, install it with `sudo npm install -g @openai/codex`, then run
`printenv OPENAI_API_KEY | codex login --with-api-key` with the
key in that variable. Do not run `claude login` or `codex login` with a
subscription on a VPS.

## Pair it with your Mac

On the Linux host, run:

```bash
specwithcode fleet invite
```

It publishes the server on `https://<host>.<tailnet>.ts.net` through Tailscale
Serve: the address persists across restarts and is reachable only on your
tailnet. It prints one line starting with `swc-machine-`. Treat it like a password. On
the Mac, run `specwithcode fleet add <that line>`, or paste it into
**Settings > Connections > Your private machines > Add a machine**. The Mac
checks that the worker answers at its Tailscale address before saving it; no
restart is needed. [Add a machine](./add-a-machine.md) covers the details.

The worker then appears under **Your private machines**: choose **Connect
machine** to pair this browser with it (with **Connect automatically** on, this
happens by itself), and under **Workers** choose the most a worker there may do
and **Allow workers**. From then on a coordinator can start work there with
`studio_thread_launch {machine: "Hetzner VPS"}`, and `studio_machine_list` shows
it as ready.

## What the worker needs for a project

The project must exist on the worker as its own checkout: clone it there and
register it in SpecWithCode on the worker, with the same remote as on the Mac so
`studio_machine_list` can match them:

```bash
git clone <same remote as on the Mac> ~/code/<repo>
specwithcode project add ~/code/<repo>
```

Install the project's toolchain on the
worker as you would on any machine. Nothing is synchronized between machines:
not files, not provider sign-ins, not browser logins.

## Costs

A worker idles at well under one CPU and a few hundred MB of memory; the
agents it runs decide the rest. A 2 vCPU, 4 GB VPS is enough for one or two
agents at a time. You pay the host directly; SpecWithCode adds nothing.
