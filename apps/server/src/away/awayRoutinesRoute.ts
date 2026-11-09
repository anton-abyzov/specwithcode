/**
 * `POST /api/away/v1/routines`: a machine leaving for this one stages, turns
 * on or takes back a routine it moves here (ScheduledTaskTransfer). Only a
 * machine with a live work grant here gets in; the grant must allow routines.
 */
import { AWAY_ROUTINES_PATH } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";

import {
  RoutineTransferRequest,
  ScheduledTaskTransfer,
} from "../scheduledTasks/ScheduledTaskTransfer.ts";
import { answerJson, awayPeerCaller } from "./awayPeerCall.ts";
import { readAwayBody } from "./awayReturnRoute.ts";

const MAX_BODY_BYTES = 256 * 1024;
const decodeRequest = Schema.decodeUnknownOption(RoutineTransferRequest);

export const layer = HttpRouter.add(
  "POST",
  AWAY_ROUTINES_PATH,
  Effect.gen(function* () {
    const who = yield* awayPeerCaller;
    if ("refused" in who) return who.refused;
    const raw = yield* readAwayBody(MAX_BODY_BYTES);
    if (raw.kind === "too-large") return answerJson(413, { error: "The request is too large." });
    const body = decodeRequest(raw.value);
    if (Option.isNone(body))
      return answerJson(400, { error: "The request does not match this version." });
    const transfer = yield* ScheduledTaskTransfer;
    return yield* transfer.receive(who.caller, body.value).pipe(
      Effect.map((answer) => answerJson(200, answer)),
      Effect.catchTags({
        RoutineTransferRefusal: (refusal) =>
          Effect.succeed(answerJson(refusal.status, { error: refusal.message })),
      }),
    );
  }),
);
