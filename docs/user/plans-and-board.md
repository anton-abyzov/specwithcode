# Plans and the Board

A plan is a short spec with tasks, kept in your repository. SpecWithCode
writes plans with SpecWeave, and every plan in a project shows as a card on
that project's **Board** tab, with its tasks, the thread working on it and its
pull request.

SpecWeave is set up per project. Until it is, a project has no plans and its
Board shows what SpecWeave would add. Nothing is ever added to your folder
without a press.

## What setting it up adds

Setting SpecWeave up in a project adds these to its folder:

- `.specweave/`, where the plans live
- Agent skills in `.claude/` and `.agents/`
- Sections in `AGENTS.md` and `CLAUDE.md`
- Rules in `.gitignore` and `.gitattributes`

The new files are left for you to review and commit. SpecWithCode commits
none of them.

## Asking for a plan in a project without SpecWeave

Ask the coordinator for a plan, a spec or an increment as you would anywhere
else. In a project without SpecWeave the coordinator starts no work and writes
no files. Instead a card appears under the conversation:

**Set up SpecWeave to plan this**
A plan is a short spec with tasks, kept in your repository. It also puts this
project's work on a board.

**What it adds** opens the list above. The card has two buttons:

- **Set up SpecWeave** sets it up in the project's folder. When it is done the
  card reads **SpecWeave is set up**, and the coordinator is told to go on: it
  starts the work, and the plan it writes shows on the Board. **Open the
  Board** on the card opens the Board tab.
- **Plan without it** keeps the project as it is. The coordinator plans the
  work in its reply instead, before it changes any code. SpecWithCode
  remembers the answer for the project on every device, so work the
  coordinator starts there plans in its reply and no longer brings the card
  back. Ask for a plan or for SpecWeave itself and the coordinator can show
  the card again. The Board tab still offers setup whenever you want a board.

The card waits for you. Leaving it unanswered blocks nothing else in the
thread, and you can answer it later.

### When the press does not work

The card says what happened and what to do next:

| The card reads | What it means |
|---|---|
| **Setting up SpecWeave…** | Setup is running. The card updates by itself. |
| A reason with **Retry** | Setup failed, for example because the folder is inside another Git repository. Fix what the reason names, then press **Retry**. SpecWithCode remembers the failure, so the Board shows it too until a setup succeeds. |
| A reason with **Install Node.js** | SpecWeave runs on Node.js, which this machine does not have. Press **Install Node.js**, then **Retry**. |
| A reason, no button | This window's access cannot change files on that machine, or team rules do not allow it. Set SpecWeave up from a window with file access. You can still press **Plan without it**. |

## A folder without Git

SpecWeave keeps plans in a Git repository. When the project's folder is not
one yet, the card says so before you press anything:

> This folder is not a Git repository yet, so this also starts one here.

The button then reads **Set up Git and SpecWeave**. One press runs `git init`
in the folder, makes an empty first commit so branches and worktrees have a
starting point, and then sets up SpecWeave. None of your files are added to
Git or committed.

## The Board when SpecWeave is off

The Board tab of a project without SpecWeave reads **See this project's work
as a board**: "Plans each piece of work as a short spec with tasks in your
repository, and gives the project a board." It lists what setup adds, so one
press of **Set up SpecWeave** (or **Set up Git and SpecWeave**) sets it up. An
example board beside it, marked **Example**, shows what the cards look like
as work moves from Planned to Active, In review and Done. It is a picture: its
cards do nothing.

**Not now** is remembered the same way as **Plan without it**: work the
coordinator starts no longer brings up the card. The Board keeps its offer and
its button.

After setup the Board lists the project's plans as cards, without reloading
the page. A plan written later shows at the Board's next refresh. A project
with SpecWeave and no plans yet reads **No work planned yet.**, and **Plan
the first piece of work** puts a planning request in the coordinator's
message box for you to send.

## Plans written before setup

A project can hold plans that were written before SpecWeave was set up in it,
for example by an agent that ran SpecWeave's command line directly. SpecWithCode
does not count those as set up. The Board says how many there are, for
example **2 plans here are not on the board yet**, names the first three, and
offers **Finish setup** (or **Set up Git and finish** in a folder without Git).
A thread working on one of them shows **Not on the board yet** beside its plan,
and pressing it opens the Board.

Finishing setup keeps every plan that is already there, and they show as cards
right after.

## Turning it on later

Any of these sets SpecWeave up in a project, with the same press and the same
states as the card:

- **The Board tab**: **Set up SpecWeave**, also after **Plan without it** or
  **Not now**.
- **Project settings**: the **SpecWeave** row, which shows what will be added
  and asks you to confirm.
- **The line above the coordinator's message box**: a code project without
  SpecWeave, such as a folder you added as it was, shows "Plan this project's
  work on a board." with **Set up SpecWeave**, **See the board** and a dismiss
  button. It never comes back after you use any of the three, and dismissing
  it also counts as **Not now**.
- **The coordinator**: ask it to set SpecWeave up. It brings the card back,
  also after **Plan without it**.

Turning SpecWeave off again is not offered. To stop using it, remove the files
it added and commit that change yourself.
