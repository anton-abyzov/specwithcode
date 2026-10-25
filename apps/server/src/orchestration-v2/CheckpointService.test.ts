// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointScopeId,
  EnvironmentId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  VcsProcessTimeoutError,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "./IdAllocator.ts";

it.effect.each([false, true, "interrupt"] as const)(
  "materializes baseline, lookup fails=%s",
  (lookupFails) => {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:materialize-baseline"),
      threadId: ThreadId.make("thread:materialize-baseline"),
      runId: RunId.make("run:materialize-baseline:3"),
      nodeId: NodeId.make("node:materialize-baseline:3"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:materialize-baseline"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const hasCheckpointRef = vi.fn((_input: CheckpointStore.RestoreCheckpointInput) =>
      lookupFails === "interrupt"
        ? Effect.interrupt
        : lookupFails
          ? Effect.fail(
              new VcsProcessTimeoutError({
                operation: "test.ref",
                command: "git",
                cwd: "/repo",
                timeoutMs: 30000,
              }),
            )
          : Effect.succeed(true),
    );
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
            hasCheckpointRef,
            captureCheckpoint: () => Effect.void,
          }),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
    );

    return Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      if (lookupFails === "interrupt") {
        const exit = yield* Effect.exit(
          checkpoints.materializeBaselineCheckpoint({ scope, ordinalWithinScope: 2 }),
        );
        assert.isTrue(Exit.hasInterrupts(exit));
        const captureExit = yield* Effect.exit(
          checkpoints.capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          }),
        );
        assert.isTrue(Exit.hasInterrupts(captureExit));
        return;
      }
      const baseline = yield* checkpoints.materializeBaselineCheckpoint({
        scope,
        ordinalWithinScope: 2,
      });

      assert.equal(baseline.ordinalWithinScope, 2);
      assert.equal(
        baseline.ref,
        yield* CheckpointService.checkpointRefForScopeOrdinal({
          scopeId: scope.id,
          ordinalWithinScope: 2,
        }),
      );
      assert.equal(baseline.status, lookupFails ? "missing" : "ready");
      assert.deepEqual(hasCheckpointRef.mock.calls[0]?.[0], {
        cwd: scope.cwd,
        checkpointRef: baseline.ref,
      });
    }).pipe(Effect.provide(layerTest));
  },
);

const layerVcsProcessTest = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const layerGitCheckpoints = CheckpointService.layer.pipe(
  Layer.provide(IdAllocator.layer),
  Layer.provide(CheckpointStore.layer),
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcessTest))),
  Layer.provideMerge(layerVcsProcessTest),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "studio-checkpoint-stamp-" }),
  ),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(NodeServices.layer),
);
const capturingMachine = EnvironmentId.make("environment:checkpoint-stamp");
// The server provides its identity around the runtime, not to this layer.
const layerGitCheckpointsOnMachine = layerGitCheckpoints.pipe(
  Layer.provide(
    Layer.succeed(
      ServerEnvironment.ServerEnvironmentIdentity,
      ServerEnvironment.ServerEnvironmentIdentity.of({
        getEnvironmentId: Effect.succeed(capturingMachine),
      }),
    ),
  ),
);

const stampScope = (cwd: string): OrchestrationV2CheckpointScope => ({
  id: CheckpointScopeId.make(`checkpoint-scope:stamp:${cwd}`),
  threadId: ThreadId.make("thread:checkpoint-stamp"),
  runId: RunId.make("run:checkpoint-stamp:1"),
  nodeId: NodeId.make("node:checkpoint-stamp:1"),
  parentScopeId: null,
  providerThreadId: null,
  kind: "root_run",
  ordinalWithinParent: 0,
  advancesAppRunCount: true,
  cwd,
  createdAt: DateTime.makeUnsafe("2026-10-24T00:00:00.000Z"),
});

const captureTurn = <E = never, R = never>(
  scope: OrchestrationV2CheckpointScope,
  turn: Effect.Effect<void, E, R> = Effect.void,
) =>
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 });
    yield* turn;
    return yield* checkpoints.capture({
      scope,
      runId: scope.runId,
      nodeId: scope.nodeId,
      ordinalWithinScope: 1,
      appRunOrdinal: 1,
      capturedAt: scope.createdAt,
    });
  });

const makeRepository = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  // Temporary folders sit under a symlink on macOS; the stamp keeps this spelling.
  const repo = yield* fileSystem.makeTempDirectoryScoped({ prefix: "studio-checkpoint-stamp-" });
  const git = (args: ReadonlyArray<string>) =>
    vcsProcess
      .run({ operation: "CheckpointService.test.git", command: "git", cwd: repo, args })
      .pipe(Effect.map((result) => result.stdout.trim()));
  yield* git(["init"]);
  yield* git(["config", "user.email", "test@test.com"]);
  yield* git(["config", "user.name", "Test"]);
  yield* fileSystem.makeDirectory(NodePath.join(repo, "packages", "app"), { recursive: true });
  yield* fileSystem.writeFileString(NodePath.join(repo, "packages", "app", "a.txt"), "one\n");
  yield* git(["add", "."]);
  yield* git(["commit", "-m", "initial"]);
  return { repo, git, fileSystem };
});

it.effect("stamps the folder, repository, branch, HEAD and machine of a capture", () =>
  Effect.gen(function* () {
    const { repo, git, fileSystem } = yield* makeRepository;
    const cwd = NodePath.join(repo, "packages", "app");
    const checkpoint = yield* captureTurn(
      stampScope(cwd),
      fileSystem.writeFileString(NodePath.join(cwd, "a.txt"), "two\n"),
    );

    assert.equal(checkpoint.status, "ready");
    assert.deepEqual(
      checkpoint.files.map((file) => file.path),
      ["packages/app/a.txt"],
    );
    assert.deepEqual(
      {
        cwd: checkpoint.cwd,
        repoRoot: checkpoint.repoRoot,
        branch: checkpoint.branch,
        headOid: checkpoint.headOid,
        capturedOnEnvironmentId: checkpoint.capturedOnEnvironmentId,
        notGitRepository: checkpoint.notGitRepository,
      },
      {
        cwd,
        repoRoot: repo,
        branch: yield* git(["symbolic-ref", "--short", "HEAD"]),
        headOid: yield* git(["rev-parse", "HEAD"]),
        capturedOnEnvironmentId: capturingMachine,
        notGitRepository: undefined,
      },
    );
  }).pipe(Effect.scoped, Effect.provide(layerGitCheckpointsOnMachine)),
);

it.effect("stamps a detached HEAD as no branch, and a plain folder as not a Git repository", () =>
  Effect.gen(function* () {
    const { repo, git, fileSystem } = yield* makeRepository;
    yield* git(["checkout", "--detach"]);
    const detached = yield* captureTurn(stampScope(repo));
    assert.equal(detached.status, "ready");
    assert.isNull(detached.branch);
    assert.equal(detached.headOid, yield* git(["rev-parse", "HEAD"]));
    // Built without a server identity, the machine stays unknown.
    assert.isFalse("capturedOnEnvironmentId" in detached);

    const folder = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "studio-checkpoint-plain-",
    });
    const plain = yield* captureTurn(stampScope(folder));
    assert.equal(plain.status, "missing");
    assert.isTrue(plain.notGitRepository);
    assert.equal(plain.cwd, folder);
    assert.isFalse("repoRoot" in plain || "branch" in plain || "headOid" in plain);
  }).pipe(Effect.scoped, Effect.provide(layerGitCheckpoints)),
);
