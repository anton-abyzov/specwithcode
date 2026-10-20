# Shared projects

A shared project is one project with a copy on more than one machine: the same
name, one coordinator and one list of threads. Each machine keeps its own
folder, provider sign-ins and files. Nothing is copied between machines except
what the steps below say.

Two projects that point at the same repository are not shared just because
they match. You link them yourself, once, from either machine.

## Roles

Every copy of a shared project has one role. The sidebar shows the project once;
hover its row to see each machine and what its copy does, for example
`M4: coordinator · M3: runs workers`.

| Role            | What it means                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Coordinator     | Plans the work, keeps the project's notes, goal and instructions, and can start workers in every copy.                           |
| Runs workers    | Ordinary threads and workers run here as before. This copy's own coordinator is kept as read-only history and takes no messages. |
| Handoff pending | A coordinator handoff has started and not finished. Reconnect both machines to finish it.                                        |

**Settings > Project > Machines** lists every copy with its machine, folder and
role.

## Link two copies

Use this when two machines each have their own project for the same work, for
example an EasyChamp folder on the M4 and another on the M3.

1. Connect both machines to the app you are using, with permission to change
   settings and run work (**Settings > Connections**). Both must run a version
   of SpecWithCode that can link projects; an older one shows "Update
   SpecWithCode on <machine> to link projects."
2. Open **Settings > Project > Machines** for one of the two projects and choose
   **Link…** next to **Link with a project on another machine**.
3. Pick the other copy. Projects on your other machines are listed, the likely
   copies first, with how their repositories compare, for example "Same root
   repository; 28 of 36 repositories match, 8 missing here." Nothing links until
   you pick one and confirm.
4. Choose **Review link**, then choose which coordinator stays. The default is
   the copy whose coordinator was used most recently.
5. Review the notes:
   - Notes only the other copy has are copied to the copy that keeps its
     coordinator.
   - Notes with the same name and different text are shown side by side. Pick
     **Keep <machine>** for either side, or **Keep both**, which saves the other
     copy's text next to it as `<name>-<machine>.md`. Link stays disabled until
     every such note has a choice.
   - The kept copy keeps its own goal and instructions. The other copy's text is
     shown so you can copy anything you need into them.
6. Confirm and choose **Link, keep coordinator on <machine>**.

After linking, the coordinator that stayed can start workers in the other copy
once **Allow workers** is on for that machine ([Add a machine](./add-a-machine.md)).
The other copy's threads keep running; its coordinator conversation stays
readable.

### When linking is refused

| Message                                                        | What to do                                                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| "Connect <machine> first."                                     | Connect that machine in **Settings > Connections**, then try again.                              |
| "Update SpecWithCode on <machine> to link projects."           | Update the app or server on that machine.                                                        |
| "… needs permission to change settings and run work."          | Pair again with a link that grants those permissions.                                            |
| "The copy on <machine> is already shared with other machines." | A copy can join only one shared project. Unlink it there first, or keep its coordinator instead. |
| "These folders are not copies of one project."                 | The root repositories differ. Pick the right folder.                                             |
| "A coordinator handoff is in progress on <machine>."           | Finish or retry the handoff first.                                                               |
| "The coordinator on <machine> is working."                     | Let it finish or stop it, then link.                                                             |

A folder that holds only some of the repositories is still a valid copy; the
match summary lists the ones missing there.

### If a machine drops off while linking

Linking runs in three steps: the kept machine prepares, the other machine
joins, the kept machine lists it. Each step can be retried safely; **Retry link**
reuses the same operation.

If the kept machine goes offline after the other copy joined, the other copy
already defers to the kept coordinator and sending messages keeps working.
**Settings > Project > Machines** then shows "Joined, but <machine> does not list
it yet." with **Finish linking**, which completes the last step when that machine
is back.

## Add a folder that is already a copy

When you add a folder on one machine, the app reads which repositories it holds
(a root repository or a plain folder of repositories, nested repositories,
linked worktrees counted under their main repository, folder links skipped) and
compares it with the projects on your other connected machines. When one
matches, it suggests **Link as a copy of <project> on <machine>**, with the match
summary and the repositories missing here, each with **Clone from origin**. The
app never links or clones without your click.

## Unlink a copy

In **Settings > Project > Machines**, choose **Unlink** next to a copy that runs
workers. That copy becomes its own project again: it gets a new identity and an
active coordinator, with a copy of the kept notes it lacks (and a second, named
copy of any note whose text differs). Its own notes are never replaced. The
coordinator that stayed stops listing it.

Unlink needs the copy's machine connected. If the coordinator's machine is
offline, the copy still unlinks, without the notes; when that machine is back,
its **Machines** list shows "This copy was unlinked on <machine>." with
**Remove** to finish.

Apart from Unlink and a takeover (below), a copy that runs workers gets an
active coordinator only through a [handoff](./portable-handoffs.md) from the
current coordinator. Project settings cannot clear that.

## When the coordinator's machine is gone

Each copy that runs workers keeps a read-only copy of the coordinator's notes,
goal and instructions. The app refreshes it when you link, and whenever the
coordinator's notes, goal or instructions change while it can reach both
machines.

If the coordinator's machine has been unreachable for at least 10 minutes,
**Settings > Project > Machines** shows **Take over coordinator here** next to
each copy that runs workers. Before then it says how many minutes are left.
Choose it and confirm once. That copy becomes the coordinator and starts from
the notes, goal and instructions it last copied. A note of its own with
different text is kept under a second name ending in `-before-takeover`.
Nothing changes over on its own: the app never takes over without you.

When the old coordinator's machine is reachable again, the app makes it give
way: it becomes a copy that runs workers. Any coordinator turns it ran while
the two machines could not see each other are listed. Choose **Review turns**
on its row to see them, and move any work that still matters to the new
coordinator. Code stays in git on each machine; nothing is merged for you.

The machine you take over on must run a version of SpecWithCode with takeover;
an older one shows **Update SpecWithCode on <machine> to take over.**

## How remote workers find the project

When a coordinator starts work on another machine, the app has to find the
project there:

- **A shared project** uses only its listed copies. The other machine's copy
  must list the same project and itself, so a project that merely has the same
  repository is never used. Link the copies first.
- **A project that is not shared** is matched by its repository: the same remote
  and the same place inside it, or the project chosen on that machine for this
  one.
