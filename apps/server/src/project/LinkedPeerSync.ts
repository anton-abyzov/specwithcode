/**
 * Keeps linked copies in step from the servers, with no app window open: the
 * coordinator's notes replica, two-way memory, plan claims, and the old
 * coordinator giving way after a takeover. Every pair of copies of one
 * logical project is driven by exactly one of its two servers, the one with
 * the lower environment ID; the other only answers (`LinkedPeerRoute`).
 * Giving way is driven by the copy that took over, since only it holds the
 * new binding, and watched for by the copy taken over from: a coordinating
 * copy reads every other copy's digest each pass, and when one shows it took
 * over from this copy at a higher epoch, this copy gives way itself. So a
 * copy gives way within a pass of reaching the other, whichever of the two
 * holds a grant on the other, and starts no coordinator turn once it has seen
 * the takeover (`CoordinatorWakeGate`). Member lists follow the coordinator:
 * whichever side drives a pair pulls the coordinator's list from its digest
 * or pushes it (`linked-members`), best effort and outside the status the app
 * reads. Calls go over the handoff peer route with this machine's work grant
 * there, so a pair is driven only toward machines this one holds a grant on;
 * the app keeps driving the rest (`projectLink.syncStatus`).
 *
 * A pass first exchanges digests; content moves only for a kind that
 * changed since the last pass that left the pair in step, and at least every
 * few minutes. Toward a machine too old for these paths, memory still moves
 * over the older memory paths, as the coordinator's server did before. The decisions are
 * the shared ones the app makes (`linkedPairSync`, `linkedMemorySync`,
 * `linkedPlanSync`), and the merges are the same services the app calls.
 *
 * @module LinkedPeerSync
 */
import {
  type EnvironmentId,
  logicalProjectMemberKey,
  type LinkedServerSyncError,
  type LinkedServerSyncKind,
  type LogicalProjectMember,
  type Project,
  type ProjectId,
  ProjectLinkError,
  type ProjectSupersedeInput,
  ProjectPlanError,
} from "@specweave-studio/contracts";
import {
  drivesPair,
  LINKED_PAIR_SYNC_MS,
  type PairSide,
  pendingSupersede,
  replicaStep,
} from "@specweave-studio/shared/linkedPairSync";
import {
  type LinkedMemoryDriver,
  type LinkedMemoryMember,
  syncLinkedMemory,
} from "@specweave-studio/shared/linkedMemorySync";
import { syncLinkedPlans } from "@specweave-studio/shared/linkedPlanSync";
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { HandoffPeerError, type HandoffPeerTarget, HandoffPeers } from "../handoff/handoffPeers.ts";
import {
  LINKED_SYNC_PROTOCOL_VERSION,
  type LinkedContentResponse,
  type LinkedDigestResponse,
} from "../handoff/linkedSyncWire.ts";
import { stringifyJson } from "../json.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import { forkParked } from "../serverActivation.ts";
import { LinkedMemorySync } from "./LinkedMemorySync.ts";
import { describeCopy, selfMemberOf } from "./LinkedPeerRoute.ts";
import { type LinkedPair, LinkedPeerSyncState, pairKey } from "./LinkedPeerSyncState.ts";
import {
  coordinatorContentDigest,
  ProjectLink,
  type ReplicateFromMemberInput,
} from "./ProjectLink.ts";
import { CoordinatorReleaseGuard } from "./ProjectLinkStandby.ts";
import {
  type AddPredecessorMembersInput,
  type AdoptMembersInput,
  memberRef,
  sameMemberSet,
} from "./ProjectLinkMembers.ts";
import { ProjectPlanService } from "./ProjectPlanService.ts";
import * as ProjectService from "./ProjectService.ts";

/** How often the loop looks for a new link between full passes. */
const LINK_WATCH_MS = 10_000;

type LocalError = ProjectLinkError | ProjectPlanError;

export interface LinkedPeerSyncDeps {
  readonly selfEnvironmentId: EnvironmentId;
  readonly selfLabel: Effect.Effect<string>;
  /** This machine's projects, deleted ones left out. */
  readonly listProjects: Effect.Effect<ReadonlyArray<Project>>;
  /** The machines this one can call, with their labels. */
  readonly targets: Effect.Effect<ReadonlyArray<HandoffPeerTarget>>;
  readonly state: LinkedPeerSyncState["Service"];
  /** True while the service is held for an update: passes are skipped. */
  readonly isHeld: Effect.Effect<boolean>;
  /** What a pass compares about a copy here. */
  readonly describe: (
    project: Project,
    member: LogicalProjectMember,
  ) => Effect.Effect<LinkedDigestResponse, LocalError>;
  /** This copy's own notes, goal and instructions, when it coordinates. */
  readonly content: (project: Project) => Effect.Effect<LinkedContentResponse, LocalError>;
  readonly replicate: (input: ReplicateFromMemberInput) => Effect.Effect<unknown, LocalError>;
  /**
   * Gives way to the copy that took over from this one, as that copy's own
   * digest showed it: the standby this copy leases to is released first.
   */
  readonly giveWay: (input: ProjectSupersedeInput) => Effect.Effect<unknown, LocalError>;
  /** This transferred copy adopts its coordinator's member list. */
  readonly adoptMembers: (
    input: AdoptMembersInput,
  ) => Effect.Effect<{ readonly changed: boolean }, LocalError>;
  /** This copy, after a takeover, adds the members its predecessor lists. */
  readonly addPredecessorMembers: (
    input: AddPredecessorMembersInput,
  ) => Effect.Effect<{ readonly changed: boolean }, LocalError>;
  readonly memory: Pick<LinkedMemorySync["Service"], "memoryExport" | "memoryMerge">;
  readonly plans: Pick<ProjectPlanService["Service"], "exportLinked" | "mergeLinked">;
  readonly peers: Pick<
    HandoffPeers["Service"],
    | "linkedDigest"
    | "linkedContent"
    | "linkedReplica"
    | "linkedSupersede"
    | "linkedMembers"
    | "planExport"
    | "planMerge"
    | "memoryExport"
    | "memoryMerge"
    | "reachable"
  >;
}

export class LinkedPeerSync extends Context.Service<
  LinkedPeerSync,
  {
    /** One pass over every pair this server drives whose backoff allows it. */
    readonly tick: Effect.Effect<void>;
    /** Changes whenever a link is made or removed here; cheap to poll. */
    readonly signature: Effect.Effect<string>;
  }
>()("specweave-studio/project/LinkedPeerSync") {}

/**
 * Why a call failed, as the app reads it. A peer that answers 404 without a
 * code body for the path itself predates server-driven sync.
 */
export function syncErrorOf(error: unknown): LinkedServerSyncError {
  if (error instanceof HandoffPeerError) {
    if (error.code === "needs_grant") return "needs_grant";
    if (error.code === "unreachable") return "unreachable";
    if (error.check === "version" || (error.code === "not_found" && error.message === "not_found"))
      return "outdated";
    return error.local === true ? "failed" : "refused";
  }
  return "failed";
}

/**
 * Refusals by which this copy's own supersede says the takeover can never
 * apply here as claimed; any other failure (a standby that must answer
 * first, storage) is tried again on the next pass while turns stay held.
 */
const PERMANENT_GIVE_WAY_REFUSALS: ReadonlySet<ProjectLinkError["code"]> = new Set([
  "not_found",
  "not_linked",
  "invalid",
  "superseded_conflict",
  "not_code_project",
  "not_member",
]);

/** How long a memo lets passes skip a kind; past it the kind is synced again. */
const MEMO_MAX_AGE_MS = 5 * LINKED_PAIR_SYNC_MS;

/** The digests a pass of one kind left the pair in step at, and when. */
interface Memo {
  readonly own: string | null;
  readonly peer: string | null;
  readonly at: number;
}

/** Per pair: the memo of each kind a pass synced. */
interface PairMemo {
  memory?: Memo;
  plan?: Memo;
}

/** A digest that could not be read (null) never counts as in step. */
const sameMemo = (memo: Memo | undefined, own: string | null, peer: string | null, now: number) =>
  memo !== undefined &&
  own !== null &&
  peer !== null &&
  memo.own === own &&
  memo.peer === peer &&
  now - memo.at < MEMO_MAX_AGE_MS;

/** How long a refused or failed member list sync waits before the same lists are tried again. */
const MEMBER_HOLD_MS = 10 * 60_000;
/** Held member list syncs kept; more pairs than any real fleet has. */
const MEMBER_HOLDS_MAX = 4096;

const memberRefs = (members: ReadonlyArray<LogicalProjectMember>) =>
  [...new Set(members.map(memberRef))].toSorted();

export const makeLinkedPeerSync = (deps: LinkedPeerSyncDeps) =>
  Effect.gen(function* () {
    const { selfEnvironmentId, state, peers } = deps;
    const context = yield* Effect.context<never>();
    const run = Effect.runPromiseWith(context);
    const memos = new Map<string, PairMemo>();
    /** Machines that answered `linked-digest`: they drive their own pairs. */
    const current = new Set<string>();
    const lock = yield* Semaphore.make(1);

    /** The copies of `project` this server pairs with, and the side it plays in each. */
    const pairsOf = (project: Project, configured: ReadonlySet<string>) => {
      const identity = project.workspaceSettings?.logicalProject;
      const self = selfMemberOf(project, selfEnvironmentId);
      if (identity === undefined || self === undefined || isPersonalAssistantProject(project))
        return [];
      const binding = project.workspaceSettings?.coordinatorBinding;
      // An older machine syncs memory only from the coordinator's server, toward every copy.
      const coordinates = binding?.state === "active" && !project.workspaceSettings?.archived;
      return identity.members.flatMap((member) => {
        if (member.environmentId === selfEnvironmentId || !configured.has(member.environmentId))
          return [];
        const drive = drivesPair(selfEnvironmentId, member.environmentId);
        // Only the copy that took over holds the binding the old coordinator must see.
        const successor =
          binding?.state === "active" &&
          binding.predecessor?.environmentId === member.environmentId &&
          binding.predecessor.projectId === member.projectId;
        // A coordinating copy reads the copies it does not drive each pass, to see a takeover of it.
        const watch = !drive && !successor && coordinates;
        const legacyOnly = watch && !current.has(member.environmentId);
        if (!drive && !successor && !watch) return [];
        const kinds: LinkedServerSyncKind[] = [
          ...(successor || watch ? (["supersede"] as const) : []),
          ...(drive ? (["replica", "memory", "plan"] as const) : []),
          ...(legacyOnly ? (["memory"] as const) : []),
        ];
        return [{ identity, self, member, kinds, legacyOnly, successor }];
      });
    };

    const signature = Effect.gen(function* () {
      const configured = new Set<string>((yield* deps.targets).map((t) => t.environmentId));
      return stringifyJson(
        (yield* deps.listProjects).flatMap((project) =>
          pairsOf(project, configured).map(({ member, kinds }) => [
            project.id,
            member.environmentId,
            member.projectId,
            kinds,
          ]),
        ),
      );
    });

    /** Runs `effect`; its failure becomes the error the status reports. */
    const step = <E>(effect: Effect.Effect<void, E>) =>
      effect.pipe(
        Effect.as(null as LinkedServerSyncError | null),
        Effect.catch((error) =>
          Effect.logDebug("linked peer sync step failed", { error }).pipe(
            Effect.as(syncErrorOf(error) as LinkedServerSyncError | null),
          ),
        ),
      );

    /**
     * The calls a shared driver makes in one pass, as promises. A failed call
     * fails the pass. Once the pass is interrupted (`signal`) or the service is
     * held for an update, no call starts and the one in flight stops.
     */
    const driverCalls = (signal: AbortSignal) => {
      let failure: unknown = null;
      const fail = (error: unknown) => {
        failure ??= error;
        return null;
      };
      const settle = <A>(effect: Effect.Effect<A, LocalError | HandoffPeerError>) =>
        signal.aborted
          ? Promise.resolve(fail("interrupted"))
          : run(
              deps.isHeld.pipe(
                Effect.flatMap((held) =>
                  held ? Effect.fail(new ProjectLinkError({ code: "paused" })) : effect,
                ),
                Effect.asSome,
                Effect.catch((error) => Effect.sync(() => (fail(error), Option.none<A>()))),
              ),
              { signal },
            ).then(Option.getOrNull, () => fail("interrupted"));
      return {
        settle,
        fail,
        error: (): LinkedServerSyncError | null => (failure === null ? null : syncErrorOf(failure)),
      };
    };

    /** Two-way memory between this copy and the peer's; the error the pass ended with. */
    const syncMemory = (
      selfMember: LinkedMemoryMember,
      peerMember: LinkedMemoryMember,
    ): Effect.Effect<LinkedServerSyncError | null> =>
      Effect.promise(async (signal) => {
        const calls = driverCalls(signal);
        const local = (target: LinkedMemoryMember) => target.environmentId === selfEnvironmentId;
        const driver: LinkedMemoryDriver = {
          exportMemory: (target, options) => {
            const request = { projectId: target.projectId, ...options };
            return calls.settle(
              local(target)
                ? deps.memory.memoryExport(request)
                : peers.memoryExport(target.environmentId, request),
            );
          },
          mergeMemory: (target, from, page) => {
            const request = { projectId: target.projectId, peer: from, export: page };
            return calls
              .settle(
                local(target)
                  ? deps.memory.memoryMerge(request)
                  : peers.memoryMerge(target.environmentId, request),
              )
              .then((result) => result !== null);
          },
          // Still different after a retry: not in step, so the app keeps driving the pair.
          reportMismatch: (left, right) => {
            calls.fail("mismatch");
            void run(
              Effect.logWarning("Linked project memory still differs after a sync and a retry", {
                left: { environmentId: left.environmentId, projectId: left.projectId },
                right: { environmentId: right.environmentId, projectId: right.projectId },
              }),
            );
          },
        };
        await syncLinkedMemory([[selfMember, peerMember]], driver);
        return calls.error();
      });

    /** Two-way plan claims between this copy and the peer's; the error the pass ended with. */
    const syncPlans = (
      ref: { readonly protocolVersion: number; readonly logicalProjectId: string },
      selfMember: LinkedMemoryMember,
      peerMember: LinkedMemoryMember,
    ): Effect.Effect<LinkedServerSyncError | null> =>
      Effect.promise(async (signal) => {
        const calls = driverCalls(signal);
        const local = (target: LinkedMemoryMember) => target.environmentId === selfEnvironmentId;
        let read = 0;
        await syncLinkedPlans([selfMember, peerMember], {
          exportPlan: (target) =>
            calls
              .settle(
                local(target)
                  ? deps.plans.exportLinked({ projectId: target.projectId })
                  : peers.planExport(target.environmentId, { ...ref, projectId: target.projectId }),
              )
              .then((value) => {
                if (value !== null) read += 1;
                return value;
              }),
          mergePlan: (target, from, exported) =>
            calls
              .settle(
                local(target)
                  ? deps.plans.mergeLinked({
                      projectId: target.projectId,
                      peer: from,
                      export: exported,
                    })
                  : peers.planMerge(target.environmentId, {
                      ...ref,
                      projectId: target.projectId,
                      peer: from,
                      export: exported,
                    }),
              )
              .then(() => undefined),
        });
        return calls.error() ?? (read < 2 ? "failed" : null);
      });

    /**
     * When `peer`'s own digest shows it took over from this copy at a higher
     * epoch, this copy gives way: no new coordinator turn starts here from
     * then on, and the takeover is written here, the standby released first.
     * The digest came from that machine over the peer route, so it confirms
     * the takeover as the peer route's own supersede does, but only as the
     * copy that was called (`member`): a digest naming another copy is no
     * takeover. Null when nothing was pending or this copy gave way;
     * otherwise why it could not. When this copy's own rules refuse to give
     * way (a permanent refusal), the hold on its turns is lifted again, so a
     * claim this copy can never act on does not stop its coordinator for good.
     */
    const yieldToTakeover = (
      project: Project,
      identityId: string,
      self: LogicalProjectMember,
      member: LogicalProjectMember,
      peer: LinkedDigestResponse,
    ): Effect.Effect<LinkedServerSyncError | null> =>
      Effect.gen(function* () {
        const binding = peer.binding;
        const pending =
          binding !== null &&
          peer.member.environmentId === member.environmentId &&
          peer.member.projectId === member.projectId &&
          member.environmentId !== selfEnvironmentId &&
          pendingSupersede(
            {
              environmentId: member.environmentId,
              projectId: member.projectId,
              logicalProjectId: identityId,
              binding,
            },
            {
              environmentId: selfEnvironmentId,
              projectId: project.id,
              logicalProjectId: project.workspaceSettings?.logicalProject?.id,
              binding: project.workspaceSettings?.coordinatorBinding,
            },
          );
        if (!pending || binding === null) {
          // Only the copy that claimed the takeover may lift what it raised.
          yield* state.clearSuperseded(project.id, member.environmentId);
          return null;
        }
        yield* state.markSuperseded({
          projectId: project.id,
          coordinatorThreadId: self.coordinatorThreadId,
          epoch: binding.epoch,
          successorEnvironmentId: member.environmentId,
        });
        const outcome = yield* deps
          .giveWay({
            projectId: project.id,
            logicalProjectId: identityId,
            successor: member,
            coordinatorBinding: binding,
          })
          .pipe(Effect.result);
        if (Result.isSuccess(outcome)) {
          yield* Effect.logInfo("This copy gave way to a linked copy that took over", {
            projectId: project.id,
            successor: member.environmentId,
            epoch: binding.epoch,
          });
          yield* state.clearSuperseded(project.id);
          return null;
        }
        const failure = outcome.failure;
        const permanent =
          failure._tag === "ProjectLinkError" && PERMANENT_GIVE_WAY_REFUSALS.has(failure.code);
        // This copy's own rules refuse the takeover: holding its turns would never end.
        if (permanent) yield* state.clearSuperseded(project.id, member.environmentId);
        yield* Effect.logWarning(
          permanent
            ? "A linked copy claims it took over from this one, which refuses to give way to it"
            : "A linked copy took over from this one, which could not give way yet",
          { projectId: project.id, successor: member.environmentId, error: failure },
        );
        return syncErrorOf(failure);
      });

    /**
     * Member list syncs a peer refused or that failed, per pair, with both
     * lists as they were: not tried again until either list changes or the
     * hold runs out, so a list the peer keeps refusing costs one call per hold.
     */
    const memberHolds = new Map<string, { readonly lists: string; readonly until: number }>();

    /**
     * Member lists follow the coordinator, along each copy's own successor: a
     * transferred copy takes the list of the copy it gave way to, whether that
     * copy coordinates or gave way in turn (it relays its own successor's
     * list), and that copy sends its list to a transferred copy that names it
     * as successor and reports a different one. A peer too old to report
     * members gets nothing. Best effort: never part of the pair's outcomes.
     */
    const syncMembers = (input: {
      readonly project: Project;
      readonly identityId: string;
      readonly self: LogicalProjectMember;
      readonly member: LogicalProjectMember;
      readonly own: LinkedDigestResponse;
      readonly peer: LinkedDigestResponse;
      readonly pair: LinkedPair;
      readonly ref: {
        readonly protocolVersion: number;
        readonly logicalProjectId: string;
        readonly projectId: ProjectId;
      };
    }) =>
      Effect.gen(function* () {
        const { project, own, peer } = input;
        const held = project.workspaceSettings?.logicalProject?.members;
        if (held === undefined || peer.members === undefined || sameMemberSet(held, peer.members))
          return;
        const isPeer =
          logicalProjectMemberKey(peer.member) === logicalProjectMemberKey(input.member);
        const relays = (binding: LinkedDigestResponse["binding"]) =>
          binding?.state === "active" || binding?.state === "transferred";
        const pull =
          isPeer &&
          own.binding?.state === "transferred" &&
          own.binding.successor !== undefined &&
          logicalProjectMemberKey(own.binding.successor) ===
            logicalProjectMemberKey(input.member) &&
          relays(peer.binding);
        const push =
          !pull &&
          isPeer &&
          relays(own.binding) &&
          !project.workspaceSettings?.archived &&
          peer.binding?.state === "transferred" &&
          peer.binding.successor !== undefined &&
          logicalProjectMemberKey(peer.binding.successor) === logicalProjectMemberKey(input.self);
        if (!pull && !push) return;
        const key = pairKey(input.pair);
        const lists = stringifyJson([
          memberRefs(held),
          memberRefs(peer.members),
          own.binding?.epoch ?? null,
          peer.binding?.epoch ?? null,
        ]);
        const now = yield* Clock.currentTimeMillis;
        const hold = memberHolds.get(key);
        if (hold !== undefined && hold.lists === lists && hold.until > now) return;
        const call: Effect.Effect<{ readonly changed: boolean }, LocalError | HandoffPeerError> =
          pull
            ? deps.adoptMembers({
                projectId: project.id,
                logicalProjectId: input.identityId,
                from: input.member,
                fromEpoch: peer.binding!.epoch,
                members: peer.members,
              })
            : peers.linkedMembers(input.member.environmentId, {
                ...input.ref,
                from: input.self,
                fromEpoch: own.binding!.epoch,
                members: held,
              });
        const outcome = yield* Effect.result(call);
        if (Result.isFailure(outcome)) {
          memberHolds.delete(key);
          if (memberHolds.size >= MEMBER_HOLDS_MAX) {
            const oldest = memberHolds.keys().next();
            if (!oldest.done) memberHolds.delete(oldest.value);
          }
          memberHolds.set(key, { lists, until: now + MEMBER_HOLD_MS });
          yield* Effect.logDebug("linked member list sync failed", { error: outcome.failure });
          return;
        }
        memberHolds.delete(key);
        // New pairs start at once rather than after the next link watch.
        if (pull && outcome.success.changed) yield* state.wake;
      }).pipe(
        Effect.catch((error) => Effect.logDebug("linked member list sync failed", { error })),
      );

    const syncPair = (input: {
      readonly project: Project;
      readonly identityId: string;
      readonly self: LogicalProjectMember;
      readonly member: LogicalProjectMember;
      readonly kinds: ReadonlyArray<LinkedServerSyncKind>;
      readonly legacyOnly: boolean;
      /** This copy took over from the peer's: it drives giving way. */
      readonly successor: boolean;
      readonly pair: LinkedPair;
      readonly labels: ReadonlyMap<string, string>;
      readonly selfLabel: string;
    }) =>
      Effect.gen(function* () {
        const { project, identityId, self, member, kinds, pair } = input;
        const ref = {
          protocolVersion: LINKED_SYNC_PROTOCOL_VERSION,
          logicalProjectId: identityId,
          projectId: member.projectId,
        };
        const selfMember: LinkedMemoryMember = {
          environmentId: selfEnvironmentId,
          projectId: project.id,
          label: input.selfLabel.slice(0, 200),
        };
        const peerMember: LinkedMemoryMember = {
          environmentId: member.environmentId,
          projectId: member.projectId,
          label: (input.labels.get(member.environmentId) ?? "Machine").slice(0, 200),
        };
        const theirs = yield* peers.linkedDigest(member.environmentId, ref).pipe(Effect.result);
        if (Result.isFailure(theirs)) {
          yield* Effect.logDebug("linked peer sync could not reach a copy", {
            peer: member.environmentId,
            error: theirs.failure,
          });
          const error = syncErrorOf(theirs.failure);
          // An older machine still answers the memory paths: memory moves, the rest stays the app's.
          const memory =
            error === "outdated" && kinds.includes("memory")
              ? yield* syncMemory(selfMember, peerMember)
              : error;
          return kinds.map((kind) => ({ kind, error: kind === "memory" ? memory : error }));
        }
        current.add(member.environmentId);
        // The peer took over from this copy: give way now, whoever drives the pair.
        const takenOver = yield* yieldToTakeover(project, identityId, self, member, theirs.success);
        // That machine drives its own pairs: only the watch for a takeover is left to this one.
        if (!kinds.includes("replica") && !input.successor)
          return [{ kind: "supersede" as const, error: takenOver }];
        const ours = yield* deps.describe(project, self).pipe(Effect.result);
        if (Result.isFailure(ours))
          return kinds.map((kind) => ({ kind, error: "failed" as const }));
        const own = ours.success;
        const peer = theirs.success;
        const sideOf = (described: LinkedDigestResponse): PairSide => ({
          environmentId: described.member.environmentId,
          projectId: described.member.projectId,
          logicalProjectId: identityId,
          binding: described.binding ?? undefined,
          coordinatorDigest: described.coordinatorDigest,
          replica: described.replica,
        });
        const outcomes: Array<{ kind: LinkedServerSyncKind; error: LinkedServerSyncError | null }> =
          [];
        const key = pairKey(pair);
        const memo: PairMemo = { ...memos.get(key) };
        const now = yield* Clock.currentTimeMillis;

        /**
         * After `kind` synced without an error, the digests both sides hold now:
         * passes skip the kind while they stay so. Read right after that kind's
         * own merges, and only for it, so a change made meanwhile to a kind this
         * pass did not move is never taken as in step.
         */
        const settled = (kind: "memory" | "plan", error: LinkedServerSyncError | null) =>
          Effect.gen(function* () {
            delete memo[kind];
            if (error !== null) return;
            const after = yield* Effect.all([
              deps.describe(project, self),
              peers.linkedDigest(member.environmentId, ref),
            ]).pipe(Effect.option);
            if (Option.isNone(after)) return;
            const [ownAfter, peerAfter] = after.value;
            memo[kind] =
              kind === "memory"
                ? {
                    own: ownAfter.memoryDigest,
                    peer: peerAfter.memoryDigest,
                    at: yield* Clock.currentTimeMillis,
                  }
                : {
                    own: ownAfter.planDigest,
                    peer: peerAfter.planDigest,
                    at: yield* Clock.currentTimeMillis,
                  };
          });

        yield* syncMembers({ project, identityId, self, member, own, peer, pair, ref });

        if (kinds.includes("supersede") && !input.successor)
          outcomes.push({ kind: "supersede", error: takenOver });
        else if (kinds.includes("supersede")) {
          const binding = own.binding;
          outcomes.push({
            kind: "supersede",
            error:
              binding !== null && pendingSupersede(sideOf(own), sideOf(peer))
                ? yield* step(
                    peers
                      .linkedSupersede(member.environmentId, {
                        ...ref,
                        successor: self,
                        coordinatorBinding: binding,
                      })
                      .pipe(
                        Effect.tap(() =>
                          Effect.logInfo("A linked copy gave way after a takeover", {
                            projectId: project.id,
                            previous: member.environmentId,
                          }),
                        ),
                        // Machines linked on the old coordinator after this copy last synced.
                        Effect.tap((answer) =>
                          answer.members === undefined || binding.state !== "active"
                            ? Effect.void
                            : deps
                                .addPredecessorMembers({
                                  projectId: project.id,
                                  predecessor: member,
                                  members: answer.members,
                                })
                                .pipe(
                                  Effect.flatMap(({ changed }) =>
                                    changed ? state.wake : Effect.void,
                                  ),
                                  Effect.catch((error) =>
                                    Effect.logDebug("linked members after a takeover failed", {
                                      error,
                                    }),
                                  ),
                                ),
                        ),
                      ),
                  )
                : null,
          });
        }

        if (kinds.includes("replica")) {
          const direction = replicaStep(sideOf(own), sideOf(peer));
          outcomes.push({
            kind: "replica",
            error:
              direction === "push"
                ? yield* step(
                    deps.content(project).pipe(
                      Effect.flatMap((content) =>
                        peers.linkedReplica(member.environmentId, {
                          ...ref,
                          from: self,
                          fromEpoch: content.epoch,
                          digest: content.digest,
                          goal: content.goal,
                          instructions: content.instructions,
                          notes: content.notes,
                          notesTruncated: content.notesTruncated,
                        }),
                      ),
                    ),
                  )
                : direction === "pull"
                  ? yield* step(
                      peers.linkedContent(member.environmentId, ref).pipe(
                        Effect.flatMap((content) =>
                          coordinatorContentDigest(content) === content.digest
                            ? deps.replicate({
                                projectId: project.id,
                                logicalProjectId: identityId,
                                from: member,
                                fromEpoch: content.epoch,
                                content,
                              })
                            : Effect.fail(new ProjectLinkError({ code: "invalid" })),
                        ),
                        // A newer coordinator's copy is already held: nothing to do.
                        Effect.catchTags({
                          ProjectLinkError: (error) =>
                            error.code === "superseded_conflict" ? Effect.void : Effect.fail(error),
                        }),
                      ),
                    )
                  : null,
          });
        }

        if (kinds.includes("memory")) {
          if (
            (own.memoryDigest !== null && own.memoryDigest === peer.memoryDigest) ||
            sameMemo(memo.memory, own.memoryDigest, peer.memoryDigest, now)
          )
            outcomes.push({ kind: "memory", error: null });
          else {
            const error = yield* syncMemory(selfMember, peerMember);
            outcomes.push({ kind: "memory", error });
            yield* settled("memory", error);
          }
        }

        if (kinds.includes("plan")) {
          // A copy without a native plan to share leaves nothing to merge, as in the app's pass.
          if (
            own.planDigest === null ||
            peer.planDigest === null ||
            sameMemo(memo.plan, own.planDigest, peer.planDigest, now)
          )
            outcomes.push({ kind: "plan", error: null });
          else {
            const error = yield* syncPlans(ref, selfMember, peerMember);
            outcomes.push({ kind: "plan", error });
            yield* settled("plan", error);
          }
        }

        memos.set(key, memo);
        return outcomes;
      });

    const tick = Effect.gen(function* () {
      if (yield* deps.isHeld) return;
      const targets = yield* deps.targets;
      const labels = new Map<string, string>(targets.map((t) => [t.environmentId, t.label]));
      const configured = new Set<string>(labels.keys());
      // A machine that could not be reached and answers again is retried in this pass.
      yield* Effect.forEach(
        (yield* state.unreachable(yield* Clock.currentTimeMillis)).filter((environmentId) =>
          configured.has(environmentId),
        ),
        (environmentId) =>
          peers
            .reachable(environmentId)
            .pipe(Effect.flatMap((up) => (up ? state.peerSeen(environmentId) : Effect.void))),
        { concurrency: 4, discard: true },
      );
      const selfLabel = yield* deps.selfLabel;
      const kept: LinkedPair[] = [];
      for (const project of yield* deps.listProjects)
        for (const { identity, self, member, kinds, legacyOnly, successor } of pairsOf(
          project,
          configured,
        )) {
          const pair: LinkedPair = {
            projectId: project.id as ProjectId,
            peerEnvironmentId: member.environmentId,
            peerProjectId: member.projectId,
          };
          kept.push(pair);
          // A hold that begins mid-pass stops it before the next pair.
          if (yield* deps.isHeld) continue;
          if (!(yield* state.due(pair, yield* Clock.currentTimeMillis))) continue;
          const outcomes = yield* syncPair({
            project,
            identityId: identity.id,
            self,
            member,
            kinds,
            legacyOnly,
            successor,
            pair,
            labels,
            selfLabel,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logDebug("linked peer sync pass failed", { cause }).pipe(
                Effect.as(kinds.map((kind) => ({ kind, error: "failed" as const }))),
              ),
            ),
          );
          yield* state.record(pair, yield* Clock.currentTimeMillis, outcomes);
        }
      yield* state.retain(kept);
      const keys = new Set(kept.map(pairKey));
      for (const key of memos.keys()) if (!keys.has(key)) memos.delete(key);
    }).pipe(
      lock.withPermits(1),
      Effect.catchCause((cause) =>
        Effect.logDebug("Linked copies could not be synced between machines", { cause }),
      ),
    );

    return LinkedPeerSync.of({ tick, signature });
  });

/** Wires the driver to this server's projects, services and peers. */
export const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const link = yield* ProjectLink;
  const memory = yield* LinkedMemorySync;
  const plans = yield* ProjectPlanService;
  const peers = yield* HandoffPeers;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const state = yield* LinkedPeerSyncState;
  const hold = yield* ServiceUpdateHold.optional;
  const guard = yield* Effect.serviceOption(CoordinatorReleaseGuard);
  // Member sync needs the peer route, which ProjectLink itself does not hold.
  yield* link.registerMembersSync({
    refresh: refreshMembersFrom({
      load: (projectId) =>
        projects.getById(projectId).pipe(
          Effect.map(Option.filter((project) => project.deletedAt === null)),
          Effect.orElseSucceed(() => Option.none<Project>()),
        ),
      adoptMembers: link.adoptMembers,
      peers,
    }),
    expedite: state.expedite,
  });
  return yield* makeLinkedPeerSync({
    selfEnvironmentId: yield* environment.getEnvironmentId,
    selfLabel: environment.getDescriptor.pipe(
      Effect.map((descriptor) => descriptor.label ?? "This machine"),
      Effect.orElseSucceed(() => "This machine"),
    ),
    listProjects: projects.snapshot.pipe(
      Effect.map((snapshot) => snapshot.projects.filter((project) => project.deletedAt === null)),
      Effect.orElseSucceed(() => []),
    ),
    targets: peers.targets,
    state,
    isHeld: hold.isHeld,
    describe: (project, member) => describeCopy({ link, memory, plans }, project, member),
    content: (project) =>
      Effect.gen(function* () {
        const binding = project.workspaceSettings?.coordinatorBinding;
        if (binding?.state !== "active")
          return yield* new ProjectLinkError({ code: "not_coordinator" });
        const preview = yield* link.preview({ projectId: project.id });
        return {
          member: preview.member,
          epoch: binding.epoch,
          digest: coordinatorContentDigest(preview),
          goal: preview.goal,
          instructions: preview.instructions,
          notes: preview.notes,
          notesTruncated: preview.notesTruncated,
        };
      }),
    replicate: link.replicateFromMember,
    // As the peer route's supersede: the standby this copy leases to is released, and answers, first.
    giveWay: (input) =>
      Option.match(guard, {
        onNone: () => Effect.void,
        onSome: (value) =>
          value.releaseBefore({
            projectId: input.projectId,
            unless: input.successor,
            changeAnyway: false,
            reason: "supersede",
          }),
      }).pipe(Effect.andThen(link.supersede(input))),
    adoptMembers: link.adoptMembers,
    addPredecessorMembers: link.addPredecessorMembers,
    memory,
    plans,
    peers,
  });
});

/**
 * A transferred copy asks the copy it gave way to for its member list and
 * adopts it; used before a re-arm consent naming a machine this copy does not
 * list. Never fails, and gives up after 15 seconds.
 */
export const refreshMembersFrom =
  (deps: {
    readonly load: (projectId: ProjectId) => Effect.Effect<Option.Option<Project>>;
    readonly adoptMembers: LinkedPeerSyncDeps["adoptMembers"];
    readonly peers: Pick<HandoffPeers["Service"], "linkedDigest">;
  }) =>
  (projectId: ProjectId): Effect.Effect<void> =>
    Effect.gen(function* () {
      const found = yield* deps.load(projectId);
      if (Option.isNone(found)) return;
      const identity = found.value.workspaceSettings?.logicalProject;
      const binding = found.value.workspaceSettings?.coordinatorBinding;
      if (identity === undefined || binding?.state !== "transferred") return;
      const successor = binding.successor;
      if (successor === undefined) return;
      const answer = yield* deps.peers
        .linkedDigest(successor.environmentId, {
          protocolVersion: LINKED_SYNC_PROTOCOL_VERSION,
          logicalProjectId: identity.id,
          projectId: successor.projectId,
        })
        .pipe(Effect.timeout(Duration.seconds(15)));
      // A successor that gave way in turn relays its own successor's list.
      if (
        (answer.binding?.state !== "active" && answer.binding?.state !== "transferred") ||
        answer.members === undefined ||
        logicalProjectMemberKey(answer.member) !== logicalProjectMemberKey(successor)
      )
        return;
      yield* deps.adoptMembers({
        projectId,
        logicalProjectId: identity.id,
        from: answer.member,
        fromEpoch: answer.binding.epoch,
        members: answer.members,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("Could not refresh a linked copy's members", { cause }),
      ),
    );

/**
 * Needs `ProjectService`, `ProjectLink`, `LinkedMemorySync`, `ProjectPlanService`,
 * `HandoffPeers`, `ServerEnvironment` and `LinkedPeerSyncState`; uses
 * `CoordinatorReleaseGuard` when the server provides it, to release a standby
 * before this copy gives way.
 */
export const layer = Layer.effect(LinkedPeerSync, make);

/**
 * Runs a pass every minute, at once when a linked machine reaches this one
 * again, within a minute when a machine that could not be reached answers a
 * probe again, and within seconds of a link being made, for as long as the
 * server runs. Forked after activation, so it never delays startup.
 */
export const start = Effect.gen(function* () {
  const sync = yield* LinkedPeerSync;
  const state = yield* LinkedPeerSyncState;
  const loop = Effect.gen(function* () {
    let seen = yield* sync.signature;
    while (true) {
      const woken = yield* state.nextWake;
      yield* sync.tick;
      seen = yield* sync.signature;
      const linkChanged = Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(Duration.millis(LINK_WATCH_MS));
          const next = yield* sync.signature;
          if (next !== seen) return;
        }
      });
      yield* Effect.raceAll([
        Effect.sleep(Duration.millis(LINKED_PAIR_SYNC_MS)),
        woken,
        linkChanged,
      ]);
    }
  });
  yield* forkParked(loop);
});
