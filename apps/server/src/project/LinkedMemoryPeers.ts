/**
 * Linked project memory between servers, without an open app window. The
 * coordinator's server drives every pair of its project's copies it can
 * reach (`LinkedMemoryPeerSync`): its own copy directly, each other copy over
 * the handoff peer route with its work grant there, where
 * `LinkedMemoryPeerReceiver` answers for the copy on that machine. Export and
 * merge are `LinkedMemorySync`'s, so a pass decides the same files as one the
 * app window drives.
 *
 * @module LinkedMemoryPeers
 */
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import {
  type LinkedMemoryDriver,
  type LinkedMemoryMember,
  syncLinkedMemory,
} from "@specweave-studio/shared/linkedMemorySync";
import type {
  EnvironmentId,
  LinkedMemoryExport,
  LinkedMemoryExportInput,
  LinkedMemoryMergeInput,
  LinkedMemoryMergeResult,
  Project,
  ProjectLinkError,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { projectInGrant } from "../fleet/workGrantPolicy.ts";
import { type HandoffPeerError, HandoffPeers } from "../handoff/handoffPeers.ts";
import { HandoffRefusal, type ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import { LinkedMemorySync } from "./LinkedMemorySync.ts";
import * as ProjectService from "./ProjectService.ts";

/** How often the coordinator's server exchanges memory between its project's copies. */
export const LINKED_MEMORY_PEER_SYNC_MS = 60_000;

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

  /** The local copy, when the caller is another copy of it with a grant that covers it. */
  const copyFor = (caller: ReceiverCaller, projectId: Project["id"]) =>
    Effect.gen(function* () {
      const found = yield* projects
        .getById(projectId)
        .pipe(
          Effect.mapError(() => refuse(500, "failed", "This machine could not read projects.")),
        );
      if (Option.isNone(found) || found.value.deletedAt !== null)
        return yield* refuse(404, "not_found", "That project is not on this machine.");
      const project = found.value;
      const members = project.workspaceSettings?.logicalProject?.members ?? [];
      if (!members.some((member) => member.environmentId === caller.sourceEnvironmentId))
        return yield* refuse(403, "needs_grant", "Only a linked copy of this project may sync it.");
      if (
        caller.grant !== null &&
        !projectInGrant(caller.grant.projects, caller.sourceEnvironmentId, project)
      )
        return yield* refuse(403, "needs_grant", "This machine's work grant does not cover it.");
      return project;
    });

  return LinkedMemoryPeerReceiver.of({
    memoryExport: (caller, input) =>
      copyFor(caller, input.projectId).pipe(
        Effect.andThen(memory.memoryExport(input).pipe(Effect.mapError(fromLinkError))),
      ),
    memoryMerge: (caller, input) =>
      copyFor(caller, input.projectId).pipe(
        Effect.andThen(memory.memoryMerge(input).pipe(Effect.mapError(fromLinkError))),
      ),
  });
});

/** Needs `ProjectService` and `LinkedMemorySync`. */
export const layerReceiver = Layer.effect(LinkedMemoryPeerReceiver, makeReceiver);

/**
 * The copies of `project` this server can sync, when it holds the project's
 * coordinator: its own copy and every copy on a configured machine. Empty when
 * fewer than two machines are left.
 */
export function peerSyncMembers(
  project: Project,
  selfEnvironmentId: EnvironmentId,
  reachable: ReadonlySet<string>,
  label: (environmentId: EnvironmentId) => string,
): LinkedMemoryMember[] {
  const settings = project.workspaceSettings;
  if (
    project.deletedAt !== null ||
    isPersonalAssistantProject(project) ||
    settings?.archived ||
    settings?.coordinatorBinding?.state !== "active"
  )
    return [];
  const members = (settings.logicalProject?.members ?? [])
    .filter(
      (member) =>
        member.environmentId === selfEnvironmentId ||
        (member.projectId !== undefined && reachable.has(member.environmentId)),
    )
    .map((member) => ({
      environmentId: member.environmentId,
      projectId: member.projectId,
      label: label(member.environmentId).slice(0, 200),
    }));
  if (!members.some((member) => member.environmentId === selfEnvironmentId))
    members.unshift({
      environmentId: selfEnvironmentId,
      projectId: project.id,
      label: label(selfEnvironmentId).slice(0, 200),
    });
  return new Set(members.map((member) => member.environmentId)).size > 1 ? members : [];
}

export class LinkedMemoryPeerSync extends Context.Service<
  LinkedMemoryPeerSync,
  {
    /** One pass over every project whose coordinator is here. */
    readonly tick: Effect.Effect<void>;
  }
>()("specweave-studio/project/LinkedMemoryPeers/LinkedMemoryPeerSync") {}

export const makeSync = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const memory = yield* LinkedMemorySync;
  const peers = yield* HandoffPeers;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const selfEnvironmentId = yield* environment.getEnvironmentId;
  const context = yield* Effect.context<never>();
  const run = Effect.runPromiseWith(context);
  /** An export or merge that failed counts as not reachable now; the next pass tries again. */
  const settle = <A>(effect: Effect.Effect<A, ProjectLinkError | HandoffPeerError>) =>
    run(
      effect.pipe(
        Effect.map(Option.some),
        Effect.tapError((cause) => Effect.logDebug("linked memory peer step failed", { cause })),
        Effect.orElseSucceed(Option.none<A>),
      ),
    ).then(Option.getOrNull);

  const driver: LinkedMemoryDriver = {
    exportMemory: (member, options) => {
      const input = { projectId: member.projectId, ...options };
      return settle<LinkedMemoryExport>(
        member.environmentId === selfEnvironmentId
          ? memory.memoryExport(input)
          : peers.memoryExport(member.environmentId, input),
      );
    },
    mergeMemory: (member, peer, page) => {
      const input = { projectId: member.projectId, peer, export: page };
      return settle<LinkedMemoryMergeResult>(
        member.environmentId === selfEnvironmentId
          ? memory.memoryMerge(input)
          : peers.memoryMerge(member.environmentId, input),
      ).then((result) => result !== null);
    },
    reportMismatch: (left, right) =>
      void run(
        Effect.logWarning("Linked project memory still differs after a sync and a retry", {
          left: { environmentId: left.environmentId, projectId: left.projectId },
          right: { environmentId: right.environmentId, projectId: right.projectId },
        }),
      ),
  };

  const tick = Effect.gen(function* () {
    const snapshot = yield* projects.snapshot.pipe(Effect.option);
    if (Option.isNone(snapshot)) return;
    const targets = yield* peers.targets;
    const reachable = new Set<string>(targets.map((target) => target.environmentId));
    const labels = new Map<string, string>(
      targets.map((target) => [target.environmentId, target.label]),
    );
    const selfLabel = (yield* environment.getDescriptor).label ?? "This machine";
    const label = (environmentId: EnvironmentId) =>
      environmentId === selfEnvironmentId ? selfLabel : (labels.get(environmentId) ?? "Machine");
    const groups = snapshot.value.projects
      .map((project) => peerSyncMembers(project, selfEnvironmentId, reachable, label))
      .filter((members) => members.length > 0);
    if (groups.length === 0) return;
    yield* Effect.promise(() => syncLinkedMemory(groups, driver));
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Linked project memory sync between machines failed", { cause }),
    ),
  );

  return LinkedMemoryPeerSync.of({ tick });
});

/** Needs `ProjectService`, `LinkedMemorySync`, `HandoffPeers` and `ServerEnvironment`. */
export const layerSync = Layer.effect(LinkedMemoryPeerSync, makeSync);

/** Runs `tick` every minute for as long as the server runs. */
export const runLoop = Effect.gen(function* () {
  const sync = yield* LinkedMemoryPeerSync;
  yield* sync.tick.pipe(
    Effect.repeat(Schedule.spaced(Duration.millis(LINKED_MEMORY_PEER_SYNC_MS))),
    Effect.asVoid,
  );
});
