/**
 * Both sides of the `personal-share` exchange (1448 T-14): the caller's two
 * phases toward one peer, the callee's answer, and the decision each applies.
 *
 * The trust boundary, as built: memory content (file names, hashes, text,
 * the link's settings) goes to a peer only when this machine accepts it by
 * its own stored facts (`shareAccess`): its owner listed the peer on this
 * machine, or a seat this one is linked with vouches for it; an own grant
 * exists in at least one direction (on the callee, the grant the caller
 * signed in with; on the caller, the grant it holds there, which the callee
 * checks); and the peer reports the same link id and protocol version. The
 * Connect user id a peer sends is its own word: it can only refuse.
 *
 * A seat never leaves, merges again or saves new copies because a condition
 * lapsed: a failed read or an unreachable peer only pauses and shows why.
 *
 * @module PersonalShareEngine
 */
import { machineAssistantOf } from "@specweave-studio/shared/personalAssistant";
import {
  type EnvironmentId,
  PERSONAL_LINK_PROTOCOL_VERSION,
  type PersonalAssistantShared,
  type PersonalShareMachineState,
  type Project,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { type ConnectAccount, connectAccountReaderStored } from "../cloud/connectAccount.ts";
import * as FleetWorkerGrants from "../fleet/FleetWorkerGrants.ts";
import * as WorkGrants from "../fleet/WorkGrants.ts";
import { HandoffPeerError, HandoffPeers } from "../handoff/handoffPeers.ts";
import { HandoffRefusal, type ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import type {
  PersonalShareContent,
  PersonalSharePhase1,
  PersonalShareRequest,
  PersonalShareResponse,
} from "../handoff/personalShareWire.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as LinkedMemoryHistory from "./LinkedMemoryHistory.ts";
import { personalLinkIdForAccount } from "./personalLinkId.ts";
import { PersonalLinkSnapshot } from "./personalLinkSnapshot.ts";
import { personalPeerSyncDeps } from "./PersonalPeerSync.ts";
import * as PersonalRestorePoint from "./personalRestorePoint.ts";
import {
  decideShareStep,
  type PersonalShareRefusalReason,
  phase1Answer,
  type ShareAccess,
  shareAccess,
  type ShareGrantFacts,
  type ShareGrantKind,
  shareGrantKind,
  type ShareRemoval,
  sharePreconditions,
  type ShareSeatState,
  type ShareSeatView,
  type ShareSelfFacts,
  sharedLinkName,
  type ShareStep,
  waitDetailText,
  withoutRemoved,
} from "./personalShareDecision.ts";
import {
  admitMember,
  adoptMembers,
  joinLink,
  linkedTo,
  PersonalShareLinkError,
  type ShareLinkServices,
  shareContentOf,
  sharedMemoryOf,
  startLink,
} from "./personalShareLink.ts";
import { PersonalShareStates } from "./PersonalShareState.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectWorkspaceService from "./ProjectWorkspaceService.ts";

export interface PersonalShareEngineDeps extends ShareLinkServices {
  readonly selfEnvironmentId: EnvironmentId;
  readonly selfLabel: Effect.Effect<string>;
  readonly account: Effect.Effect<ConnectAccount>;
  /** The switch and the assistant setting; a failed read pauses this machine. */
  readonly settings: Effect.Effect<
    { readonly shared: PersonalAssistantShared; readonly aideEnabled: boolean },
    unknown
  >;
  readonly projects: ShareLinkServices["projects"] &
    Pick<ProjectService.ProjectService["Service"], "snapshot">;
  readonly grants: {
    /** The grant this machine issued to the peer, as `shareGrantKind` reads it. */
    readonly issued: (environmentId: EnvironmentId) => Effect.Effect<ShareGrantKind>;
    /** Whether this machine holds a grant on the peer it can call with. */
    readonly held: (environmentId: EnvironmentId) => Effect.Effect<boolean>;
  };
  readonly peers: Pick<HandoffPeers["Service"], "personalShare">;
  readonly states: PersonalShareStates["Service"];
}

export class PersonalShareEngine extends Context.Service<
  PersonalShareEngine,
  {
    /** The callee's side: answers one request on the peer route. */
    readonly answer: (
      caller: ReceiverCaller,
      request: PersonalShareRequest,
    ) => Effect.Effect<PersonalShareResponse, HandoffRefusal>;
    /** The caller's side toward one peer: both phases and this side's decision. Never fails. */
    readonly exchange: (peer: EnvironmentId) => Effect.Effect<void>;
    /** What this machine stores about calls between it and the peer. */
    readonly reach: (
      peer: EnvironmentId,
    ) => Effect.Effect<{ readonly selfCanCall: boolean; readonly peerCanCall: boolean }>;
    /** The machines this one considers: confirmed here, link members, and vouched for. */
    readonly candidates: Effect.Effect<ReadonlyArray<EnvironmentId>>;
    /** Whether the owner's switch is on here now; a failed read counts as off. */
    readonly switchOn: Effect.Effect<boolean>;
  }
>()("specweave-studio/project/PersonalShareEngine") {}

/** This machine as one exchange sees it. */
interface SelfView {
  readonly facts: ShareSelfFacts;
  readonly shared: PersonalAssistantShared;
  readonly assistant: Project | undefined;
  readonly linked: boolean;
  /** In a link with others under another id (from before the account's link). */
  readonly foreignLink: boolean;
  readonly seat: ShareSeatState | null;
  readonly memory: PersonalShareContent["memory"];
  /** The machines removed from this seat's link, or that left it, with when. */
  readonly removals: ReadonlyArray<ShareRemoval>;
  readonly removed: ReadonlySet<string>;
}

const OWN_REFUSAL_DETAIL: Readonly<Record<PersonalShareRefusalReason, string>> = {
  switch_off:
    "Percy is off on this machine, or it is not linked to SpecWithCode Connect, or the assistant is turned off.",
  not_confirmed:
    "This machine has not confirmed the other one. Run `specwithcode percy on --with <machine>` here.",
  legacy_grant: "The only access between the two machines is an older kind. Pair them again.",
  no_grant: "The two machines have no access to each other.",
  other_account: "The other machine is linked to another SpecWithCode Connect account.",
  older_version: "The other machine runs a version without the shared Percy. Update it.",
};
const PEER_REFUSAL_DETAIL: Readonly<Record<PersonalShareRefusalReason, string>> = {
  switch_off: "Percy is off on the other machine, or it cannot use it right now.",
  not_confirmed:
    "The other machine has not confirmed this one. Run `specwithcode percy on --with <machine>` there.",
  legacy_grant: "The other machine has only an older kind of access for this one. Pair them again.",
  no_grant: "The other machine refused this machine's access.",
  other_account: "The other machine is linked to another SpecWithCode Connect account.",
  older_version: "The other machine says this one runs an older version. Update it.",
};
const FOREIGN_LINK_DETAIL =
  "This machine's Percy is still in a link from before your account's Percy. Turn Percy off and on again here to join it.";
const REMOVED_DETAIL =
  "This machine was removed from Percy here, or left it. It joins again once Percy is turned on there again.";
const PAUSED_DETAIL =
  "Paused: this machine could not read its SpecWithCode Connect sign-in or settings. Nothing changed.";

const isShareLinkError = Schema.is(PersonalShareLinkError);

const seatViewOf = (environmentId: string, seat: ShareSeatState): ShareSeatView => ({
  environmentId,
  start: seat.start,
  linked: seat.linked,
  members: seat.members,
});

const peerViewOf = (state: Extract<PersonalSharePhase1, { accepted: true }>): ShareSeatView => ({
  environmentId: state.environmentId,
  start: state.start,
  linked: state.linked,
  members: state.members,
});

export const makePersonalShareEngine = (deps: PersonalShareEngineDeps) =>
  Effect.sync(() => {
    const { selfEnvironmentId: self, states } = deps;
    // One change of this seat's link at a time: the reconciler, an incoming call and the
    // owner's switch or undo (`PersonalShare`, through the same states) never interleave.
    const applying = states.changing;
    const switchOn: Effect.Effect<boolean> = deps.settings.pipe(
      Effect.map((current) => current.shared.enabled),
      Effect.orElseSucceed(() => false),
    );
    const peerSync = personalPeerSyncDeps(deps.projects, {
      getEnvironmentId: Effect.succeed(self),
    });
    const nowIso = Clock.currentTimeMillis.pipe(
      Effect.map((ms) => DateTime.formatIso(DateTime.makeUnsafe(ms))),
    );

    /** This machine now; null while its Connect sign-in, settings or projects cannot be read. */
    const readSelf: Effect.Effect<SelfView | null> = Effect.gen(function* () {
      const account = yield* deps.account;
      if (account.status === "unknown") return null;
      const read = yield* deps.settings.pipe(Effect.result);
      if (Result.isFailure(read)) return null;
      const { shared, aideEnabled } = read.success;
      const snapshot = yield* deps.projects.snapshot.pipe(Effect.result);
      if (Result.isFailure(snapshot)) return null;
      const assistant = machineAssistantOf(snapshot.success.projects);
      const linkId =
        account.status === "linked" ? personalLinkIdForAccount(account.cloudUserId) : null;
      const identity = assistant?.workspaceSettings?.logicalProject;
      const linked = linkedTo(assistant, linkId);
      const foreignLink = !linked && (identity?.members.length ?? 0) > 1;
      const members = linked
        ? identity!.members.map((member) => member.environmentId as string)
        : [];
      const vouches = yield* states.vouches;
      const vouched = new Set<string>(members);
      for (const member of members)
        for (const id of vouches.get(member as EnvironmentId) ?? []) vouched.add(id);
      vouched.delete(self);
      // A seat removed from this link, or that left it, stays out until its owner turns its
      // switch on again (`removalStands`); a later link of it clears the entry.
      const removals = (assistant?.workspaceSettings?.coordinatorBinding?.removedMembers ?? []).map(
        (entry) => ({ environmentId: entry.environmentId as string, removedAt: entry.removedAt }),
      );
      const confirmed = new Set<string>(shared.machines);
      const files =
        assistant === undefined
          ? []
          : yield* deps.workspace
              .readMemoryFiles({ projectId: assistant.id })
              .pipe(Effect.orElseSucceed(() => []));
      const memory =
        assistant === undefined ? { files: [], index: null } : sharedMemoryOf(assistant, files);
      const ready =
        linkId !== null &&
        aideEnabled &&
        assistant !== undefined &&
        !foreignLink &&
        assistant.workspaceSettings?.archived !== true;
      return {
        facts: {
          environmentId: self,
          switchOn: shared.enabled,
          ready,
          linkId,
          confirmed,
          vouched,
        },
        removals,
        removed: new Set(removals.map((entry) => entry.environmentId)),
        shared,
        assistant,
        linked,
        foreignLink,
        memory,
        seat:
          linkId === null
            ? null
            : {
                linkId,
                start: shared.start ?? false,
                name: shared.name,
                linked,
                members,
                memoryFileCount: memory.files.length,
                switchedOnAt: shared.enabled ? shared.enabledAt : undefined,
              },
      };
    });

    /** This seat's facts for `peer`, without it while a removal keeps it out. */
    const factsFor = (view: SelfView, peer: EnvironmentId, switchedOnAt: string | undefined) =>
      withoutRemoved(view.facts, view.removals, peer, switchedOnAt);

    const answerFor = (view: SelfView, access: ShareAccess): PersonalSharePhase1 => {
      const seat = view.seat;
      return phase1Answer(
        self,
        seat === null ? { ok: false, reason: "switch_off" } : access,
        () => seat!,
      );
    };

    const contentOf = (view: SelfView): PersonalShareContent | undefined =>
      view.assistant === undefined
        ? undefined
        : shareContentOf(view.assistant, self, view.facts.linkId, view.memory);

    const record = (
      peer: EnvironmentId,
      state: PersonalShareMachineState,
      detail?: string,
      synced = false,
    ) =>
      Effect.gen(function* () {
        yield* states.record(peer, {
          state,
          ...(detail === undefined ? {} : { detail }),
          ...(synced ? { lastSyncedAt: yield* nowIso } : {}),
        });
      });

    /** A lapse: the pair keeps the state it had and shows that this machine paused. */
    const recordPaused = (peer: EnvironmentId) =>
      Effect.gen(function* () {
        const known = (yield* states.states).get(peer)?.state ?? "waiting";
        yield* record(peer, known, PAUSED_DETAIL);
      });

    const recordOwnRefusal = (
      peer: EnvironmentId,
      view: SelfView,
      reason: PersonalShareRefusalReason,
    ) =>
      record(
        peer,
        reason,
        view.foreignLink
          ? FOREIGN_LINK_DETAIL
          : reason === "not_confirmed" && view.removed.has(peer)
            ? REMOVED_DETAIL
            : OWN_REFUSAL_DETAIL[reason],
      );

    /** A peer's accepted answer: a member this seat is linked with vouches for the seats it lists. */
    const learnVouches = (view: SelfView, state: PersonalSharePhase1) =>
      state.accepted && view.linked && view.seat?.members.includes(state.environmentId)
        ? states.setVouches(state.environmentId as EnvironmentId, state.linked ? state.members : [])
        : Effect.void;

    /**
     * Applies this seat's decision about `peer`, under the lock and on this
     * seat as it is now. Records the outcome; never fails.
     */
    const apply = (
      peer: EnvironmentId,
      peerState: Extract<PersonalSharePhase1, { accepted: true }>,
      peerContent: PersonalShareContent,
      checks: {
        /** The grant facts as they are now, for this side. */
        readonly grant: Effect.Effect<ShareGrantFacts>;
        readonly protocolVersion: number | null;
        readonly linkId: string | null;
        readonly switchedOnAt: string | undefined;
      },
    ) =>
      applying(
        Effect.gen(function* () {
          const view = yield* readSelf;
          if (view === null) {
            return yield* recordPaused(peer);
          }
          const project = view.assistant;
          const seat = view.seat;
          if (project === undefined || seat === null || view.facts.linkId === null)
            return yield* recordOwnRefusal(peer, view, "switch_off");
          // The owner may have turned Percy off or dropped the peer while the calls ran.
          const still = shareAccess(
            factsFor(view, peer, checks.switchedOnAt),
            { environmentId: peer, protocolVersion: checks.protocolVersion, linkId: checks.linkId },
            yield* checks.grant,
          );
          if (!still.ok) return yield* recordOwnRefusal(peer, view, still.reason);
          // A content that names another machine than the one answering is not this pair's.
          if (peerContent.self.environmentId !== peer)
            return yield* record(
              peer,
              "waiting",
              "The other machine sent another machine's Percy.",
            );
          const step: ShareStep = decideShareStep(seatViewOf(self, seat), peerViewOf(peerState));
          const now = yield* nowIso;
          const outcome = yield* Effect.gen(function* () {
            switch (step.kind) {
              case "in_step": {
                yield* peerSync
                  .syncPersonalSettings({ project, peerSettings: peerContent.settings })
                  .pipe(Effect.ignore);
                const fresh = yield* deps.projects.getById(project.id).pipe(
                  Effect.map(Option.getOrElse(() => project)),
                  Effect.orElseSucceed(() => project),
                );
                yield* adoptMembers(deps, {
                  project: fresh,
                  peer: peerContent,
                  nowIso: now,
                }).pipe(Effect.ignore);
                return yield* record(peer, "joined", undefined, true);
              }
              case "join": {
                const title =
                  peerContent.link?.title ??
                  sharedLinkName(
                    { name: peerState.name, assistantName: peerContent.settings.title },
                    { assistantName: project.title },
                  );
                yield* joinLink(deps, {
                  project,
                  selfEnvironmentId: self,
                  machineLabel: yield* deps.selfLabel,
                  linkId: view.facts.linkId!,
                  title,
                  peer: peerContent,
                  nowIso: now,
                  ...(seat.switchedOnAt === undefined ? {} : { switchedOnAt: seat.switchedOnAt }),
                  switchOn,
                });
                return yield* record(
                  peer,
                  "waiting",
                  waitDetailText("peer_admits", step.startIgnored),
                );
              }
              case "start":
                yield* startLink(deps, {
                  project,
                  selfEnvironmentId: self,
                  linkId: view.facts.linkId!,
                  peer: peerContent,
                  nowIso: now,
                  ...(seat.switchedOnAt === undefined ? {} : { switchedOnAt: seat.switchedOnAt }),
                  switchOn,
                });
                return yield* record(peer, "joined", undefined, true);
              case "admit":
                yield* admitMember(deps, { project, peer: peerContent, nowIso: now, switchOn });
                return yield* record(peer, "joined", undefined, true);
              case "wait":
                return yield* record(
                  peer,
                  "waiting",
                  waitDetailText(step.detail, step.startIgnored),
                );
            }
          }).pipe(Effect.result);
          if (Result.isFailure(outcome)) {
            const failure = outcome.failure;
            // The switch went off while the link was being made: nothing was linked.
            if (isShareLinkError(failure) && failure.stage === "switched_off")
              return yield* recordOwnRefusal(peer, view, "switch_off");
            yield* record(peer, "waiting", failure.message);
          }
        }),
      );

    const grantFacts = (peer: EnvironmentId) =>
      Effect.gen(function* () {
        const issued = yield* deps.grants.issued(peer);
        const held = (yield* deps.grants.held(peer)) && !(yield* states.heldRefused(peer));
        return { issued, heldUsable: held } satisfies ShareGrantFacts;
      });

    const answer: PersonalShareEngine["Service"]["answer"] = (caller, request) =>
      Effect.gen(function* () {
        const peer = caller.sourceEnvironmentId;
        // The caller is the machine its grant names, never one its body names.
        if (request.state.environmentId !== peer)
          return yield* new HandoffRefusal({
            status: 403,
            code: "needs_grant",
            message: "A machine may speak only for itself.",
          });
        // The peer is calling: the reconciler's liveness check reads this.
        yield* states.markInbound(peer);
        const view = yield* readSelf;
        if (view === null) {
          yield* recordPaused(peer);
          return yield* new HandoffRefusal({
            status: 503,
            code: "unreachable",
            message:
              "This machine could not read its SpecWithCode Connect sign-in; try again later.",
          });
        }
        // Both the header and the body must name this account: either alone is the caller's word.
        const headerLink =
          caller.cloudUserId === undefined || caller.cloudUserId === null
            ? null
            : personalLinkIdForAccount(caller.cloudUserId);
        const claimedLink =
          request.linkId !== null && request.linkId === headerLink ? request.linkId : null;
        // Only the grant this machine issued and the caller signed in with counts here.
        const grant: ShareGrantFacts = { issued: shareGrantKind(caller.grant), heldUsable: false };
        const peerOn = request.state.accepted ? request.state.switchedOnAt : undefined;
        const access = shareAccess(
          factsFor(view, peer, peerOn),
          { environmentId: peer, protocolVersion: request.protocolVersion, linkId: claimedLink },
          grant,
        );
        const own = answerFor(view, access);
        if (!access.ok) {
          yield* recordOwnRefusal(peer, view, access.reason);
          return { state: own };
        }
        yield* learnVouches(view, request.state);
        if (!request.state.accepted) {
          yield* record(peer, request.state.reason, PEER_REFUSAL_DETAIL[request.state.reason]);
          return { state: own };
        }
        if (request.phase === 1 || request.content === undefined) return { state: own };
        yield* apply(peer, request.state, request.content, {
          grant: Effect.succeed(grant),
          protocolVersion: request.protocolVersion,
          linkId: claimedLink,
          switchedOnAt: peerOn,
        });
        const after = yield* readSelf;
        if (after === null) return { state: own };
        const again = shareAccess(
          factsFor(after, peer, peerOn),
          { environmentId: peer, protocolVersion: request.protocolVersion, linkId: claimedLink },
          grant,
        );
        const content = again.ok ? contentOf(after) : undefined;
        return {
          state: answerFor(after, again),
          ...(content === undefined ? {} : { content }),
        };
      });

    /** What a failed call says about the pair; a refused grant there flips the driver. */
    const recordFailure = (peer: EnvironmentId, error: unknown) =>
      Effect.gen(function* () {
        if (!(error instanceof HandoffPeerError))
          return yield* record(
            peer,
            "waiting",
            "The exchange failed on this machine; it tries again.",
          );
        if (error.check === "version" || error.needsUpdate === true)
          return yield* record(peer, "older_version", OWN_REFUSAL_DETAIL.older_version);
        if (error.code === "needs_grant") {
          if (error.local !== true) yield* states.markHeldRefused(peer);
          return yield* record(peer, "no_grant", OWN_REFUSAL_DETAIL.no_grant);
        }
        if (error.code === "unreachable")
          return yield* record(
            peer,
            "offline",
            "The other machine did not answer; it is tried again.",
          );
        return yield* record(
          peer,
          "waiting",
          "The other machine refused the exchange; it is tried again.",
        );
      });

    const exchange: PersonalShareEngine["Service"]["exchange"] = (peer) =>
      Effect.gen(function* () {
        const view = yield* readSelf;
        if (view === null) {
          return yield* recordPaused(peer);
        }
        const grant = yield* grantFacts(peer);
        // Before the peer has said when its switch went on, a removal of it keeps it out.
        const pre = sharePreconditions(factsFor(view, peer, undefined), peer, grant);
        const mine = answerFor(view, pre);
        const base = {
          protocolVersion: PERSONAL_LINK_PROTOCOL_VERSION,
          linkId: view.facts.linkId,
          state: mine,
        };
        const first = yield* deps.peers
          .personalShare(peer, { ...base, phase: 1 })
          .pipe(Effect.result);
        if (Result.isFailure(first)) return yield* recordFailure(peer, first.failure);
        const theirs = first.success.state;
        if (theirs.environmentId !== peer)
          return yield* record(peer, "waiting", "The other machine answered as another machine.");
        if (!theirs.accepted) {
          if (theirs.reason === "legacy_grant" || theirs.reason === "no_grant")
            yield* states.markHeldRefused(peer);
          return yield* record(peer, theirs.reason, PEER_REFUSAL_DETAIL[theirs.reason]);
        }
        const access = shareAccess(
          factsFor(view, peer, theirs.switchedOnAt),
          { environmentId: peer, protocolVersion: theirs.protocolVersion, linkId: theirs.linkId },
          grant,
        );
        // Content goes only to a peer this machine accepts by its own facts, and that accepted it.
        if (!access.ok) return yield* recordOwnRefusal(peer, view, access.reason);
        yield* learnVouches(view, theirs);
        // Read again: the owner may have changed the switch while the first call ran.
        const fresh = yield* readSelf;
        if (fresh === null) {
          return yield* recordPaused(peer);
        }
        const claims = {
          environmentId: peer,
          protocolVersion: theirs.protocolVersion,
          linkId: theirs.linkId,
        };
        const now = shareAccess(
          factsFor(fresh, peer, theirs.switchedOnAt),
          claims,
          yield* grantFacts(peer),
        );
        if (!now.ok) return yield* recordOwnRefusal(peer, fresh, now.reason);
        const content = contentOf(fresh);
        if (content === undefined) return yield* recordOwnRefusal(peer, fresh, "switch_off");
        const second = yield* deps.peers
          .personalShare(peer, {
            protocolVersion: PERSONAL_LINK_PROTOCOL_VERSION,
            linkId: fresh.facts.linkId,
            state: answerFor(fresh, now),
            phase: 2,
            content,
          })
          .pipe(Effect.result);
        if (Result.isFailure(second)) return yield* recordFailure(peer, second.failure);
        const after = second.success.state;
        if (after.environmentId !== peer)
          return yield* record(peer, "waiting", "The other machine answered as another machine.");
        if (!after.accepted)
          return yield* record(peer, after.reason, PEER_REFUSAL_DETAIL[after.reason]);
        if (second.success.content === undefined)
          return yield* record(peer, "waiting", "The other machine sent nothing to link with yet.");
        yield* apply(peer, after, second.success.content, {
          grant: grantFacts(peer),
          protocolVersion: after.protocolVersion,
          linkId: after.linkId,
          switchedOnAt: after.switchedOnAt,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("Percy share exchange failed", { cause }).pipe(
            Effect.andThen(
              record(peer, "waiting", "The exchange failed on this machine; it tries again."),
            ),
          ),
        ),
      );

    const reach: PersonalShareEngine["Service"]["reach"] = (peer) =>
      Effect.gen(function* () {
        const grant = yield* grantFacts(peer);
        return { selfCanCall: grant.heldUsable, peerCanCall: grant.issued === "own" };
      });

    const candidates: PersonalShareEngine["Service"]["candidates"] = Effect.gen(function* () {
      const view = yield* readSelf;
      if (view === null) return [...(yield* states.states).keys()];
      const identity = view.assistant?.workspaceSettings?.logicalProject;
      const ids = new Set<string>([
        ...view.shared.machines,
        ...(view.linked ? (identity?.members ?? []).map((member) => member.environmentId) : []),
        ...view.facts.vouched,
      ]);
      ids.delete(self);
      return [...ids].map((id) => id as EnvironmentId);
    });

    return PersonalShareEngine.of({ answer, exchange, reach, candidates, switchOn });
  });

/** The grant this machine issued to `peer`, as the share rule reads it; unreadable is none. */
const issuedGrant = (grants: WorkGrants.WorkGrantsShape, peer: EnvironmentId) =>
  Effect.gen(function* () {
    if (!grants.enabled || grants.peekPolicy === undefined) return "none" as const;
    const record = yield* grants.peekPolicy(peer);
    if (record === undefined) return "none" as const;
    return shareGrantKind(
      WorkGrants.effectiveGrant(record, yield* grants.managers, yield* Clock.currentTimeMillis),
    );
  }).pipe(Effect.orElseSucceed((): ShareGrantKind => "none"));

/** Wires the engine to this server's projects, settings, grants and peers. */
export const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const workspace = yield* ProjectWorkspaceService.ProjectWorkspaceService;
  const histories = yield* LinkedMemoryHistory.LinkedMemoryHistory;
  const restorePoints = yield* PersonalRestorePoint.PersonalRestorePoint;
  const snapshot = yield* PersonalLinkSnapshot;
  const settings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const grants = yield* WorkGrants.WorkGrants;
  const workers = yield* FleetWorkerGrants.FleetWorkerGrants;
  const peers = yield* HandoffPeers;
  const states = yield* PersonalShareStates;
  return yield* makePersonalShareEngine({
    selfEnvironmentId: yield* environment.getEnvironmentId,
    selfLabel: environment.getDescriptor.pipe(
      Effect.map((descriptor) => descriptor.label ?? "This machine"),
      Effect.orElseSucceed(() => "This machine"),
    ),
    account: yield* connectAccountReaderStored,
    settings: settings.getSettings.pipe(
      Effect.map((current) => ({
        shared: current.personalAssistantShared,
        aideEnabled: current.aideEnabled,
      })),
    ),
    projects,
    workspace,
    histories,
    restorePoints,
    snapshot,
    grants: {
      issued: (peer) => issuedGrant(grants, peer),
      held: (peer) =>
        peers.target(peer).pipe(
          Effect.flatMap((target) => workers.status(target.machineId)),
          Effect.map(
            (status) =>
              status.status === "allowed" ||
              status.status === "expiring" ||
              (status.status === "expired" && status.renewable),
          ),
          Effect.orElseSucceed(() => false),
        ),
    },
    peers,
    states,
  });
});

/**
 * Needs `ProjectService`, `ProjectWorkspaceService`, `LinkedMemoryHistory`,
 * `PersonalRestorePoint`, `ServerSettingsService`, `ServerEnvironment`,
 * `FleetWorkerGrants`, `HandoffPeers` and `PersonalShareStates`.
 */
export const layer = Layer.effect(PersonalShareEngine, make);
