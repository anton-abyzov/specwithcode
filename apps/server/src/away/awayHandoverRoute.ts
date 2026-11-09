/**
 * `POST /api/away/v1/handover`: the coordinator of a linked project, which
 * already gave way to this machine's copy, asks it to take over (Away mode's
 * planned handover, CoordinatorPlannedHandover). Only a machine with a live
 * work grant here gets in, and the handover must come from that machine.
 *
 * Routines that ride along run here under that machine's work grant here,
 * never under a grant the copy claims: each is stamped with the caller's grant
 * (its runtime cap and accounts), so the routine grant gate checks it before
 * every fire. Without the routines capability none are kept; the handover
 * still goes ahead and the answer lists them with why. A routine this machine
 * already has as its owner's own stays exactly as it is.
 */
import {
  AWAY_HANDOVER_PATH,
  type CoordinatorRoutineCopy,
  type ScheduledTask,
  type ScheduledTaskGrantedBy,
  ScheduledTaskId,
} from "@specweave-studio/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import { COORDINATOR_REPLICA_MAX_BYTES } from "../handoff/handoffWire.ts";
import type { ReceiverCaller } from "../handoff/HandoffReceiver.ts";
import { parseJson } from "../json.ts";
import {
  CoordinatorPlannedHandover,
  PlannedHandoverRequest,
} from "../project/CoordinatorPlannedHandover.ts";
import { routineCopyOf } from "../scheduledTasks/ScheduledTaskCopies.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import { answerJson, awayPeerCaller } from "./awayPeerCall.ts";

/** Routines with their run state, and up to 200 workers. */
const MAX_BODY_BYTES = COORDINATOR_REPLICA_MAX_BYTES;
const decodeRequest = Schema.decodeUnknownOption(PlannedHandoverRequest);

export const ROUTINES_NOT_ALLOWED_REASON =
  "This machine's work grant for that machine does not allow routines, so they were not kept here. Turn on Routines for it in Settings > Machines > Who can run work here.";

export interface RoutineNotCarried {
  readonly routineId: string;
  readonly title: string;
  readonly reason: string;
}

/** A routine this machine already holds, with the grant it was saved under (undefined: the owner's). */
export interface LocalRoutine {
  readonly task: ScheduledTask;
  readonly grantedBy: ScheduledTaskGrantedBy | undefined;
}

/**
 * The request as this machine keeps it: routines stamped with the caller's
 * grant here, or none when that grant does not allow routines. A copy's own
 * `grantedBy` is never trusted.
 */
export function stampHandoverRoutines(
  caller: ReceiverCaller,
  request: PlannedHandoverRequest,
  local: ReadonlyMap<string, LocalRoutine>,
): {
  readonly request: PlannedHandoverRequest;
  readonly notCarried: ReadonlyArray<RoutineNotCarried>;
} {
  const routines = request.routines;
  if (routines === undefined || routines.length === 0) return { request, notCarried: [] };
  const grant = caller.grant;
  if (grant !== null && !grant.routines && grant.legacy !== true) {
    const { routines: _routines, runStates: _runStates, ...rest } = request;
    return {
      request: rest,
      notCarried: routines.map((routine) => ({
        routineId: routine.id,
        title: routine.title.slice(0, 200),
        reason: ROUTINES_NOT_ALLOWED_REASON,
      })),
    };
  }
  const stamp: ScheduledTaskGrantedBy | undefined =
    grant === null
      ? undefined
      : {
          coordinatorEnvironmentId: caller.sourceEnvironmentId,
          runtimeCap: caller.runtimeCeiling ?? null,
          accounts: grant.accounts,
        };
  const kept = routines.map((copy): CoordinatorRoutineCopy => {
    const held = local.get(copy.id);
    // The owner's own routine here keeps its content and has no grant: a grantee never changes it.
    if (
      held !== undefined &&
      held.task.projectId === request.projectId &&
      held.grantedBy === undefined
    ) {
      const own = routineCopyOf(held.task);
      if (own !== null) return own;
    }
    const { grantedBy: _foreign, ...rest } = copy;
    return stamp === undefined ? rest : { ...rest, grantedBy: stamp };
  });
  return { request: { ...request, routines: kept }, notCarried: [] };
}

/** This machine's routines in `projectId`, with the grants they were saved under. */
const localRoutines = (projectId: string) =>
  Effect.gen(function* () {
    const scheduled = yield* Effect.serviceOption(ScheduledTaskService);
    if (Option.isNone(scheduled)) return new Map<string, LocalRoutine>();
    const service = scheduled.value;
    const tasks = yield* service.list().pipe(
      Effect.map((listed) => listed.tasks.filter((task) => task.projectId === projectId)),
      Effect.orElseSucceed((): ReadonlyArray<ScheduledTask> => []),
    );
    const entries = yield* Effect.forEach(tasks, (task) =>
      (service.readGrant === undefined
        ? Effect.succeed(undefined)
        : service.readGrant(ScheduledTaskId.make(task.id)).pipe(
            // A grant that cannot be read is never taken as the owner's.
            Effect.orElseSucceed((): ScheduledTaskGrantedBy => ({
              coordinatorEnvironmentId: "unknown",
            })),
          )
      ).pipe(Effect.map((grantedBy) => [task.id as string, { task, grantedBy }] as const)),
    );
    return new Map<string, LocalRoutine>(entries);
  });

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
    const stamped = stampHandoverRoutines(
      who.caller,
      body.value,
      body.value.routines === undefined || body.value.routines.length === 0
        ? new Map()
        : yield* localRoutines(body.value.projectId),
    );
    const handover = yield* CoordinatorPlannedHandover;
    return yield* handover.receive(who.caller, stamped.request).pipe(
      Effect.map((answer) =>
        answerJson(
          200,
          stamped.notCarried.length === 0
            ? answer
            : { ...answer, routinesNotCarried: stamped.notCarried },
        ),
      ),
      Effect.catchTags({
        HandoverRefusal: (refusal) =>
          Effect.succeed(answerJson(refusal.status, { error: refusal.message })),
      }),
    );
  }),
);
