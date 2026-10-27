# SpecWithCode security boundaries

This page covers one person's setup: their own Macs, their own subscription accounts, SpecWithCode in the
browser today and a Mac desktop app next. It ranks what can actually go wrong with the CLIProxyAPI
hub and Tailscale, and says what SpecWithCode enforces versus what you configure.

## How machines connect, with or without Tailscale

Tailscale is not required to connect machines. A machine can have several routes: SpecWithCode Connect,
LAN address, SSH, Tailscale or a public URL. SpecWithCode Connect (**Settings → Connections → SpecWithCode Connect**,
or `specwithcode connect link`) is the default way to reach a machine from anywhere. What each gives you:

| Route                                                                  | Works off your home network | Notes                                                                                                                                   |
| ---------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| SpecWithCode Connect                                                   | Yes                         | Encrypted Cloudflare tunnel to the desktop app, a browser or the phone. No Tailscale and no port forwarding. Each client still signs in |
| SSH port forward (fleet tunnels, or desktop **Add environment → SSH**) | Only if SSH is reachable    | Encrypted and pinned; today's workers use this over the LAN from the primary Mac                                                        |
| Plain LAN address                                                      | No                          | Needs the server bound beyond loopback; traffic is unencrypted http unless you add TLS. Avoid                                           |
| Tailscale Serve                                                        | Yes                         | Optional. Encrypted, private https on your tailnet, often faster on the same network. Tried first for worker delegation and folder copy |
| Public URL                                                             | Yes                         | Exposes SpecWithCode to the internet behind pairing alone. Avoid                                                                        |

Recommendation: link each machine with SpecWithCode Connect to reach it from your other devices, including the phone.
Connect is also enough for a main machine to start work on another machine, manage it or copy folders to it. Over
Connect it sends its token only bound to its own fleet key (DPoP), with a fresh proof per request; a plain bearer token
never goes over Connect. Add Tailscale when you want a direct private route; the main machine tries it first.
Another private network (plain WireGuard, ZeroTier) can replace Tailscale for direct routes with the same rules: bind
SpecWithCode to loopback, forward into it, pair each origin.

## What the CLIProxyAPI hub is for

CLIProxyAPI is a separate open-source program that signs in to several Claude, Codex or Gemini
subscriptions and offers them as one API endpoint. SpecWithCode does not need it. SpecWithCode runs agents
through the official Codex and Claude Code CLIs on each machine, which bypass the hub entirely.

SpecWithCode's only use of a hub is read-only usage plus one action: under **Settings → Providers → Usage
providers → Add hub** it reads each pooled account's 5-hour and weekly limits, banked resets and
Codex credit balance so they appear in **Usage → Limits**, and it can redeem a banked Codex or Claude
reset. Sending agent requests through the
hub is a separate, manual provider setting and carries the provider-terms risk below. Without a hub,
SpecWithCode still shows limits for the accounts signed in on each machine.

## What each layer protects

| Layer                      | Protects                                                                                                             | Does not protect                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| SpecWithCode bind address  | The server listens on `127.0.0.1:8319`; the fleet installer and updater refuse anything else                         | Anything that forwards into loopback (Serve, SSH `-L`)         |
| SpecWithCode pairing       | Every origin needs its own one-time pairing; sessions are scoped cookies, bearer or DPoP tokens                      | A browser profile or device that is already paired             |
| SpecWithCode Connect       | HTTPS through a Cloudflare tunnel to a loopback origin; each client gets its own DPoP-bound session from the machine | A compromised relay signing key: the relay is a trusted broker |
| Tailscale Serve            | Private HTTPS inside your tailnet, encrypted by WireGuard; never Funnel                                              | Who in the tailnet may connect: that is your tailnet policy    |
| Pinned SSH forwards        | Primary-to-worker traffic over the LAN with strict host keys, bound to `127.0.0.1`                                   | A compromised primary Mac, which holds the worker keys         |
| CLIProxyAPI management key | SpecWithCode stores it in its secret store and never sends it to a browser                                           | Anyone who holds the key: it can act as every pooled account   |

SpecWithCode ignores Tailscale identity headers (`Tailscale-User-Login` and similar). Network reachability
never authenticates a request; pairing does. Keep it that way in any new transport, including the
desktop app.

## Ranked risks

### 1. The hub management key is every pooled account

CLIProxyAPI's management API includes `api-call`, which sends a request to a caller-chosen URL with a
pooled account's OAuth token substituted into the headers. SpecWithCode uses it to read Codex and Claude
usage and to redeem their banked resets. Anyone holding the management key can therefore use, or
send away, the token of every account on the hub.

SpecWithCode enforces:

- The key is kept in the server secret store and redacted to `••••••` for every client.
- The key is sent only over https, loopback or a Tailscale address. A plain-http LAN URL is refused
  before any request is made.
- Moving a hub to a different URL origin discards the saved key, so a changed setting cannot carry
  the key to another host.

You configure, in CLIProxyAPI's `config.yaml` on the hub machine:

- `host: "127.0.0.1"`. The default empty host listens on every interface, including your LAN and the
  tailnet address, which bypasses Serve.
- `remote-management.allow-remote: false`, unless SpecWithCode on another machine must read the hub. In
  that case put the hub behind Tailscale Serve on its own port and restrict that port in your
  tailnet policy.
- A long random `remote-management.secret-key` and long random client `api-keys`.
- `remote-management.disable-control-panel: true` when you do not use the web console. The console
  page keeps the management key in the browser, and CLIProxyAPI can refresh that page from its
  upstream GitHub release; if you keep it, treat that repository as part of your trusted code.
- The auth directory (`~/.cli-proxy-api` by default) readable only by your user (`chmod 700`).

Check without printing secrets: `lsof -nP -iTCP:8317 -sTCP:LISTEN` should show only `127.0.0.1`.

### 2. Provider terms for subscription accounts

SpecWithCode's native path runs the official Codex and Claude Code binaries with their own sign-in. That
is the lowest-risk way to use a subscription. Routing a Claude or ChatGPT subscription's OAuth token
through a proxy such as CLIProxyAPI, pooling several subscriptions behind one endpoint, or rotating
accounts to get past limits can break the provider's terms and get an account suspended. Anthropic's
Claude Code documentation says subscription OAuth is meant for Claude Code and Claude.ai, and that
third-party products should use API keys. SpecWithCode's hub client also calls undocumented provider
endpoints (`/api/oauth/usage`, `/api/oauth/profile`, Claude's `reset_rate_limits`, the ChatGPT
`wham` usage and reset-credit endpoints) with
Codex-client headers; these can change or be refused without notice.

For a desktop app offered to other people, do not ship a flow that signs in with someone's Claude
subscription inside SpecWithCode. Let each provider's own CLI or app own its sign-in, and use API keys for
anything SpecWithCode calls directly.

### 3. Tailnet policy decides who reaches SpecWithCode

Serve makes the primary's `443`, `8443` and `8444` reachable by every tailnet device your policy
allows. The default policy allows all of them. Pairing still stands between them and SpecWithCode, but a
pairing link sent to the wrong device, or a phishing page on a shared node, is enough.

- Restrict those ports to your own user's devices with a grant, for example
  `{"src": ["autogroup:member"], "dst": ["tag:studio"], "ip": ["tcp:443", "tcp:8443", "tcp:8444"]}`
  with your Macs tagged `tag:studio`. In a tailnet with other members, use your own user instead of
  `autogroup:member`.
- Do not share the primary Mac to other tailnets; a shared node can reach its Serve ports.
- Consider Tailnet Lock so a new node needs a signature from one of your devices.
- Serve certificates for `*.ts.net` names are published in public Certificate Transparency logs, so
  machine and tailnet names become public. Pick names that do not identify you, and never commit
  them, tailnet IPs or SSH host details to a public repository.

### 4. The primary Mac holds the fleet

The primary keeps pinned SSH keys for every worker and terminates all three Serve routes. Taking it
over gives access to every worker's SpecWithCode and shell.

- Use a separate SSH key for the tunnels and restrict it in the worker's `authorized_keys`:
  `restrict,port-forwarding,permitopen="127.0.0.1:8319" ssh-ed25519 …`. Keep the administrative key
  used for updates separate, ideally with a passphrase or hardware-backed agent.
- Limit Remote Login on each worker to your user and turn off password authentication.

### 5. Pairing links and sessions

A pairing link is a credential until it is used or expires. Create it with a short `--ttl`, open it
in the intended profile, and never paste it into chat, a ticket or a screenshot. Review
`specweave-studio auth pairing list` and `auth session list` after setup and revoke by exact ID what
you no longer use. Use `--scope orchestration:read` for a view-only device.

### 6. Project connections and repository preparation

The Personal projects work (increment 0888) adds per-project MCP connections and repository
preparation with the device's Git login. Review findings against that branch:

- A connection is a local stdio command started in the project's workspace with the listed
  environment secrets and no sandbox. A relative or `PATH`-resolved command (`node ./mcp.js`,
  `npx …`) lets an agent that can write the workspace plant code that runs outside its sandbox on
  the next check or call. Require an absolute executable outside every writable root and start it in
  a SpecWithCode-owned empty folder.
- Granted connection tools run without a per-call approval, even in approval-required threads.
- `envKeys` secrets must sit in the server environment, which provider processes inherit, so agents
  can usually read them directly. Prefer the secret store and pass values only to the connection.
- Approved folders have no denylist: `/`, your home folder, `~/.ssh` or SpecWithCode's own state folder
  can be approved and become writable roots. Refuse those.
- Repository preparation runs `git clone` with your credential helper and SSH agent, so it reaches
  every repository your login can. Its URL host is unrestricted; refuse loopback, link-local and
  this machine's own addresses.

## Desktop app requirements

The Mac desktop app inherits these rules:

- Keep the embedded server on loopback. Do not switch to the `remote-reachable` policy (`0.0.0.0`)
  to reach other devices; use SpecWithCode Connect or Tailscale Serve, which keep transport private and pairing
  separate.
- Keep the connection catalog in the desktop secure-storage bridge (Keychain), as the inherited
  desktop code does, not in web storage.
- Treat the hub key and provider tokens as server-side secrets only; renderer code must never
  receive them.
- SpecWithCode Connect is the supported way to reach the desktop app's machine from other devices. Keep telemetry
  off, and keep self-update limited to signed, verified SpecWithCode releases.
