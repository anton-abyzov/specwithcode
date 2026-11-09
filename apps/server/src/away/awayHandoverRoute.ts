/**
 * `POST /api/away/v1/handover`: the coordinator of a linked project, which
 * already gave way to this machine's copy, asks it to take over (Away mode's
 * planned handover, CoordinatorPlannedHandover). Only a machine with a live
 * work grant here gets in, and the handover must come from that machine.
 */
import { AWAY_HANDOVER_PATH } from "@specweave-studio/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import { COORDINATOR_REPLICA_MAX_BYTES } from "../handoff/handoffWire.ts";
import { parseJson } from "../json.ts";
import {
  CoordinatorPlannedHandover,
  PlannedHandoverRequest,
} from "../project/CoordinatorPlannedHandover.ts";
import { answerJson, awayPeerCaller } from "./awayPeerCall.ts";

/** Routines with their run state, and up to 200 workers. */
const MAX_BODY_BYTES = COORDINATOR_REPLICA_MAX_BYTES;
const decodeRequest = Schema.decodeUnknownOption(PlannedHandoverRequest);

export const layer = HttpRouter.add(
  "POST",
  AWAY_HANDOVER_PATH,
  Effect.gen(function* () {
    const who = yield* awayPeerCaller;
    if ("refused" in who) return who.refused;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const length = Number(request.headers["content-length"] ?? "0");
    if (!Number.isFinite(length) || length > MAX_BODY_BYTES)
      return answerJson(413, { error: "The request is too large." });
    const text = yield* request.text.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
      Effect.option,
    );
    if (Option.isNone(text)) return answerJson(413, { error: "The request is too large." });
    let raw: unknown = null;
    try {
      raw = parseJson(text.value);
    } catch {
      raw = null;
    }
    const body = decodeRequest(raw);
    if (Option.isNone(body))
      return answerJson(400, { error: "The request does not match this version." });
    const handover = yield* CoordinatorPlannedHandover;
    return yield* handover.receive(who.caller, body.value).pipe(
      Effect.map((answer) => answerJson(200, answer)),
      Effect.catchTags({
        HandoverRefusal: (refusal) =>
          Effect.succeed(answerJson(refusal.status, { error: refusal.message })),
      }),
    );
  }),
);
