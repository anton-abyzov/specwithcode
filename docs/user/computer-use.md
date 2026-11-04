# Computer use

Agents can see and control the desktop of the Mac the SpecWithCode app runs
on. Ask in any thread for something like "make my mouse a little faster" or
"turn on Night Shift", and the agent opens System Settings, looks at the
screen and clicks through it, the way you would. It works in any native app,
not only System Settings.

Computer use is macOS only. On Windows and Linux the tools answer that it is
not available on that system.

Agents reach the desktop through the `computer_*` tools on the `studio-code`
MCP server: `computer_screenshot` to see the screen, then `computer_open`,
`computer_click`, `computer_type`, `computer_key`, `computer_scroll`,
`computer_drag` and `computer_move`. For websites they use the browser tools
instead. Every provider gets them: Claude, Codex, Copilot and the other ACP
agents, Cursor, OpenCode and Pi. A computer-use skill that asks for
`mcp__computer-use__*` tools uses these.

## Turn it on

Computer use belongs to the machine. It is on by default, and every project,
thread and delegated worker on that machine gets it; no project can override
it. Turn it off for a machine with **Settings → Integrations → Agent computer
access** while that machine is selected. A change applies when an agent
session next starts. A thread acts on the desktop of the machine it runs on.

The actions run inside the SpecWithCode desktop app, so the app must be open
on that Mac, and macOS must allow two permissions for SpecWithCode:

- **Screen Recording**, so agents can see the screen.
- **Accessibility**, so agents can click and type.

The grant belongs to the SpecWithCode app, not to the background service or
to `node`: the service only passes each request to the app, which takes the
screenshot and posts the clicks. Check both under **Settings → Integrations →
Agent computer access**: each shows its live status and an **Allow** button,
which brings up the macOS prompt or opens the right Privacy & Security page
with a SpecWithCode icon you can drag into the list.

When an agent needs a permission you have not allowed yet, the thread shows a
card above the composer with the same **Allow** button. The agent's action
waits up to two minutes and goes through by itself once you allow it. If it
gave up, the card stays under the failed step; once the permission is
allowed, **Ask the agent to try again** sends that for you. macOS lets only
you grant these permissions; no app can grant them to itself. If macOS asks
you to quit and reopen the app, choose **Quit & Reopen**; the card offers the
same button.

Settings → Connections may list a `computer-use` row with Codex showing
**Disabled** and Claude Code **Not found**. Those are the providers' own
computer-use helpers, not what agents in SpecWithCode use, so nothing there
needs turning on.

## Allow an app

Computer use being on lets agents ask for apps; it does not let them use any
app they like. The first time an agent in a thread opens an app or clicks,
types, scrolls or drags in the app in front, a card appears just above the
composer: "Claude wants to use Notes", the agent's one-sentence reason, and
each app with its own icon. **Allow for this session** lets the agent use those
apps in this thread; **Always allow on this machine**, under the buttons, lets
every thread on this Mac use them. **Deny** stops the action, and the agent is
told not to ask again in that turn. The agent's action waits for your answer
for up to five minutes. While it waits, the thread shows as waiting for you,
and the project's coordinator shows the thread with "Asking to use apps on
your computer" and a **View thread** button.

Screenshots and pointer moves change nothing, so they are never asked about.
An agent can also ask ahead with the `request_access` tool, naming the apps
and devices it will need, so you answer one card instead of several.

The same card shows in the iPhone app, so you can answer it from your phone.
Apps you allowed with **Always on this machine** are listed under **Settings →
Integrations → Agent computer access**; **Remove** takes one back, and the next
agent that needs it asks again.

## What agents do and do not do

- Agents type text by pasting it, then put back what you had copied.
- One action runs at a time, so two threads cannot fight over the pointer.
- Agents ask before deleting data, sending messages, buying anything or
  changing security settings.
- Only macOS is supported for now.
