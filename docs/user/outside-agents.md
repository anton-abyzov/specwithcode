# Outside agents

Agents that SpecWithCode did not start can work with an environment through its
MCP server. They can read projects and threads, start and message threads, see
which providers and models are available, and run work on the other machines in
your fleet. This covers Claude Code or Codex in your own terminal, ChatGPT,
Claude.ai, Grok and the OpenAI API, and bots that support MCP. Each agent signs
in once, and you choose what it may do.

## Get the MCP URL

In **Settings → Connections**, open a saved environment's menu and choose
**Copy MCP URL**. The URL is the environment's address followed by `/mcp`, for
example:

```text
https://<environment-address>/mcp
```

The copied URL uses the route this device is connected over, so an agent on the
same device can reach it. When the environment also has a SpecWithCode Connect
address, the menu offers **Copy public MCP URL** for agents that run on the
internet.

- **An agent on your own computers** can use `localhost` on the host,
  SpecWithCode Connect, or any `https` address, such as
  [Tailscale HTTPS](./remote-access.md#tailscale-https-optional). Signing in
  sends the agent's credentials to the environment, and agents only do that
  over `https` or to `localhost`. A plain-`http` LAN or Tailscale address, like
  `http://100.x.y.z:3773`, lets an agent find the environment but not finish
  signing in.
- **A hosted agent**, such as ChatGPT, Claude.ai, Grok or a bot running in the
  cloud, must reach the environment from the internet. Use the public
  SpecWithCode Connect address (`https://<label>.<connect-domain>/mcp`). A
  Tailscale address only works from your own tailnet.

## Approve a sign-in

The first time an agent connects, it opens a sign-in page on the environment.
The page names the agent and where its access goes:

- For an agent on your computer, approval returns to a `localhost` address on
  the computer that opened the page.
- For a hosted agent, approval redirects to that service, such as `chatgpt.com`
  or `claude.ai`. Anyone who runs that service gets the access, so approve only
  services you trust with it.

Only approve a sign-in you just started. To approve, enter a pairing code from
**Settings → Connections** or from `specweave-studio auth pairing create` on the
host. A browser already signed in to the environment with permission to manage
access can approve without a code.

Then choose what the agent may do:

- **Read only** is the default. The agent can read projects and threads and see
  the available providers and models. It cannot change anything.
- **Supervised**, **Auto-accept edits**, **Auto** and **Full access** also let
  it start, message and stop threads in every project. A thread it starts or
  steers cannot run with more permissions than the mode you chose.

## Claude Code

```sh
claude mcp add --transport http specwithcode https://<environment-address>/mcp
claude mcp login specwithcode
```

`claude mcp login` opens the sign-in page in your browser. On a machine
without a browser, add `--no-browser`, open the printed URL elsewhere, and
paste the final URL back when asked. `claude mcp list` shows `specwithcode` as
connected once you approve.

## Codex

```sh
codex mcp add specwithcode --url https://<environment-address>/mcp
codex mcp login specwithcode
```

`codex mcp login --no-browser` prints the sign-in URL instead of opening it.
`codex mcp list` shows `specwithcode` with OAuth once you approve.

## ChatGPT

Add the environment as a custom MCP connector in ChatGPT's apps settings:

1. Create a new app or connector with a custom MCP server.
2. Set the server URL to the public SpecWithCode Connect MCP URL.
3. Choose **OAuth** for authentication. ChatGPT discovers the rest; you do not
   need a client ID or secret.
4. Create it, then approve the sign-in page that opens.

## Claude.ai

In Claude.ai, open **Settings → Connectors** and choose **Add custom
connector**. Paste the public SpecWithCode Connect MCP URL and leave the OAuth
client fields empty: Claude.ai registers itself. Connect it, then approve the
sign-in page that opens.

## Static tokens: Grok, the OpenAI API and bots

Some clients cannot run an OAuth sign-in and can only send a fixed
`Authorization` header: Grok (xAI remote MCP tools), the OpenAI Responses API
`mcp` tool, n8n and most bots. Give them a static MCP token instead. On the
host, run:

```sh
specweave-studio auth mcp-token create --label grok-bot --access read-only --ttl 7d
```

- `--label` names the client in **Settings → Connections**.
- `--access` is the most the token may do: `read-only`, `approval-required`,
  `auto-accept-edits`, `auto` or `full-access`, the same levels as a sign-in.
- `--ttl` is how long it lasts. It defaults to 30 days.

The token is printed once. Store it like a password; anyone holding it gets the
access you chose. The client sends it on every request:

```text
Authorization: Bearer <token>
```

For Grok or the OpenAI Responses API, set the remote MCP tool's server URL to
the public SpecWithCode Connect MCP URL and pass the token as a bearer
authorization header. For example, with the OpenAI Responses API:

```json
{
  "type": "mcp",
  "server_label": "specwithcode",
  "server_url": "https://<label>.<connect-domain>/mcp",
  "headers": { "Authorization": "Bearer <token>" },
  "require_approval": "never"
}
```

Any other agent that supports remote MCP servers over HTTP works the same way:
with OAuth, give it the MCP URL and it finds the sign-in settings itself;
without OAuth, give it a static token.

## Work across your machines

An outside agent signed in to one machine can also run work on the other
machines in your fleet, within the access it was given and what each machine
allows:

1. `studio_machine_list` lists the machines it can reach, with whether each is
   ready, the most work there may do, and its providers and models.
2. `studio_thread_launch` with `machine` (an id or label from that list) starts
   a thread there, in a matching project or as a scratch thread when you pass
   no project.
3. `studio_thread_read`, `studio_thread_send`, `studio_thread_wait` and
   `studio_thread_interrupt` with the same `machine` follow it.
   `studio_threads_wait` waits on several threads at once.

A thread there never runs with more permissions than the lower of the agent's
access and what that machine lets this one use. Allow workers on a machine in
**Settings → Connections → Your private machines**; each machine sets what
others may use on it in **Settings → Machines → Who can run work on this Mac**.

## Remove an agent

Approved agents and static tokens appear under **Settings → Connections** like
other clients. Revoke one there to cut off its access immediately. A sign-in
lasts 30 days; after that the agent asks you to approve it again.
