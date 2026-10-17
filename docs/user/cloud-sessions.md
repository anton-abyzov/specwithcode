# Anthropic cloud sessions

Run a task on Anthropic's own VMs instead of a machine you own. SpecWithCode drives
the Claude Code CLI already installed on the server (`claude --cloud`), so the
session uses your claude.ai plan and its usage limits. Anthropic charges nothing
for the VM beyond that plan, and SpecWithCode adds no charge. Nothing here replaces
your machines: cloud is one more place work can run, next to this machine and the
[private machines](./remote-access.md) you pair.

## What you need

- Claude Code 2.1.223 or later on the server, signed in with `claude auth login`
  using a Pro, Max or Team account. An API key or a long-lived token cannot start
  cloud sessions.
- For a Team or Enterprise account, cloud sessions enabled by an Owner at
  claude.ai/admin-settings/claude-code.
- A checkout whose `origin` is on github.com with every commit pushed, or an
  upload (see below).

**Settings > Connections > Anthropic cloud sessions** shows whether this server can
start one, and the fix when it cannot.

## Starting one

Ask a coordinator, in your own words, for the work to run in the cloud. It calls
`studio_cloud_session_create` with the whole task and answers with the session
URL. The cloud VM clones the pushed branch, runs the repository's setup script and
starts Claude Code there; creation takes a few minutes. The session cannot see
this conversation, this machine or any file that is not on the branch, so the
brief must stand on its own.

With `upload`, SpecWithCode sends the committed files as a bundle (under 100 MB)
instead of requiring a GitHub remote. The session then cannot push results back,
so bring them home with `claude --teleport` (below).

An agent can also start one from any Claude Code run that has the SpecWithCode
MCP server: `studio_machine_list` reports under `cloud` whether this machine is
ready, and `studio_cloud_session_list` shows the sessions it started.

## Following and continuing

Open the session URL at claude.ai/code to read the transcript, answer questions
and review the diff; SpecWithCode keeps no copy of the transcript because the CLI
exposes none. Send a follow-up from SpecWithCode with `studio_cloud_session_send`;
the reply is only visible at the URL.

To continue on this machine, copy the command next to the session in
**Settings > Connections** and run it in a checkout of the same repository:

```bash
claude --teleport <session id>
```

Claude Code checks out the session's branch, pulls its conversation and carries
on locally.

## What leaves this machine

- The pushed branch (through GitHub) or, with upload, the committed files.
- The task text and your follow-up messages.
- Nothing from SpecWithCode's own data folder, and no credential: the CLI holds
  the claude.ai sign-in, and SpecWithCode never reads or stores it.

Cloud sessions are an Anthropic service; its [terms and data
policies](https://www.anthropic.com/legal) apply to what runs there.

## Records

SpecWithCode keeps a list of the sessions it started (title, URL, repository,
branch, created and last-sent times) in its data folder. The list survives
restarts and holds the last 200 sessions. Deleting a session at claude.ai does not
remove it from the list.
