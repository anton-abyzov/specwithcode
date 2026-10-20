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

The sidebar and project link use the logical identity. The coordinator runs on one admitted binding. A worker keeps its own machine and provider. Thread references contain both the environment and thread ID, so identical local IDs on two hosts cannot open the wrong conversation.

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

A member keeps a replica of its coordinator's notes, goal and instructions in `coordinator-replicas/<hash of project id>.json` in its state directory (`apps/server/src/project/CoordinatorReplicas.ts`; owner-only, atomic rewrite, database untouched). The client keeps it fresh from `CoordinatorSync` in the root route: every 60 s and on any binding, settings or reachability change, it compares `projectLink.digest` (sha256 over goal, instructions and sorted notes) on the coordinator with the replica digest on each member, and on a difference sends the coordinator's `projectLink.preview` content through `projectLink.replicate`. The member recomputes the digest and refuses a mismatch, a replica from its own machine, or another identity.

`projectLink.takeover` runs on a member when the coordinator's machine has been unreachable for 10 minutes; the client enforces the wait from the machine's last-seen time, since a server cannot judge another machine's reachability. It names the coordinator the client sees as `predecessor`, writes the replica's notes (a differing local note is kept as `<name>-before-takeover.md`), goal and instructions, and moves the binding to active at `max(own epoch, knownEpoch) + 1` with `predecessor` and `takenOverAt` (mode `takeover`). When both machines are reachable, the client calls `projectLink.supersede` on the old owner, which becomes transferred at the new epoch with `successor` and `takenOverAt` (mode `superseded`) and returns the coordinator turns it started since `takenOverAt` for review; `projectLink.preview` keeps returning them. Supersede refuses a lower or equal epoch, an unlisted successor or a copy that is no longer active. The highest epoch wins in `logicalCoordinator` meanwhile. Servers without the `coordinatorTakeover` capability are skipped.

## Shared visibility and history

The project shows threads from its explicit machine bindings, including archived threads. Earlier coordinator segments remain readable. Requests use the model recorded on their run and the execution environment of that segment, so changing the current picker does not relabel history.

The coordinator's default `studio_thread_list` reads the authorized logical-project inventory across reachable bindings. Results include environment-qualified thread links, pagination, and per-binding status. A machine that is disconnected, denied, or too old to provide the requested inventory is reported as unavailable or partial. It is never presented as an empty successful project.

This is private federation, not an always-on central transcript server. Unreachable hosts can have newer history that is not available to the current coordinator. The app does not elect another coordinator merely because the current host disconnects.

## Continuity limits

Handoffs retain bounded conversation text and project context with a committed Git checkpoint. They start a fresh native provider session. They do not move live processes, provider credentials, uncommitted files, or the provider's hidden session state. A transfer that exceeds supported bounds or lacks a safe checkpoint must fail explicitly.

History labels identify the recorded execution host and requested run model. They do not claim to identify the physical keyboard/browser that submitted the request or undocumented provider-side model routing.

Older projects remain readable. Their unrelated histories are not merged automatically by title or repository. Product implementation does not itself migrate live stores, publish a release, or prove acceptance on a physical three-machine fleet.

## Verification

Focused contract, admission, handoff, grouping, scoped-thread, federation, and request-provenance tests cover the domain behavior. `scripts/studio-logical-projects/verify.mjs` starts three isolated servers with synthetic project history and disabled providers, then verifies the built UI using headless Chrome. It writes screenshots and a receipt, and stops only its own process IDs. This verifies real application transport/rendering with fixtures; it is not a live-provider or physical-machine acceptance claim.

With the project's Node 22 dependencies and coverage provider available:

```sh
node scripts/studio-logical-projects/check.mjs /tmp/logical-project-coverage
# Build apps/web, then apps/server before this UI check.
PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never node scripts/studio-logical-projects/verify.mjs /tmp/logical-project-browser
```

The browser check resolves Playwright from the project or the bundled Codex runtime. `STUDIO_TEST_PLAYWRIGHT_MODULE` may name an installed Playwright module path, and `STUDIO_TEST_CHROMIUM` may select an installed Chrome executable. It always launches a separate headless context, keeps ephemeral credentials out of artifacts, verifies that no provider turns occurred, and removes its temporary server stores after stopping them.
