import { it as effectIt } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { expect, it } from "vite-plus/test";
import { fixtureProjectDatabase } from "../project/ProjectWorkspace.testkit.ts";
import * as Settings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Projects from "./ProjectStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as Archive from "./InactiveThreadArchive.ts";
import {
  DAY_MS,
  InactiveArchiveError,
  OVERFLOW_IDLE_MS,
  isInactiveArchiveCandidate,
  isOverflowArchiveCandidate,
  isSweepArchiveProtected,
  isValidActiveThreadCap,
} from "./InactiveThreadArchiveGuard.ts";

const at = DateTime.makeUnsafe(0);
const candidate = {
  id: ThreadId.make("archive-000"),
  projectId: ProjectId.make("archive-project"),
  createdBy: "user",
  creationSource: "web",
  status: "completed",
  latestRunId: RunId.make("run"),
  createdAt: at,
  updatedAt: at,
  latestRunRequestedAt: at,
  latestRunStartedAt: at,
  latestRunCompletedAt: at,
  activeRunId: null,
  pendingRuntimeRequest: null,
  archivedAt: null,
  deletedAt: null,
  pinnedAt: null,
  pendingBackgroundTasks: [],
  hasActionableProposedPlan: false,
  lineage: {
    parentThreadId: null,
    rootThreadId: ThreadId.make("archive-000"),
    relationshipToParent: null,
  },
  latestUserMessageAt: null,
  settledOverride: "settled",
  settledAt: null,
  worktreePath: "/retained/dirty-unpushed",
  branch: "retained",
  title: "Retained chat",
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
  runtimeMode: "full-access",
  interactionMode: "default",
  forkedFrom: null,
  activeProviderThreadId: null,
  latestVisibleMessage: null,
  itemCount: 0,
  visibleItemCount: 0,
} satisfies OrchestrationV2ThreadShell;

it("archives at the exact inactivity boundary, respecting custom days and Never", () => {
  expect(isInactiveArchiveCandidate(candidate, 30 * DAY_MS - 1, 30)).toBe(false);
  expect(isInactiveArchiveCandidate(candidate, 30 * DAY_MS, 30)).toBe(true);
  expect(isInactiveArchiveCandidate(candidate, 300 * DAY_MS, null)).toBe(false);
  expect(isInactiveArchiveCandidate(candidate, 6 * DAY_MS, 7)).toBe(false);
  expect(isInactiveArchiveCandidate(candidate, 7 * DAY_MS, 7)).toBe(true);
  for (const invalid of [0, -1, 1.5, 3651, Number.NaN])
    expect(isInactiveArchiveCandidate(candidate, 300 * DAY_MS, invalid)).toBe(false);
});
it.each([
  ["running", { status: "running" }],
  ["queued", { status: "queued" }],
  ["stopped", { status: "interrupted" }],
  ["failed", { status: "failed" }],
  ["never ran", { latestRunId: null }],
  ["active run", { activeRunId: RunId.make("live") }],
  ["approval/question", { pendingRuntimeRequest: { id: "approval" } }],
  ["held queue", { heldQueuedCount: 1 }],
  ["background", { pendingBackgroundTasks: [{ title: "monitor" }] }],
  ["unknown background", { pendingBackgroundTasks: undefined }],
  ["pinned", { pinnedAt: at }],
  ["unknown pin", { pinnedAt: undefined }],
  ["proposal", { hasActionableProposedPlan: true }],
  ["unknown proposal", { hasActionableProposedPlan: undefined }],
  ["snoozed", { snoozedUntil: at }],
  ["reported blocker", { reportedBlocker: "Awaiting input" }],
  ["reported wait", { reportedWait: "Waiting for CI" }],
  ["usage recovery", { limitRecovery: {} }],
  ["title regeneration", { titleRegeneration: {} }],
  ["native imported", { historyOrigin: "native" }],
  ["legacy imported", { historyOrigin: "v1_import" }],
  ["unknown creator", { createdBy: undefined }],
  ["native creator", { creationSource: "provider" }],
  ["fleet ownership", { ownerMachineId: "other" }],
  ["unknown execution", { executionState: "unknown" }],
  ["moved", { movedTo: {} }],
  ["delegated", { lineage: { parentThreadId: "parent" } }],
  ["goal", { goal: {} }],
  ["active tool", { activeWork: {} }],
  ["unfinished plan", { planProgress: { completed: 1, total: 2 } }],
  ["PR monitor", { pullRequests: [{ watch: {} }] }],
  ["archived", { archivedAt: at }],
  ["deleted", { deletedAt: at }],
  ["incomplete timing", { latestRunCompletedAt: undefined }],
] as const)("protects %s", (_name, patch) => {
  expect(
    isInactiveArchiveCandidate(
      { ...candidate, ...patch } as OrchestrationV2ThreadShell,
      31 * DAY_MS,
      30,
    ),
  ).toBe(false);
});
it.each([
  "updatedAt",
  "latestUserMessageAt",
  "latestUserAuthoredMessageAt",
  "latestRunRequestedAt",
  "latestRunStartedAt",
  "latestRunCompletedAt",
  "settledAt",
  "unsettledAt",
  "lastVisitedAt",
] as const)("fresh %s resets inactivity", (field) => {
  expect(
    isInactiveArchiveCandidate(
      { ...candidate, [field]: DateTime.makeUnsafe(DAY_MS) },
      30 * DAY_MS,
      30,
    ),
  ).toBe(false);
});

effectIt.effect(
  "sweeps bounded keyset pages, advances the clock and never reads full history",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const sql = yield* SqlClient.SqlClient;
      const sent: OrchestrationV2ServerCommand[] = [];
      let shellReads = 0;
      for (let index = 0; index < 30; index++) {
        const id = `archive-${String(index).padStart(3, "0")}`;
        yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json)
      VALUES (${id},${candidate.projectId},'Retained','codex','full-access','default','1970-01-01','1970-01-01','{}')`;
      }
      const archive = yield* Archive.InactiveThreadArchive.pipe(
        Effect.provide(
          Archive.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ProjectionStore.ProjectionStoreV2, {
                  getThreadShell: (id: ThreadId) =>
                    Effect.sync(() => {
                      shellReads++;
                      return { ...candidate, id };
                    }),
                } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
                Layer.succeed(ThreadManagement.ThreadManagementService, {
                  dispatch: (command: OrchestrationV2ServerCommand) =>
                    Effect.sync(() => {
                      sent.push(command);
                      return { sequence: 1, storedEvents: [] };
                    }),
                } as unknown as ThreadManagement.ThreadManagementService["Service"]),
                Projects.layer,
                Settings.layerTest(),
              ),
            ),
          ),
        ),
      );
      yield* archive.sweep;
      expect(shellReads).toBe(25);
      expect(sent).toHaveLength(0);
      yield* archive.sweep;
      expect(shellReads).toBe(25);
      yield* TestClock.adjust(30 * DAY_MS);
      yield* archive.sweep;
      expect(sent).toHaveLength(5);
      yield* TestClock.adjust(60_000);
      yield* archive.sweep;
      expect(sent).toHaveLength(30);
      expect(
        sent.every(
          (command) => command.type === "thread.archive" && command.inactive !== undefined,
        ),
      ).toBe(true);
    }).pipe(Effect.provide(fixtureProjectDatabase([candidate.projectId]))),
);

const worker = {
  ...candidate,
  createdBy: "agent",
  creationSource: "mcp",
  lineage: {
    parentThreadId: ThreadId.make("project-coordinator:archive-project"),
    rootThreadId: ThreadId.make("project-coordinator:archive-project"),
    relationshipToParent: "subagent",
  },
} satisfies OrchestrationV2ThreadShell;

it("caps agent-created and child threads only after one idle hour", () => {
  expect(isOverflowArchiveCandidate(worker, OVERFLOW_IDLE_MS - 1)).toBe(false);
  expect(isOverflowArchiveCandidate(worker, OVERFLOW_IDLE_MS)).toBe(true);
  for (const creationSource of ["provider", "server", "web"] as const)
    expect(isOverflowArchiveCandidate({ ...worker, creationSource }, OVERFLOW_IDLE_MS)).toBe(true);
  expect(isSweepArchiveProtected(worker, { allowAgent: true })).toBe(false);
  // The 30-day rule still keeps its own user-created, top-level scope.
  expect(isSweepArchiveProtected(worker, { allowAgent: false })).toBe(true);
  expect(isInactiveArchiveCandidate(worker, 300 * DAY_MS, 30)).toBe(false);
  for (const cap of [null, 19, 5001, 20.5]) expect(isValidActiveThreadCap(cap)).toBe(false);
  for (const cap of [20, 200, 5000]) expect(isValidActiveThreadCap(cap)).toBe(true);
});
it.each([
  ["running", { status: "running" }],
  ["queued", { status: "queued" }],
  ["waiting", { status: "waiting" }],
  ["stopped", { status: "interrupted" }],
  ["never ran", { latestRunId: null }],
  ["active run", { activeRunId: RunId.make("live") }],
  ["pending request", { pendingRuntimeRequest: { id: "approval" } }],
  ["held queue", { heldQueuedCount: 1 }],
  ["background", { pendingBackgroundTasks: [{ title: "monitor" }] }],
  ["unknown background", { pendingBackgroundTasks: undefined }],
  ["pinned", { pinnedAt: at }],
  ["proposal", { hasActionableProposedPlan: true }],
  ["snoozed", { snoozedUntil: at }],
  ["blocked", { reportedBlocker: "Awaiting input" }],
  ["waiting on CI", { reportedWait: "Waiting for CI" }],
  ["waiting on a merge", { reportedWait: "Waiting for PR merge" }],
  ["usage recovery", { limitRecovery: {} }],
  ["native imported", { historyOrigin: "native" }],
  ["owned elsewhere", { ownerMachineId: "other" }],
  ["executing elsewhere", { executionMachineId: "other" }],
  ["unknown execution", { executionState: "unknown" }],
  ["moved", { movedTo: {} }],
  ["goal", { goal: {} }],
  ["active tool", { activeWork: {} }],
  ["unfinished plan", { planProgress: { completed: 1, total: 2 } }],
  ["watched PR", { pullRequests: [{ watch: {} }] }],
  ["archived", { archivedAt: at }],
  ["deleted", { deletedAt: at }],
  ["incomplete timing", { latestRunCompletedAt: undefined }],
  ["active this hour", { lastVisitedAt: DateTime.makeUnsafe(DAY_MS) }],
] as const)("the cap protects %s", (_name, patch) => {
  expect(
    isOverflowArchiveCandidate(
      { ...worker, ...patch } as OrchestrationV2ThreadShell,
      DAY_MS + OVERFLOW_IDLE_MS - 1,
    ),
  ).toBe(false);
});

// A subagent the provider spawned: no app runs, finished by its parent's native record.
const nativeSubagent = {
  ...worker,
  creationSource: "provider",
  status: "idle",
  latestRunId: null,
  latestRunRequestedAt: null,
  latestRunStartedAt: null,
  latestRunCompletedAt: null,
  nativeSubagentStatus: "completed",
  nativeSubagentCompletedAt: at,
} satisfies OrchestrationV2ThreadShell;

it("caps a finished provider-native subagent that never had a run", () => {
  expect(isOverflowArchiveCandidate(nativeSubagent, OVERFLOW_IDLE_MS - 1)).toBe(false);
  expect(isOverflowArchiveCandidate(nativeSubagent, OVERFLOW_IDLE_MS)).toBe(true);
  // The 30-day rule never reaches agent-created children.
  expect(isInactiveArchiveCandidate(nativeSubagent, 300 * DAY_MS, 30)).toBe(false);
  // Without a provider-native lineage a run-less thread still never ran.
  expect(
    isOverflowArchiveCandidate({ ...nativeSubagent, creationSource: "mcp" }, OVERFLOW_IDLE_MS),
  ).toBe(false);
});
it.each([
  ["running", { nativeSubagentStatus: "running" }],
  ["failed", { nativeSubagentStatus: "failed" }],
  ["stopped", { nativeSubagentStatus: "interrupted" }],
  ["unknown status", { nativeSubagentStatus: undefined }],
  ["no receipt", { nativeSubagentStatus: null }],
  ["incomplete timing", { nativeSubagentCompletedAt: null }],
  ["working turn", { activityRunStatus: "running" }],
  ["active run", { activeRunId: RunId.make("live") }],
  ["pinned", { pinnedAt: at }],
  ["owned elsewhere", { ownerMachineId: "other" }],
  ["waiting", { reportedWait: "Waiting for review" }],
  ["finished this hour", { nativeSubagentCompletedAt: DateTime.makeUnsafe(DAY_MS) }],
] as const)("the cap protects a provider-native subagent that is %s", (_name, patch) => {
  expect(
    isOverflowArchiveCandidate(
      { ...nativeSubagent, ...patch } as OrchestrationV2ThreadShell,
      DAY_MS + OVERFLOW_IDLE_MS - 1,
    ),
  ).toBe(false);
});

const overflowSweep = (
  preferences: Parameters<typeof Settings.layerTest>[0],
  shells: Map<string, Partial<OrchestrationV2ThreadShell>> = new Map(),
  guardRefuses: ReadonlySet<string> = new Set(),
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sent: Array<Extract<OrchestrationV2ServerCommand, { type: "thread.archive" }>> = [];
    const refusedSends: string[] = [];
    const reads: string[] = [];
    const archive = yield* Archive.InactiveThreadArchive.pipe(
      Effect.provide(
        Archive.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ProjectionStore.ProjectionStoreV2, {
                getThreadShell: (id: ThreadId) =>
                  Effect.gen(function* () {
                    reads.push(id);
                    const [row] = yield* sql<{ projectId: string }>`
                      SELECT project_id AS "projectId" FROM orchestration_v2_projection_threads
                      WHERE thread_id = ${id}`;
                    return {
                      ...worker,
                      id,
                      projectId: ProjectId.make(row!.projectId),
                      ...shells.get(id),
                    };
                  }).pipe(Effect.orDie),
              } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
              Layer.succeed(ThreadManagement.ThreadManagementService, {
                // Stands in for the guarded archive: the row leaves the live count.
                dispatch: (command: OrchestrationV2ServerCommand) =>
                  // Stands in for a refusal only the guard sees: a stuck record, a session, a draft.
                  command.type === "thread.archive" && guardRefuses.has(command.threadId)
                    ? Effect.sync(() => refusedSends.push(command.threadId)).pipe(
                        Effect.andThen(
                          Effect.fail(new InactiveArchiveError({ cause: "Protected" })),
                        ),
                      )
                    : Effect.gen(function* () {
                        if (command.type !== "thread.archive")
                          return { sequence: 1, storedEvents: [] };
                        sent.push(command);
                        yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = '1970-01-02'
                      WHERE thread_id = ${command.threadId}`;
                        return { sequence: 1, storedEvents: [] };
                      }).pipe(Effect.orDie),
              } as unknown as ThreadManagement.ThreadManagementService["Service"]),
              Projects.layer,
              Settings.layerTest(preferences),
            ),
          ),
        ),
      ),
    );
    return { sweep: archive.sweep, sent, refusedSends, reads };
  });
const insertThreads = (projectId: ProjectId, ids: ReadonlyArray<string>, offset = 0) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const [index, id] of ids.entries()) {
      const updatedAt = DateTime.formatIso(DateTime.makeUnsafe((offset + index) * 1000));
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json)
      VALUES (${id},${projectId},'Worker','codex','full-access','default',${updatedAt},${updatedAt},'{}')`;
    }
  });
const capped = ProjectId.make("capped-project");
const inheriting = ProjectId.make("inheriting-project");
const named = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(3, "0")}`);

effectIt.effect(
  "archives the oldest finished threads down to the cap, skipping the coordinator and protected",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DAY_MS);
      // The coordinator is the oldest row, and the oldest worker is pinned.
      yield* insertThreads(capped, [`project-coordinator:${capped}`, ...named("worker", 25)]);
      const { sweep, sent } = yield* overflowSweep(
        { keepActiveThreadsPerProject: 20 },
        new Map([["worker-000", { pinnedAt: at }]]),
      );
      yield* sweep;
      expect(sent.map((command) => command.threadId)).toEqual(named("worker", 7).slice(1));
      expect(
        sent.every(
          (command) =>
            command.inactive?.reason === "overflow" &&
            DateTime.toEpochMillis(command.inactive.expectedUpdatedAt) === 0,
        ),
      ).toBe(true);
      yield* TestClock.adjust(60_000);
      yield* sweep;
      expect(sent).toHaveLength(6);
    }).pipe(Effect.provide(fixtureProjectDatabase([capped]))),
);

effectIt.effect("drains a large backlog at most 50 threads per sweep", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DAY_MS);
    yield* insertThreads(capped, named("backlog", 100));
    const { sweep, sent } = yield* overflowSweep({ keepActiveThreadsPerProject: 20 });
    yield* sweep;
    expect(sent.map((command) => command.threadId)).toEqual(named("backlog", 50));
    yield* TestClock.adjust(60_000);
    yield* sweep;
    expect(sent).toHaveLength(80);
    yield* TestClock.adjust(60_000);
    yield* sweep;
    expect(sent).toHaveLength(80);
  }).pipe(Effect.provide(fixtureProjectDatabase([capped]))),
);

effectIt.effect("does nothing under No limit, and a project's own cap overrides it", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DAY_MS);
    yield* insertThreads(capped, named("capped", 23));
    yield* insertThreads(inheriting, named("inheriting", 40));
    const { sweep, sent } = yield* overflowSweep({
      keepActiveThreadsPerProject: null,
      projectSettingsOverrides: { [capped]: { keepActiveThreadsPerProject: 20 } },
    });
    yield* sweep;
    expect(sent.map((command) => command.threadId)).toEqual(named("capped", 3));
  }).pipe(Effect.provide(fixtureProjectDatabase([capped, inheriting]))),
);

effectIt.effect("a project override of No limit keeps every thread under a global cap", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DAY_MS);
    yield* insertThreads(capped, named("unlimited", 30));
    const { sweep, sent } = yield* overflowSweep({
      keepActiveThreadsPerProject: 20,
      projectSettingsOverrides: { [capped]: { keepActiveThreadsPerProject: null } },
    });
    yield* sweep;
    expect(sent).toHaveLength(0);
  }).pipe(Effect.provide(fixtureProjectDatabase([capped]))),
);

effectIt.effect("a project that cannot reach its cap neither starves others nor rescans", () => {
  const stuck = ProjectId.make("aaa-stuck");
  const drains = ProjectId.make("bbb-drains");
  return Effect.gen(function* () {
    yield* TestClock.setTime(DAY_MS);
    const pinned = named("stuck", 600);
    yield* insertThreads(stuck, pinned);
    yield* insertThreads(drains, named("drains", 100));
    const { sweep, sent, reads } = yield* overflowSweep(
      { keepActiveThreadsPerProject: 20 },
      new Map(pinned.map((id) => [id, { pinnedAt: at }])),
    );
    // Shell reads of the stuck project per sweep; the 30-day page adds at most 25 of its own.
    const stuckReads = () =>
      Effect.gen(function* () {
        const before = reads.filter((id) => id.startsWith("stuck")).length;
        yield* sweep;
        yield* TestClock.adjust(60_000);
        return reads.filter((id) => id.startsWith("stuck")).length - before;
      });
    const drained: number[] = [];
    for (let minute = 0; minute < 2; minute++) {
      yield* stuckReads();
      drained.push(sent.length);
    }
    // The other project drains at the full rate while the stuck one is scanned.
    expect(drained).toEqual([50, 80]);
    expect(sent.every((command) => command.threadId.startsWith("drains"))).toBe(true);
    expect(yield* stuckReads()).toBeGreaterThanOrEqual(250);
    expect(yield* stuckReads()).toBeGreaterThanOrEqual(100);
    // One full pass found nothing to archive, so the project waits an idle hour.
    expect(yield* stuckReads()).toBeLessThanOrEqual(25);
    expect(yield* stuckReads()).toBeLessThanOrEqual(25);
    yield* TestClock.adjust(OVERFLOW_IDLE_MS);
    expect(yield* stuckReads()).toBeGreaterThanOrEqual(250);
    expect(sent).toHaveLength(80);
  }).pipe(Effect.provide(fixtureProjectDatabase([stuck, drains])));
});

effectIt.effect("restarts from the oldest thread after a project falls back to its cap", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DAY_MS);
    const sql = yield* SqlClient.SqlClient;
    const threads = named("t", 100);
    yield* insertThreads(capped, threads);
    // The ten oldest were visited this hour.
    const { sweep, sent } = yield* overflowSweep(
      { keepActiveThreadsPerProject: 20 },
      new Map(
        threads.slice(0, 10).map((id) => [id, { lastVisitedAt: DateTime.makeUnsafe(DAY_MS) }]),
      ),
    );
    yield* sweep;
    expect(sent.map((command) => command.threadId)).toEqual(threads.slice(10, 60));
    // The owner archives the newest 30 by hand: the project is at its cap.
    yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = '1970-01-02'
      WHERE thread_id >= 't-070'`;
    yield* TestClock.adjust(60_000);
    yield* sweep;
    expect(sent).toHaveLength(50);
    // Two hours on, the oldest are idle and five new threads push the project over again.
    yield* TestClock.adjust(2 * OVERFLOW_IDLE_MS);
    yield* insertThreads(capped, named("new", 5), 200);
    yield* sweep;
    expect(sent.slice(50).map((command) => command.threadId)).toEqual(threads.slice(0, 5));
  }).pipe(Effect.provide(fixtureProjectDatabase([capped]))),
);

effectIt.effect("archives finished provider-native subagents that never had a run", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DAY_MS);
    const children = named("native", 25);
    const { id: _id, ...native } = nativeSubagent;
    yield* insertThreads(capped, children);
    const { sweep, sent } = yield* overflowSweep(
      { keepActiveThreadsPerProject: 20 },
      new Map<string, Partial<OrchestrationV2ThreadShell>>([
        ...children.map((id) => [id, native] as const),
        ["native-000", { ...native, nativeSubagentStatus: "running" }],
      ]),
    );
    yield* sweep;
    expect(sent.map((command) => command.threadId)).toEqual(children.slice(1, 6));
  }).pipe(Effect.provide(fixtureProjectDatabase([capped]))),
);

effectIt.effect(
  "a thread the guard refuses is resent at most once an idle hour while the project hovers at its cap",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DAY_MS);
      const refused = named("old", 10);
      yield* insertThreads(capped, refused);
      yield* insertThreads(capped, named("idle", 20), 10);
      const { sweep, sent, refusedSends } = yield* overflowSweep(
        { keepActiveThreadsPerProject: 20 },
        new Map(),
        new Set(refused),
      );
      // The coordinator keeps spawning: one new worker a minute keeps the project at its cap.
      const minute = (index: number) =>
        Effect.gen(function* () {
          yield* insertThreads(capped, [`new-${String(index).padStart(3, "0")}`], 100 + index);
          const before = refusedSends.length;
          yield* sweep;
          yield* TestClock.adjust(60_000);
          return refusedSends.length - before;
        });
      const perMinute: number[] = [];
      for (let index = 0; index < 10; index++) perMinute.push(yield* minute(index));
      expect(perMinute).toEqual([10, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      // Each minute still archives the oldest thread the guard accepts.
      expect(sent.map((command) => command.threadId)).toEqual(named("idle", 20));
      yield* TestClock.adjust(OVERFLOW_IDLE_MS);
      expect(yield* minute(10)).toBe(10);
      expect(yield* minute(11)).toBe(0);
      expect(refusedSends.filter((id) => id === "old-000")).toHaveLength(2);
    }).pipe(Effect.provide(fixtureProjectDatabase([capped]))),
);

effectIt.effect("leaves the coordinator's own native subagents to it without a dispatch", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DAY_MS);
    const children = named("coordinated", 5);
    yield* insertThreads(capped, [...children, ...named("worker", 20)]);
    const { id: _id, ...subagent } = nativeSubagent;
    const parentThreadId = ThreadId.make(`project-coordinator:${capped}`);
    const native = { ...subagent, lineage: { ...subagent.lineage, parentThreadId } };
    const { sweep, sent, reads } = yield* overflowSweep(
      { keepActiveThreadsPerProject: 20 },
      new Map(children.map((id) => [id, native] as const)),
    );
    yield* sweep;
    expect(sent.map((command) => command.threadId)).toEqual(named("worker", 5));
    yield* insertThreads(capped, ["late"], 100);
    yield* TestClock.adjust(60_000);
    const before = reads.filter((id) => id.startsWith("coordinated")).length;
    yield* sweep;
    expect(sent.at(-1)?.threadId).toBe("worker-005");
    // Held for an idle hour: the next pass does not read them again.
    expect(reads.filter((id) => id.startsWith("coordinated")).length - before).toBe(0);
  }).pipe(Effect.provide(fixtureProjectDatabase([capped]))),
);
