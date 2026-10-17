# Linux worker

Add a Linux machine, such as a small VPS, to your private fleet so coordinators on
your Mac can start workers there. It runs the same SpecWithCode server as a Mac
worker; only the install differs. Cloud compute stays yours: you rent the VPS and
sign its provider CLIs in with your own accounts. For work on Anthropic's VMs
instead, see [cloud sessions](./cloud-sessions.md).

## What you need

- A Linux host on x64 or arm64 with glibc (Debian 12, Ubuntu 22.04 or later,
  Fedora 40 or later) and a systemd user session.
- Node.js 22.20 or a later 22.x release on that host. The archive holds
  JavaScript and the native builds for Linux; it needs no compiler.
- The same Tailscale tailnet as your Mac, with MagicDNS. The fleet only accepts
  private `*.ts.net` HTTPS addresses.
- The provider CLIs you want to run there (`claude`, `codex`), signed in on
  that host with your own accounts.
- A `specwithcode` release that ships Linux archives:
  `studio-<version>-linux-<arch>-<commit>.tar.gz` next to `SHA256SUMS`.

## Install the server

On the Linux host, download the archive and its checksums from the release and
verify them:

```bash
VERSION=1.0.40
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

Coordinators reach workers through the primary server's fleet file. On the Linux
host, issue a management credential for the Mac. It only lets the Mac create
short-lived pairing links on this worker:

```bash
specwithcode auth session issue --scope access:write --label "Fleet management from my Mac" --token-only
```

Treat the printed token like a password. On the Mac, add the worker to
`studio-fleet.json` in the primary server's base folder (for example
`~/.specwithcode/m4/studio-fleet.json`), then restart the Mac server:

```json
{
  "version": 1,
  "machines": [
    {
      "id": "vps1",
      "label": "Hetzner VPS",
      "environmentId": "<the worker's environment id>",
      "url": "https://vps1.tailnet-name.ts.net",
      "managementToken": "<the token from the worker>"
    }
  ]
}
```

The environment id is the content of the `environment-id` file in the worker's
SpecWithCode state folder, written on first start. Keep `studio-fleet.json`
readable by your user only; it holds the token.

In the desktop app, open **Settings > Connections**. The worker appears under
**Your private machines**: choose **Connect machine** to pair this browser with
it, and under **Workers** choose the most a worker there may do and **Allow
workers**. From then on a coordinator can start work there with
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
