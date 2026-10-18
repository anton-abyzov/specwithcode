# Running SpecWithCode in the background

On Linux and macOS, SpecWithCode can run as a service for your user so you do not need
to keep a terminal open.

## Manage the service

Install the `specwithcode` CLI first ([Install SpecWithCode](./install.md#command-line)), then
run these commands on the machine that will host SpecWithCode. Older installs also answer to
`specweave-studio`. On a Linux host such as a VPS you rent, follow the
[Linux worker](./linux-worker.md) guide instead; it installs the service for you.

| Task                            | Command                                    |
| ------------------------------- | ------------------------------------------ |
| Install and start               | `specwithcode service install`             |
| Inspect status and log location | `specwithcode service status`              |
| Move to a newer release         | See [Updating SpecWithCode](./updating.md) |
| Restart                         | `specwithcode service restart`             |
| Stop and remove from startup    | `specwithcode service uninstall`           |

Uninstalling the service leaves your projects, threads, and settings intact.
Running `specwithcode service install` again repairs a service that `specwithcode service status`
reports as broken.

If the server was installed from npm (`npm i -g specwithcode`), update it with
`npm i -g specwithcode@<version>` and then `specwithcode service install`, which
re-pins the service to the new package. The CLI's own `specwithcode update` is off
unless `STUDIO_ENABLE_SELF_UPDATE=true` is set. For other installs, move the service to a newer
release the way the server was installed:

- **Desktop app on that machine:** open **Settings → About**. The **SpecWithCode service**
  row offers **Check now** or **Install now**.
- **Service installed without the desktop app:** its update agent, when installed, applies
  reviewed releases on its own. [Updates](../studio/updates.md) covers the agent and
  the guarded `update.py` run it performs.
- **Server built from source:** run `git pull`,
  [rebuild](./install.md#build-from-source), then start it again with your usual
  options such as `--host` or `--tailscale-serve`.

Server updates restart the connection and can interrupt active agents and
terminal commands. Saved threads, settings, and project files remain. To match a
remote client's version, follow [Updating SpecWithCode](./updating.md).

`specwithcode uninstall` removes the background service, the command launcher, and the
downloaded versions after showing you the list and asking once. Your projects,
threads, and settings under `~/.specweave-studio/userdata` are kept. Pass `--yes` from a
script.

## Platform support

Linux needs systemd user services. Setup enables lingering so SpecWithCode starts at
boot and keeps running after logout. If this needs administrator permission,
setup prints a recovery command before changing the service.

macOS starts the service when you log in and stops it when you log out. Keep the
Mac logged in and awake for unattended remote access. Installing over SSH while
nobody is logged in at the Mac's screen can fail at the final start step; the
service is still installed and will start at the next login.

Windows background services are not supported.

SpecWithCode Connect can offer service installation during setup, but the two are managed
separately. Signing out of SpecWithCode Connect does not stop or uninstall the service.

## Troubleshooting

Start with `specwithcode service status` on the host. It prints the log path and, on Linux,
checks whether the installed service is running, enabled, and allowed to survive
logout.

If it stops when your SSH session closes, check for `linger-disabled`. An
administrator can enable lingering with:

```sh
sudo loginctl enable-linger "$(id -un)"
```

Over SSH, allow sudo to prompt:

```sh
ssh -t your-server 'sudo loginctl enable-linger "$(id -un)"'
```

Then retry service setup as your normal user. Run only the `loginctl` command
with sudo; running SpecWithCode as root creates a separate installation and Connect
identity. Without administrator access, run `specwithcode serve` in a terminal and keep
that session open.

| Status problem                          | Next step                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `linger-unavailable`                    | Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.                             |
| `user-manager-unavailable`              | Run `systemctl --user status` in a login session for the service user; check your distribution's systemd user-session support. |
| `service-disabled` or `service-stopped` | Read the log and `systemctl --user status studio.service`, then use the repair command printed by SpecWithCode.                |
| `restart-pending`                       | A newer version is installed but the service still runs the previous one. Run `specwithcode service restart`.                  |

On macOS, check **System Settings → General → Login Items** if the service no
longer starts at login. If agent work cannot access Desktop, Documents, or
Downloads, it may need Full Disk Access for the `specweave-studio` executable listed in
`ProgramArguments` in
`~/Library/LaunchAgents/com.specweave.studio.service.plist`.

For failures after signing in to SpecWithCode Connect, see
[connection troubleshooting](./remote-access.md#specwithcode-connect-troubleshooting).
