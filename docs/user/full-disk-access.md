# Full Disk Access for agents

On a Mac, macOS keeps some of your data away from every app until you allow
it: Chrome and Safari profiles and history, Mail, Messages, Notes, your Photos
library, Time Machine backups and other apps' files. An agent that tries to
read them gets `Operation not permitted`, even though the files are yours.

Some tasks need that access, for example "list my Chrome profiles", "find the
email from my landlord" or "search my Safari history for that article". Most
coding work never does.

Full Disk Access is off until you turn it on. SpecWithCode can't turn it on
for you: only you can, in System Settings.

## What it means for security

Full Disk Access is a whole-machine switch. **Every agent on that Mac, in
every project and with every provider, gets it until you turn it off in
System Settings.** macOS can't give it to one thread or one task.

That matters because agents read web pages, files and messages that other
people wrote. A prompt hidden in one of them could ask an agent to read your
mail or send your browser history somewhere. With Full Disk Access off,
macOS stops that read. With it on, only the agent's own judgment and your
permission mode (see [Permission modes](permission-modes.md)) stand in the
way.

Turn it on when a task needs it, on the Macs where you need it. Turn it off
again if you no longer do.

## Where you find it

- **First-run setup.** The Access step has a closed **Full Disk Access for
  agents (optional)** item. It explains the switch and opens System Settings.
  You can skip it; setup never waits on it.
- **Settings › Machines.** Each Mac's readiness checklist has a **Privacy
  access** row that says whether agents there have Full Disk Access:
  - **off**: agents can't read other apps' data. **What this allows**
    explains it, and **Open System Settings** opens the right pane on this
    Mac. On another Mac's card the row tells you to open SpecWithCode on
    that Mac instead.
  - **allowed**: new agent runs can read protected data.
  - **allowed, restart running threads**: the grant came after some threads
    started. New runs have it; a thread that was already running gets it
    once it restarts.
- **In a thread.** When an agent is refused one of these files, it asks with
  a card: "*Agent* needs Full Disk Access", what it unlocks, and the
  whole-machine warning. **Open System Settings** opens the pane, and the
  card closes by itself once the agent can read the files. **Not now**
  declines it. The card has no "this session" or "always" choice, because
  macOS grants it to the whole machine.

Windows and Linux have no such switch: programs running as you can already
read your other apps' files, so none of this appears there.

## Turning it on

1. Press **Open System Settings** in the row, the first-run item or the
   card. System Settings opens at **Privacy & Security › Full Disk Access**,
   and a small panel appears at the bottom of its window with an item to drag.
2. Drag that item into the list and turn its switch on. If the list doesn't
   take the drag, press **+** under the list and pick the same item. macOS
   may ask for your password.
3. Come back to SpecWithCode. The row rechecks every 2 seconds for 2 minutes
   after you opened System Settings, and when the window gets focus.

### Which item to allow

macOS asks about the program that runs the agents, which is not always the
SpecWithCode window:

- When the app started its own background service, allow **SpecWithCode**.
- When you started the service from a terminal app, macOS asks about that
  app, for example **Terminal**.
- When the service runs on its own, as a launchd job you installed with
  `specweave-studio service install` or a script, macOS asks about that
  service's executable, for example `~/.nvm/versions/node/v22.20.0/bin/node`.
  The row, the card and the drag panel name the exact path. Allowing
  SpecWithCode.app does nothing for such a service.

When the service runs on a shared Node.js binary, allowing it gives Full
Disk Access to every Node.js script you run on that Mac, not only
SpecWithCode. A new Node.js version is a new binary and needs allowing again.

## Turning it off

Open **System Settings › Privacy & Security › Full Disk Access** and turn the
switch off, or remove the item with **−**. Agents lose access in their next
run. The row in Settings › Machines then shows **off**.

## The drag panel for other permissions

The same panel appears whenever SpecWithCode sends you to a privacy pane:
Screen Recording and Accessibility for [computer use](computer-use.md) and
[Snap Shot](snap-shot.md), and Full Disk Access for
[browser import](browser-import.md) and agents. It sits inside the System
Settings window, follows it when you move it, and closes once the permission
is on or when you close System Settings.

| Pane | **+** button | Drag an item in | The panel shows |
|---|---|---|---|
| Screen & System Audio Recording | yes | yes | the item to drag |
| Accessibility | yes | yes | the item to drag |
| Full Disk Access | yes | yes | the item to drag |
| Automation | no | no | how to turn on the row macOS added after asking |

Automation rows appear only after macOS asks you once, so there is nothing
to drag; the panel tells you which switch to turn on.
