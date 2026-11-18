# Welcome wizard

SpecWithCode shows a setup flow when you open a new installation or connect to the
hosted app for the first time. Existing workspaces skip this flow.

Setup has at most four stages, in this order:

| Stage                          | Required?                                                                                | What it settles                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Sign in** (or **Computers**) | Optional, recommended                                                                    | Your SpecWithCode Connect account, this machine's link and your other machines |
| **Agents**                     | The one stage that asks for something: one agent ready, or **Continue without an agent** | Installing and signing in to an agent                                          |
| **Access**                     | Optional                                                                                 | What agents can use: files and commands, your browser, the Mac's apps          |
| **Projects**                   | Optional                                                                                 | Importing projects and their conversations                                     |

Every other stage is passed with one press that changes nothing: **Use without
an account**, **Continue**, or **Do not import projects**. Nothing is granted,
paired or turned on unless you press that row's own button. You can go back to
an earlier stage from the progress bar or with **Back**.

## Sign in

In the desktop app, setup starts with **Sign in to SpecWithCode Connect**. One
account links all your machines and your phone. Once you are signed in, this
machine links by itself, and **Choose your main machine** lists your other
machines: pick the one that should start work here and press **Allow**. If this
is your first machine there is nothing to choose, so continue. See
[Add a machine](./add-a-machine.md) for what a main machine does.

**Use without an account** skips this stage. You can sign in later from the
account button.

## Computers

When there is no Connect sign-in, for example in the hosted app, the first
stage is **Computers** instead. Select one or more computers to set up. If you opened SpecWithCode directly from a
server or the desktop app, that computer is already connected and selected.
It is identified by its name, which may differ from the device running your
browser.

You can add more computers before continuing:

- **SpecWithCode Connect** connects computers that are signed in to your account.
  [Install the CLI](./install.md#command-line) and run `specwithcode connect` on each
  computer you want to add, then start SpecWithCode or run `specwithcode serve` so the
  computer stays available.
- **Add a computer** connects directly to a server on your network. Start the server with
  `specwithcode serve --host <address>`, then run `specwithcode pair` and paste the pairing
  link. If you use Tailscale, you can instead start it with `specwithcode serve` and run
  `specwithcode pair --tailscale`.

This connects computers so you can open and set them up from here. To let a
coordinator on your main machine start work on another computer, also add it
as a worker: see [Add a machine](./add-a-machine.md).

Saved computers and computers discovered through SpecWithCode Connect are selected by
default. Uncheck any you do not want to set up; this does not disconnect them.
Continue when your selected computers are connected. Setup checks
agents across the selected computers, then offers project import grouped by computer.

If SpecWithCode cannot confirm the workspace during startup, the setup flow shows
**Still connecting** instead of opening the app. Select **Reload** to try again.

If SpecWithCode cannot read your saved settings, it shows **Could not read settings**.
Select **Retry** after storage becomes available. Setup does not replace
unreadable settings with defaults.

## Agents

SpecWithCode checks each selected computer for Claude Code and Codex. If an agent is
not installed or signed in, select its action to open a terminal with the
correct command ready to run. Install uses the vendor's own installer, which
keeps **Update now** working in Settings. Other providers can be enabled in
Settings.

The setup terminal uses the home directory and environment configured for the
selected provider instance. Sensitive values remain redacted in Settings and
terminal metadata while the terminal process can use them.

**Continue** is the filled button once one agent is ready. With none ready it
reads **Continue without an agent**: setup goes on, and you can add an agent
later in Settings > Providers.

## Access

The Access stage, titled **What agents can use**, is a list. Each row says
what it allows, shows its current state, and has its own button. One row is
open at a time. **Continue** and Enter change nothing, so you can leave every
row as it is. The stage appears only when at least one row applies.

- **Files and commands.** Shown when Full access is recommended for a machine
  you are setting up. **Use Full access** lets agents edit files and run
  commands without asking each time. **Keep Supervised** (or **Keep current
  access**) leaves new chats as they are. **What it allows** explains it.
  Answering stays on this stage; the row then shows your answer with
  **Change**. With several machines, the row names them. See
  [Permission modes](./permission-modes.md).
- **Your browser.** Pairs a Chrome profile so agents can work in your
  signed-in browser. Press **Set up**, add the extension, press **Copy code**
  and paste the code in the extension's page. See [Chrome for agents](./chrome.md).
- **Mac apps.** Screen Recording and Accessibility, which agents need to see
  the screen and click and type in any app. **Allow** opens the checklist.
  Screen Recording takes effect after SpecWithCode reopens: press **Quit &
  Reopen** and setup opens again on Access for the same machines. See
  [Computer use](./computer-use.md).
- **Full Disk Access for agents (optional).** Last on a Mac. It explains the
  macOS switch and opens System Settings. See
  [Full Disk Access](./full-disk-access.md).

**Your browser** and **Mac apps** act on the computer the desktop app runs on,
so they appear only in the desktop app. A browser tab, even one on the same
computer, shows only **Files and commands**.

## Projects

SpecWithCode finds directories that Claude Code or Codex has used. Git repositories
are listed first, newest activity on top. When the remote is on GitHub, the
group shows the repository as `owner/name`. Clones with the same remote share
one group. Directories that are not git repositories sit under "Other folders".

The default selection includes git repositories active within the last 30 days
with at least three conversations. Use the checkboxes, or "Select all" and
"Select none", to change the selection. Linked git worktrees, Codex scratch
directories under `Documents/Codex`, and anything under `Downloads` are not
offered.

A large or malformed history can reach the scan limit. SpecWithCode keeps the
projects it found and warns when projects or conversations may be missing.

Imported projects include Codex and Claude conversations active within the last
30 days. You can continue those conversations in SpecWithCode.

Conversation import is best effort. SpecWithCode keeps the first user prompt and the
newest remaining visible user and assistant messages, with 200 messages total.
It omits tool activity and attachments. For Codex, it omits generated setup
context only when a canonical user event and a valid shared turn ID identify the
same user turn. Ambiguous legacy or response-only context stays in the imported
conversation so SpecWithCode does not remove user text. It reads one conversation at
a time and skips files larger than 16 MiB. It ignores malformed records and skips
unreadable or unparseable conversations.

Each import attempt reads up to 100 conversation files and 64 MiB per project,
with up to 100,000 input records. Run import again to continue a large batch.
Completed conversations are not imported again. You can continue without the
remaining history.

**Do not import projects** finishes setup without importing. Navigation pauses
while an import is running.

## Nothing you skip is lost

Everything setup offers is also somewhere else:

- **Chrome:** Settings > Chrome, and the **Connect Chrome** card a thread shows
  when an agent needs Chrome and no profile is paired.
- **Mac permissions:** the computer-use card a thread shows when an agent
  needs Screen Recording or Accessibility, and Settings > Integrations > Agent
  computer access.
- **Full access:** the access picker in the composer, and Settings > General.
- **Full Disk Access:** Settings > Machines, and the card an agent raises
  when macOS refuses it a file.
- **Agents:** Settings > Providers.
- **Projects:** add or import a project from the sidebar at any time.

Setup does not remind you about anything you skipped.
