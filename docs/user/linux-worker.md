# Linux worker

Add a Linux machine, such as a small VPS, to your private fleet so coordinators on
your Mac can start workers there. It runs the same SpecWithCode server as a Mac
worker; only the install differs. Cloud compute stays yours: you rent the VPS and
sign its provider CLIs in with your own accounts. This is how SpecWithCode runs
work off your own computers; it does not start sessions on a provider's VMs.

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
sudo tailscale up
```

Sign in with the Tailscale account your Mac uses, then in the Tailscale admin
console turn off key expiry for this machine so it does not drop out of the fleet
after a few months. Install Node.js 22 from your distribution's NodeSource or
`fnm` instructions, then follow the steps below.

## What you need

- A Linux host on x64 or arm64 with glibc (Debian 12, Ubuntu 22.04 or later,
  Fedora 40 or later) and a systemd user session.
- Node.js 22.20 or a later 22.x release on that host. The archive holds
  JavaScript and the native builds for Linux; it needs no compiler.
- The same Tailscale tailnet as your Mac, with MagicDNS. The fleet only accepts
  private `*.ts.net` HTTPS addresses.
- The provider CLIs you want to run there (`claude`, `codex`), signed in on
  that host with your own accounts. On a rented VPS, prefer an API key over a
  subscription sign-in; see [Add a machine](./add-a-machine.md#keep-your-provider-accounts-safe).
- A `specwithcode` release that ships Linux archives:
  `studio-<version>-linux-<arch>-<commit>.tar.gz` next to `SHA256SUMS`.

## Install the server

On the Linux host, download the archive and its checksums from the release and
verify them:

```bash
VERSION=1.0.43
ARCH=$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')
BASE=https://github.com/anton-abyzov/specwithcode/releases/download/v$VERSION
curl -fsSLO "$BASE/SHA256SUMS"
ARCHIVE=$(grep -o "studio-$VERSION-linux-$ARCH-[0-9a-f]*\.tar\.gz" SHA256SUMS | head -n1)
curl -fsSLO "$BASE/$ARCHIVE"
grep "$ARCHIVE" SHA256SUMS | sha256sum -c -
```

Unpack it into a folder of its own and give it a command:

```bash
mkdir -p ~/.local/share/specwithcode/runtime/$VERSION ~/.local/bin
tar -xzf "$ARCHIVE" -C ~/.local/share/specwithcode/runtime/$VERSION
printf '#!/bin/sh\nexec node "%s/bin.mjs" "$@"\n' "$HOME/.local/share/specwithcode/runtime/$VERSION" \
  > ~/.local/bin/specwithcode
chmod +x ~/.local/bin/specwithcode
specwithcode --version
```

Keep `~/.local/bin` on the `PATH` of login shells and of the user service. To
update, unpack the next release into its own folder and point the wrapper at it.

## Run it and reach it over Tailscale

Start the server once by hand with Tailscale Serve, which gives it a private
HTTPS address on the tailnet:

```bash
specwithcode serve --tailscale-serve
```

Tailscale must be running on the host, and Serve must be allowed for your
tailnet. The server prints the `https://<host>.<tailnet>.ts.net` address it
answers on. Then make it a user service so it survives logouts and reboots:

```bash
specwithcode service install
specwithcode service status
```

[Running in the background](./background-service.md) covers the systemd
details and the lingering setting the installer enables.

## Pair it with your Mac

On the Linux host, run:

```bash
specwithcode fleet invite
```

It prints one line starting with `swc-machine-`. Treat it like a password. On
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
`studio_machine_list` can match them. Install the project's toolchain on the
worker as you would on any machine. Nothing is synchronized between machines:
not files, not provider sign-ins, not browser logins.

## Costs

A worker idles at well under one CPU and a few hundred MB of memory; the
agents it runs decide the rest. A 2 vCPU, 4 GB VPS is enough for one or two
agents at a time. You pay the host directly; SpecWithCode adds nothing.
