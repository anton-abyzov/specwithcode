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

import type {
  EnvironmentId,
  HandoffModeErrorCode,
  HandoffPreflightCheck,
} from "@specweave-studio/contracts";

import * as FleetTargets from "../fleet/FleetTargets.ts";
import {
  type FleetOrigin,
  fleetAddresses,
  fleetAuthorization,
  fleetMachineKey,
  reachFleetMachine,
} from "../fleet/fleetTransport.ts";
import * as FleetWorkerGrants from "../fleet/FleetWorkerGrants.ts";
import { stringifyJson } from "../json.ts";
import { FleetError, type FleetTarget, readBoundedJson } from "../studioFleet.ts";
import {
  encodeFrame,
  HANDOFF_JSON_MAX_BYTES,
  HANDOFF_PEER_PREFIX,
  HeartbeatRequest,
  HeartbeatResponse,
  NegotiateRequest,
  NegotiateResponse,
  PeerErrorBody,
  type PeerPath,
  PeerPreflightRequest,
  PeerPreflightResponse,
  ReplicateMeta,
  ReplicateResponse,
  TakeoverRequest,
  TakeoverResponse,
} from "./handoffWire.ts";

const IDENTITY_TTL_MS = 5 * 60_000;
const TIMEOUT_MS: Record<PeerPath, number> = {
  negotiate: 15_000,
  replicate: 120_000,
  preflight: 30_000,
  takeover: 180_000,
  heartbeat: 10_000,
};

export class HandoffPeerError extends Data.TaggedError("HandoffPeerError")<{
  readonly code: HandoffModeErrorCode;
  readonly message: string;
  readonly check?: HandoffPreflightCheck | undefined;
  /** No answer came back: the destination may or may not have acted. */
  readonly uncertain: boolean;
  /**
   * The call failed on this machine before it reached the destination (no such
   * machine, no credential, identity check failed). Nothing changed there for
   * this call, but it is no refusal from the destination either, so it never
   * settles an earlier takeover that is still in doubt.
   */
  readonly local?: boolean | undefined;
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
  }
>()("specweave-studio/handoff/handoffPeers") {}

const encodeNegotiate = Schema.encodeSync(NegotiateRequest);
const encodeMeta = Schema.encodeSync(ReplicateMeta);
const encodePreflight = Schema.encodeSync(PeerPreflightRequest);
const encodeTakeover = Schema.encodeSync(TakeoverRequest);
const encodeHeartbeat = Schema.encodeSync(HeartbeatRequest);
const decodeError = Schema.decodeUnknownOption(PeerErrorBody);
const decodeNegotiate = Schema.decodeUnknownOption(NegotiateResponse);
const decodeReplicate = Schema.decodeUnknownOption(ReplicateResponse);
const decodePreflight = Schema.decodeUnknownOption(PeerPreflightResponse);
const decodeTakeover = Schema.decodeUnknownOption(TakeoverResponse);
const decodeHeartbeat = Schema.decodeUnknownOption(HeartbeatResponse);

const jsonBody = (value: unknown) => new TextEncoder().encode(stringifyJson(value));

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
          error instanceof FleetError && error.kind === "identity-mismatch"
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
              : unreachable(target.label, false, true),
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

  const post = <A>(
    environmentId: EnvironmentId,
    path: PeerPath,
    body: Uint8Array,
    contentType: string,
    decode: (input: unknown) => Option.Option<A>,
  ): Effect.Effect<A, HandoffPeerError> =>
    Effect.gen(function* () {
      const target = yield* findTarget(environmentId);
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
        try: () => readBoundedJson(answer, HANDOFF_JSON_MAX_BYTES),
        catch: () => null,
      }).pipe(Effect.orElseSucceed(() => undefined));
      if (!answer.ok) {
        const refusal = decodeError(json);
        if (Option.isSome(refusal)) {
          return yield* new HandoffPeerError({
            code: refusal.value.code ?? "failed",
            message: refusal.value.error,
            check: refusal.value.check,
            uncertain: false,
          });
        }
        // A proxy's 5xx without our body may come after the destination acted.
        return yield* answer.status >= 500
          ? unreachable(target.label, true)
          : new HandoffPeerError({
              code: "failed",
              message: `${target.label} refused the request (HTTP ${answer.status}).`,
              uncertain: false,
            });
      }
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
        Effect.flatMap((frame) =>
          post(environmentId, "replicate", frame, "application/octet-stream", decodeReplicate),
        ),
      ),
    preflight: (environmentId, request) =>
      postJson(environmentId, "preflight", encodePreflight(request), decodePreflight),
    takeover: (environmentId, request) =>
      postJson(environmentId, "takeover", encodeTakeover(request), decodeTakeover),
    heartbeat: (environmentId, request) =>
      postJson(environmentId, "heartbeat", encodeHeartbeat(request), decodeHeartbeat),
  });
});

export const layer = Layer.effect(HandoffPeers, make);
