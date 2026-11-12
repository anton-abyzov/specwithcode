# Updating SpecWithCode

The app you use and the server running your agents can be on different machines.
When a server is behind your web or desktop app, an update notice appears in the
conversation and **Settings → Machines**. Update the machine named in that
notice.

## Before you update

Server updates restart the connection and can interrupt active agents and
terminal commands. Saved threads, settings, and project files remain.

**Settings → General → Continue threads after restarts** is on by default.
It resumes supported active threads after an update, crash, or machine
restart. A thread that had ended its turn while a background command, subagent
or Workflow was still running is continued too: that work stops with the
provider's process and never reports back, so the server starts one turn that
lists what was lost and tells the agent to check what finished and carry on.
This also happens without a restart, about two minutes after the provider's
process ends between turns. It reads **Resumed after restart** in the thread.
A thread you stopped, settled or archived, a paused project and a loss older
than 24 hours are left alone. Changes are saved to connected environments that support this setting;
update older servers first. If a supported environment was offline or has a
different value, use **Apply to all** in Settings after it connects.
SpecWithCode must start again on that machine;
the setting does not enable automatic startup. Terminal commands may still be
interrupted, and threads without saved provider resume state need a new message.
If you previously enabled continuation for updates, enable this setting once
to allow recovery without a connected client.

### When a machine is busy

An update that installs by itself never interrupts running work unless you allow it.
**Pause running work for updates** is off by default on every machine. With it off, an
automatic update waits until that machine has no running task, queued message or open
terminal:

- A Mac keeps waiting however long that takes. Its update agent tries again every 10
  minutes and installs once the machine is quiet.
- A Linux machine waits up to 30 minutes. If it is still busy then, it stays on its version
  until the next update request: the next release rollout, or **Update now**.

Nothing asks you about it.

An open question or approval does not hold an update back, with the setting on or off. It
is closed after about 2 minutes and asked again after the restart.

Turn the setting on per machine, on that machine's update card in **Settings → General**
(this machine) or **Settings → Machines** (any machine you are connected to). Each machine
keeps its own value. A machine on a SpecWithCode version older than the setting shows the
switch locked and asks you to update that machine first; until then its updates pause
running work after their wait, as they did before. With it on:

- A Mac waits the time set in **Pause running work after** (10, 30 or 60 minutes), then
  pauses the running turns, installs, and the turns continue where they left off. It pauses
  at most once per version per hour, and **Later** in the sidebar waits another hour.
- A Linux machine waits 30 minutes, then does the same.
- A folder copy to or from another machine is never interrupted; the update waits for it.

The setting has no effect while **Continue threads after restarts** is off on that machine,
because paused turns would not continue.

**Update now**, **Restart now** and `specweave-studio update` are your own choice and work
either way. A fleet update that asks a machine to stop its work for the update is refused
by a machine that has the setting off, and that machine is reported as left for later.

Updates from the previous orchestration system preserve conversation transcripts but cannot carry
every kind of runtime history forward. Read [Threads from older SpecWithCode versions](./thread-migration.md)
before continuing an important older thread.

## When versions don't match

A client and server must speak the same orchestration protocol. If they do not, the connection is
refused rather than running half-upgraded:

- An app newer than the server is blocked before connecting, with a notice telling you to update
  SpecWithCode on the machine named in the notice.
- A server newer than your app refuses the connection with an update message.

Update the side the notice names, then reconnect.

## Update a connected server

The offered action depends on how the server runs:

| Action                     | What to do                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**          | Keep the client open while it installs and reconnects. Supported background services update remotely. For a desktop-hosted server, this also closes and relaunches the desktop app on the host. |
| **Update the desktop app** | Update the desktop app on the machine running the server, then reopen it if needed.                                                                                                             |
| **Copy update steps**      | The server cannot update itself. Follow the copied steps on the named host, then start the server again with your usual options.                                                                |

If the server was installed from npm (`npm i -g specwithcode`), update it with
`npm i -g specwithcode@<version>` and then `specwithcode service install`, which
re-pins the service to the new package. The CLI's own `specwithcode update` is off
unless `STUDIO_ENABLE_SELF_UPDATE=true` is set. For other installs, on the named host, use the path that matches how
the server was installed:

- **Desktop app on that machine:** open **Settings → About**. The **SpecWithCode service**
  row offers **Check now** or **Install now**.
- **Service installed without the desktop app:** its update agent, when installed, applies
  reviewed releases on its own. [Updates](../studio/updates.md) covers the agent and
  the guarded `update.py` run it performs.
- **Server built from source:** run `git pull`,
  [rebuild](./install.md#build-from-source), then start it again with your usual
  options such as `--host` or `--tailscale-serve`.

## If an update fails

Keep the client open until it reconnects or reports a failure. A failed service
update can roll back to the previous version. If the update still fails:

1. Retry the offered action once.
2. Check that you updated the server's machine, not only the device you are using.
3. For a server built from source, check that the rebuilt checkout is at the version shown in the notice.

## Update providers

**Settings → Providers** shows provider updates for the selected environment.
**Update all** updates every outdated provider on every connected environment
at once. Hover it to see which providers it will update. Providers that only
offer a manual update command are not included.

## Mobile updates

To update an environment from your phone, open **Settings → Environments** and
select it. **Check for updates** finds the latest release on that environment's
current release channel. Keep the app open while the environment updates and
reconnects. Hosts that cannot update remotely show instructions for updating on
the machine instead.

The same page lets you refresh provider status and update supported providers.
These controls require a connected environment and permission to operate it.
Provider update checks and restart continuation preferences are in
**Settings → Maintenance**. If provider update checks are disabled, enable them
there before refreshing to find newer versions.

There is no published mobile app yet, so there are no App Store or Google Play
releases to install. A build of the mobile app can
download updates in the background and apply them when you next leave the app.
It saves drafts and queued messages before restarting. If you keep the app open
for a long time, it may ask to install immediately; choosing **Later** leaves the
update queued for the next suitable moment.

## Provider CLIs

Open **Settings > Providers** and use the update action beside a CLI version. Only that instance on the selected machine starts checked. **Select eligible connected machines** includes other machines explicitly; review their current and target versions and installer actions, then press **Update selected**. The header's **Update CLIs…** opens the same flow for all outdated CLIs.

Each destination checks its existing provider-management permission again. Offline machines, unknown ownership, incompatible releases and missing permission show a reason instead of being updated. No permission is granted by this action. A CLI update does not change model entitlement.

A verified staged Codex fleet wrapper uses its owning Node/npm to install a fresh exact version beside the old release. The app verifies the package and executable before switching the wrapper, preserving its configured path and old files for running sessions. Unknown or edited wrappers remain manual. Homebrew, native and package-manager installs retain their own installer; the app never substitutes a global npm install for them.

Other installers refuse while their configured CLI is in use. Retry after those sessions finish. A host process check also detects configured renamed executables and Node package entrypoints; a new external session can still start after that check. On Windows, inability to establish idle state remains manual. Nothing kills sessions or restarts the app or service.

Results appear per machine. At most two updates run concurrently. **Cancel queued** skips items that have not started; an installer already running finishes normally. Keep the page open until the batch finishes. This batch is not a saved job across app closure or service restart. Retry failed items by selecting them again.
