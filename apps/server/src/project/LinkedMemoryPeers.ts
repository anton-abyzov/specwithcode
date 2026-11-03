/**
 * Linked project memory between servers, without an open app window: the
 * `memory-export` and `memory-merge` peer paths, answered for the copy on this
 * machine. The server that drives a pair (`LinkedPeerSync`) calls them with
 * its work grant here. Export and merge are `LinkedMemorySync`'s, so a pass
 * decides the same files as one the app window drives.
 *
 * @module LinkedMemoryPeers
 */
import type {
  LinkedMemoryExport,
  LinkedMemoryExportInput,
  LinkedMemoryMergeInput,
  LinkedMemoryMergeResult,
  Project,
  ProjectLinkError,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { HandoffRefusal, type ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import { LinkedMemorySync } from "./LinkedMemorySync.ts";
import { linkedCopyFor } from "./LinkedPeerRoute.ts";
import { LinkedPeerSyncState } from "./LinkedPeerSyncState.ts";
import * as ProjectService from "./ProjectService.ts";

export class LinkedMemoryPeerReceiver extends Context.Service<
  LinkedMemoryPeerReceiver,
  {
    readonly memoryExport: (
      caller: ReceiverCaller,
      input: LinkedMemoryExportInput,
    ) => Effect.Effect<LinkedMemoryExport, HandoffRefusal>;
    readonly memoryMerge: (
      caller: ReceiverCaller,
      input: LinkedMemoryMergeInput,
    ) => Effect.Effect<LinkedMemoryMergeResult, HandoffRefusal>;
  }
>()("specweave-studio/project/LinkedMemoryPeers/LinkedMemoryPeerReceiver") {}

const refuse = (status: number, code: HandoffRefusal["code"], message: string) =>
  new HandoffRefusal({ status, code, message });

/** The memory service's refusal as the peer route words it. */
const fromLinkError = (error: ProjectLinkError) =>
  error.code === "not_found"
    ? refuse(404, "not_found", "That project is not on this machine.")
    : error.code === "too_large"
      ? refuse(413, "too_large", "The memory page is too large.")
      : error.code === "handoff_in_progress"
        ? refuse(409, "busy", "This copy is moving to another machine; try again after.")
        : error.code === "storage_failed"
          ? refuse(500, "failed", "This machine could not read or write its memory.")
          : refuse(409, "invalid", error.detail ?? `This copy refused the memory (${error.code}).`);

export const makeReceiver = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const memory = yield* LinkedMemorySync;

  const selfEnvironmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const state = yield* Effect.serviceOption(LinkedPeerSyncState);

  /** The local copy, when the caller is another copy of it with a grant that covers it. */
  const copyFor = (caller: ReceiverCaller, projectId: Project["id"]) =>
    linkedCopyFor(projects, selfEnvironmentId, caller, projectId).pipe(
      Effect.tap(() =>
        Option.isSome(state) ? state.value.peerSeen(caller.sourceEnvironmentId) : Effect.void,
      ),
    );

  return LinkedMemoryPeerReceiver.of({
    memoryExport: (caller, input) =>
      copyFor(caller, input.projectId).pipe(
        Effect.andThen(memory.memoryExport(input).pipe(Effect.mapError(fromLinkError))),
      ),
    memoryMerge: (caller, input) =>
      copyFor(caller, input.projectId).pipe(
        // A machine merges in only its own memory, never another member's in that member's name.
        Effect.andThen(
          input.peer.environmentId === caller.sourceEnvironmentId
            ? Effect.void
            : Effect.fail(refuse(403, "needs_grant", "A machine may send only its own memory.")),
        ),
        Effect.andThen(memory.memoryMerge(input).pipe(Effect.mapError(fromLinkError))),
      ),
  });
});

/** Needs `ProjectService`, `LinkedMemorySync` and `ServerEnvironment`. */
export const layerReceiver = Layer.effect(LinkedMemoryPeerReceiver, makeReceiver);
