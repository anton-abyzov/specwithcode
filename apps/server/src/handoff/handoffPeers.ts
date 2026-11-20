import {
  CoordinatorMessageReceiptRequest,
  CoordinatorMessageReceiptResponse,
} from "./coordinatorMessageWire.ts";
import {
  CoordinatorMessageReadRequest,
  CoordinatorMessageReadResponse,
} from "./coordinatorMessageWire.ts";
import {
  CoordinatorMessageDeliverRequest,
  CoordinatorMessageDeliverResponse,
} from "./coordinatorMessageWire.ts";
/**
 * The source side of the machine-to-machine handoff API. Every call goes to
 * a configured private machine (pinned environment id, verified identity)
 * with this server's worker credential on it, never anywhere else.
 *
 * A refusal the destination answered is definite: nothing changed there. A
 * call that never got an answer is uncertain, which matters for a takeover:
 * the destination may have continued the thread, so the source must not run
 * it again at the old epoch.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import {
  type EnvironmentId,
  type HandoffModeErrorCode,
  type HandoffPreflightCheck,
  LinkedMemoryExport,
  LinkedMemoryExportInput,
  LinkedMemoryMergeInput,
  LinkedMemoryMergeResult,
  type ProjectPlanLinkExport,
  ProjectPlanLinkMergeResult,
} from "@specweave-studio/contracts";

import { teamRulesHoldRefusal } from "@specweave-studio/shared/teamRules";
import * as FleetTargets from "../fleet/FleetTargets.ts";
import { currentTeamRules } from "../teamRules/TeamRules.ts";
import {
  type FleetOrigin,
  fleetAddresses,
  fleetAuthorization,
  fleetMachineKey,
  reachFleetMachine,
  fleetReachMayBeRemembered,
} from "../fleet/fleetTransport.ts";
import * as FleetWorkerGrants from "../fleet/FleetWorkerGrants.ts";
import { stringifyJson } from "../json.ts";
import { FleetError, type FleetTarget, readBoundedJson } from "../studioFleet.ts";
import {
  CoordinatorLeaseRequest,
  CoordinatorLeaseResponse,
  CoordinatorReplicaRequest,
  CoordinatorReplicaResponse,
  encodeFrame,
  ExtrasNegotiateRequest,
  ExtrasReplicateMeta,
  ExtrasReplicateResponse,
  HANDOFF_JSON_MAX_BYTES,
  HANDOFF_PEER_PREFIX,
  HeartbeatRequest,
  HeartbeatResponse,
  LINKED_MEMORY_PEER_MAX_BYTES,
  LINKED_SYNC_PEER_MAX_BYTES,
  NegotiateRequest,
  NegotiateResponse,
  PeerErrorBody,
  type PeerPath,
  PeerPreflightRequest,
  reviewPath,
  PeerPreflightResponse,
  ReplicateMeta,
  ReplicateResponse,
  TakeoverRequest,
  TakeoverResponse,
  TransferPullRequest,
  TransferStatusRequest,
  TransferStatusResponse,
  FolderWorkRequest,
  FolderWorkResponse,
  unknownFolderWorkPath,
} from "./handoffWire.ts";
import { reviewStaysText } from "./handoffReviewLock.ts";
import { PeerCheckRequest, PeerCheckResponse, unknownCheckPath } from "./handoffPlan.ts";
import {
  LinkedContentRequest,
  LinkedContentResponse,
  LinkedDigestRequest,
  LinkedDigestResponse,
  LinkedMembersRequest,
  LinkedMembersResponse,
  LinkedPlanExportRequest,
  LinkedPlanExportResponse,
  LinkedPlanMergeRequest,
  LinkedReplicaRequest,
  LinkedReplicaResponse,
  LinkedSupersedeRequest,
  LinkedSupersedeResponse,
} from "./linkedSyncWire.ts";

const IDENTITY_TTL_MS = 5 * 60_000;
/** The calls that move work off this machine: they need readable Team rules. */
const LEAVES_THIS_MACHINE: ReadonlySet<PeerPath> = new Set([
  "replicate",
  "takeover",
  "extras-replicate",
  "review-replicate",
  "review-takeover",
  // A message and a report read carry this project's words and files to another machine.
  "coordinator-message",
  "coordinator-message-read",
]);

/** A request this machine cannot encode never leaves it: a definite, local refusal. */
const encodeLocal = <S extends Schema.Top>(schema: S, value: S["Type"]) =>
  Schema.encodeEffect(schema)(value).pipe(
    Effect.mapError(
      (error) =>
        new HandoffPeerError({
          code: "invalid",
          message: `The request is not valid: ${error.message}`,
          uncertain: false,
          local: true,
        }),
    ),
  );
const TIMEOUT_MS: Record<PeerPath, number> = {
  negotiate: 15_000,
  replicate: 120_000,
  preflight: 30_000,
  takeover: 180_000,
  heartbeat: 10_000,
  "coordinator-lease": 10_000,
  "coordinator-replica": 10_000,
  "memory-export": 60_000,
  "memory-merge": 60_000,
  "linked-digest": 15_000,
  "linked-content": 60_000,
  "linked-replica": 60_000,
  "linked-supersede": 30_000,
  "linked-members": 15_000,
  "plan-export": 60_000,
  "plan-merge": 60_000,
  "extras-negotiate": 15_000,
  "extras-replicate": 120_000,
  "transfer-status": 15_000,
  // The source stops its turn (up to 45 seconds) and waits for this machine's takeover.
  "transfer-pull": 300_000,
  "review-replicate": 120_000,
  "review-takeover": 180_000,
  check: 30_000,
  "folder-work": 120_000,
  // A message is small and the receiver answers before its agent reads it.
  "coordinator-message": 15_000,
  "coordinator-message-read": 15_000,
  "coordinator-message-receipt": 15_000,
};
/** A memory page, a coordinator's content or a plan answers with up to the link cap; the rest is small. */
const answerLimit = (path: PeerPath) =>
  path === "memory-export"
    ? LINKED_MEMORY_PEER_MAX_BYTES
    : path === "linked-content" ||
        path === "plan-export" ||
        path === "linked-digest" ||
        path === "linked-supersede"
      ? LINKED_SYNC_PEER_MAX_BYTES
      : HANDOFF_JSON_MAX_BYTES;

export class HandoffPeerError extends Data.TaggedError("HandoffPeerError")<{
  readonly code: HandoffModeErrorCode;
  readonly message: string;
  readonly check?: HandoffPreflightCheck | undefined;
  /** No answer came back: the destination may or may not have acted. */
  readonly uncertain: boolean;
  /**
   * The call failed on this machine before it reached the destination (no such
   * machine, no credential, identity check failed; not a network that carried
   * no answer, which is plain unreachable). Nothing changed there for
   * this call, but it is no refusal from the destination either, so it never
   * settles an earlier takeover that is still in doubt.
   */
  readonly local?: boolean | undefined;
  /**
   * For a local `needs_grant` from this machine's own grant there: "none" when
   * it holds none (never allowed, or the owner stopped it here), otherwise
   * whether the grant it held was revoked there or expired.
   */
  readonly grant?: "none" | "revoked" | "expired" | undefined;
  /** The destination runs a version from before this call existed. */
  readonly needsUpdate?: boolean | undefined;
}> {}

const unreachable = (label: string, uncertain: boolean, local = false) =>
  new HandoffPeerError({
    code: "unreachable",
    message: `${label} did not answer.`,
    uncertain,
    ...(local ? { local } : {}),
  });

export interface HandoffPeerTarget {
  readonly machineId: string;
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export class HandoffPeers extends Context.Service<
  HandoffPeers,
  {
    /** The configured private machine with this environment id. */
    readonly target: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<HandoffPeerTarget, HandoffPeerError>;
    readonly targets: Effect.Effect<ReadonlyArray<HandoffPeerTarget>>;
    /**
     * Whether this machine can reach `environmentId` now with its work grant
     * there: an address answers as that machine. Sends no request.
     */
    readonly reachable: (environmentId: EnvironmentId) => Effect.Effect<boolean>;
    readonly coordinatorMessageReceipt: (
      environmentId: EnvironmentId,
      request: CoordinatorMessageReceiptRequest,
    ) => Effect.Effect<CoordinatorMessageReceiptResponse, HandoffPeerError>;
    readonly coordinatorMessageRead: (
      environmentId: EnvironmentId,
      request: CoordinatorMessageReadRequest,
    ) => Effect.Effect<CoordinatorMessageReadResponse, HandoffPeerError>;
    readonly coordinatorMessage: (
      environmentId: EnvironmentId,
      request: CoordinatorMessageDeliverRequest,
    ) => Effect.Effect<CoordinatorMessageDeliverResponse, HandoffPeerError>;
    readonly negotiate: (
      environmentId: EnvironmentId,
      request: NegotiateRequest,
    ) => Effect.Effect<NegotiateResponse, HandoffPeerError>;
    readonly replicate: (
      environmentId: EnvironmentId,
      meta: ReplicateMeta,
      bundle: Uint8Array | null,
    ) => Effect.Effect<ReplicateResponse, HandoffPeerError>;
    readonly preflight: (
      environmentId: EnvironmentId,
      request: PeerPreflightRequest,
    ) => Effect.Effect<PeerPreflightResponse, HandoffPeerError>;
    readonly takeover: (
      environmentId: EnvironmentId,
      request: TakeoverRequest,
    ) => Effect.Effect<TakeoverResponse, HandoffPeerError>;
    readonly heartbeat: (
      environmentId: EnvironmentId,
      request: HeartbeatRequest,
    ) => Effect.Effect<HeartbeatResponse, HandoffPeerError>;
    /** To the armed standby: the coordinator is alive, pausing, or releasing it. */
    readonly coordinatorLease: (
      environmentId: EnvironmentId,
      request: CoordinatorLeaseRequest,
    ) => Effect.Effect<CoordinatorLeaseResponse, HandoffPeerError>;
    readonly coordinatorReplica: (
      environmentId: EnvironmentId,
      request: CoordinatorReplicaRequest,
    ) => Effect.Effect<CoordinatorReplicaResponse, HandoffPeerError>;
    /** One page of the linked copy's memory there. */
    readonly memoryExport: (
      environmentId: EnvironmentId,
      request: LinkedMemoryExportInput,
    ) => Effect.Effect<LinkedMemoryExport, HandoffPeerError>;
    /** Merges another copy's page into the linked copy there. */
    readonly memoryMerge: (
      environmentId: EnvironmentId,
      request: LinkedMemoryMergeInput,
    ) => Effect.Effect<LinkedMemoryMergeResult, HandoffPeerError>;
    /** Server-driven sync of a linked copy there (`linkedSyncWire.ts`). */
    readonly linkedDigest: (
      environmentId: EnvironmentId,
      request: LinkedDigestRequest,
    ) => Effect.Effect<LinkedDigestResponse, HandoffPeerError>;
    readonly linkedContent: (
      environmentId: EnvironmentId,
      request: LinkedContentRequest,
    ) => Effect.Effect<LinkedContentResponse, HandoffPeerError>;
    readonly linkedReplica: (
      environmentId: EnvironmentId,
      request: LinkedReplicaRequest,
    ) => Effect.Effect<LinkedReplicaResponse, HandoffPeerError>;
    readonly linkedSupersede: (
      environmentId: EnvironmentId,
      request: LinkedSupersedeRequest,
    ) => Effect.Effect<LinkedSupersedeResponse, HandoffPeerError>;
    /** The coordinator's member list, for the linked copy there to adopt. */
    readonly linkedMembers: (
      environmentId: EnvironmentId,
      request: LinkedMembersRequest,
    ) => Effect.Effect<LinkedMembersResponse, HandoffPeerError>;
    readonly planExport: (
      environmentId: EnvironmentId,
      request: LinkedPlanExportRequest,
    ) => Effect.Effect<ProjectPlanLinkExport, HandoffPeerError>;
    readonly planMerge: (
      environmentId: EnvironmentId,
      request: LinkedPlanMergeRequest,
    ) => Effect.Effect<ProjectPlanLinkMergeResult, HandoffPeerError>;
    /** Sync extras (1390): which of these commits the repository there holds. */
    readonly extrasNegotiate: (
      environmentId: EnvironmentId,
      request: ExtrasNegotiateRequest,
    ) => Effect.Effect<NegotiateResponse, HandoffPeerError>;
    /** Sync extras: one bundle, landed there as a branch `swc/from-{machine}/…`. */
    readonly extrasReplicate: (
      environmentId: EnvironmentId,
      meta: ExtrasReplicateMeta,
      bundle: Uint8Array | null,
    ) => Effect.Effect<ExtrasReplicateResponse, HandoffPeerError>;
    /** What became of a takeover this machine has no answer for (1390). */
    readonly transferStatus: (
      environmentId: EnvironmentId,
      request: TransferStatusRequest,
    ) => Effect.Effect<TransferStatusResponse, HandoffPeerError>;
    /** Asks the machine that runs a thread to hand it to this one (1390). */
    /** What the machine would run a thread on, asked before anything is copied there. */
    readonly check: (
      environmentId: EnvironmentId,
      request: PeerCheckRequest,
    ) => Effect.Effect<PeerCheckResponse, HandoffPeerError>;
    readonly transferPull: (
      environmentId: EnvironmentId,
      request: TransferPullRequest,
    ) => Effect.Effect<TakeoverResponse, HandoffPeerError>;
    /** A hand off batch's folder work: put the snapshot that arrived into the working folder there. */
    readonly folderWork: (
      environmentId: EnvironmentId,
      request: FolderWorkRequest,
    ) => Effect.Effect<FolderWorkResponse, HandoffPeerError>;
  }
>()("specweave-studio/handoff/handoffPeers") {}

const encodeNegotiate = Schema.encodeSync(NegotiateRequest);
const encodeExtrasNegotiate = Schema.encodeSync(ExtrasNegotiateRequest);
const encodeExtrasMeta = Schema.encodeSync(ExtrasReplicateMeta);
const decodeExtrasReplicate = Schema.decodeUnknownOption(ExtrasReplicateResponse);
const encodeMeta = Schema.encodeSync(ReplicateMeta);
const encodePreflight = Schema.encodeSync(PeerPreflightRequest);
const encodeFolderWork = Schema.encodeSync(FolderWorkRequest);
const decodeFolderWork = Schema.decodeUnknownOption(FolderWorkResponse);
const encodeCheck = Schema.encodeSync(PeerCheckRequest);
const decodeCheck = Schema.decodeUnknownOption(PeerCheckResponse);
const encodeTakeover = Schema.encodeSync(TakeoverRequest);
const encodeHeartbeat = Schema.encodeSync(HeartbeatRequest);
const encodeCoordinatorLease = Schema.encodeSync(CoordinatorLeaseRequest);
const encodeCoordinatorReplica = Schema.encodeSync(CoordinatorReplicaRequest);
const encodeMemoryExport = Schema.encodeSync(LinkedMemoryExportInput);
const encodeMemoryMerge = Schema.encodeSync(LinkedMemoryMergeInput);
const decodeMemoryExport = Schema.decodeUnknownOption(LinkedMemoryExport);
const decodeMemoryMerge = Schema.decodeUnknownOption(LinkedMemoryMergeResult);
const decodeError = Schema.decodeUnknownOption(PeerErrorBody);
const encodeLinkedDigest = Schema.encodeSync(LinkedDigestRequest);
const encodeLinkedContent = Schema.encodeSync(LinkedContentRequest);
const encodeLinkedReplica = Schema.encodeSync(LinkedReplicaRequest);
const encodeLinkedSupersede = Schema.encodeSync(LinkedSupersedeRequest);
const encodeLinkedMembers = Schema.encodeSync(LinkedMembersRequest);
const encodePlanExport = Schema.encodeSync(LinkedPlanExportRequest);
const encodePlanMerge = Schema.encodeSync(LinkedPlanMergeRequest);
const decodeLinkedDigest = Schema.decodeUnknownOption(LinkedDigestResponse);
const decodeLinkedContent = Schema.decodeUnknownOption(LinkedContentResponse);
const decodeLinkedReplica = Schema.decodeUnknownOption(LinkedReplicaResponse);
const decodeLinkedSupersede = Schema.decodeUnknownOption(LinkedSupersedeResponse);
const decodeLinkedMembers = Schema.decodeUnknownOption(LinkedMembersResponse);
const decodePlanExport = Schema.decodeUnknownOption(LinkedPlanExportResponse);
const decodePlanMerge = Schema.decodeUnknownOption(ProjectPlanLinkMergeResult);
const decodeNegotiate = Schema.decodeUnknownOption(NegotiateResponse);
const decodeReplicate = Schema.decodeUnknownOption(ReplicateResponse);
const decodePreflight = Schema.decodeUnknownOption(PeerPreflightResponse);
const decodeTakeover = Schema.decodeUnknownOption(TakeoverResponse);
const decodeHeartbeat = Schema.decodeUnknownOption(HeartbeatResponse);
const encodeTransferStatus = Schema.encodeSync(TransferStatusRequest);
const decodeTransferStatus = Schema.decodeUnknownOption(TransferStatusResponse);
const encodeTransferPull = Schema.encodeSync(TransferPullRequest);
const decodeCoordinatorLease = Schema.decodeUnknownOption(CoordinatorLeaseResponse);
const decodeCoordinatorReplica = Schema.decodeUnknownOption(CoordinatorReplicaResponse);

const jsonBody = (value: unknown) => new TextEncoder().encode(stringifyJson(value));

/**
 * How a source reads an answer that is not a success. One with the refusal body
 * (`error`, and `code` and `check`) is the destination's definite refusal. Any
 * other 5xx may come after the destination acted (a proxy, or a destination that
 * cannot tell), so it is in doubt, as no answer is; any other status is a refusal.
 */
export const refusedAnswer = (label: string, status: number, json: unknown): HandoffPeerError => {
  const refusal = decodeError(json);
  if (Option.isSome(refusal)) {
    return new HandoffPeerError({
      code: refusal.value.code ?? "failed",
      message: refusal.value.error,
      check: refusal.value.check,
      // The machine says it may have acted: no "no" to release a hold on.
      uncertain: refusal.value.uncertain === true,
    });
  }
  return status >= 500
    ? unreachable(label, true)
    : new HandoffPeerError({
        code: "failed",
        message: `${label} refused the request (HTTP ${status}).`,
        uncertain: false,
      });
};

const toPeerTarget = (target: FleetTarget): HandoffPeerTarget => ({
  machineId: target.id,
  environmentId: target.environmentId,
  label: target.label,
});

export const make = Effect.gen(function* () {
  const fleet = yield* FleetTargets.FleetTargets;
  const link = FleetTargets.linkOf(fleet);
  const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
  /** Per machine: the address whose identity was checked, and when. */
  const identities = yield* Ref.make(
    new Map<string, { address: FleetOrigin; checkedAt: number }>(),
  );

  const configured = fleet.load.pipe(
    Effect.map((config) => config?.machines ?? []),
    Effect.orElseSucceed((): ReadonlyArray<FleetTarget> => []),
  );

  const findTarget = (environmentId: EnvironmentId) =>
    configured.pipe(
      Effect.flatMap((machines) => {
        const found = machines.find((machine) => machine.environmentId === environmentId);
        return found === undefined
          ? Effect.fail(
              new HandoffPeerError({
                code: "invalid",
                message: "That machine is not one of your private machines.",
                uncertain: false,
                local: true,
              }),
            )
          : Effect.succeed(found);
      }),
    );

  const credentialFor = (target: FleetTarget) =>
    grants.credential(target.id).pipe(
      Effect.mapError((error) =>
        error.reason === "not_allowed" || error.reason === "revoked" || error.reason === "expired"
          ? new HandoffPeerError({
              code: "needs_grant",
              message: `${target.label}: this machine has no work grant there (${error.message})`,
              check: "grant",
              uncertain: false,
              local: true,
              grant: error.reason === "not_allowed" ? "none" : error.reason,
            })
          : error.reason === "unknown_machine"
            ? new HandoffPeerError({
                code: "invalid",
                message: error.message,
                uncertain: false,
                local: true,
              })
            : unreachable(target.label, false, true),
      ),
    );

  /**
   * The address to call: the one checked within the last few minutes while it
   * is still configured, else the first that answers as the machine (tailnet
   * first). The worker credential decides which addresses it may use: a
   * bearer grant never goes to a Connect address.
   */
  const reachPeer = (target: FleetTarget, accessToken: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cached = (yield* Ref.get(identities)).get(target.id);
      if (
        cached !== undefined &&
        fleetReachMayBeRemembered(link) &&
        now - cached.checkedAt < IDENTITY_TTL_MS &&
        fleetAddresses(target).some((address) => address.origin === cached.address.origin)
      )
        return cached.address;
      const reached = yield* Effect.tryPromise({
        try: () => {
          // A stale check is read again, never refreshed from memory.
          if (cached !== undefined)
            link.book.forget(fleetMachineKey(target), cached.address.origin);
          return reachFleetMachine(link, target, { token: accessToken });
        },
        catch: (error) =>
          error instanceof FleetError && error.kind === "team-rules"
            ? new HandoffPeerError({
                code: "needs_grant",
                message: error.message,
                check: "grant",
                uncertain: false,
                local: true,
              })
            : error instanceof FleetError && error.kind === "identity-mismatch"
              ? new HandoffPeerError({
                  code: "invalid",
                  message: `${target.label} answered as a different machine.`,
                  uncertain: false,
                  local: true,
                })
              : error instanceof FleetError && error.kind === "connect-unbound"
                ? new HandoffPeerError({
                    code: "needs_grant",
                    message: `${target.label} answers only through SpecWithCode Connect, and this machine's work grant there works only over Tailscale.`,
                    check: "grant",
                    uncertain: false,
                    local: true,
                  })
                : // No address answered: the network between the two says nothing about
                  // this machine's setup, so it is no local failure.
                  unreachable(target.label, false),
      });
      const address: FleetOrigin = { origin: reached.origin, transport: reached.transport };
      yield* Ref.update(identities, (current) =>
        new Map(current).set(target.id, { address, checkedAt: now }),
      );
      return address;
    });

  /** The next call checks the machine's addresses again. */
  const dropAddress = (target: FleetTarget, origin: string) =>
    Ref.update(identities, (current) => {
      const next = new Map(current);
      next.delete(target.id);
      return next;
    }).pipe(Effect.andThen(Effect.sync(() => link.book.forget(fleetMachineKey(target), origin))));

  /** A machine too old to hold a carried ceiling would drop it on arrival. */
  const refuseUncarried = (environmentId: EnvironmentId) =>
    Effect.gen(function* () {
      const target = yield* findTarget(environmentId);
      const credential = yield* credentialFor(target);
      yield* reachPeer(target, credential.accessToken);
      if (link.book.peerRules?.(fleetMachineKey(target))?.carried === true) return;
      return yield* new HandoffPeerError({
        code: "invalid",
        message: `Team rules travel with this thread, and ${target.label} runs a SpecWithCode too old to enforce them. Update SpecWithCode on ${target.label}.`,
        uncertain: false,
        local: true,
      });
    });

  /** A machine that does not keep a reviewer lock would continue the review on any model. */
  const refuseUnlocked = (environmentId: EnvironmentId) =>
    Effect.gen(function* () {
      const target = yield* findTarget(environmentId);
      const credential = yield* credentialFor(target);
      yield* reachPeer(target, credential.accessToken);
      if (link.book.peerRules?.(fleetMachineKey(target))?.reviewLock === true) return;
      return yield* new HandoffPeerError({
        code: "invalid",
        message: `${reviewStaysText("update_needed", target.label)}.`,
        uncertain: false,
        local: true,
      });
    });

  const post = <A>(
    environmentId: EnvironmentId,
    path: PeerPath,
    body: Uint8Array,
    contentType: string,
    decode: (input: unknown) => Option.Option<A>,
  ): Effect.Effect<A, HandoffPeerError> =>
    Effect.gen(function* () {
      const target = yield* findTarget(environmentId);
      // Work leaves here only under readable rules: a broken file could be hiding `none`.
      if (LEAVES_THIS_MACHINE.has(path)) {
        const held = teamRulesHoldRefusal(yield* currentTeamRules);
        if (held !== null) {
          return yield* new HandoffPeerError({
            code: "needs_grant",
            message: held.message,
            check: "grant",
            uncertain: false,
            local: true,
          });
        }
      }
      const credential = yield* credentialFor(target);
      const address = yield* reachPeer(target, credential.accessToken);
      const url = `${address.origin}${HANDOFF_PEER_PREFIX}/${path}`;
      const authorization = yield* Effect.tryPromise({
        try: () => fleetAuthorization(link, address, "POST", url, credential.accessToken),
        catch: () => unreachable(target.label, false, true),
      });
      // Sent once: a call that may have arrived is never repeated at another address.
      const answer = yield* Effect.tryPromise({
        try: (signal) =>
          link.fetch(url, {
            method: "POST",
            redirect: "error",
            headers: { ...authorization, "content-type": contentType },
            body: body as Uint8Array<ArrayBuffer>,
            signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS[path])]),
          }),
        catch: () => unreachable(target.label, true),
      }).pipe(Effect.tapError(() => dropAddress(target, address.origin)));
      if (answer.status === 401) {
        yield* grants.reportRejected(target.id, credential.accessToken);
        return yield* new HandoffPeerError({
          code: "needs_grant",
          message: `${target.label}: this machine's work grant there was revoked`,
          check: "grant",
          uncertain: false,
        });
      }
      const json = yield* Effect.tryPromise({
        try: () => readBoundedJson(answer, answerLimit(path)),
        catch: () => null,
      }).pipe(Effect.orElseSucceed(() => undefined));
      // A machine from before Sync extras has no such path.
      if (answer.status === 404 && (path === "extras-negotiate" || path === "extras-replicate")) {
        return yield* new HandoffPeerError({
          code: "failed",
          message: `${target.label} runs a SpecWithCode from before Sync. Update SpecWithCode on ${target.label}.`,
          uncertain: false,
          needsUpdate: true,
        });
      }
      // A machine from before transfer records has no such path. It changed nothing.
      if (answer.status === 404 && (path === "transfer-status" || path === "transfer-pull")) {
        return yield* new HandoffPeerError({
          code: "invalid",
          message: `Needs update: ${target.label} runs a SpecWithCode from before handoff transfer records. Update SpecWithCode on ${target.label} first.`,
          check: "version",
          uncertain: false,
          needsUpdate: true,
        });
      }
      // A machine from before the reviewer lock has no such path: it answered, and took nothing.
      if (answer.status === 404 && (path === "review-replicate" || path === "review-takeover")) {
        return yield* new HandoffPeerError({
          code: "invalid",
          message: `${reviewStaysText("update_needed", target.label)}.`,
          check: "provider",
          uncertain: false,
        });
      }
      // A machine from before hand off plans has no such path. It changed nothing.
      if (answer.status === 404 && path === "check") {
        return yield* new HandoffPeerError(unknownCheckPath(target.label));
      }
      // A machine from before hand off batches has no such path. It changed nothing.
      if (answer.status === 404 && path === "folder-work") {
        return yield* new HandoffPeerError(unknownFolderWorkPath(target.label));
      }
      // A machine from before coordinator messages has no such path. It took nothing.
      if (
        answer.status === 404 &&
        (path === "coordinator-message" ||
          path === "coordinator-message-read" ||
          path === "coordinator-message-receipt")
      ) {
        return yield* new HandoffPeerError({
          code: "invalid",
          message: `Needs update: ${target.label} runs a SpecWithCode from before coordinator messages. Update SpecWithCode on ${target.label}.`,
          check: "version",
          uncertain: false,
          needsUpdate: true,
        });
      }
      if (!answer.ok) return yield* refusedAnswer(target.label, answer.status, json);
      const decoded = decode(json);
      if (Option.isSome(decoded)) return decoded.value;
      // The destination may have acted, so an unreadable answer is in doubt, not a refusal.
      return yield* new HandoffPeerError({
        code: "unreachable",
        message: `${target.label} sent an answer this version cannot read.`,
        uncertain: true,
      });
    });

  const postJson = <A>(
    environmentId: EnvironmentId,
    path: PeerPath,
    value: unknown,
    decode: (input: unknown) => Option.Option<A>,
  ) => post(environmentId, path, jsonBody(value), "application/json", decode);

  return HandoffPeers.of({
    target: (environmentId) => findTarget(environmentId).pipe(Effect.map(toPeerTarget)),
    targets: configured.pipe(Effect.map((machines) => machines.map(toPeerTarget))),
    reachable: (environmentId) =>
      Effect.gen(function* () {
        const target = yield* findTarget(environmentId);
        const credential = yield* credentialFor(target);
        yield* reachPeer(target, credential.accessToken);
      }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ),
    negotiate: (environmentId, request) =>
      postJson(environmentId, "negotiate", encodeNegotiate(request), decodeNegotiate),
    replicate: (environmentId, meta, bundle) =>
      Effect.try({
        try: () => encodeFrame(encodeMeta(meta), bundle),
        catch: (cause) =>
          new HandoffPeerError({
            code: "too_large",
            message: cause instanceof Error ? cause.message : "The checkpoint is too large.",
            uncertain: false,
            local: true,
          }),
      }).pipe(
        Effect.tap(() =>
          meta.carried === undefined ? Effect.void : refuseUncarried(environmentId),
        ),
        Effect.tap(() => (meta.reviewLock == null ? Effect.void : refuseUnlocked(environmentId))),
        Effect.flatMap((frame) =>
          post(
            environmentId,
            reviewPath("replicate", meta.reviewLock != null),
            frame,
            "application/octet-stream",
            decodeReplicate,
          ),
        ),
      ),
    preflight: (environmentId, request) =>
      postJson(environmentId, "preflight", encodePreflight(request), decodePreflight),
    check: (environmentId, request) =>
      postJson(environmentId, "check", encodeCheck(request), decodeCheck),
    folderWork: (environmentId, request) =>
      postJson(environmentId, "folder-work", encodeFolderWork(request), decodeFolderWork),
    takeover: (environmentId, request) =>
      postJson(
        environmentId,
        reviewPath("takeover", request.review === true),
        encodeTakeover(request),
        decodeTakeover,
      ),
    heartbeat: (environmentId, request) =>
      postJson(environmentId, "heartbeat", encodeHeartbeat(request), decodeHeartbeat),
    coordinatorMessageReceipt: (environmentId, request) =>
      encodeLocal(CoordinatorMessageReceiptRequest, request).pipe(
        Effect.flatMap((body) =>
          postJson(
            environmentId,
            "coordinator-message-receipt",
            body,
            Schema.decodeUnknownOption(CoordinatorMessageReceiptResponse),
          ),
        ),
      ),
    coordinatorMessageRead: (environmentId, request) =>
      encodeLocal(CoordinatorMessageReadRequest, request).pipe(
        Effect.flatMap((body) =>
          postJson(
            environmentId,
            "coordinator-message-read",
            body,
            Schema.decodeUnknownOption(CoordinatorMessageReadResponse),
          ),
        ),
      ),
    coordinatorMessage: (environmentId, request) =>
      encodeLocal(CoordinatorMessageDeliverRequest, request).pipe(
        Effect.flatMap((body) =>
          postJson(
            environmentId,
            "coordinator-message",
            body,
            Schema.decodeUnknownOption(CoordinatorMessageDeliverResponse),
          ),
        ),
      ),
    coordinatorLease: (environmentId, request) =>
      postJson(
        environmentId,
        "coordinator-lease",
        encodeCoordinatorLease(request),
        decodeCoordinatorLease,
      ),
    coordinatorReplica: (environmentId, request) =>
      postJson(
        environmentId,
        "coordinator-replica",
        encodeCoordinatorReplica(request),
        decodeCoordinatorReplica,
      ),
    memoryExport: (environmentId, request) =>
      postJson(environmentId, "memory-export", encodeMemoryExport(request), decodeMemoryExport),
    memoryMerge: (environmentId, request) =>
      postJson(environmentId, "memory-merge", encodeMemoryMerge(request), decodeMemoryMerge),
    linkedDigest: (environmentId, request) =>
      postJson(environmentId, "linked-digest", encodeLinkedDigest(request), decodeLinkedDigest),
    linkedContent: (environmentId, request) =>
      postJson(environmentId, "linked-content", encodeLinkedContent(request), decodeLinkedContent),
    linkedReplica: (environmentId, request) =>
      postJson(environmentId, "linked-replica", encodeLinkedReplica(request), decodeLinkedReplica),
    linkedSupersede: (environmentId, request) =>
      postJson(
        environmentId,
        "linked-supersede",
        encodeLinkedSupersede(request),
        decodeLinkedSupersede,
      ),
    linkedMembers: (environmentId, request) =>
      postJson(environmentId, "linked-members", encodeLinkedMembers(request), decodeLinkedMembers),
    planExport: (environmentId, request) =>
      postJson(environmentId, "plan-export", encodePlanExport(request), decodePlanExport),
    planMerge: (environmentId, request) =>
      postJson(environmentId, "plan-merge", encodePlanMerge(request), decodePlanMerge),
    transferStatus: (environmentId, request) =>
      postJson(
        environmentId,
        "transfer-status",
        encodeTransferStatus(request),
        decodeTransferStatus,
      ),
    transferPull: (environmentId, request) =>
      postJson(environmentId, "transfer-pull", encodeTransferPull(request), decodeTakeover),
    extrasNegotiate: (environmentId, request) =>
      postJson(environmentId, "extras-negotiate", encodeExtrasNegotiate(request), decodeNegotiate),
    extrasReplicate: (environmentId, meta, bundle) =>
      Effect.try({
        try: () => encodeFrame(encodeExtrasMeta(meta), bundle),
        catch: (cause) =>
          new HandoffPeerError({
            code: "too_large",
            message: cause instanceof Error ? cause.message : "The bundle is too large.",
            uncertain: false,
            local: true,
          }),
      }).pipe(
        Effect.flatMap((frame) =>
          post(
            environmentId,
            "extras-replicate",
            frame,
            "application/octet-stream",
            decodeExtrasReplicate,
          ),
        ),
      ),
  });
});

export const layer = Layer.effect(HandoffPeers, make);
