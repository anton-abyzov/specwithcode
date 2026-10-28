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
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as Archive from "./InactiveThreadArchive.ts";
import { DAY_MS, isInactiveArchiveCandidate } from "./InactiveThreadArchiveGuard.ts";

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
