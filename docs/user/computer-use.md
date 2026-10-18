# Computer use

Agents can see and control the desktop of the Mac the SpecWithCode app runs
on. Ask in any thread for something like "make my mouse a little faster" or
"turn on Night Shift", and the agent opens System Settings, looks at the
screen and clicks through it, the way you would. It works in any native app,
not only System Settings.

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
on that Mac. The first time an agent takes a screenshot or clicks, macOS asks
for two permissions for SpecWithCode, and System Settings opens at the right
page:

- **Screen Recording**, so agents can see the screen.
- **Accessibility**, so agents can click and type.

Click **Allow** or turn on SpecWithCode in the list. The agent's action waits
up to two minutes for you, then carries on by itself, so you do not need to
ask again. macOS lets only you grant these permissions; no app can grant them
to itself. If macOS asks you to quit and reopen the app, do that, then ask
the agent to try again.

## What agents do and do not do

- Agents type text by pasting it, then put back what you had copied.
- One action runs at a time, so two threads cannot fight over the pointer.
- Agents ask before deleting data, sending messages, buying anything or
  changing security settings.
- Only macOS is supported for now.
