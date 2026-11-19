/**
 * The machine-to-machine handoff API (`/api/handoff/v1/<path>`). Only a
 * paired machine's worker credential gets in: the work grant it holds here
 * names the source, and every request must name that same source.
 */
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as WorkGrants from "../fleet/WorkGrants.ts";
import { currentTeamRules } from "../teamRules/TeamRules.ts";
import { callerFingerprint, teamRulesSessionRefusal } from "../teamRules/TeamRulesReach.ts";
import { parseJson } from "../json.ts";
import { clientRuntimeModeCeiling } from "../mcp/McpInvocationContext.ts";
import { CoordinatorLeaseReceiver } from "../project/CoordinatorLeaseRoute.ts";
import { CoordinatorMessageReceiver } from "../project/CoordinatorMessageReceiver.ts";
import { LinkedMemoryPeerReceiver } from "../project/LinkedMemoryPeers.ts";
import { LinkedPeerReceiver } from "../project/LinkedPeerRoute.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import { ExtrasReceiver } from "./ExtrasReceiver.ts";
import { FolderWorkReceiver } from "./HandoffBatch.ts";
import { PeerCheckRequest } from "./handoffPlan.ts";
import {
  HandoffReceiver,
  HandoffRefusal,
  type ReceiverCaller,
  refusalAnswer,
} from "./HandoffReceiver.ts";
import {
  COORDINATOR_REPLICA_MAX_BYTES,
  CoordinatorLeaseRequest,
  CoordinatorReplicaRequest,
  decodeFrame,
  ExtrasNegotiateRequest,
  ExtrasReplicateMeta,
  HANDOFF_FRAME_META_MAX_BYTES,
  HANDOFF_JSON_MAX_BYTES,
  HANDOFF_PEER_PREFIX,
  HeartbeatRequest,
  LINKED_MEMORY_PEER_MAX_BYTES,
  LINKED_SYNC_PEER_MAX_BYTES,
  NegotiateRequest,
  PEER_PATHS,
  PeerPreflightRequest,
  type PeerPath,
  ReplicateMeta,
  TakeoverReason,
  TakeoverRequest,
  TransferPullRequest,
  TransferStatusRequest,
  FolderWorkRequest,
} from "./handoffWire.ts";
import { CoordinatorMessageDeliverRequest } from "./coordinatorMessageWire.ts";
import { isRetiredReason } from "./handoffState.ts";
import {
  LinkedContentRequest,
  LinkedDigestRequest,
  LinkedMembersRequest,
  LinkedPlanExportRequest,
  LinkedPlanMergeRequest,
  LinkedReplicaRequest,
  LinkedSupersedeRequest,
} from "./linkedSyncWire.ts";
import {
  HANDOFF_MAX_BUNDLE_BYTES,
  LinkedMemoryExportInput,
  LinkedMemoryMergeInput,
} from "@specweave-studio/contracts";

const decodeMeta = Schema.decodeUnknownOption(ReplicateMeta);
const decodeExtrasMeta = Schema.decodeUnknownOption(ExtrasReplicateMeta);
const MAX_BODY_BYTES = HANDOFF_MAX_BUNDLE_BYTES + HANDOFF_FRAME_META_MAX_BYTES + 4;

const refusal = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  HttpServerResponse.jsonUnsafe(
    { error, ...extra },
    { status, headers: { "cache-control": "no-store" } },
  );

const fromRefusal = (error: HandoffRefusal) => {
  const answer = refusalAnswer(error);
  return HttpServerResponse.jsonUnsafe(answer.body, {
    status: answer.status,
    headers: { "cache-control": "no-store" },
  });
};

const UPDATING = "This machine is updating; try again in a minute.";

const decodeJson = <S extends Schema.Top>(schema: S, bytes: Uint8Array) => {
  let raw: unknown;
  try {
    raw = parseJson(new TextDecoder().decode(bytes));
  } catch {
    return Option.none<S["Type"]>();
  }
  return Schema.decodeUnknownOption(schema as never)(raw) as Option.Option<S["Type"]>;
};

/** Answered for a sleep or silence start this machine refuses before reading it. */
const RETIRED_UNREAD =
  "This machine did not read the request, so whether an earlier start of this thread began here is not settled; the thread stays paused until a heartbeat settles it.";

const decodeReason = Schema.Struct({ reason: TakeoverReason });

/** A takeover body that asks for a start this release retired (sleep or silence). */
const asksRetiredStart = (bytes: Uint8Array) => {
  const asked = decodeJson(decodeReason, bytes);
  return Option.isSome(asked) && isRetiredReason(asked.value.reason);
};

const retiredUnread = () =>
  fromRefusal(
    new HandoffRefusal({ status: 503, code: "busy", message: RETIRED_UNREAD, inDoubt: true }),
  );

const ok = (value: unknown) =>
  HttpServerResponse.jsonUnsafe(value, { headers: { "cache-control": "no-store" } });

export const layer = HttpRouter.add(
  "POST",
  `${HANDOFF_PEER_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (yield* (yield* ServiceUpdateHold.optional).isHeld) {
      // A takeover is not read while updating, so whether an earlier one began here is
      // unknown: no answer, which keeps the source's hold on every release.
      const takeover =
        Option.isSome(url) && url.value.pathname === `${HANDOFF_PEER_PREFIX}/takeover`;
      return takeover
        ? fromRefusal(
            new HandoffRefusal({ status: 503, code: "busy", message: UPDATING, inDoubt: true }),
          )
        : refusal(503, UPDATING, { code: "busy" });
    }
    if (Option.isNone(url)) return refusal(400, "invalid_request", { code: "invalid" });
    const path = url.value.pathname.slice(HANDOFF_PEER_PREFIX.length + 1);
    if (!PEER_PATHS.has(path)) return refusal(404, "not_found", { code: "not_found" });
    // A sleep or silence start an earlier release sends may follow one that launched
    // here: refused before the receiver reads it, it gets no answer, never a refusal,
    // so the source keeps its hold (1390 AC-36). Only the receiver can prove it new.
    const unread = (
      structured: HttpServerResponse.HttpServerResponse,
    ): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
      path !== "takeover"
        ? Effect.succeed(structured)
        : request.arrayBuffer.pipe(
            Effect.map((buffer) =>
              asksRetiredStart(new Uint8Array(buffer)) ? retiredUnread() : structured,
            ),
            Effect.provideService(
              HttpIncomingMessage.MaxBodySize,
              ByteSize.bytes(HANDOFF_JSON_MAX_BYTES),
            ),
            Effect.orElseSucceed(() => structured),
          );

    // Absent on a server built without coordinator messages: the path reads as unknown there.
    const messages = yield* Effect.serviceOption(CoordinatorMessageReceiver);
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const client = yield* auth.authenticateMcpClient(request).pipe(Effect.option);
    if (Option.isNone(client))
      return yield* unread(refusal(401, "unauthorized", { code: "needs_grant" }));
    const grants = yield* WorkGrants.WorkGrants;
    const grant = yield* grants.forClient(client.value).pipe(Effect.option);
    if (Option.isNone(grant) || grant.value === undefined) {
      return yield* unread(
        refusal(403, "Only a paired machine's worker credential may hand off here.", {
          code: "needs_grant",
          check: "grant",
        }),
      );
    }
    if (grant.value.revoked) {
      // A standby stops standing by for a coordinator this machine revoked.
      if (path === "coordinator-lease")
        yield* (yield* CoordinatorLeaseReceiver).grantRefused(grant.value.coordinatorEnvironmentId);
      // A message's refusal names both machines (1427 AC-12).
      if (path === "coordinator-message" && Option.isSome(messages))
        return fromRefusal(yield* messages.value.revoked(grant.value.coordinatorEnvironmentId));
      return yield* unread(
        refusal(403, "This machine revoked that machine's work here.", {
          code: "needs_grant",
          check: "grant",
        }),
      );
    }
    const ruled = teamRulesSessionRefusal(
      yield* currentTeamRules,
      { subject: EnvironmentAuth.MCP_CLIENT_SUBJECT, coordinator: true },
      callerFingerprint(request.headers),
    );
    if (ruled !== null) {
      return yield* unread(refusal(403, ruled.message, { code: "needs_grant", check: "grant" }));
    }
    const caller: ReceiverCaller = {
      sourceEnvironmentId: grant.value.coordinatorEnvironmentId,
      grant: grant.value,
      // From the credential on this request, not the stored policy: a legacy
      // grant has no stored cap until its coordinator calls again.
      runtimeCeiling: clientRuntimeModeCeiling(client.value),
    };

    const limit =
      path === "replicate" || path === "review-replicate" || path === "extras-replicate"
        ? MAX_BODY_BYTES
        : path === "coordinator-replica"
          ? COORDINATOR_REPLICA_MAX_BYTES
          : path === "memory-merge"
            ? LINKED_MEMORY_PEER_MAX_BYTES
            : path === "linked-replica" || path === "plan-merge" || path === "linked-members"
              ? LINKED_SYNC_PEER_MAX_BYTES
              : HANDOFF_JSON_MAX_BYTES;
    const contentLength = Number(request.headers["content-length"] ?? "0");
    if (!Number.isFinite(contentLength) || contentLength > limit) {
      return refusal(413, "The request is too large.", { code: "too_large" });
    }
    const body = yield* request.arrayBuffer.pipe(
      Effect.map((buffer) => new Uint8Array(buffer)),
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(limit)),
      Effect.option,
    );
    if (Option.isNone(body))
      return refusal(413, "The request is too large.", { code: "too_large" });

    const receiver = yield* HandoffReceiver;
    const invalid = refusal(400, "The request does not match this version.", { code: "invalid" });
    const answer = (effect: Effect.Effect<unknown, HandoffRefusal>) =>
      effect.pipe(
        Effect.map(ok),
        Effect.catchTags({ HandoffRefusal: (error) => Effect.succeed(fromRefusal(error)) }),
      );

    switch (path as PeerPath) {
      case "negotiate": {
        const input = decodeJson(NegotiateRequest, body.value);
        return Option.isNone(input)
          ? invalid
          : yield* answer(receiver.negotiate(caller, input.value));
      }
      case "preflight": {
        const input = decodeJson(PeerPreflightRequest, body.value);
        return Option.isNone(input)
          ? invalid
          : yield* answer(receiver.preflight(caller, input.value));
      }
      case "takeover":
      case "review-takeover": {
        const input = decodeJson(TakeoverRequest, body.value);
        if (Option.isSome(input)) return yield* answer(receiver.takeover(caller, input.value));
        return asksRetiredStart(body.value) ? retiredUnread() : invalid;
      }
      case "heartbeat": {
        const input = decodeJson(HeartbeatRequest, body.value);
        return Option.isNone(input)
          ? invalid
          : yield* answer(receiver.heartbeat(caller, input.value));
      }
      case "transfer-status": {
        const input = decodeJson(TransferStatusRequest, body.value);
        return Option.isNone(input)
          ? invalid
          : yield* answer(receiver.transferStatus(caller, input.value));
      }
      case "check": {
        const input = decodeJson(PeerCheckRequest, body.value);
        return Option.isNone(input) ? invalid : yield* answer(receiver.check(caller, input.value));
      }
      case "folder-work": {
        const input = decodeJson(FolderWorkRequest, body.value);
        return Option.isNone(input)
          ? invalid
          : yield* answer((yield* FolderWorkReceiver).apply(caller, input.value));
      }
      case "transfer-pull": {
        const input = decodeJson(TransferPullRequest, body.value);
        return Option.isNone(input)
          ? invalid
          : yield* answer(receiver.transferPull(caller, input.value));
      }
      case "coordinator-lease": {
        const input = decodeJson(CoordinatorLeaseRequest, body.value);
        return Option.isNone(input)
          ? invalid
          : yield* answer((yield* CoordinatorLeaseReceiver).lease(caller, input.value));
      }
      case "coordinator-replica": {
        const input = decodeJson(CoordinatorReplicaRequest, body.value);
        return Option.isNone(input)
          ? invalid
          : yield* answer((yield* CoordinatorLeaseReceiver).replica(caller, input.value));
      }
      case "memory-export": {
        const input = decodeJson(LinkedMemoryExportInput, body.value);
        return Option.isNone(input)
          ? invalid
          : yield* answer((yield* LinkedMemoryPeerReceiver).memoryExport(caller, input.value));
      }
      case "memory-merge": {
        const input = decodeJson(LinkedMemoryMergeInput, body.value);
        return Option.isNone(input)
          ? invalid
          : yield* answer((yield* LinkedMemoryPeerReceiver).memoryMerge(caller, input.value));
      }
      case "coordinator-message": {
        const input = decodeJson(CoordinatorMessageDeliverRequest, body.value);
        return Option.isNone(input)
          ? invalid
          : Option.isNone(messages)
            ? refusal(404, "not_found", { code: "not_found" })
            : yield* answer(
                messages.value.deliver(caller, input.value, {
                  // A problem or a request needs a credential that may operate here.
                  operate: client.value.access !== "read-only",
                }),
              );
      }
      case "linked-digest": {
        const input = decodeJson(LinkedDigestRequest, body.value);
        return Option.isNone(input)
          ? invalid
          : yield* answer((yield* LinkedPeerReceiver).digest(caller, input.value));
      }
      case "linked-content": {
        const input = decodeJson(LinkedContentRequest, body.value);
        return Option.isNone(input)
          ? invalid
          : yield* answer((yield* LinkedPeerReceiver).content(caller, input.value));
      }
      case "linked-replica": {
        const input = decodeJson(LinkedReplicaRequest, body.value);
        return Option.isNone(input)
          ? invalid
          : yield* answer((yield* LinkedPeerReceiver).replica(caller, input.value));
      }
      case "linked-supersede": {
        const input = decodeJson(LinkedSupersedeRequest, body.value);
        return Option.isNone(input)
          ? invalid
          : yield* answer((yield* LinkedPeerReceiver).supersede(caller, input.value));
      }
      case "linked-members": {
        const input = decodeJson(LinkedMembersRequest, body.value);
        return Option.isNone(input)
          ? invalid
          : yield* answer((yield* LinkedPeerReceiver).members(caller, input.value));
      }
      case "plan-export": {
        const input = decodeJson(LinkedPlanExportRequest, body.value);
        return Option.isNone(input)
          ? invalid
          : yield* answer((yield* LinkedPeerReceiver).planExport(caller, input.value));
      }
      case "plan-merge": {
        const input = decodeJson(LinkedPlanMergeRequest, body.value);
        return Option.isNone(input)
          ? invalid
          : yield* answer((yield* LinkedPeerReceiver).planMerge(caller, input.value));
      }
      case "extras-negotiate": {
        const input = decodeJson(ExtrasNegotiateRequest, body.value);
        return Option.isNone(input)
          ? invalid
          : yield* answer((yield* ExtrasReceiver).negotiate(caller, input.value));
      }
      case "extras-replicate": {
        let frame: { meta: unknown; bundle: Uint8Array };
        try {
          frame = decodeFrame(body.value);
        } catch {
          return invalid;
        }
        const meta = decodeExtrasMeta(frame.meta);
        return Option.isNone(meta)
          ? invalid
          : yield* answer((yield* ExtrasReceiver).replicate(caller, meta.value, frame.bundle));
      }
      case "replicate":
      case "review-replicate": {
        let frame: { meta: unknown; bundle: Uint8Array };
        try {
          frame = decodeFrame(body.value);
        } catch {
          return invalid;
        }
        const meta = decodeMeta(frame.meta);
        return Option.isNone(meta)
          ? invalid
          : yield* answer(receiver.replicate(caller, meta.value, frame.bundle));
      }
    }
  }),
);
