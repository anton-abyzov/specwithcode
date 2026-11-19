/**
 * The receiving side of a worktree set, as `HandoffReceiver` uses it: which
 * offers this machine agreed to, a set's frames, the files its members need,
 * and the thread folder a takeover builds. What each step does to Git is in
 * `HandoffSetMoves.ts`; this holds only what the receiver wires together.
 */
// @effect-diagnostics nodeBuiltinImport:off - the state folder is a plain path.
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";

import { incomingRef } from "./bundleGit.ts";
import type { HandoffRefusal } from "./HandoffReceiver.ts";
import {
  checkArrivedSet,
  isLandedSet,
  makeSetOffers,
  materializeSet,
  missingSetSecrets,
  setOwnerTag,
  startedSetFolder,
} from "./HandoffSetMoves.ts";
import { type HandoffDocument, incomingKey } from "./handoffState.ts";
import {
  HANDOFF_CAPABILITIES,
  hasWorktreeSets,
  type PeerPreflightRequest,
  type ReplicateMeta,
  type ReplicateSet,
} from "./handoffWire.ts";

interface Takeover {
  readonly sourceEnvironmentId: string;
  readonly sourceThreadId: string;
  readonly epoch: number;
}

export const makeSetReceiver = <E>(
  config: { readonly stateDir?: unknown },
  document: Effect.Effect<HandoffDocument, E>,
  /** The refusal a failed Git step is answered with. */
  fail: (cause: unknown) => HandoffRefusal,
) => {
  const setOffers = makeSetOffers(undefined, {
    // A test's stand-in for the config may name no state folder.
    directory:
      typeof config.stateDir === "string"
        ? NodePath.join(config.stateDir, "handoff-sets")
        : undefined,
    stored: (landing) =>
      Effect.runPromise(
        document.pipe(
          Effect.map((held) =>
            isLandedSet(
              (held.incomingDetails ?? {})[
                incomingKey(landing.sourceEnvironmentId, landing.sourceThreadId)
              ]?.set,
              landing,
            ),
          ),
        ),
      ),
  });
  const ownerOf = (request: Takeover) =>
    `${request.sourceEnvironmentId}/${request.sourceThreadId}/${request.epoch}`;
  /** Two sources can make the same name; a set's folder also says whose it is. */
  const folderName = (name: string, request: Takeover, set: ReplicateSet | undefined) =>
    set === undefined ? name : `${name}-${setOwnerTag(ownerOf(request))}`;

  return {
    folderName,
    /**
     * A frame as the receiver goes on with it. A frame of a worktree set is
     * taken only under an offer this machine agreed to. A member's frame waits
     * outside its repository and answers `meta: null`: nothing of the thread
     * is stored for it. With the thread's own frame every member's ref is
     * written (`landed`), and taken back if the thread is then refused.
     */
    take: (
      /** `grant` is null for this machine asking itself: it never offers, and is taken at its word. */
      caller: { readonly grant: unknown },
      project: { readonly workspaceRoot: string },
      sent: ReplicateMeta,
      bundle: Uint8Array | null,
    ): Effect.Effect<
      { readonly meta: ReplicateMeta | null; readonly landed: boolean },
      HandoffRefusal,
      Scope.Scope
    > =>
      sent.setPart === undefined && sent.set === undefined
        ? Effect.succeed({ meta: sent, landed: false })
        : Effect.gen(function* () {
            const whole = yield* Effect.tryPromise({
              try: () =>
                setOffers.take({
                  sourceEnvironmentId: sent.sourceEnvironmentId,
                  sourceThreadId: sent.sourceThreadId,
                  self: caller.grant === null,
                  projectRoot: project.workspaceRoot,
                  targetRef: incomingRef(sent.sourceEnvironmentId, sent.sourceThreadId),
                  commit: sent.checkpoint.commit,
                  part: sent.setPart,
                  set: sent.set,
                  bundle,
                }),
              catch: fail,
            });
            if (whole === null) return { meta: null, landed: false };
            // Stored: the refs are the thread's. Refused or cut short: they are taken back.
            yield* Effect.addFinalizer((exit) =>
              Effect.promise(Exit.isSuccess(exit) ? whole.done : whole.undo),
            );
            const meta = { ...sent, repositoryPath: whole.set.members[0]!.repositoryPath };
            // The thread's copy is its own frame alone, and only with every member here.
            yield* Effect.tryPromise({
              try: () =>
                checkArrivedSet({
                  projectRoot: project.workspaceRoot,
                  set: whole.set,
                  repositoryPath: meta.repositoryPath,
                  commit: sent.checkpoint.commit,
                }),
              catch: fail,
            });
            return { meta, landed: true };
          }),

    /** Secret files the other members of a set need here and do not have. */
    missingSecrets: (projectRoot: string, set: ReplicateSet | undefined) =>
      set === undefined
        ? Effect.succeed([] as ReadonlyArray<string>)
        : Effect.promise(() => missingSetSecrets(projectRoot, set)),

    /**
     * The capabilities a check is answered with. A set is agreed to only with
     * a source that passes every check a move needs (`fit`) and can send one.
     * Any other source reads an answer without the capability, and its frames
     * are refused.
     */
    offer: (request: PeerPreflightRequest, fit: boolean) =>
      Effect.gen(function* () {
        const offered = request.setOffer;
        const agreed = fit && hasWorktreeSets(request.capabilities);
        if (offered !== undefined && agreed) {
          yield* Effect.promise(() =>
            setOffers.open(request.sourceEnvironmentId, offered.sourceThreadId, offered.id),
          );
        }
        return offered === undefined || agreed
          ? HANDOFF_CAPABILITIES
          : HANDOFF_CAPABILITIES.filter((each) => !hasWorktreeSets([each]));
      }),

    /**
     * The thread folder of a set at a takeover, built whole or not at all; null
     * for a thread in one repository. A set is never put in the project folder:
     * an earlier attempt's folder is found and built on, otherwise the set goes
     * where a new worktree is placed.
     */
    folder: (
      project: { readonly workspaceRoot: string },
      name: string,
      request: Takeover,
      detail: { readonly set?: ReplicateSet | undefined },
      placement: Effect.Effect<{ readonly worktreePath: string }, HandoffRefusal>,
      replica: { readonly sourceLabel: string },
    ) => {
      const set = detail.set;
      if (set === undefined) return Effect.succeed(null);
      return Effect.tryPromise({
        try: () =>
          startedSetFolder({
            projectRoot: project.workspaceRoot,
            set,
            name: folderName(name, request, set),
          }),
        catch: fail,
      }).pipe(
        Effect.flatMap((started) =>
          started === null
            ? Effect.map(placement, (place) => place.worktreePath)
            : Effect.succeed(started),
        ),
        Effect.flatMap((folder) =>
          Effect.tryPromise({
            try: () =>
              materializeSet({
                projectRoot: project.workspaceRoot,
                folder,
                owner: ownerOf(request),
                set,
                sourceLabel: replica.sourceLabel,
                sourceThreadId: request.sourceThreadId,
              }),
            catch: fail,
          }),
        ),
      );
    },
  };
};
