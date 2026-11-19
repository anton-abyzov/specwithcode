/**
 * The live away intents service (`AwayIntents.layer`) over its own file and
 * this machine's reads (1390 AC-36, T-23). A read that fails is never an
 * answer: an intent left acting is not settled while its bindings, the
 * standby records or its threads do not read, and an intents file that does
 * not decode is an error, never "no intents".
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  type AwayIntentRecord,
  EnvironmentId,
  type Project,
  ProjectId,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { EffectiveWorkGrant } from "../fleet/workGrantPolicy.ts";
import { RemoteWorkerAdoption } from "../fleet/RemoteWorkerAdoption.ts";
import { HandoffReceiver, type ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import type { ContinuationEvidence } from "../handoff/handoffState.ts";
import {
  CoordinatorStandbyStore,
  CoordinatorStandbyStoreError,
} from "../project/CoordinatorStandbyStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as AwayIntents from "./AwayIntents.ts";
import { cancelIntent, recordIntent } from "./awayIntentRoute.ts";

const STATE_DIR = "/state";
const FILE = `${STATE_DIR}/away-intents.json`;

const SOURCE = EnvironmentId.make("machine-a");

const caller: ReceiverCaller = {
  sourceEnvironmentId: SOURCE,
  grant: {
    coordinatorEnvironmentId: SOURCE,
    projects: { kind: "linked" },
    hopLimit: 1,
    revoked: false,
  } as unknown as EffectiveWorkGrant,
};

/** An intent the previous release marked acting before its process stopped. */
const acting = (overrides: Partial<AwayIntentRecord> = {}): AwayIntentRecord => ({
  intentId: "intent-1",
  sourceEnvironmentId: SOURCE,
  graceMinutes: 2,
  projectIds: [ProjectId.make("project-a")],
  threadIds: [],
  receivedAt: "2026-11-09T22:00:00.000Z",
  dueAt: "2026-11-09T22:02:00.000Z",
  state: "acting",
  actedAt: "2026-11-09T22:02:00.000Z",
  ...overrides,
});

/** The target's copy, taken over from the source's: it coordinates with it as predecessor. */
const TAKEN_COPY = {
  id: "project-b",
  deletedAt: null,
  workspaceSettings: {
    logicalProject: {
      id: "logical-project",
      members: [
        { environmentId: "machine-a", projectId: "project-a" },
        {
          environmentId: "machine-b",
          projectId: "project-b",
          coordinatorThreadId: "project-coordinator:project-b",
        },
      ],
    },
    coordinatorBinding: {
      state: "active",
      epoch: 2,
      operationId: "away:intent-1:2",
      predecessor: { environmentId: "machine-a", projectId: "project-a" },
    },
  },
} as unknown as Project;

interface Reads {
  /** Reads of the project list that fail before one succeeds. */
  projectFailures: number;
  /** Reads of the standby records that fail before one succeeds. */
  standbyFailures: number;
  /** What handoff mode answers for each of the source's threads. */
  readonly threads: Map<string, ContinuationEvidence>;
}

/** The target's intents service on `contents`, the intents file a previous release left. */
const live = (contents: string | null, projects: ReadonlyArray<Project> = [TAKEN_COPY]) =>
  Effect.gen(function* () {
    const files = new Map<string, string>();
    if (contents !== null) files.set(FILE, contents);
    const reads: Reads = { projectFailures: 0, standbyFailures: 0, threads: new Map() };
    const adopted: string[] = [];
    const layer = AwayIntents.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          FileSystem.layerNoop({
            exists: (path) => Effect.sync(() => files.has(path)),
            readFileString: (path) => Effect.sync(() => files.get(path) ?? ""),
            writeFileString: (path, data) => Effect.sync(() => void files.set(path, data)),
            rename: (from, to) =>
              Effect.sync(() => {
                files.set(to, files.get(from) ?? "");
                files.delete(from);
              }),
            makeDirectory: () => Effect.void,
          }),
          Path.layer,
          NodeCrypto.layer,
          Layer.succeed(ServerConfig.ServerConfig, {
            stateDir: STATE_DIR,
          } as unknown as ServerConfig.ServerConfig["Service"]),
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make("machine-b")),
          } as unknown as ServerEnvironment.ServerEnvironment["Service"]),
          Layer.succeed(ProjectService.ProjectService, {
            snapshot: Effect.suspend(
              (): Effect.Effect<
                { readonly projects: ReadonlyArray<Project> },
                ProjectService.ProjectOperationError
              > => {
                if (reads.projectFailures === 0) return Effect.succeed({ projects });
                reads.projectFailures -= 1;
                return Effect.fail(
                  new ProjectService.ProjectOperationError({
                    operation: "list-projects",
                    cause: new Error("The project store is busy."),
                  }),
                );
              },
            ),
          } as unknown as ProjectService.ProjectService["Service"]),
          Layer.succeed(CoordinatorStandbyStore, {
            get: () =>
              Effect.suspend((): Effect.Effect<undefined, CoordinatorStandbyStoreError> => {
                if (reads.standbyFailures === 0) return Effect.succeed(undefined);
                reads.standbyFailures -= 1;
                return Effect.fail(
                  new CoordinatorStandbyStoreError({
                    operation: "read",
                    cause: new Error("The standby file is busy."),
                  }),
                );
              }),
          } as unknown as CoordinatorStandbyStore["Service"]),
          Layer.succeed(RemoteWorkerAdoption, {
            adopt: (input: { readonly projectId: string }) =>
              Effect.sync(() => {
                adopted.push(input.projectId);
                return { adopted: [], readOnly: [], waitingForPredecessor: 0 };
              }),
          } as unknown as RemoteWorkerAdoption["Service"]),
          Layer.succeed(HandoffReceiver, {
            continuation: (_source: EnvironmentId, sourceThreadId: string) =>
              Effect.sync(
                (): ContinuationEvidence => reads.threads.get(sourceThreadId) ?? { kind: "none" },
              ),
          } as unknown as HandoffReceiver["Service"]),
        ),
      ),
    );
    const intents = yield* Effect.flatMap(AwayIntents.AwayIntents, Effect.succeed).pipe(
      Effect.provide(layer),
    );
    const saved = () => {
      const text = files.get(FILE);
      return text === undefined
        ? undefined
        : (JSON.parse(text) as { intents: ReadonlyArray<AwayIntentRecord> }).intents;
    };
    return { intents, reads, adopted, saved, file: () => files.get(FILE) };
  });

const fileOf = (...intents: ReadonlyArray<AwayIntentRecord>) =>
  JSON.stringify({ version: 1, intents });

describe("an acting intent is settled only from state that reads", () => {
  it.effect("bindings that do not read leave it acting; the next tick settles it done", () =>
    Effect.gen(function* () {
      const f = yield* live(fileOf(acting()));
      f.reads.projectFailures = 1;
      // Unread bindings are no evidence that nothing moved: nothing is written.
      expect(yield* f.intents.tick).toEqual([]);
      expect(f.saved()?.map((intent) => intent.state)).toEqual(["acting"]);
      expect(f.adopted).toEqual([]);
      // The source asking now still holds: the intent is acting, not cancelled.
      const asked = yield* cancelIntent(f.intents, caller, { sourceEnvironmentId: SOURCE });
      expect(asked.body).toEqual({ cancelled: 0, state: "acting", takenOver: [] });

      const settled = yield* f.intents.tick;
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({
        state: "done",
        results: [{ projectId: "project-a", outcome: "handed-over", detail: "", epoch: 2 }],
      });
      expect(f.saved()?.map((intent) => intent.state)).toEqual(["done"]);
      expect(f.adopted).toEqual(["project-b"]);
    }),
  );

  it.effect("standby records that do not read leave it acting too", () =>
    Effect.gen(function* () {
      const f = yield* live(fileOf(acting()));
      f.reads.standbyFailures = 1;
      expect(yield* f.intents.tick).toEqual([]);
      expect(f.saved()?.map((intent) => intent.state)).toEqual(["acting"]);
      // Its workers are adopted only with the standby record read, on the next tick.
      expect(f.adopted).toEqual([]);
      expect((yield* f.intents.tick)[0]).toMatchObject({ state: "done" });
      expect(f.adopted).toEqual(["project-b"]);
    }),
  );

  it.effect("a thread whose launch here is in doubt leaves it acting, whatever it took", () =>
    Effect.gen(function* () {
      // It took no project; its thread launched, but the record of it was cut off.
      const f = yield* live(fileOf(acting({ projectIds: [], threadIds: ["thread-reel"] })), []);
      f.reads.threads.set("thread-reel", { kind: "unresolved" });
      expect(yield* f.intents.tick).toEqual([]);
      expect(f.saved()?.map((intent) => intent.state)).toEqual(["acting"]);
      // Handoff mode recovers the continuation: the thread moved, so the intent is done.
      f.reads.threads.set("thread-reel", { kind: "continued", threadId: "thread-reel-ms" });
      expect((yield* f.intents.tick)[0]).toMatchObject({ state: "done", results: [] });
    }),
  );
});

describe("an intents file that does not decode is an error, never no intents", () => {
  it.effect("the source's state, a new intent and the drain all wait for a readable file", () =>
    Effect.gen(function* () {
      const f = yield* live('{"version":1,"intents":[{"intentId":');
      const state = yield* f.intents.latestState(SOURCE).pipe(Effect.result);
      // Null would read as "no intent here", and a source would run its work again.
      expect(state._tag).toBe("Failure");
      const cancel = yield* cancelIntent(f.intents, caller, { sourceEnvironmentId: SOURCE });
      expect(cancel.status).toBe(500);
      const record = yield* recordIntent(
        caller,
        { sourceEnvironmentId: SOURCE, graceMinutes: 2, projectIds: [], threadIds: [] },
        f.intents,
        {
          projects: Effect.succeed(Option.some([])),
          continuation: () => Effect.succeed({ kind: "none" }),
        },
      );
      // Not a refusal: a sender on an earlier release keeps its hold on a 5xx without `error`.
      expect(record.status).toBe(503);
      expect(record.body).not.toHaveProperty("error");
      expect(yield* f.intents.tick).toEqual([]);
      expect(f.file()).toBe('{"version":1,"intents":[{"intentId":');
    }),
  );

  it.effect("a missing file is still no intents", () =>
    Effect.gen(function* () {
      const f = yield* live(null);
      expect(yield* f.intents.latestState(SOURCE)).toBeNull();
      expect(yield* f.intents.tick).toEqual([]);
    }),
  );
});

describe("compaction keeps what a source still asks about", () => {
  it.effect("another machine's intents never push out a source's receipt that its work moved", () =>
    Effect.gen(function* () {
      // As the previous release left it: its 50 settled intents, the oldest the source's acted one.
      const other = EnvironmentId.make("machine-c");
      const receipt = acting({
        state: "done",
        results: [
          { projectId: ProjectId.make("project-a"), outcome: "handed-over", detail: "", epoch: 2 },
        ],
      });
      const others = Array.from({ length: 50 }, (_, index) =>
        acting({
          intentId: `other-${index}`,
          sourceEnvironmentId: other,
          projectIds: [],
          state: index < 49 ? "cancelled" : "waiting",
          ...(index < 49
            ? { cancelledAt: "2026-11-09T22:05:00.000Z", cancelReason: "replaced" }
            : {}),
        }),
      );
      const f = yield* live(fileOf(receipt, ...others));
      expect(yield* f.intents.latestState(SOURCE)).toBe("done");
      // The drain settles the other machine's waiting intent: 51 settled, one over the limit.
      expect((yield* f.intents.tick).map((intent) => intent.intentId)).toEqual(["other-49"]);
      const kept = f.saved() ?? [];
      const mine = kept.filter((intent) => intent.sourceEnvironmentId === SOURCE);
      expect(mine).toMatchObject([{ intentId: "intent-1", state: "done" }]);
      expect(kept).toHaveLength(50);
      expect(kept.some((intent) => intent.intentId === "other-0")).toBe(false);
      // Cancel and status still answer from it: the source gives way.
      expect(yield* f.intents.latestState(SOURCE)).toBe("done");
      const told = yield* cancelIntent(f.intents, caller, { sourceEnvironmentId: SOURCE });
      expect(told.body).toEqual({ cancelled: 0, state: "done", takenOver: ["project-a"] });
    }),
  );
});
