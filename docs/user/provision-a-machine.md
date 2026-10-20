# Provision a machine

You just bought a mini PC or rented a VPS and want it to run workers. Provisioning
installs everything a worker needs, at the versions your SpecWithCode release
pins, and tells you what is left for you to do. Run it again at any time: it only
changes what is missing or older, and never downgrades anything.

It installs or checks:

| Item                       | What you get                                                     |
| -------------------------- | ---------------------------------------------------------------- |
| git                        | From your distribution (Linux) or Xcode Command Line Tools (Mac) |
| GitHub CLI (`gh`)          | The pinned release, checked against its published SHA-256        |
| Node.js 22                 | The pinned 22.x build, checked against its published SHA-256     |
| Claude Code, Codex         | The pinned versions                                              |
| Tailscale                  | Tailscale's own package; you sign in                             |
| SpecWithCode server        | This release, checked against the release's `SHA256SUMS`         |
| Background service         | systemd user service (Linux) or launch agent (Mac)               |
| Agent commands on the PATH | The service can start `claude`, `codex`, `gh` and `git`          |
| Service runs after logout  | `loginctl enable-linger` (Linux, needs root once)                |
| Legacy `specweave-studio`  | The old command and service names keep working                   |

It never:

- turns on **Allow workers** for the machine;
- signs in to anything, or copies sign-ins from another machine;
- turns on billing or attaches Ubuntu Pro or any other subscription;
- asks for, stores or logs a root password;
- installs an operating system, formats or repartitions disks, or reboots.

Those stay your steps, and the readback at the end lists each with its exact
command.

## Supported systems

Ubuntu 22.04, 24.04 and 26.04, Debian 12 (x64 or arm64, systemd), and macOS.
On anything else, provisioning stops before changing anything and names the
nearest supported release. Windows machines cannot run workers.

## From a new machine

1. **Install the OS** yourself: Ubuntu Server 24.04 LTS is the easiest choice.
   Create a regular user with `sudo`.
2. **Reach it.** Either join it to your tailnet (`curl -fsSL
https://tailscale.com/install.sh | sh` then `sudo tailscale up
--operator="$(id -un)"`) and use `ssh you@its-tailscale-name`, or SSH to its
   LAN address. Keep host-key checking on; accept its key once after comparing
   the fingerprint shown on the machine's console.
3. **Install SpecWithCode and join** with the one-line installer from
   [Add a machine](./add-a-machine.md#with-the-one-line-installer). It
   verifies the release archive, starts the service and prints the
   `swc-machine-` line. Add that line on your main machine under **Settings >
   Connections > Add a machine**.
4. **Provision.** Either:
   - on your main machine, open **Settings > Connections**, find the machine
     under **Your private machines** and press **Provision**; or
   - on the machine itself, run `specwithcode provision`.
5. **Do your steps** from the readback: run the root line if there is one, sign
   in to the provider CLIs, then turn on **Allow workers**.

## The Provision button

The button appears on a machine row when that machine's server is new enough to
provision itself, and only for a browser allowed to maintain that machine. It
opens a sheet that first checks the machine and shows, for every item, what is
installed and what would change (`18.19.1 → 22.20.0`). **Provision \<machine\>**
then runs on that machine through its own server, streaming each step and its
log. From the button, provisioning never restarts that machine's server, so the
connection stays up; it finishes with the readback:

- **Retry** continues a run that failed or stopped at a root step; finished
  steps are only checked again.
- **Run again** starts over (it still skips what is already done).
- **Check again** repeats the check without changing anything.

## The command

```bash
specwithcode provision --dry-run   # the plan; changes nothing
specwithcode provision             # install and verify
specwithcode provision --resume    # continue a run that did not finish
specwithcode provision --json      # the readback as one JSON object
```

`specweave-studio provision` is the same command under the old name.

| Option              | What it does                                                                      |
| ------------------- | --------------------------------------------------------------------------------- |
| `--dry-run`         | Show what is installed and what would change                                      |
| `--resume`          | Continue the last unfinished run                                                  |
| `--json`            | Print the readback as JSON: OS, items wanted and found, service, your steps       |
| `--server-version`  | Install or verify that server version instead of this release (newer is kept)     |
| `--standalone`      | On a Mac with the desktop app, set up a command-line server and service beside it |
| `--restart-service` | Restart the service to apply a PATH change, only when it runs no threads          |

Exit codes: `0` provisioned (your steps may remain), `1` a step failed, `3`
waiting for the root steps.

## Root steps

Some items need root once, such as `loginctl enable-linger` or a distribution
package. Provisioning never asks for a password. Instead it writes the exact
commands to `~/.specwithcode/provision/root-steps.sh` and stops with exit code
`3`. Read the script, run it in a terminal on that machine, then run provisioning
again (or press **Retry**):

```bash
less ~/.specwithcode/provision/root-steps.sh
sudo sh ~/.specwithcode/provision/root-steps.sh
specwithcode provision --resume
```

If your user has passwordless `sudo`, provisioning runs these steps itself.

## Logs and state

Each run appends to `~/.specwithcode/provision/run.log`, and the last run's state
is kept beside it for `--resume`. Downloads are checked against their pinned
SHA-256 before anything is installed; a mismatch stops the step and leaves the
installed version alone.

## Known limits

- Install the server from a real login session (SSH or the console). `sudo -iu
other-user` has no user systemd session, so the service cannot be installed
  that way.
- On Linux, `~/.local/bin/specwithcode service install` run by hand can fail
  with "user manager unavailable", because the launcher clears the environment.
  Provisioning installs the service through the release itself and is not
  affected.
