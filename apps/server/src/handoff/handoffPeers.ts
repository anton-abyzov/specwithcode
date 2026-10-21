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
import * as FleetWorkerGrants from "../fleet/FleetWorkerGrants.ts";
import { stringifyJson } from "../json.ts";
import { checkIdentity, FleetError, type FleetTarget, readBoundedJson } from "../studioFleet.ts";
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
}> {}

const unreachable = (label: string, uncertain: boolean) =>
  new HandoffPeerError({
    code: "unreachable",
    message: `${label} did not answer.`,
    uncertain,
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
  const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
  const identities = yield* Ref.make(new Map<string, { url: string; checkedAt: number }>());

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
            })
          : error.reason === "unknown_machine"
            ? new HandoffPeerError({ code: "invalid", message: error.message, uncertain: false })
            : unreachable(target.label, false),
      ),
    );

  const verifyIdentity = (target: FleetTarget) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cached = (yield* Ref.get(identities)).get(target.id);
      if (
        cached !== undefined &&
        cached.url === target.url &&
        now - cached.checkedAt < IDENTITY_TTL_MS
      )
        return;
      yield* Effect.tryPromise({
        try: () => checkIdentity(fleet.fetch, target),
        catch: (error) =>
          error instanceof FleetError && error.kind === "identity-mismatch"
            ? new HandoffPeerError({
                code: "invalid",
                message: `${target.label} answered as a different machine.`,
                uncertain: false,
              })
            : unreachable(target.label, false),
      });
      yield* Ref.update(identities, (current) =>
        new Map(current).set(target.id, { url: target.url, checkedAt: now }),
      );
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
      const credential = yield* credentialFor(target);
      yield* verifyIdentity(target);
      const answer = yield* Effect.tryPromise({
        try: (signal) =>
          fleet.fetch(`${target.url}${HANDOFF_PEER_PREFIX}/${path}`, {
            method: "POST",
            redirect: "error",
            headers: {
              authorization: `Bearer ${credential.accessToken}`,
              "content-type": contentType,
            },
            body: body as Uint8Array<ArrayBuffer>,
            signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS[path])]),
          }),
        catch: () => unreachable(target.label, true),
      });
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
      return yield* new HandoffPeerError({
        code: "failed",
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
