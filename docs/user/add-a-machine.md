# Add a machine

Let coordinators on your main machine start work on your other computers: a
second Mac, a Linux box or a VPS. Every machine reaches the others by its own
private Tailscale name, so it does not matter which network each one is on, and
one machine moving to another network does not cut the others off.

## What you need

- [Tailscale](https://tailscale.com/download) on every machine, signed in to
  the same tailnet, with MagicDNS on (the default) and HTTPS certificates
  allowed in the admin console under **DNS → HTTPS Certificates**.
- SpecWithCode running on every machine, as a [background
  service](./background-service.md) so it survives restarts. A Linux machine
  follows [Linux worker](./linux-worker.md) up to its server step.
- Each machine's own provider sign-ins and project checkouts. Nothing is
  copied between machines.

## Add it

### In the app

On the machine you are adding, open the app and go to **Settings →
Connections → Your private machines → Add this machine to another one**, then
choose **Invite this machine**. On a new install, the first screen asks how you
will use the machine: choose **Join my existing machines** to do the same
there, without setting up agents or projects.

Give the machine a name if you like (it defaults to the machine's own name) and
choose **Make the line**. The app checks that Tailscale is installed, signed in
and has a MagicDNS name, publishes the app on the machine's own Tailscale
name with Tailscale Serve (private to your tailnet, never public) and shows one
line starting with `swc-machine-`. Copy it. The line holds a management
credential, so treat it like a password and do not paste it into chat. The app
shows it only once: close the dialog and it is gone, so make a new line if you
lose it. **Revoke this line** turns it off.

Before the line, the app shows what Tailscale still needs on this machine and
looks again every few seconds until it is ready:

- **Not installed:** **Install Tailscale** opens Tailscale's download page. On
  a Mac with Homebrew, the app also shows `brew install --cask tailscale` to
  copy into Terminal. The app never installs anything itself.
- **Not signed in, or turned off:** **Sign in to Tailscale** opens the
  Tailscale app on a Mac, starts `tailscale up` and opens the sign-in page it
  prints in your browser. Sign in to the same tailnet as your main machine. The
  app never runs `sudo` and never uses an auth key; where Tailscale needs
  administrator rights to sign in (usually Linux), it says so and you run
  `sudo tailscale up` yourself.
- **MagicDNS off:** turn it on in the Tailscale admin console under **DNS**.

If something still fails when you make the line, the app says what to do. It
never replaces a Tailscale Serve mapping that already
fronts another server or another app on the same port. When Tailscale HTTPS is
on under **Settings → Connections**, the app uses that port; otherwise it uses 443.

Only a session with **Manage access** on that machine can make the line, and
only from the app's own page, never from another site.

On your main machine, paste the line into **Settings → Connections → Your
private machines → Add a machine**. The main machine first checks that the
address answers as that machine, then saves it. With **Connect automatically**
on, your browser pairs with it within a minute. Choose **Allow workers** on its
card to let coordinators start work there.

### From a terminal

The same works with the `specwithcode` command, where it is installed. On the
machine you are adding, run:

```bash
specwithcode fleet invite
```

It prints the same `swc-machine-` line. On your main machine, either paste it
into **Add a machine** as above or run:

```bash
specwithcode fleet add swc-machine-…
```

`specwithcode fleet list` shows every configured machine and whether the main
machine reaches it now. `specwithcode fleet remove <name>` takes one off the
list; revoke its credential on that machine under **Settings → Connections →
Authorized clients** (it is listed as "Fleet management (fleet invite)"), or
with `specwithcode auth session list` and `auth session revoke`.

## Keep your provider accounts safe

The fleet only connects your own machines over your tailnet. Each machine's
agents still talk to Anthropic and OpenAI directly from that machine's own
internet connection, signed in with that machine's own provider login, so
Tailscale changes nothing about how a provider sees your account.

- Prefer machines you own on a home or office connection for subscription
  sign-ins. On a rented server (a VPS or cloud VM), sign the provider CLIs in
  with an API key instead: users report that subscription sign-ins from
  datacenter addresses draw extra scrutiny, and Anthropic describes
  subscription sign-in as meant for ordinary, individual use.
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
the main machine. That updates the
machine in place: it keeps its name, and workers you allowed there carry over
the next time a coordinator uses them. Browsers add the new address on their
own and keep the old one as a fallback.

The invitation is valid for a year by default (`fleet invite --ttl` changes it).
Adding a fresh one renews it.
