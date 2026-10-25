/**
 * CheckpointStore - Repository interface for filesystem-backed workspace checkpoints.
 *
 * Owns hidden Git-ref checkpoint capture/restore and diff computation for a
 * workspace thread timeline. It does not store user-facing checkpoint metadata
 * and does not coordinate provider conversation rollback.
 *
 * The live adapter resolves the active VCS driver once per checkpoint operation
 * and delegates to the driver's optional checkpoint capability.
 *
 * Uses Effect `Context.Service` for dependency injection and exposes typed
 * domain errors for checkpoint storage operations.
 *
 * @module CheckpointStore
 */
import { VcsUnsupportedOperationError, type CheckpointRef } from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { CheckpointStoreError } from "./Errors.ts";
import type {
  VcsCheckpointCaptureReport,
  VcsCheckpointOps,
  VcsDiffCheckpointsReport,
} from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

export interface CaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
}

export interface RestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export interface DiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
  readonly format?: "patch" | "numstat";
}

export interface DeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

/** Service tag for checkpoint persistence and restore operations. */
export class CheckpointStore extends Context.Service<
  CheckpointStore,
  {
    /** Check whether cwd is inside a Git worktree. */
    readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Capture a checkpoint commit and store it at the provided checkpoint ref.
     *
     * Uses an isolated temporary Git index and writes a hidden ref.
     */
    readonly captureCheckpoint: (
      input: CaptureCheckpointInput,
    ) => Effect.Effect<void, CheckpointStoreError>;

    /**
     * captureCheckpoint that also reports the repository root, branch and HEAD
     * the snapshot was taken at. Optional so test stores may omit it.
     */
    readonly captureCheckpointReport?: (
      input: CaptureCheckpointInput,
    ) => Effect.Effect<VcsCheckpointCaptureReport, CheckpointStoreError>;

    /** Check whether a checkpoint ref exists. */
    readonly hasCheckpointRef: (
      input: Omit<RestoreCheckpointInput, "fallbackToHead">,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Restore workspace and staging state to a checkpoint.
     *
     * Optionally falls back to current `HEAD` when the checkpoint ref is missing.
     */
    readonly restoreCheckpoint: (
      input: RestoreCheckpointInput,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Compute a diff between two checkpoint refs. Defaults to a full patch.
     *
     * Numstat output has NUL-delimited paths for file summaries.
     * Can optionally treat a missing "from" ref as `HEAD`.
     */
    readonly diffCheckpoints: (
      input: DiffCheckpointsInput,
    ) => Effect.Effect<string, CheckpointStoreError>;

    /**
     * diffCheckpoints that also says whether the output limit cut the patch.
     * Optional so test stores may omit it.
     */
    readonly diffCheckpointsReport?: (
      input: DiffCheckpointsInput,
    ) => Effect.Effect<VcsDiffCheckpointsReport, CheckpointStoreError>;

    /**
     * Paths the diff between two checkpoints holds only because HEAD moved
     * (a checkout, pull or merge), not because the turn edited them. Empty
     * when the driver cannot tell. Optional so test stores may omit it.
     */
    readonly headMovePaths?: (input: {
      readonly cwd: string;
      readonly fromCheckpointRef: CheckpointRef;
      readonly toCheckpointRef: CheckpointRef;
    }) => Effect.Effect<ReadonlySet<string>, CheckpointStoreError>;

    /**
     * Delete the provided checkpoint refs.
     *
     * Best-effort delete: missing refs are tolerated.
     */
    readonly deleteCheckpointRefs: (
      input: DeleteCheckpointRefsInput,
    ) => Effect.Effect<void, CheckpointStoreError>;
  }
>()("specweave-studio/checkpointing/CheckpointStore") {}

type OptionalCheckpointStoreMethod =
  | "captureCheckpointReport"
  | "diffCheckpointsReport"
  | "headMovePaths";

/**
 * A store's optional method, or undefined when the store does not implement
 * it. Layer.mock answers every key with a method that dies, so only the
 * store's own keys count.
 */
export function implementedMethod<K extends OptionalCheckpointStoreMethod>(
  store: CheckpointStore["Service"],
  key: K,
): CheckpointStore["Service"][K] | undefined {
  return Object.hasOwn(store, key) ? store[key] : undefined;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;

  const resolveCheckpoints = Effect.fn("CheckpointStore.resolveCheckpoints")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* vcsRegistry.resolve({ cwd });
    if (!handle.driver.checkpoints) {
      return yield* new VcsUnsupportedOperationError({
        operation,
        kind: handle.kind,
        detail: `${handle.kind} driver does not implement checkpoint operations.`,
      });
    }
    return handle.driver.checkpoints satisfies VcsCheckpointOps;
  });

  const isGitRepository: CheckpointStore["Service"]["isGitRepository"] = (cwd) =>
    vcsRegistry
      .detect({ cwd, requestedKind: "git" })
      .pipe(Effect.map((repository) => repository !== null));

  const captureCheckpoint: CheckpointStore["Service"]["captureCheckpoint"] = Effect.fn(
    "captureCheckpoint",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.captureCheckpoint", input.cwd);
    return yield* checkpoints.captureCheckpoint(input);
  });

  const hasCheckpointRef: CheckpointStore["Service"]["hasCheckpointRef"] = Effect.fn(
    "hasCheckpointRef",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.hasCheckpointRef", input.cwd);
    return yield* checkpoints.hasCheckpointRef(input);
  });

  const restoreCheckpoint: CheckpointStore["Service"]["restoreCheckpoint"] = Effect.fn(
    "restoreCheckpoint",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.restoreCheckpoint", input.cwd);
    return yield* checkpoints.restoreCheckpoint(input);
  });

  const captureCheckpointReport: NonNullable<
    CheckpointStore["Service"]["captureCheckpointReport"]
  > = Effect.fn("captureCheckpointReport")(function* (input) {
    const checkpoints = yield* resolveCheckpoints(
      "CheckpointStore.captureCheckpointReport",
      input.cwd,
    );
    if (checkpoints.captureCheckpointReport) {
      return yield* checkpoints.captureCheckpointReport(input);
    }
    yield* checkpoints.captureCheckpoint(input);
    return { repoRoot: null, branch: undefined, headOid: null };
  });

  const diffCheckpoints: CheckpointStore["Service"]["diffCheckpoints"] = Effect.fn(
    "diffCheckpoints",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.diffCheckpoints", input.cwd);
    return yield* checkpoints.diffCheckpoints(input);
  });

  const diffCheckpointsReport: NonNullable<CheckpointStore["Service"]["diffCheckpointsReport"]> =
    Effect.fn("diffCheckpointsReport")(function* (input) {
      const checkpoints = yield* resolveCheckpoints(
        "CheckpointStore.diffCheckpointsReport",
        input.cwd,
      );
      return checkpoints.diffCheckpointsReport
        ? yield* checkpoints.diffCheckpointsReport(input)
        : { diff: yield* checkpoints.diffCheckpoints(input), truncated: false };
    });

  const headMovePaths: NonNullable<CheckpointStore["Service"]["headMovePaths"]> = Effect.fn(
    "headMovePaths",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.headMovePaths", input.cwd);
    return checkpoints.headMovePaths ? yield* checkpoints.headMovePaths(input) : new Set<string>();
  });

  const deleteCheckpointRefs: CheckpointStore["Service"]["deleteCheckpointRefs"] = Effect.fn(
    "deleteCheckpointRefs",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(
      "CheckpointStore.deleteCheckpointRefs",
      input.cwd,
    );
    return yield* checkpoints.deleteCheckpointRefs(input);
  });

  return CheckpointStore.of({
    isGitRepository,
    captureCheckpoint,
    captureCheckpointReport,
    hasCheckpointRef,
    restoreCheckpoint,
    diffCheckpoints,
    diffCheckpointsReport,
    headMovePaths,
    deleteCheckpointRefs,
  });
});

export const layer = Layer.effect(CheckpointStore, make);
