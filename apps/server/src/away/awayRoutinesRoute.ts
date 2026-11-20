/**
 * `POST /api/away/v1/routines`: another of the owner's machines moves a
 * routine's runner here or takes it back (ScheduledTaskTransfer), or settles
 * which machine runs a project's routines and sends a change to the runner
 * (ScheduledTaskRunner). Only a machine with a live work grant here gets in;
 * the grant must allow routines.
 */
import { AWAY_ROUTINES_PATH } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";

import { RoutineRunnerRequest, RUNNER_OPS } from "../scheduledTasks/ScheduledTaskRunnerWire.ts";
import {
  RoutineTransferRequest,
  ScheduledTaskTransfer,
} from "../scheduledTasks/ScheduledTaskTransfer.ts";
import { answerJson, awayPeerCaller } from "./awayPeerCall.ts";
import { readAwayBody } from "./awayReturnRoute.ts";

const MAX_BODY_BYTES = 256 * 1024;
const decodeTransfer = Schema.decodeUnknownOption(RoutineTransferRequest);
const decodeRunner = Schema.decodeUnknownOption(RoutineRunnerRequest);
/**
 * A runner request (1390 AC-45) is told from the older transfer by its `op`
 * alone, never by a field an older machine would drop.
 */
export const decodeRoutinesRequest = (
  body: unknown,
): Option.Option<RoutineTransferRequest | RoutineRunnerRequest> => {
  const op =
    typeof body === "object" && body !== null && "op" in body
      ? (body as { readonly op: unknown }).op
      : undefined;
  return typeof op === "string" && RUNNER_OPS.has(op) ? decodeRunner(body) : decodeTransfer(body);
};

export const layer = HttpRouter.add(
  "POST",
  AWAY_ROUTINES_PATH,
  Effect.gen(function* () {
    const who = yield* awayPeerCaller;
    if ("refused" in who) return who.refused;
    const raw = yield* readAwayBody(MAX_BODY_BYTES);
    if (raw.kind === "too-large") return answerJson(413, { error: "The request is too large." });
    const body = decodeRoutinesRequest(raw.value);
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
