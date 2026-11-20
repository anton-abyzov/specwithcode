/**
 * The routes a machine going to sleep used to reach its Away target on
 * (1267 AC-09; 1390 AC-36). Sleep starts nothing now:
 * `POST /api/away/v1/intent` refuses new work with a definite answer, so a
 * machine on an earlier release keeps its work and lets its hold go. A
 * request that may repeat the intent recorded here before the update gets
 * that intent back instead, and one naming work that may already continue
 * here gets no answer yet: either way its sender keeps its hold and asks on
 * wake.
 * `POST /api/away/v1/intent/cancel` and `POST /api/away/v1/intent/status`
 * still answer for intents recorded before this machine updated: whether one
 * was cancelled, and per project whether this machine took it over, with the
 * threads it continued. Only a machine with a live work grant here gets in
 * (`awayPeerCaller`); the body must name that same machine.
 *
 * An answer that would let a source run its work again is given only from
 * state read here. When a read fails, or a thread's launch here is in doubt,
 * the answer is one a source on any release reads as "no answer yet": it
 * keeps its hold and asks again.
 */
import {
  AWAY_INTENT_CANCEL_PATH,
  AWAY_INTENT_PATH,
  AWAY_INTENT_STATUS_PATH,
  AwayIntentCancelRequest,
  type AwayIntentRecord,
  AwayIntentRequest,
  AwayIntentStatusAnswer,
  AwayIntentStatusRequest,
  type Project,
} from "@specweave-studio/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { HandoffReceiver, type ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import type { ContinuationEvidence } from "../handoff/handoffState.ts";
import { parseJson } from "../json.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { AwayIntents, type AwayIntentsShape, linkedCopyOf, projectStatus } from "./AwayIntents.ts";
import { answerJson, awayPeerCaller } from "./awayPeerCall.ts";

const MAX_BODY_BYTES = 128 * 1024;
const decodeIntent = Schema.decodeUnknownOption(AwayIntentRequest);
const decodeCancel = Schema.decodeUnknownOption(AwayIntentCancelRequest);
const decodeStatus = Schema.decodeUnknownOption(AwayIntentStatusRequest);
const encodeStatusAnswer = Schema.encodeSync(AwayIntentStatusAnswer);

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

/** What a machine that still sends an intent is told. */
export const SLEEP_START_REFUSAL =
  "Not accepted: nothing moves when a machine goes to sleep. Hand work off from the machine that runs it.";

/**
 * The status of an answer given when this machine cannot tell yet. A source
 * on any release reads it as no answer and keeps its hold. On the intent
 * route the body carries no `error` text: an earlier release's sender reads
 * a 5xx without it as "the request may have arrived", never as a refusal.
 */
const NOT_NOW = 503;

/**
 * Whether `request` may repeat `recorded`, the source's latest intent here
 * (cancel and status answer about that one). The wire carries no operation
 * id, so this errs towards a repeat, however old the record is: the same
 * grace, the same threads in any order, and every project recorded was asked for (an earlier release kept only the
 * projects linked here), whatever the record's state. A false match costs
 * the source a hold until its wake check, which answers from the record:
 * against a cancelled one it runs its work again; against a done one it gives
 * way to what is still taken over and offers to bring work back, even if
 * nothing is away any more. Refusing a true repeat would cost more: its
 * sender would run work that already continues here.
 */
const mayRepeat = (
  recorded: AwayIntentRecord,
  request: Pick<AwayIntentRequest, "graceMinutes" | "projectIds" | "threadIds">,
): boolean => {
  const threads = new Set(request.threadIds);
  const recordedThreads = new Set(recorded.threadIds);
  return (
    recorded.graceMinutes === request.graceMinutes &&
    threads.size === recordedThreads.size &&
    [...recordedThreads].every((threadId) => threads.has(threadId)) &&
    recorded.projectIds.every((projectId) => request.projectIds.includes(projectId))
  );
};

/**
 * What a refusal of an intent is checked against: this machine's own record
 * of the work it names, whatever its intents still hold.
 */
export interface IntentRefusalEvidence {
  /** This machine's projects; none when they do not read. Read only for an intent naming projects. */
  readonly projects: Effect.Effect<Option.Option<ReadonlyArray<Project>>>;
  /** Handoff mode's receiver for the caller's thread. Never launches. */
  readonly continuation: (sourceThreadId: string) => Effect.Effect<ContinuationEvidence>;
}

/**
 * Whether the source's project provably never moved here: this machine has
 * no linked copy of it, or its copy has no binding or defers to the source's
 * copy. A copy that coordinates, is mid-handover or defers to a third machine
 * proves nothing: a binding that gave way names no predecessor, so one that
 * took the project over from the source and handed it on reads like that.
 */
const stayedWithSource = (
  projects: ReadonlyArray<Project>,
  sourceEnvironmentId: string,
  sourceProjectId: string,
): boolean => {
  const copy = linkedCopyOf(projects, sourceEnvironmentId, sourceProjectId);
  const binding = copy?.workspaceSettings?.coordinatorBinding;
  return (
    copy === undefined ||
    binding == null ||
    (binding.state === "transferred" &&
      binding.successor?.environmentId === sourceEnvironmentId &&
      binding.successor.projectId === sourceProjectId)
  );
};

/**
 * Whether any work the request names began here or cannot be told apart from
 * work that did: a project that may have moved here, a thread continued here
 * or whose launch is in doubt, or projects that do not read. Read from the
 * bindings and handoff mode, so an intent record compacted away, or older
 * than the source's latest, still counts.
 */
const anyBeganHere = (
  sourceEnvironmentId: string,
  request: Pick<AwayIntentRequest, "projectIds" | "threadIds">,
  evidence: IntentRefusalEvidence,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (request.projectIds.length > 0) {
      const projects = yield* evidence.projects;
      if (Option.isNone(projects)) return true;
      for (const projectId of request.projectIds)
        if (!stayedWithSource(projects.value, sourceEnvironmentId, projectId)) return true;
    }
    const threads = yield* Effect.forEach(request.threadIds, (threadId) =>
      evidence.continuation(threadId),
    );
    return threads.some((found) => found.kind !== "none");
  });

/**
 * An intent from `caller`. Nothing is recorded and nothing starts. One that
 * may repeat the source's latest intent here (`mayRepeat`) gets it back as an earlier
 * release answered its first delivery (200, the intent and the projects not
 * kept), so its sender holds and settles on wake through cancel and status.
 * Only proven new work is refused with 409 and a reason, which a sender on an
 * earlier release reads as a definite "no" and runs: none of the work it names
 * began here (`anyBeganHere`). Otherwise, or when the intents do not read, 503
 * without `error`: its sender keeps every hold, and its wake check settles
 * each project and thread from this machine's evidence, with or without a
 * record of the intent.
 */
export const recordIntent = (
  caller: ReceiverCaller,
  raw: unknown,
  intents: Pick<AwayIntentsShape, "list">,
  evidence: IntentRefusalEvidence,
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
    const held = yield* intents.list.pipe(Effect.result);
    if (held._tag === "Failure")
      return {
        status: NOT_NOW,
        body: { unavailable: "This machine could not read its away intents. Ask again." },
      };
    const latest = held.success.findLast(
      (intent) => intent.sourceEnvironmentId === caller.sourceEnvironmentId,
    );
    if (latest !== undefined && mayRepeat(latest, body.value))
      return {
        status: 200,
        body: {
          intent: latest,
          refusedProjectIds: body.value.projectIds.filter(
            (projectId) => !latest.projectIds.includes(projectId),
          ),
        },
      };
    if (yield* anyBeganHere(caller.sourceEnvironmentId, body.value, evidence))
      return {
        status: NOT_NOW,
        body: {
          unavailable:
            "Some of this work may already continue on this machine. Ask what happened to it after waking.",
        },
      };
    return { status: 409, body: { error: SLEEP_START_REFUSAL } };
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

/** What the status route reads: the intents, and what began here for each asked thread. */
export interface IntentStatusSources extends Pick<AwayIntentsShape, "latestState"> {
  /** Handoff mode's receiver for the caller's thread. Never launches. */
  readonly continuation: (sourceThreadId: string) => Effect.Effect<ContinuationEvidence>;
}

const notNow = (error: string): IntentAnswer => ({ status: NOT_NOW, body: { error } });

/**
 * Whether this machine took over each of the caller's projects. Answered from
 * the bindings here, not only from the intents: a planned handover in doubt
 * and an intent that acted both show as a copy that coordinates with the
 * caller's copy as its predecessor. Not taken over is answered only where the
 * project provably stayed with the caller (`stayedWithSource`); any other is
 * left out of `projects`, which a source on any release keeps held.
 *
 * Each asked thread is answered from handoff mode: continued names the
 * thread here; provably not begun is null. A thread whose launch here is in
 * doubt is left out of `threads`, which a source on any release keeps held
 * while the intent is not cancelled or absent. With a cancelled or absent
 * intent a source releases every thread it is not told was continued, so the
 * whole answer is 503 then, as it is when the projects asked about do not read.
 */
export const intentStatus = <E>(
  sources: IntentStatusSources,
  caller: ReceiverCaller,
  raw: unknown,
  /** This machine's projects; read only when the caller asks about projects. */
  projects: Effect.Effect<ReadonlyArray<Project>, E>,
  selfEnvironmentId: string,
): Effect.Effect<IntentAnswer> =>
  Effect.gen(function* () {
    const body = decodeStatus(raw);
    if (Option.isNone(body))
      return { status: 400, body: { error: "The request does not match this version." } };
    if (body.value.sourceEnvironmentId !== caller.sourceEnvironmentId)
      return { status: 403, body: { error: "A machine may ask only about its own projects." } };
    const state = yield* sources.latestState(caller.sourceEnvironmentId).pipe(Effect.result);
    if (state._tag === "Failure") return { status: 500, body: { error: state.failure.message } };
    const projectIds = body.value.projectIds;
    let projectsHere: ReadonlyArray<Project> = [];
    if (projectIds.length > 0) {
      const read = yield* projects.pipe(Effect.option);
      // Unread, every project would answer "not taken over", and a source would run it again.
      if (Option.isNone(read))
        return notNow("This machine could not read its projects. Ask again.");
      projectsHere = read.value;
    }
    const asked = body.value.threadIds;
    const evidence: ReadonlyArray<{
      readonly threadId: string;
      readonly found: ContinuationEvidence;
    }> =
      asked === undefined
        ? []
        : yield* Effect.forEach(asked, (threadId) =>
            sources.continuation(threadId).pipe(Effect.map((found) => ({ threadId, found }))),
          );
    const inDoubt = evidence.some((entry) => entry.found.kind === "unresolved");
    if (inDoubt && (state.success === "cancelled" || state.success === null))
      return notNow("This machine cannot tell yet whether it continued a thread. Ask again.");
    const answer: AwayIntentStatusAnswer = {
      intentState: state.success,
      projects: projectIds.flatMap((projectId) => {
        const source = caller.sourceEnvironmentId;
        const status = projectStatus(projectsHere, selfEnvironmentId, source, projectId);
        // Neither taken over nor deferring to the source: it may have come here and gone on.
        const known = status.takenOver || stayedWithSource(projectsHere, source, projectId);
        return known ? [status] : [];
      }),
      ...(asked === undefined
        ? {}
        : {
            threads: evidence.flatMap(({ threadId, found }) =>
              found.kind === "unresolved"
                ? []
                : [
                    {
                      threadId,
                      continuedThreadId: found.kind === "continued" ? found.threadId : null,
                    },
                  ],
            ),
            // Nothing here continues a thread for an intent any more.
            threadsSettled: state.success !== "waiting" && state.success !== "acting",
          }),
      receivedAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
    };
    return { status: 200, body: encodeStatusAnswer(answer) };
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
    const projects = (yield* ProjectService.ProjectService).snapshot.pipe(
      Effect.map((snapshot) => snapshot.projects),
      Effect.option,
    );
    // The receiver the handoff peer route uses, so its takeover lock orders these reads.
    const receiver = yield* HandoffReceiver;
    const answer = yield* recordIntent(who.caller, body.raw, yield* AwayIntents, {
      projects,
      continuation: (sourceThreadId) =>
        receiver.continuation(who.caller.sourceEnvironmentId, sourceThreadId),
    });
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

const statusRoute = HttpRouter.add(
  "POST",
  AWAY_INTENT_STATUS_PATH,
  Effect.gen(function* () {
    const who = yield* awayPeerCaller;
    if ("refused" in who) return who.refused;
    const body = yield* readBody;
    if (body === undefined) return tooLarge;
    const projects = (yield* ProjectService.ProjectService).snapshot.pipe(
      Effect.map((snapshot) => snapshot.projects),
    );
    const selfEnvironmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
    const intents = yield* AwayIntents;
    // The receiver the handoff peer route uses, so its takeover lock orders these reads.
    const receiver = yield* HandoffReceiver;
    const answer = yield* intentStatus(
      {
        latestState: intents.latestState,
        continuation: (sourceThreadId) =>
          receiver.continuation(who.caller.sourceEnvironmentId, sourceThreadId),
      },
      who.caller,
      body.raw,
      projects,
      selfEnvironmentId,
    );
    return answerJson(answer.status, answer.body);
  }),
);

export const layer = Layer.mergeAll(intentRoute, cancelRoute, statusRoute);
