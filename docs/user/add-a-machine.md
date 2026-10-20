# Add a machine

Let coordinators on your main machine start work on your other computers: a
second Mac, a Linux box or a VPS. Every machine reaches the others by its own
private Tailscale name, so it does not matter which network each one is on, and
one machine moving to another network does not cut the others off.

Joining always takes the same three steps:

1. On the machine you are adding (the **worker**), make an invitation line. It
   starts with `swc-machine-`.
2. On your **main machine**, paste that line under **Settings → Connections →
   Your private machines → Add a machine** and choose **Add machine**.
3. On the worker's card there, choose **Allow workers**.

Prefer to watch first? The
[1.5-minute video tutorial](https://www.youtube.com/watch?v=GFfnjNYcWrU) shows
the npm path end to end on 1.0.47.

Only step 1 differs, depending on how SpecWithCode is installed on the worker.
Pick the row that matches it:

| On the worker you have                                                      | Make the line with                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------ |
| The desktop app, 1.0.44 or later                                            | [The app itself](#in-the-app-1044-and-later)           |
| The desktop app, 1.0.43                                                     | [The app's built-in command](#desktop-app-1043)        |
| No desktop app, and Node.js 22.16 or later                                  | [The npm package](#with-npm)                           |
| Nothing yet on a Mac or Linux machine, once a release carries the installer | [The one-line installer](#with-the-one-line-installer) |
| A Linux server or VPS set up by hand                                        | [Linux worker](./linux-worker.md), then `fleet invite` |

The app's version is under **Settings → About**. Installing SpecWithCode in the
first place is covered in [Install SpecWithCode](./install.md).

## Before you start: Tailscale on both machines

Do this once, on the main machine and on every worker.

1. Install Tailscale from [tailscale.com/download](https://tailscale.com/download).
   On a Mac with Homebrew you can instead run `brew install --cask tailscale` in
   Terminal. On Linux, run `curl -fsSL https://tailscale.com/install.sh | sh`.
2. Open Tailscale and sign in. On a Mac, the first launch asks to add a VPN
   configuration: click **Allow**. On Linux, run `sudo tailscale up` and open the
   link it prints. **Sign in with the same account on every machine**, so they
   are all in the same tailnet.
3. In the [Tailscale admin console](https://login.tailscale.com/admin), check
   these once for the whole tailnet:
   - **DNS → MagicDNS** is on (it is on by default). Without it a machine has no
     Tailscale name and the line cannot be made.
   - **DNS → HTTPS Certificates** is enabled. The worker is published over HTTPS
     on its Tailscale name, which needs a certificate.
4. Still in the admin console, open **Machines** and, for each machine, open its
   **…** menu and choose **Disable key expiry**. Otherwise Tailscale signs a
   machine out after a few months and it drops out of the fleet until you sign
   in again.

The worker is published only inside your tailnet with Tailscale Serve, never on
the public internet. Each machine keeps its own provider sign-ins and project
checkouts; nothing is copied between machines.

## Make the line on the worker

The line holds a management credential for the worker. Treat it like a
password: paste it only into your own main machine, never into a chat, an issue
or a shared document.

### In the app (1.0.44 and later)

**On a new install**, the first screen asks **How will you use this Mac?**
(**this machine** on Linux). Choose **Join my existing machines**. This skips
setting up agents and projects on the worker.

**On a Mac that is already set up**, open **Settings → Connections → Your
private machines**. Next to **Add this machine to another one**, choose **Invite
this machine**.

Then:

1. The app checks Tailscale on this machine and shows what is still missing. It
   looks again every few seconds, so the message clears on its own once you fix
   it:
   - **Tailscale is not installed:** choose **Install Tailscale** to open
     Tailscale's download page. On a Mac with Homebrew it also shows
     `brew install --cask tailscale` to copy into Terminal. The app never
     installs anything itself.
   - **Tailscale is not signed in** or **Tailscale is turned off:** choose
     **Sign in to Tailscale**. On a Mac this opens the Tailscale app and the
     sign-in page in your browser. Sign in with the account your main machine
     uses. If the page does not open, choose **Open the sign-in page again**.
     Where Tailscale needs administrator rights to sign in (usually Linux), the
     app says so: run `sudo tailscale up` in a terminal yourself.
   - **MagicDNS is off:** turn it on in the Tailscale admin console under **DNS**.
2. Optionally type a name under **Name on the main machine (optional)**. Left
   empty, the machine's own name is used.
3. When **Tailscale is connected** shows, choose **Make the line**. The app
   publishes itself on the machine's Tailscale name and shows the line.
4. Choose **Copy**, and paste it on your main machine
   ([below](#add-it-on-the-main-machine)).
5. In the first-run flow, choose **I pasted it**; in Settings, choose **Done**.

The app shows the line only once. Close the dialog and it is gone; if you lose
it, make a new one (**Make a new line** after first run, or **Invite this
machine** again). Before closing, **Revoke this line** turns it off.

Only a session with **Manage access** on that machine can make the line. Without
it, the button reads **Manage access required**.

### Desktop app 1.0.43

Version 1.0.43 has no **Invite this machine** button and puts no `specwithcode`
command on your `PATH`, but the command is inside the app. With the app open on
the worker, open Terminal and paste this as one line (change `MacBook Air` to
any name you like):

```bash
ELECTRON_RUN_AS_NODE=1 STUDIO_CLI_NAME=specwithcode /Applications/SpecWithCode.app/Contents/MacOS/SpecWithCode /Applications/SpecWithCode.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs fleet invite --label "MacBook Air"
```

If you installed the app in your own `Applications` folder, put `~` in front of
both `/Applications` paths.

It publishes the app on the Mac's Tailscale name and prints a few lines: the
address, a `fleet add` command, and the invitation line on its own (starting
with `swc-machine-`), followed by the date it stops working and a command to
revoke it. Copy the `swc-machine-…` line and paste it on your main machine
([below](#add-it-on-the-main-machine)).

### With npm

On a Mac or Linux machine **without** the desktop app, the server and its
command come from npm. They need Node.js 22.16 or later (23.11+ or 24.10+ also
work); check with
`node --version`, and on a Mac get it from [nodejs.org](https://nodejs.org) or
with `brew install node@22`.

1. Install it:

   ```bash
   npm i -g specwithcode
   ```

   This puts `specwithcode` (and its older name, `specweave-studio`) on your
   `PATH`. If npm reports a permissions error (`EACCES`), your Node.js install
   keeps global packages in a system folder; installing Node.js with Homebrew
   or a version manager such as `fnm` avoids that.

2. Start the server and leave that Terminal window open:

   ```bash
   specwithcode serve
   ```

3. In a second Terminal window, make the line:

   ```bash
   specwithcode fleet invite --label "MacBook Air"
   ```

   It prints the same `swc-machine-…` line as above.

To keep it running after you close Terminal or restart, run
`specwithcode service install` (1.0.46 and later). The service pins a copy of
the installed package under `~/.specwithcode/runtime/versions/<version>` and runs
it with the Node.js that ran the install. After `npm i -g specwithcode@<version>`,
run `specwithcode service install` again to move the service to it. On 1.0.45 and
earlier, start `specwithcode serve` again after a restart.

**If the desktop app is already on this Mac**, you do not need a second server.
Run only `specwithcode fleet invite --label "…"`, which talks to the server the
app is running. (From 1.0.45, a bare `specwithcode` opens the running server in
your browser instead of stopping with "A SpecWithCode server is already running
for …".) Install the npm package at the same
version as the app (`npm i -g specwithcode@1.0.43` for app 1.0.43), or use the
app's [built-in command](#desktop-app-1043) instead.

### With the one-line installer

The installer sets up Tailscale, installs SpecWithCode and prints the line, in
one go:

```bash
curl -fsSL https://github.com/anton-abyzov/specwithcode/releases/latest/download/install.sh | bash -s -- --join
```

Releases from 1.0.44 carry `install.sh`. On 1.0.43, use the
[app's built-in command](#desktop-app-1043) or [npm](#with-npm) instead.

What it does:

1. **Tailscale.** If Tailscale is missing, it asks to install it: on a Mac,
   Tailscale's own package, which it checks is signed by Tailscale Inc. before
   installing; on Linux, Tailscale's own installer. Both ask for your password.
   If Tailscale is signed out, it opens the sign-in page in your browser and
   waits. Sign in with the account your main machine uses. If your tailnet
   requires approving new machines, approve it in the admin console under
   **Machines** and run the line again.
2. **SpecWithCode.** It installs the command-line build and starts it as a
   [background service](./background-service.md). If the desktop app or a
   managed service already runs SpecWithCode on this machine, it installs
   nothing and uses that one (open the app first if it is not running).
3. **The line.** It runs `specwithcode fleet invite` and prints the line, plus
   the `fleet add` command for your main machine.

Options go after `--join`, for example `bash -s -- --join --yes`:

| Option         | What it does                                                            |
| -------------- | ----------------------------------------------------------------------- |
| `--yes`        | Install Tailscale without asking                                        |
| `--dry-run`    | Show what it would do; changes nothing                                  |
| `--standalone` | Install the command-line build even when the desktop app is on this Mac |
| `--version V`  | Install exactly version `V` instead of the newest release               |
| `--no-service` | Set up the command only, without the background service                 |

Run the installer with `--help` for every option.

## Add it on the main machine

1. Open **Settings → Connections → Your private machines**.
2. Paste the line into the **Add a machine** field and choose **Add machine**.
   The main machine first checks that the address answers as that machine, then
   saves it.
3. With **Connect automatically** on, your browser pairs with the worker within a
   minute. Otherwise choose **Connect machine** on its card.
4. Choose **Allow workers** on its card to let coordinators start work there.

From a terminal on the main machine you can run the `fleet add` command the
worker printed instead:

```bash
specwithcode fleet add swc-machine-…
```

`specwithcode fleet list` shows every configured machine and whether the main
machine reaches it now. To take one off the list, see
[Remove a machine](#remove-a-machine).

**Give the worker the project.** Coordinators start work in a project folder
on the worker, not in a copy of yours. Add the folder there; if the project is
shared, or the worker already has its own project for the same work, link the
two from **Settings > Project > Machines** so the coordinator finds that copy
([Shared projects](./shared-projects.md)). **Settings > Machines** shows each
machine, whether this app can see it, its worker grants and its shared projects.

**Keep SpecWithCode running on the worker.** Coordinators can only start work
there while its app or server is running and Tailscale is connected. With the
desktop app, leave the app open. A [background
service](./background-service.md) keeps it running across restarts.

## Revoke a line

A line works for a year unless you revoke it (`fleet invite --ttl` changes that).
To turn one off:

- Right after making it in the app, choose **Revoke this line**.
- Later, on the worker, open **Settings → Connections → Authorized clients** and
  revoke **Fleet management (fleet invite)**.
- From a terminal on the worker, run the `auth session revoke …` command
  `fleet invite` printed, or find the session with
  `specwithcode auth session list` and revoke it with
  `specwithcode auth session revoke <id>`.

After revoking, the main machine can no longer pair with that worker. To add it
again, make a new line on the worker and add it on the main machine.

## Who can run work on this Mac

Allowing workers is a grant the worker gives the main machine, and the worker
enforces it. On the worker, open **Settings → Connections → Who can run work on
this Mac**. Each machine that may start work there has a row with:

- **Whose machine**: **My machine** or **Someone else's machine**. Work from
  your own machine may pass through two machines in a row (main machine to this
  one to a third); work from someone else's machine only one. Switching a
  machine to someone else's also turns off its sign-ins until you choose them.
- **Projects**: **Linked to it** (the default for new grants: projects that are
  part of a shared project with that machine), **Chosen projects**, or **All
  projects**. Work outside these is refused, and the other machine does not see
  those projects in its list.
- **Sign-ins**: **All sign-ins**, **Chosen sign-ins** or **None**. A launch that
  asks for a sign-in outside the list is refused with a message naming the
  allowed ones. With **None**, every launch is refused.
- **Most access**: the most a thread started from there may run with, as chosen
  in **Allow workers** on the main machine.
- When the grant expires, and how many threads it started here are running.

Machines allowed before 1.0.56 show **Allowed before work could be limited**:
they keep every project and sign-in until you change them. A main machine
running 1.0.56 or later that starts work on an older worker says that the
worker cannot check these limits, and the older worker runs it as before.

### Loops and hops

Every launch carries the list of machines it came through. A machine refuses a
launch whose list already names it (M4 starts work on M1, and that work tries to
start work back on M4), and one that came through more machines than its grant
allows. The message names the path, for example `M4 → M1 → M4`. Different
projects can still use each other's machines in both directions.

### Revoke

Choose **Revoke** on the row. The other machine can no longer start work here
from that moment, even with a fresh grant. Threads it already started keep
running for 2 minutes, then stop as if you pressed Stop: their worktrees,
changes and history stay. To let it back, choose **Allow again** here, then
**Allow workers** for this machine on the other one.

## Remove a machine

On the main machine, choose **Remove machine** on its card under **Your private
machines**, or run:

```bash
specwithcode fleet remove <name>
```

Before taking it off the list, the main machine gives up what it holds on that
machine: it revokes its worker grant and the management token from the
invitation line there. If that machine is off or unreachable, the main machine
still removes it here and says what stays valid there. On that machine, revoke
it under **Settings → Connections → Authorized clients**, or with the
`auth session revoke` command the message prints.

## Troubleshooting

Messages may be worded slightly differently in older releases.

| You see                                                                                         | What to do                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Tailscale is not installed on this machine."                                                   | Install Tailscale, open it and sign in ([above](#before-you-start-tailscale-on-both-machines)), then try again.                                                                                                                                               |
| "Tailscale is not signed in on this machine."                                                   | Open Tailscale and sign in with the account your main machine uses.                                                                                                                                                                                           |
| "Could not reach Tailscale on this machine."                                                    | Open the Tailscale app and check that it is connected.                                                                                                                                                                                                        |
| "This machine has no Tailscale name yet."                                                       | Sign in to Tailscale and turn on MagicDNS in the admin console under **DNS**.                                                                                                                                                                                 |
| "Tailscale could not publish this machine on HTTPS port 443."                                   | Enable **DNS → HTTPS Certificates** in the Tailscale admin console, then try again.                                                                                                                                                                           |
| "HTTPS port 443 on this machine's Tailscale name is already used by another app"                | Something else already uses that port, and the app will not replace it. Choose another port under **Tailscale HTTPS** in **Settings → Connections**, or run `fleet invite --tailscale-serve-port 8443`.                                                       |
| "HTTPS port 443 on this machine's Tailscale name already shows a different SpecWithCode server" | Another SpecWithCode server on this machine already uses that port. Turn off Tailscale HTTPS for it, or pick another port as above.                                                                                                                           |
| "Tailscale needs an administrator to sign in on this machine."                                  | Sign in from the Tailscale app, or run `sudo tailscale up` in a terminal yourself.                                                                                                                                                                            |
| "A SpecWithCode server is already running for …"                                                | SpecWithCode is already running on this machine (often the desktop app); 1.0.43 and 1.0.44 print this for a bare `specwithcode`. Use the running one: run `specwithcode fleet invite` to join, or open the app. From 1.0.45 it opens in your browser instead. |
| "No running SpecWithCode server found."                                                         | `fleet invite` needs a running server. Open the desktop app, or start `specwithcode serve` in another Terminal window, then run it again.                                                                                                                     |
| "This is not a machine invitation."                                                             | Part of the line is missing. Make a new line on the worker and copy the whole thing, from `swc-machine-` to the end.                                                                                                                                          |
| "Pairing is unavailable. Ask the server owner to renew this machine's connection permission."   | The line was revoked or has expired. Make a new line on the worker and add it on the main machine again; that updates the same machine.                                                                                                                       |
| "This machine is unavailable. Check its private connection and retry."                          | The worker is off, asleep, signed out of Tailscale or not running SpecWithCode. Check each, and that its key has not expired in the Tailscale admin console.                                                                                                  |
| "Manage access required"                                                                        | This session cannot manage the machine. Use the app on that machine itself.                                                                                                                                                                                   |
| "Refused: this launch would loop back to a machine it came from (M4 → M1 → M4)."                | Start the work on a machine not on that path, or on the machine itself.                                                                                                                                                                                       |
| "Refused: this launch came through …, 2 machine hops; this machine allows 1 for that sender."   | On the worker, set the sender to **My machine** in **Who can run work on this Mac** if it is yours, or start the work closer to where it began.                                                                                                               |
| "Project … on this machine is not linked to …"                                                  | Link the projects, or add the project under **Projects** in **Who can run work on this Mac** on the worker.                                                                                                                                                   |
| "This machine lets … use only these sign-ins: …"                                                | Pick one of the listed sign-ins, or add that sign-in under **Sign-ins** in **Who can run work on this Mac** on the worker.                                                                                                                                    |
| "… runs an older SpecWithCode that does not check delegation loops, project scope or …"         | The worker runs the work without these limits. Update SpecWithCode on the worker.                                                                                                                                                                             |

## Keep your provider accounts safe

The fleet only connects your own machines over your tailnet. Each machine's
agents still talk to Anthropic and OpenAI directly from that machine's own
internet connection, signed in with that machine's own provider login, so
Tailscale changes nothing about how a provider sees your account.

- Subscription sign-ins (Claude Pro or Max, ChatGPT) belong only on machines
  you own on a home or office connection. We do not recommend them on Hetzner,
  AWS or any other rented server or VPN: sign-ins from datacenter addresses
  draw extra scrutiny and can get the account locked, and Anthropic describes
  subscription sign-in as meant for ordinary, individual use. A rented server
  runs agents on API keys only; [Linux worker](./linux-worker.md#give-the-agents-api-keys)
  shows how.
- Using your own subscription on several of your machines is ordinary use, but
  every machine signed in to one account shares that account's limits. Running
  agents on all of them at once spends the limits faster, not slower.
- Do not route one subscription's sign-in through a shared proxy or pool
  several subscriptions behind one endpoint. Anthropic does not allow its
  subscription credentials to be stored or relayed by other tools. See
  [security](../studio/security.md).
- Turn on two-factor sign-in for your Tailscale account: it is the key to every
  machine in the fleet. The invitation line is a credential too; revoke one you
  no longer need.

## When a machine moves or changes

A machine keeps its Tailscale name on any network, so moving a laptop to
another Wi-Fi, a hotel or a phone hotspot needs nothing. Tailscale reconnects
on its own; machines can be offline while it does, and work already running on
a machine continues there.

If a machine's address does change (a new Tailscale name, a renamed machine, or
moving off an older setup that reached it through another machine), make a new
line on it (**Invite this machine**, or `fleet invite`) and add the new line on
the main machine. That updates the machine in place: it keeps its name, and
workers you allowed there carry over the next time a coordinator uses them.
Browsers add the new address on their own and keep the old one as a fallback.

The invitation is valid for a year by default (`fleet invite --ttl` changes it).
Adding a fresh one renews it.
