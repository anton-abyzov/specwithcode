# One project across machines

A project is the identity of the work: its name, intent, coordinator conversation, and threads. A machine registration is a location where that project can execute. A Git folder, provider session, or handoff worktree is not another project.

```mermaid
flowchart TD
  P[Logical project] --> C[One coordinator conversation]
  P --> T[Project threads]
  C --> S[Ordered execution segments]
  S --> M4[M4 binding]
  S --> M1[M1 binding]
  S --> M3[M3 binding]
  T --> R[Runs with recorded machine and model]
```

The sidebar and project link use the logical identity. The coordinator runs on one admitted binding, and a linked machine can run its own coordinator beside it ([An orchestrator on each machine](#an-orchestrator-on-each-machine)). A worker keeps its own machine and provider. Thread references contain both the environment and thread ID, so identical local IDs on two hosts cannot open the wrong conversation.

The logical project's name appears in its sidebar, coordinator header, desktop window, settings, and handoff review. A checkout named for an old handoff does not replace that name. Renaming through settings targets the current active coordinator's project, even when those settings are scoped to an earlier machine. A disconnected, denied, conflicting, or transferring owner must be resolved before renaming. Checkout-specific settings and deletion keep their original scope.

Legacy repository grouping can display a selected handoff checkout's title while the original project and its threads still exist. That is not evidence that either project was deleted or that their histories belong together. Such records require explicit association; the app does not recover a name or merge history by guessing from repository URLs or handoff labels.

## Switching the coordinator

Choosing another machine starts a checked handoff. The review names the destination and the committed Git checkpoint. The source persists its transfer state before publication or destination execution. The bundle is pinned to the chosen environment and project; another matching repository cannot receive it accidentally.

The destination retains the context, creates a safe execution checkout, and returns the accepted coordinator receipt. That checkout belongs to the same logical project. The source then records the completed transfer and remains unable to run the old coordinator. Ordinary workers can continue on their own machines after acknowledgment.

A lost response does not authorize a second coordinator. Retry the same handoff operation. While its outcome is unresolved, the UI shows the pending transfer and the source does not silently resume. Project settings cannot clear an ownership fence.

Recovery stays available across the logical project's bindings after the active coordinator moves or the page reloads. If the destination already started, retry confirms its receipt and acknowledges the source without launching it again.

Joining a previously independent destination is an explicit association. Existing history is retained. Repository URLs and project names can suggest a location, but do not establish domain membership or authorize merging an already linked fleet.

## Linking two existing projects

Two independent projects for the same work, one per machine, become one project through an explicit link (`apps/server/src/project/ProjectLink.ts`, RPCs in `packages/contracts/src/projectLinkRpc.ts`). The client drives both machines, as for handoff:

1. `projectLink.preview` on both copies: identity, binding, repository fingerprint, notes, goal, instructions, last coordinator activity and any refusal.
2. `projectLink.prepare` on the kept copy. A project created before shared identities gets one first (`adopt-identity`: `logical:<uuid>`, itself as the only member, binding epoch 0 active). Project IDs never change.
3. `projectLink.accept` on the joining copy (`join-as-member`): it checks that the fingerprints match at the root, then adopts the kept identity with a relinquished binding at the kept epoch, `successor` = the kept member. Its coordinator is fenced; ordinary workers continue.
4. `projectLink.commit` on the kept copy: writes the chosen notes, then lists the joining copy (`link-member`: same identity, binding unchanged).

Each step is idempotent by state, and project command IDs include the project revision, so retrying the same operation never applies a step twice. A missing step 4 leaves the joining copy deferring to the kept coordinator, which keeps sending safe; the UI offers Finish linking. Remote workers then use the copy because `isLogicalProjectBinding` holds in both directions.

`projectLink.unlink` with `side: "member"` gives the member a fresh identity and an active epoch-0 binding (`unlink`, the only non-handoff path from relinquished to active), copying the kept notes it lacks; `side: "coordinator"` removes the member from the kept identity (`remove-member`). Every ownership update names its mode, and `ownershipRejection` in `ProjectCommands.ts` refuses any other transition. Servers without the `projectLink` capability are reported as needing an update.

### Replicas and coordinator takeover

A member keeps a replica of its coordinator's notes, goal and instructions in `coordinator-replicas/<hash of project id>.json` in its state directory (`apps/server/src/project/CoordinatorReplicas.ts`; owner-only, atomic rewrite, database untouched). The servers keep it fresh with no app window open; see [Server-driven sync](#server-driven-sync). The pass compares the coordinator's content digest (sha256 over goal, instructions and sorted notes) with the replica digest on each member and, on a difference, copies the coordinator's content into the member, which recomputes the digest and refuses a mismatch, a replica from its own machine, or another identity. A replica records the coordinator's epoch (`fromEpoch`) and is never replaced by one from a lower epoch, so two copies that both coordinate after a takeover do not keep overwriting each other's replica. For pairs no server covers, `CoordinatorSync` in the root route does the same through `projectLink.digest`, `projectLink.preview` and `projectLink.replicate` every 60 s and on any binding, settings or reachability change.

### Server-driven sync

`apps/server/src/project/LinkedPeerSync.ts` drives the replica, two-way memory, plan claims and supersede from the servers. Each pair of copies of one logical project is driven by exactly one server, the one with the lower environment ID (`drivesPair` in `packages/shared/src/linkedPairSync.ts`); the other only answers. Supersede is the exception: the copy that took over drives it, since only it holds the new binding. The loop runs a pass every 60 s, at once when a linked machine calls this one again after a failure, within 60 s when a machine the last pass could not reach answers a reachability probe (`HandoffPeers.reachable`, which sends no request), within 10 s of a link being made or removed, and within 10 s of a work grant appearing on a machine a pass could not call for want of one (its pairs are then due at once, and member lists held for it are sent again). Passes never overlap; they are skipped while `ServiceUpdateHold` holds the service, and a hold or shutdown that begins mid-pass stops it before its next call. Toward a machine too old for these paths (`outdated`), the pair's driver still moves memory over `memory-export` and `memory-merge`, and so does a coordinator's server toward older copies whose pair it does not drive, as the coordinator's server did before.

A pass calls the peer over the handoff peer route with this machine's work grant there, so it drives only pairs toward machines it holds a grant on. The versioned paths are `linked-digest`, `linked-content`, `linked-replica`, `linked-supersede`, `linked-members`, `plan-export` and `plan-merge` (protocol version `LINKED_SYNC_PROTOCOL_VERSION` in `apps/server/src/handoff/linkedSyncWire.ts`), plus the existing `memory-export` and `memory-merge`. The receiver (`apps/server/src/project/LinkedPeerRoute.ts`) refuses its own machine, a machine the project does not list, a grant whose project list leaves the copy out, another identity, another protocol version and bodies over `LINKED_SYNC_PEER_MAX_BYTES`; it accepts content, memory, plans or a supersede only in the caller's own name, checks membership before anything else about the copy, takes a replica from another member than the copy it gave way to only at one epoch past it (longer takeover chains are left to the app), and gives way only after the successor confirms over the peer route that it holds that takeover binding. When this machine can never ask the successor (no grant there, revoked or expired, the successor is not in its fleet, it refuses this machine's grant, or it predates the digest path), the successor stands for itself: it signed in with the grant this machine issued to it and may claim only its own takeover, so a confirmation would add only freshness, which is checked locally instead. The claim must name this very copy as predecessor, come from a listed copy, carry an `operationId`, be at a higher epoch than this copy's binding and have a `takenOverAt` later than this copy's own; a copy that already gave way never moves to another successor on a claim alone. A successor that does not answer, answers with another binding, or refuses otherwise, is never taken at its word: the supersede is refused `busy` and the successor tries again. It reuses the `ProjectLink`, `LinkedMemorySync` and `ProjectPlanService` operations the app calls, and the decisions are the shared ones in `packages/shared/src/linkedPairSync.ts`, `linkedMemorySync.ts` and `linkedPlanSync.ts`.

Member lists follow the coordinator (`apps/server/src/project/ProjectLinkMembers.ts`). A transferred copy adopts the list of the copy it gave way to (additions and removals), whether that copy coordinates or gave way in turn and relays its own successor's list; from another machine it takes nothing, since a claimed epoch is that machine's own word. Only the app (`projectLink.syncMembers`), which read the coordinator itself, may send additions from a coordinator one takeover later, with the same epoch check as a replica. The list arrives through the optional `members` field of `linked-digest` (the pair's driver pulls from the copy it gave way to, and a copy that gave way reads it from its successor on every pass even when the successor drives the pair), the `linked-members` path (the driver pushes to a copy that gave way to it, and so does a coordinating copy to the copies it only watches, so the list arrives whichever way the environment IDs sort and whichever side holds the grant), `projectLink.syncMembers` from the app on servers with the `linkedMembersSync` capability (`CoordinatorSync`, every 60 s, for pairs no server drives), or a refresh from the copy it gave way to when a re-arm consent names a machine this copy does not list. Adopting never drops the copy itself or the copy it gave way to, never rewrites its own entry, never lists a second copy on its own machine and never changes its binding (ownership mode `sync-members`). A copy that took over adds the members its predecessor lists in the `members` field of the `linked-supersede` answer (mode `link-member`), except members it unlinked since the takeover: the binding's optional `removedMembers` remembers them (written by `remove-member`, at most 256). A sync the peer refused is not tried again for that pair until either list changes or 10 minutes pass; one that failed on this machine (no grant there yet), was refused for want of a grant, or got no answer is tried again on the pair's next pass. Linking or unlinking a member on the coordinator starts a pass at once for that project. Member sync is best effort and outside `projectLink.syncStatus`; a peer that predates it sends no `members` and is sent nothing. Limit: a copy that takes over before it learned a later member, from a predecessor it cannot reach, lists that member only after the app syncs it or it is linked again.

Each pass first exchanges digests (binding, coordinator content, replica, memory and plan) and moves content only for a kind whose digests changed since the last pass that left it in step, and at least every 5 minutes. A kind is taken as in step only from digests read right after its own merges, never for a kind the pass skipped; memory that still differs after its retry counts as a failure. A pair that fails backs off 1, 2, 4 then 5 minutes at most; a call from that peer, or a probe that reaches it again, resets it. The copy that took over retries giving way every 5 s (`SUPERSEDE_RETRY_MS`) for the first 10 minutes the old coordinator does not answer (`QUICK_RETRY_WINDOW_MS`), then once a minute (never the minutes of a pair's backoff, since the old one may hold no grant to call back), so the old one gives way within seconds of being reachable again, whichever of the two holds a grant on the other. Those quick retries wake a pass over only the pairs waiting for one. A copy that only reads its successor's list backs off the same way when the successor does not answer. A peer that answers 404 for an unknown path predates server-driven sync and is reported as `outdated`.

`projectLink.syncStatus` returns, per pair and kind, the last success, last attempt and last error (`needs_grant`, `unreachable`, `outdated`, `refused` or `failed`). The status is in memory only. The app skips a pair in `CoordinatorSync`, `LinkedMemorySync` and `LinkedPlanSync` only when both servers advertise the `serverLinkedSync` capability and the driving server reports a success for that kind within the last 3 minutes (`SERVER_SYNC_FRESH_MS`); otherwise it keeps driving the pair as before, for example after a restart, without a grant, or toward an older server.

### Equal coordinators

Every machine that has a project runs its own active coordinator, and what is typed on a machine goes to that machine's coordinator. Nothing makes a coordinator give way, takes one over, stands by for one or moves one.

- Link acceptance writes `active` on the joining copy (`joinedBinding` in `apps/server/src/project/EqualCoordinatorMigration.ts`).
- When a server starts, one pass (`migrate`, same module) rewrites every linked copy whose binding is `transferred`, `transferring`, or `active` with a standby, successor, predecessor or takeover stamp into an active binding at the same epoch. An open role operation is retired (`retiredOperationIds`), so a late write under it never fences the copy again. Standby records, re-arm consents and the "superseded" marks of peer sync are cleared. Holds on single threads are not touched.
- `projectLink.takeover`, `supersede`, `setStandby`, `acceptStandby`, the re-arm calls and the planned and Away coordinator handovers are refused with `EQUAL_COORDINATORS_DETAIL`. A peer on an older version that reconnects with a superseding binding is refused each time it asks, and both machines keep their own coordinator.
- A copy keeps whether it was the one owner of the project's routines (`routineOwner`, read by `coordinatorOwnsRoutines`), so making every copy active never makes two machines fire a routine no runner is settled for.
- Member lists stay additive between equals (`adoptEqualMembers` in `apps/server/src/project/ProjectLinkMembers.ts`); a removed member is remembered and never added back.
- Unlink stays in Settings and names the project. The per-thread fence, each machine's own workers and both coordinator conversations are unchanged.

### Coordinator role for other services

Server code that should act only where this machine coordinates a project (routines failover, for one) uses `CoordinatorRole` (`apps/server/src/project/CoordinatorRole.ts`, provided by the orchestration runtime). `roleOf(projectId)` returns this copy's role from its own `coordinatorBinding`: `active` while the binding is active, with its `epoch`, `state` and `logicalProjectId`; a copy without a binding, linked or not, is active at epoch 0, and a missing or deleted project returns none. Several copies may be active at once (each machine may run its own coordinator); the highest epoch is the newest, as `logicalCoordinator` orders them in the client. `changes` streams role changes on this machine from the moment of subscription: `took-over` (a person's or an automatic takeover, starting this copy's coordinator, or unlinking, which makes it the coordinator of its own project at epoch 0, with `epoch`, `predecessor` and `takenOverBy`), `gave-way` (superseded, including the lease loop giving way to a standby, or joining another copy's project as a member, with `epoch` and `successor`), `standby-armed` and `standby-released` (with the reason: turned off, released, grant scope or revocation, project removed, outdated). They are published by ProjectLink and the lease receiver after the change is written. A copy another machine superseded without reaching this one still reads as active until it hears of it, and a handoff of the whole project is not published; read `roleOf` again after one.

### Routines follow the coordinator

With a standby armed, the lease loop also sends the standby the project's coordinator-owned routines (`ownThread`, not webhook) as `routines` on `coordinator-replica`, at most 200 and 256 KiB of JSON (larger sets send none), with `routinesDigest` on every lease (`apps/server/src/scheduledTasks/ScheduledTaskCopies.ts`). Both fields are optional and kept apart from `contentDigest`, so a standby that predates them still accepts the notes; the lease protocol version is unchanged. The standby asks for content again when the digest it holds differs, and keeps the routines under the same ids in its own copy, marked `copiedFrom: <logicalProjectId>` in `run_policy_json`; the coordinator marks the routines it sends the same way. Marked routines no longer sent are deleted unless the list was full, so a routine deleted on a new coordinator also leaves the old one once it stands by. Unchanged copies are not saved again. An id another project uses on the standby is skipped. Webhook URLs and signing secrets never travel.

`ScheduledTaskCoordinatorGate.ts` reads `CoordinatorRole.roleOf` before every fire of a coordinator-owned routine: `transferring` waits (stays due), a copy that is not active rests (moves to its next time with a note, cleared on `took-over`), an active copy fenced by `CoordinatorWakeGate` waits. Unlinked projects, webhook and worker-bound routines are not gated. A daily or monthly run missed by more than 10 minutes records a skip note in `lastRunError` (`missedRunNote` in `Schedule.ts`). Limits: the linked sync path does not carry routines, so a person's takeover on a copy that was never the standby starts without them.

A copy that joins a link as a member keeps its own routines, unmarked, and they rest like any other. `projectLink.preview` lists them as `routines` (`RoutineCopies.owned`) and the link review names them. The single-writer refusal on a resting copy covers every change to a marked routine; an unmarked one, which no other machine holds, can be turned off or deleted there (`isCoordinatorCopy` in `ScheduledTaskService.ts`). Turning it on, editing and running it stay refused.

### Link review choices and the first memory merge

Linking writes the review's note choices into the kept copy only (`noteWrites` in `apps/web/src/studio/projectLink.ts`); the joining copy keeps its notes. A note both copies hold with different text would reach the two-way memory merge as two unrelated edits. So `projectLink.preview` sends each note's `contentSha256`, and the client's commit names, as `superseded`, the joining versions the review set aside ("keep the kept machine's" and "keep both"). The kept copy records each as an earlier version of its own note in `LinkedMemoryHistory` (`ProjectLinkNotes.ts`), so the merge reads the kept text as the newer version and the joining copy takes it, with no conflict copy. Both fields are optional: with a server that predates them, or if the record cannot be written, the merge keeps both texts as before.

### Two-way memory

Members that each run a coordinator write project memory independently, so memory also replicates in both directions. Each server keeps the last 50 sha256 hashes every memory file has had on that machine, and a tombstone with that history when a file is deleted, in `linked-memory/<hash of project id>.json` in its state directory (`apps/server/src/project/LinkedMemoryHistory.ts`; owner-only, atomic rewrite, database untouched). Every memory write and delete records its version there; a lost or damaged history file never loses content, because files it can no longer order are merged as concurrent edits, which keep both versions.

The servers sync memory for the pairs they drive ([Server-driven sync](#server-driven-sync)) with the same calls the app makes. `LinkedMemorySync` in the root route covers the remaining pairs: it runs every 60 s and when a copy comes online or is linked. For each pair of reachable copies with the `linkedMemorySync` capability (any binding state) it calls `projectLink.memoryExport` on both, then `projectLink.memoryMerge` on each side with the other's export, so a side that fails never changes what the other sees and the next pass converges. A merge refuses another identity, an unlisted peer, this machine, a payload over `PROJECT_LINK_MAX_BYTES`, or content that does not match its hash. `apps/server/src/project/linkedMemoryMerge.ts` decides each file the peer sent; files only this machine has are never touched:

| Case                                                | Result                                                                                                                                                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same content on both                                | Histories are joined                                                                                                                                                                                                                    |
| The peer's content is in this file's history        | Kept: this side is newer                                                                                                                                                                                                                |
| This content is in the peer's history               | The peer's version is written                                                                                                                                                                                                           |
| Neither history knows the other's content           | The later write wins (tie: larger environment ID). The winning machine keeps its file; the other saves its own version as `<base>.conflict-<machine>.md` before taking the winner, adding `-2`, `-3` when that name holds other content |
| A file here, the peer's tombstone lists its content | Deleted                                                                                                                                                                                                                                 |
| A tombstone here lists the peer's content           | Stays deleted                                                                                                                                                                                                                           |
| Any other file against a tombstone                  | The file is kept or restored                                                                                                                                                                                                            |

`MEMORY.md` is never deleted by replication: a peer's tombstone for it is ignored and a local one never blocks the peer's copy. Identical content never produces a conflict copy. The one-way replica and takeover flow above still runs for older peers.

## An orchestrator on each machine

A linked project can run an active coordinator on every member machine, so the project keeps going while one machine is off. `projectLink.startCoordinator` (capability `coordinatorPerMachine`) gives the calling member its own active binding; it does not move or fence the other coordinator. Each coordinator owns the threads it started or that were migrated to it. Another coordinator reads those threads but cannot send to, steer or stop them (`apps/server/src/mcp/workGrantAccess.ts`). Pairing grants work both ways for the linked project only, and `apps/server/src/fleet/workGrantPolicy.ts` still refuses delegation loops.

### Viewing, moving and migrating

The machine switcher under the project composer (`apps/web/src/components/studio/OrchestratorSwitcher.tsx`) has three separate actions:

| Action                                | What it does                                                                                                                                                             | What moves                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| _machine_, under View this project on | Reads that machine's coordinator conversation, threads, plan and memory from its own server. A message typed there is sent to and handled by that machine's coordinator. | Nothing. The device only remembers which orchestrator it last viewed. |
| Move to _machine_…                    | Opens the checked handoff in [Switching the coordinator](#switching-the-coordinator) for review before anything moves.                                                   | The coordinator, recorded as a transfer.                              |
| Move running threads…                 | Moves selected threads through thread handoff, with a preflight result per thread. Disabled until thread handoff ships.                                                  | Only the threads chosen.                                              |

### Online and offline

Online, the view reads the remote server live, so messages and thread state are the same data that machine shows. Offline, the view shows what this device last loaded from that machine, labeled `<machine> unreachable · last synced <time> · read-only`, and the composer refuses to send with the machine's name. Nothing is queued or sent to another machine. A linked machine this device never loaded reads `Unknown`, never an empty list or another checkout in its place.

| Data                                                                                 | How the other machine gets it                                         | Offline                                                                 |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Project memory files, including `MEMORY.md`                                          | Replicated both ways ([Two-way memory](#two-way-memory))              | Last replicated copy                                                    |
| Plan tasks and claims                                                                | Replicated both ways; each claim names its machine                    | Last replicated copy; claims held on the unreachable machine show Stale |
| Coordinator conversation and thread summaries                                        | Read live from that machine; the viewing device caches what it loaded | The cached copy, read-only, with its sync time                          |
| Thread checkpoints, transcript deltas, handoff notes                                 | Replicated by thread handoff, for threads with handoff on             | Whatever handoff last replicated                                        |
| Full transcripts, tool activity, diffs, terminals, queues, approvals, provider state | Remote read only                                                      | `Unknown`                                                               |

### Plan claims across machines

The servers merge plan claims for the pairs they drive ([Server-driven sync](#server-driven-sync)); `LinkedPlanSync` in the root route covers the rest. It runs every 60 s for reachable copies with the `linkedPlans` capability: `projectLink.planExport` on both, then `projectLink.planMerge` on each with the other's copy. `apps/server/src/project/plan/PlanMerge.ts` merges so that the result is the same whichever copy merges first; the earliest claim wins, ties going to the user, then the smaller machine ID. A claim held by a thread on another machine binds here too, so a local thread cannot take that task. While the holder's machine is unreachable, the claim shows `Stale · <machine> unreachable · only you can release it`; no machine releases it on its own.

A merge writes only when the plan changed. The peer's machine label counts only as present or missing, because the app window names a machine from its saved connection and the server from the fleet; comparing labels made the two drivers rewrite an unchanged plan back and forth, bumping its revision on every restart. The window sends an empty label for a machine its connection does not name, which keeps the stored label, so its old "Another machine" placeholder no longer wins the first write. A merge that changes the plan for real stores the label its caller sent, when it sent one; a rename alone is stored with the next real change. While `ServiceUpdateHold` holds the service, including across an update's restart until the helper has verified or rolled it back, nothing is merged in: the peer route answers every call `503 busy` (so a driving peer records a failed pass, never an in-step memo), the server's own pass skips, the window's `planMerge` answers `changed: false` with the stored revision, and the window's memory merge is refused (`paused`). The window's next 60 s pass merges after the hold. Older builds still flip the label, so the fix holds only once both window and server run a release that has it. A plan rewritten during that window changed `project_plans` and refused the update's page proof (`Refused:authority-table-changed:project_plans`), which sent M4's 1.0.180 update to the full read and a rollback.

### Where a thread runs

`studio_thread_launch` places a thread by this policy (`apps/server/src/mcp/toolkits/project/remoteLaunch.ts`):

1. The machine named in the call. If it cannot take the thread, the launch is refused with the reason; another machine is never substituted.
2. Otherwise, for the coordinator, the project's worker machine, if it is reachable, granted, has the project and is signed in to the provider.
3. Otherwise the coordinator's own machine.

The result reports the chosen machine as `placement` with each skipped candidate and its reason. A worker machine is skipped only on a failure that proves it started nothing; a launch whose outcome is unknown is never retried elsewhere.

### Independent checkouts

Two checkouts of one repository that are not explicitly linked stay two projects with two orchestrators and their own branches. Nothing links them by name or by a matching remote. They consolidate through pull requests to the shared remote: the PRs tab on a linked project lists "Pull requests from both machines" with the machine each one came from. Linking ([Linking two existing projects](#linking-two-existing-projects)) does not move threads; each coordinator keeps its own until they are migrated.

## Shared visibility and history

The project shows threads from its explicit machine bindings, including archived threads. Earlier coordinator segments remain readable. Requests use the model recorded on their run and the execution environment of that segment, so changing the current picker does not relabel history.

The coordinator's default `studio_thread_list` reads the authorized logical-project inventory across reachable bindings. Results include environment-qualified thread links, pagination, and per-binding status. A machine that is disconnected, denied, or too old to provide the requested inventory is reported as unavailable or partial. It is never presented as an empty successful project.

This is private federation, not an always-on central transcript server. Unreachable hosts can have newer history that is not available to the current coordinator. The app does not elect another coordinator merely because the current host disconnects; a member runs its own coordinator only when the user starts one there.

## Continuity limits

Handoffs retain bounded conversation text and project context with a committed Git checkpoint. They start a fresh native provider session. They do not move live processes, provider credentials, uncommitted files, or the provider's hidden session state. A transfer that exceeds supported bounds or lacks a safe checkpoint must fail explicitly.

History labels identify the recorded execution host and requested run model. They do not claim to identify the physical keyboard/browser that submitted the request or undocumented provider-side model routing.

Older projects remain readable. Their unrelated histories are not merged automatically by title or repository. Product implementation does not itself migrate live stores, publish a release, or prove acceptance on a physical three-machine fleet.

## Notifications across machines

Every app reports its activity to every machine it is connected to, so a thread's own server hears from every app that could alert for it. That server elects one notification client, in this order: the desktop or web app in use now and touched last; a phone in use now (no desktop pops up; the phone gets its push as before); the desktop or web app touched last; the app on the server's own machine; nobody. A client that is no longer connected, or has not reported for 35 s (a machine that went to sleep, though its 45 s lease runs on), is never elected. Interaction times are kept in memory for 8 hours (64 clients at most), so a server restart falls back to the own-machine rule until someone interacts.

Out of focus, only the elected app posts the system notification and plays the sound. The app on the item's owner machine still badges it and counts it in the sidebar, the project page and Overview; other apps neither badge nor count it, and Overview says "N more on <machine>, in use there". Rows keep their status everywhere. The owner is the machine of the coordinator that launched a remote worker, else the thread's owner machine, else the serving machine. A handed-off copy (`executionState: "fenced"`, or running on another machine) raises nothing. A server that names nobody leaves alerts with the app on the serving machine, or with every app when that app is not connected. A server too old to elect, or one that does not answer within 1.5 s, cannot say whether that app is connected, so every app alerts and counts and badges show everywhere, as before. A focused window always shows its in-app toast. One with pointer, key, wheel or touch input in the last 45 s plays its sound without asking; one without asks the serving machine like a window out of focus and stays silent when another app is elected, so an app left in front on a computer nobody is at makes no noise. Phone pushes do not change.

## Verification

Focused contract, admission, handoff, grouping, scoped-thread, federation, and request-provenance tests cover the domain behavior. `scripts/studio-logical-projects/verify.mjs` starts three isolated servers with synthetic project history and disabled providers, then verifies the built UI using headless Chrome. It writes screenshots and a receipt, and stops only its own process IDs. This verifies real application transport/rendering with fixtures; it is not a live-provider or physical-machine acceptance claim.

With the project's Node 22 dependencies and coverage provider available:

```sh
node scripts/studio-logical-projects/check.mjs /tmp/logical-project-coverage
# Build apps/web, then apps/server before this UI check.
PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never node scripts/studio-logical-projects/verify.mjs /tmp/logical-project-browser
```

`scripts/studio-logical-projects/two-orchestrators.mjs` starts two isolated servers (M4 and a Minis fixture) with one linked project, an active coordinator on each and providers off, then checks in headless Chrome: a replicated plan claim, a memory conflict copy, the three switcher actions, a message typed in Minis's view running on Minis, pull requests from both machines, Minis going offline while viewed (last synced, read-only, sends refused by name), a stale claim after the partition, `Unknown` for a machine never synced, and reconnecting to a live view. Workers use `link-launch-agent.mjs --echo`; a prompt line `MCP-CALL {"name","arguments"}` makes that one MCP call with the thread's own credential, so the script can claim a plan task as a thread. Build apps/web and apps/server first.

```sh
STUDIO_TEST_CHROMIUM=<chrome-headless-shell> PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never node scripts/studio-logical-projects/two-orchestrators.mjs /tmp/two-orchestrators
```

`scripts/studio-logical-projects/notify-active.mjs` starts two isolated servers with providers off and two apps, each holding a socket to both servers and reporting activity as a desktop window does. For one question it checks that exactly one app pops up and which ones count it: the own-machine app before anyone interacts, the app touched last, a focused window, and the other app once the first machine's lease ends. Build apps/server first; it opens no browser.

```sh
node scripts/studio-logical-projects/notify-active.mjs /tmp/notify-active
```

The browser check resolves Playwright from the project or the bundled Codex runtime. `STUDIO_TEST_PLAYWRIGHT_MODULE` may name an installed Playwright module path, and `STUDIO_TEST_CHROMIUM` may select an installed Chrome executable. It always launches a separate headless context, keeps ephemeral credentials out of artifacts, verifies that no provider turns occurred, and removes its temporary server stores after stopping them.
