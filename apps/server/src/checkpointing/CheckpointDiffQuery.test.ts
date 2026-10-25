// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
} from "@specweave-studio/contracts";
import { splitPatchByFile } from "@specweave-studio/shared/structuredPatch";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as CheckpointService from "../orchestration-v2/CheckpointService.ts";
import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import type { ProjectionCheckpointContext } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CheckpointDiffQuery from "./CheckpointDiffQuery.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import {
  CheckpointRefUnavailableError,
  CheckpointThreadNotFoundError,
  CheckpointTurnRangeUnavailableError,
} from "./Errors.ts";

const threadId = ThreadId.make("thread:checkpoint-diff-v2");
const firstRunId = RunId.make("run:checkpoint-diff-v2:1");
const secondRunId = RunId.make("run:checkpoint-diff-v2:2");
const firstScopeId = CheckpointScopeId.make("scope:checkpoint-diff-v2:1");
const secondScopeId = CheckpointScopeId.make("scope:checkpoint-diff-v2:2");
const secondRef = CheckpointRef.make("refs/studio/test/second");

function makeProjection(): ProjectionCheckpointContext {
  return {
    runs: [
      { id: firstRunId, ordinal: 1, status: "completed" },
      { id: secondRunId, ordinal: 2, status: "completed" },
    ],
    checkpointScopes: [
      { id: firstScopeId, runId: firstRunId, kind: "root_run", cwd: "/repo" },
      { id: secondScopeId, runId: secondRunId, kind: "root_run", cwd: "/repo" },
    ],
    checkpoints: [
      {
        scopeId: secondScopeId,
        runId: secondRunId,
        appRunOrdinal: 2,
        status: "ready",
        ref: secondRef,
      },
    ],
  };
}

function layerFor(input: {
  readonly projection: Effect.Effect<ProjectionCheckpointContext, OrchestratorProjectionError>;
  readonly diffCheckpoints?: CheckpointStore.CheckpointStore["Service"]["diffCheckpoints"];
  readonly store?: Partial<CheckpointStore.CheckpointStore["Service"]>;
}) {
  return CheckpointDiffQuery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getCheckpointContext: () => input.projection,
        }),
        Layer.mock(CheckpointStore.CheckpointStore)({
          diffCheckpoints: input.diffCheckpoints ?? (() => Effect.succeed("diff")),
          ...input.store,
        }),
      ),
    ),
    Layer.provideMerge(NodeCrypto.layer),
  );
}

/** A projected checkpoint with the provenance and files a capture stamps. */
type StampedCheckpoint = ProjectionCheckpointContext["checkpoints"][number] & {
  readonly ordinalWithinScope?: number | undefined;
  readonly cwd?: string | undefined;
  readonly files?: ReadonlyArray<{ readonly path: string }> | undefined;
};

function contextOf(input: {
  readonly runs: ProjectionCheckpointContext["runs"];
  readonly checkpointScopes: ProjectionCheckpointContext["checkpointScopes"];
  readonly checkpoints: ReadonlyArray<StampedCheckpoint>;
}): ProjectionCheckpointContext {
  return input;
}

const fileBlock = (path: string) =>
  `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;

it.effect("computes V2 run diffs from projected checkpoint scopes", () => {
  const diffCheckpoints = vi.fn((_input: CheckpointStore.DiffCheckpointsInput) =>
    Effect.succeed("diff --git a/file b/file"),
  );
  const layer = layerFor({ projection: Effect.succeed(makeProjection()), diffCheckpoints });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });

    assert.deepEqual(result, {
      threadId,
      fromTurnCount: 0,
      toTurnCount: 2,
      diff: "diff --git a/file b/file",
    });
    assert.deepEqual(diffCheckpoints.mock.calls[0]?.[0], {
      cwd: "/repo",
      fromCheckpointRef: yield* checkpointRefForScopeOrdinal({
        scopeId: firstScopeId,
        ordinalWithinScope: 0,
      }),
      toCheckpointRef: secondRef,
      fallbackFromToHead: false,
      ignoreWhitespace: true,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("preserves the typed missing-thread error contract", () => {
  const layer = layerFor({
    projection: Effect.fail(new OrchestratorProjectionError({ threadId })),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 1 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointThreadNotFoundError);
    assert.deepEqual(
      { operation: error.operation, threadId: error.threadId },
      { operation: "CheckpointDiffQuery.getTurnDiff", threadId },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("preserves the typed unavailable-range error contract", () => {
  const layer = layerFor({ projection: Effect.succeed(makeProjection()) });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 3 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointTurnRangeUnavailableError);
    assert.deepEqual(
      {
        requestedTurnCount: error.requestedTurnCount,
        availableTurnCount: error.availableTurnCount,
      },
      { requestedTurnCount: 3, availableTurnCount: 2 },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("excludes ready checkpoints from rolled-back runs", () => {
  const projection = makeProjection();
  const layer = layerFor({
    projection: Effect.succeed({
      ...projection,
      runs: projection.runs.map((run) =>
        run.id === secondRunId ? { ...run, status: "rolled_back" as const } : run,
      ),
      checkpoints: [
        {
          ...projection.checkpoints[0]!,
          scopeId: firstScopeId,
          runId: firstRunId,
          appRunOrdinal: 1,
          ref: CheckpointRef.make("refs/studio/test/first"),
        },
        ...projection.checkpoints,
      ],
    }),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 2 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointTurnRangeUnavailableError);
    assert.deepEqual(
      {
        requestedTurnCount: error.requestedTurnCount,
        availableTurnCount: error.availableTurnCount,
      },
      { requestedTurnCount: 2, availableTurnCount: 1 },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("preserves the typed missing-baseline-ref error contract", () => {
  const projection = makeProjection();
  const layer = layerFor({
    projection: Effect.succeed({
      ...projection,
      checkpointScopes: projection.checkpointScopes.map((scope) => ({
        ...scope,
        kind: "tool" as const,
      })),
    }),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 2 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointRefUnavailableError);
    assert.deepEqual(
      { checkpoint: error.checkpoint, turnCount: error.turnCount },
      { checkpoint: "from", turnCount: 0 },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("diffs interrupted and cancelled turns, each in the folder it was captured in", () => {
  const calls: Array<CheckpointStore.DiffCheckpointsInput> = [];
  const refs = [1, 2, 3].map((turn) => CheckpointRef.make(`refs/studio/test/stamped-${turn}`));
  const runIds = [1, 2, 3].map((turn) => RunId.make(`run:checkpoint-diff-v2:stamped-${turn}`));
  const stamped = (turn: number): StampedCheckpoint => ({
    scopeId: firstScopeId,
    runId: runIds[turn - 1]!,
    appRunOrdinal: turn,
    ordinalWithinScope: turn,
    status: "ready",
    ref: refs[turn - 1]!,
  });
  const layer = layerFor({
    projection: Effect.succeed(
      contextOf({
        runs: [
          { id: runIds[0]!, ordinal: 1, status: "interrupted" },
          { id: runIds[1]!, ordinal: 2, status: "cancelled" },
          { id: runIds[2]!, ordinal: 3, status: "completed" },
        ],
        // The scope's cwd follows the latest run.
        checkpointScopes: [
          { id: firstScopeId, runId: runIds[2]!, kind: "root_run", cwd: "/current" },
        ],
        checkpoints: [
          { ...stamped(1), cwd: "/worktree-a" },
          { ...stamped(2), cwd: "/worktree-b" },
          // Captured before checkpoints were stamped.
          stamped(3),
        ],
      }),
    ),
    diffCheckpoints: (input) => {
      calls.push(input);
      return Effect.succeed("");
    },
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    for (const toTurnCount of [1, 2, 3]) {
      yield* query.getTurnDiff({ threadId, fromTurnCount: toTurnCount - 1, toTurnCount });
    }

    assert.deepEqual(
      calls.map((call) => [call.cwd, call.fromCheckpointRef, call.toCheckpointRef]),
      [
        [
          "/worktree-a",
          yield* checkpointRefForScopeOrdinal({ scopeId: firstScopeId, ordinalWithinScope: 0 }),
          refs[0],
        ],
        ["/worktree-b", refs[0], refs[1]],
        ["/current", refs[1], refs[2]],
      ],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("keeps only the card's files in a turn patch and flags a cut patch", () => {
  const ref = CheckpointRef.make("refs/studio/test/filtered");
  const patch = [
    fileBlock("src/edited.ts"),
    // Brought in by a checkout during the turn; the card left it out.
    fileBlock("vendor/moved.ts"),
    "diff --git a/old name.ts b/new name.ts\nsimilarity index 90%\nrename from old name.ts\nrename to new name.ts\n",
    "diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n",
  ].join("");
  const truncatedRef = Ref.makeUnsafe(false);
  const layer = layerFor({
    projection: Effect.succeed(
      contextOf({
        runs: [{ id: secondRunId, ordinal: 2, status: "completed" }],
        checkpointScopes: [
          { id: secondScopeId, runId: secondRunId, kind: "root_run", cwd: "/repo" },
        ],
        checkpoints: [
          {
            scopeId: secondScopeId,
            runId: secondRunId,
            appRunOrdinal: 1,
            status: "ready",
            ref: CheckpointRef.make("refs/studio/test/filtered-base"),
          },
          {
            scopeId: secondScopeId,
            runId: secondRunId,
            appRunOrdinal: 2,
            ordinalWithinScope: 2,
            status: "ready",
            ref,
            files: [{ path: "src/edited.ts" }, { path: "new name.ts" }, { path: "gone.ts" }],
          },
        ],
      }),
    ),
    store: {
      diffCheckpointsReport: () =>
        Ref.get(truncatedRef).pipe(Effect.map((truncated) => ({ diff: patch, truncated }))),
    },
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const turn = yield* query.getTurnDiff({ threadId, fromTurnCount: 1, toTurnCount: 2 });
    assert.deepEqual(
      splitPatchByFile(turn.diff).map((block) => block.newPath ?? block.oldPath),
      ["src/edited.ts", "new name.ts", "gone.ts"],
    );
    assert.isFalse("truncated" in turn);
    // Several turns span several card lists, so the range keeps the whole patch.
    const range = yield* query.getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 2 });
    assert.equal(range.diff, patch);

    yield* Ref.set(truncatedRef, true);
    const cut = yield* query.getTurnDiff({ threadId, fromTurnCount: 1, toTurnCount: 2 });
    assert.isTrue(cut.truncated);
  }).pipe(Effect.provide(layer));
});

it.effect("bases the turn after a failed run on the scope snapshot its card used", () => {
  const runIds = [1, 2, 3].map((turn) => RunId.make(`run:checkpoint-diff-v2:failed-${turn}`));
  const thirdRef = CheckpointRef.make("refs/studio/test/after-failed");
  const lookups: Array<{ readonly cwd: string; readonly checkpointRef: CheckpointRef }> = [];
  const calls: Array<CheckpointStore.DiffCheckpointsInput> = [];
  const refExists = Ref.makeUnsafe(true);
  const layer = layerFor({
    projection: Effect.succeed(
      contextOf({
        runs: [
          { id: runIds[0]!, ordinal: 1, status: "completed" },
          { id: runIds[1]!, ordinal: 2, status: "failed" },
          { id: runIds[2]!, ordinal: 3, status: "completed" },
        ],
        checkpointScopes: [{ id: firstScopeId, runId: runIds[2]!, kind: "root_run", cwd: "/repo" }],
        checkpoints: [
          {
            scopeId: firstScopeId,
            runId: runIds[0]!,
            appRunOrdinal: 1,
            status: "ready",
            ref: CheckpointRef.make("refs/studio/test/before-failed"),
          },
          // The failed run took no snapshot; the next run's baseline is not a run checkpoint.
          {
            scopeId: firstScopeId,
            runId: null,
            appRunOrdinal: null,
            status: "ready",
            ref: CheckpointRef.make("refs/studio/test/baseline-2"),
          },
          {
            scopeId: firstScopeId,
            runId: runIds[2]!,
            appRunOrdinal: 3,
            ordinalWithinScope: 3,
            status: "ready",
            ref: thirdRef,
            cwd: "/repo/worktree",
          },
        ],
      }),
    ),
    diffCheckpoints: (input) => {
      calls.push(input);
      return Effect.succeed("");
    },
    store: {
      hasCheckpointRef: (input) => {
        lookups.push(input);
        return Ref.get(refExists);
      },
    },
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const scopeSnapshot = yield* checkpointRefForScopeOrdinal({
      scopeId: firstScopeId,
      ordinalWithinScope: 2,
    });

    yield* query.getTurnDiff({ threadId, fromTurnCount: 2, toTurnCount: 3 });
    assert.deepEqual(lookups, [{ cwd: "/repo/worktree", checkpointRef: scopeSnapshot }]);
    assert.deepEqual(
      calls.map((call) => [call.cwd, call.fromCheckpointRef, call.toCheckpointRef]),
      [["/repo/worktree", scopeSnapshot, thirdRef]],
    );

    yield* Ref.set(refExists, false);
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 2, toTurnCount: 3 })
      .pipe(Effect.flip);
    assert.instanceOf(error, CheckpointRefUnavailableError);
    assert.deepEqual(
      { checkpoint: error.checkpoint, turnCount: error.turnCount },
      { checkpoint: "from", turnCount: 2 },
    );
  }).pipe(Effect.provide(layer));
});

const layerVcsProcessTest = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const layerGitCheckpoints = CheckpointService.layer.pipe(
  Layer.provide(IdAllocator.layer),
  Layer.provideMerge(CheckpointStore.layer),
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcessTest))),
  Layer.provideMerge(layerVcsProcessTest),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "studio-checkpoint-diff-test-" }),
  ),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(NodeServices.layer),
);

// AC-08 end to end: a failed turn, then a turn that edits one file while a
// fast-forward brings in another. The card and the panel list the same file.
it.effect("lists the card's files in the patch of the turn after a failed run", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const vcsProcess = yield* VcsProcess.VcsProcess;
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    const store = yield* CheckpointStore.CheckpointStore;
    const repo = yield* fileSystem.makeTempDirectoryScoped({ prefix: "studio-turn-diff-repo-" });
    const elsewhere = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "studio-turn-diff-elsewhere-",
    });
    const git = (cwd: string, args: ReadonlyArray<string>) =>
      vcsProcess.run({ operation: "CheckpointDiffQuery.test.git", command: "git", cwd, args });
    const write = (relativePath: string, contents: string) =>
      fileSystem.writeFileString(NodePath.join(repo, relativePath), contents);
    yield* git(repo, ["init"]);
    yield* git(repo, ["config", "user.email", "test@test.com"]);
    yield* git(repo, ["config", "user.name", "Test"]);
    yield* write("README.md", "# test\n");
    yield* git(repo, ["add", "."]);
    yield* git(repo, ["commit", "-m", "initial"]);
    // A commit another checkout of the repository made.
    const otherCheckout = NodePath.join(elsewhere, "other");
    yield* git(repo, ["worktree", "add", "-b", "other", otherCheckout]);
    yield* fileSystem.writeFileString(NodePath.join(otherCheckout, "moved.txt"), "upstream\n");
    yield* git(otherCheckout, ["add", "moved.txt"]);
    yield* git(otherCheckout, ["commit", "-m", "upstream"]);

    const runIds = [1, 2, 3].map((turn) => RunId.make(`run:checkpoint-diff-v2:git-${turn}`));
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("scope:checkpoint-diff-v2:git"),
      threadId,
      runId: runIds[2]!,
      nodeId: NodeId.make("node:checkpoint-diff-v2:git"),
      parentScopeId: null,
      providerThreadId: null,
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: repo,
      createdAt: DateTime.makeUnsafe("2026-10-24T00:00:00.000Z"),
    };
    const capture = (turn: number) =>
      checkpoints.capture({
        scope,
        runId: runIds[turn - 1]!,
        nodeId: scope.nodeId,
        ordinalWithinScope: turn,
        appRunOrdinal: turn,
        capturedAt: scope.createdAt,
      });

    yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 });
    yield* write("first.txt", "first turn\n");
    const first = yield* capture(1);
    // The second run fails before any snapshot; its edit lands in the third run's baseline.
    yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 1 });
    yield* write("failed.txt", "failed turn\n");
    yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 2 });
    const baseline = yield* checkpoints.materializeBaselineCheckpoint({
      scope,
      ordinalWithinScope: 2,
    });
    yield* git(repo, ["merge", "--ff-only", "other"]);
    yield* write("third.txt", "third turn\n");
    const third = yield* capture(3);

    assert.deepEqual(
      third.files.map((file) => file.path),
      ["third.txt"],
    );
    const unfiltered = yield* store.diffCheckpoints({
      cwd: repo,
      fromCheckpointRef: baseline.ref,
      toCheckpointRef: third.ref,
      ignoreWhitespace: false,
    });
    assert.include(unfiltered, "moved.txt");

    const context = contextOf({
      runs: [
        { id: runIds[0]!, ordinal: 1, status: "completed" },
        { id: runIds[1]!, ordinal: 2, status: "failed" },
        { id: runIds[2]!, ordinal: 3, status: "completed" },
      ],
      checkpointScopes: [{ id: scope.id, runId: scope.runId, kind: scope.kind, cwd: scope.cwd }],
      checkpoints: [first, baseline, third],
    });
    const turnPaths = (fromTurnCount: number, toTurnCount: number) =>
      CheckpointDiffQuery.CheckpointDiffQuery.pipe(
        Effect.flatMap((query) =>
          query.getTurnDiff({ threadId, fromTurnCount, toTurnCount, ignoreWhitespace: false }),
        ),
        Effect.map((turn) =>
          splitPatchByFile(turn.diff).map((block) => block.newPath ?? block.oldPath),
        ),
        Effect.provide(
          CheckpointDiffQuery.layer.pipe(
            Layer.provide(
              Layer.mock(ThreadManagement.ThreadManagementService)({
                getCheckpointContext: () => Effect.succeed(context),
              }),
            ),
          ),
        ),
      );

    assert.deepEqual(
      yield* turnPaths(2, 3),
      third.files.map((file) => file.path),
    );
    assert.deepEqual(
      yield* turnPaths(0, 1),
      first.files.map((file) => file.path),
    );
  }).pipe(Effect.scoped, Effect.provide(layerGitCheckpoints)),
);
