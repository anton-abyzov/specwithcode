/**
 * The target's routes for Away mode's sleep trigger (1267 AC-09):
 * `POST /api/away/v1/intent` records the source's away intent, and
 * `POST /api/away/v1/intent/cancel` cancels it once the source is back. Only
 * a machine with a live work grant here gets in (`awayPeerCaller`); the body
 * must name that same machine, and only projects its grant covers are kept.
 */
import {
  AWAY_INTENT_CANCEL_PATH,
  AWAY_INTENT_PATH,
  AwayIntentCancelRequest,
  type AwayIntentRecord,
  AwayIntentRequest,
  type Project,
  type ProjectId,
} from "@specweave-studio/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import { projectInGrant } from "../fleet/workGrantPolicy.ts";
import type { ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import { parseJson } from "../json.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { AwayIntents, type AwayIntentsShape, linkedCopyOf } from "./AwayIntents.ts";
import { answerJson, awayPeerCaller } from "./awayPeerCall.ts";

const MAX_BODY_BYTES = 128 * 1024;
const decodeIntent = Schema.decodeUnknownOption(AwayIntentRequest);
const decodeCancel = Schema.decodeUnknownOption(AwayIntentCancelRequest);

export interface IntentAnswer {
  readonly status: number;
  readonly body: unknown;
}

/** Reads a JSON body up to `MAX_BODY_BYTES`; undefined when it is too large or not JSON. */
const readBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const length = Number(request.headers["content-length"] ?? "0");
  if (!Number.isFinite(length) || length > MAX_BODY_BYTES) return undefined;
  const text = yield* request.text.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
    Effect.option,
  );
  if (Option.isNone(text)) return undefined;
  try {
    return { raw: parseJson(text.value) as unknown };
  } catch {
    return { raw: null as unknown };
  }
});

/**
 * Records an intent for `caller`. The projects kept are the source's copies
 * that are linked here and that the caller's grant covers; the rest are
 * answered as refused, so the source lists them as staying.
 */
export const recordIntent = (
  intents: Pick<AwayIntentsShape, "record">,
  caller: ReceiverCaller,
  raw: unknown,
  projects: ReadonlyArray<Project>,
): Effect.Effect<IntentAnswer> =>
  Effect.gen(function* () {
    const body = decodeIntent(raw);
    if (Option.isNone(body))
      return { status: 400, body: { error: "The request does not match this version." } };
    if (body.value.sourceEnvironmentId !== caller.sourceEnvironmentId)
      return {
        status: 403,
        body: { error: "A machine may record an away intent only for itself." },
      };
    const kept: ProjectId[] = [];
    const refused: ProjectId[] = [];
    for (const projectId of body.value.projectIds) {
      const copy = linkedCopyOf(projects, caller.sourceEnvironmentId, projectId);
      const covered =
        copy !== undefined &&
        (caller.grant === null ||
          projectInGrant(caller.grant.projects, caller.sourceEnvironmentId, copy));
      (covered ? kept : refused).push(projectId);
    }
    const recorded = yield* intents
      .record(caller.sourceEnvironmentId, {
        graceMinutes: body.value.graceMinutes,
        projectIds: kept,
        threadIds: body.value.threadIds,
      })
      .pipe(Effect.result);
    if (recorded._tag === "Failure")
      return { status: 500, body: { error: recorded.failure.message } };
    return {
      status: 200,
      body: { intent: recorded.success satisfies AwayIntentRecord, refusedProjectIds: refused },
    };
  });

export const cancelIntent = (
  intents: Pick<AwayIntentsShape, "cancel">,
  caller: ReceiverCaller,
  raw: unknown,
): Effect.Effect<IntentAnswer> =>
  Effect.gen(function* () {
    const body = decodeCancel(raw);
    if (Option.isNone(body))
      return { status: 400, body: { error: "The request does not match this version." } };
    if (body.value.sourceEnvironmentId !== caller.sourceEnvironmentId)
      return { status: 403, body: { error: "A machine may cancel only its own away intent." } };
    const cancelled = yield* intents
      .cancel(caller.sourceEnvironmentId, "source-back")
      .pipe(Effect.result);
    return cancelled._tag === "Failure"
      ? { status: 500, body: { error: cancelled.failure.message } }
      : { status: 200, body: cancelled.success };
  });

const tooLarge = answerJson(413, { error: "The request is too large." });

const intentRoute = HttpRouter.add(
  "POST",
  AWAY_INTENT_PATH,
  Effect.gen(function* () {
    const who = yield* awayPeerCaller;
    if ("refused" in who) return who.refused;
    const body = yield* readBody;
    if (body === undefined) return tooLarge;
    const projects = yield* (yield* ProjectService.ProjectService).snapshot.pipe(
      Effect.map((snapshot) => snapshot.projects),
      Effect.orElseSucceed(() => []),
    );
    const answer = yield* recordIntent(yield* AwayIntents, who.caller, body.raw, projects);
    return answerJson(answer.status, answer.body);
  }),
);

const cancelRoute = HttpRouter.add(
  "POST",
  AWAY_INTENT_CANCEL_PATH,
  Effect.gen(function* () {
    const who = yield* awayPeerCaller;
    if ("refused" in who) return who.refused;
    const body = yield* readBody;
    if (body === undefined) return tooLarge;
    const answer = yield* cancelIntent(yield* AwayIntents, who.caller, body.raw);
    return answerJson(answer.status, answer.body);
  }),
);

export const layer = Layer.mergeAll(intentRoute, cancelRoute);
