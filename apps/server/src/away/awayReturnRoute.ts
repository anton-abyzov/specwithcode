/**
 * `POST /api/away/v1/return`: Bring back, on the target. The machine that left
 * asks for the threads this machine continued for it; each goes back through
 * the normal move with reason `back` (its queued messages too). Only threads
 * that came from that machine are handed, and only to it. It also asks for
 * the coordinators it handed here: this machine hands each linked copy back
 * by the same planned handover (reason `back`), so two never coordinate.
 */
import {
  AWAY_RETURN_PATH,
  AwayHandoverResult,
  type EnvironmentId,
  type HandoffMachineThreadResult,
  NonNegativeInt,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import { HandoffMode } from "../handoff/HandoffMode.ts";
import { parseJson } from "../json.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { CoordinatorPlannedHandover } from "../project/CoordinatorPlannedHandover.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { linkedCopyOf } from "./AwayIntents.ts";
import { answerJson, awayPeerCaller } from "./awayPeerCall.ts";

export const AWAY_RETURN_PROTOCOL_VERSION = 1;
const MAX_BODY_BYTES = 64 * 1024;

export const AwayReturnRequest = Schema.Struct({
  protocolVersion: NonNegativeInt,
  /** This machine's continuations, as the caller recorded them. */
  threadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(20)),
  /** The caller's projects whose coordinator this machine took for it. */
  projectIds: Schema.optional(Schema.Array(ProjectId).check(Schema.isMaxLength(20))),
});
export type AwayReturnRequest = typeof AwayReturnRequest.Type;

export const AwayReturnResult = Schema.Struct({
  threadId: Schema.String,
  outcome: Schema.Literals(["moved", "stayed", "skipped"]),
  detail: Schema.NullOr(Schema.String),
  /** The thread on the caller that continues it. */
  continuedThreadId: Schema.NullOr(Schema.String),
});
export const AwayReturnResponse = Schema.Struct({
  results: Schema.Array(AwayReturnResult),
  /** Per caller project: `projectId` is the caller's. */
  coordinators: Schema.optional(Schema.Array(AwayHandoverResult)),
});
export type AwayReturnResponse = typeof AwayReturnResponse.Type;

/** Reads a bounded JSON body; `too-large` past `maxBytes`, null for unreadable JSON. */
export const readAwayBody = (maxBytes: number) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const length = Number(request.headers["content-length"] ?? "0");
    if (!Number.isFinite(length) || length > maxBytes) return { kind: "too-large" } as const;
    const text = yield* request.text.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(maxBytes)),
      Effect.option,
    );
    if (Option.isNone(text)) return { kind: "too-large" } as const;
    let value: unknown = null;
    try {
      value = parseJson(text.value);
    } catch {
      value = null;
    }
    return { kind: "body", value } as const;
  });

/** Which of `threadIds` came here from `caller`; the rest stay, with why. */
export function returnable(
  threads: ReadonlyArray<{
    readonly id: string;
    readonly sourceEnvironmentId: string | null;
    readonly found: boolean;
  }>,
  caller: string,
): {
  readonly ok: ReadonlyArray<string>;
  readonly refused: ReadonlyArray<HandoffMachineThreadResult>;
} {
  const ok: Array<string> = [];
  const refused: Array<HandoffMachineThreadResult> = [];
  for (const thread of threads) {
    if (thread.found && thread.sourceEnvironmentId === caller) {
      ok.push(thread.id);
      continue;
    }
    refused.push({
      threadId: ThreadId.make(thread.id),
      title: thread.id.slice(0, 500),
      outcome: "skipped",
      detail: thread.found
        ? "That thread did not come here from your machine, so it stays."
        : "That thread is not on this machine any more.",
      continuedThreadId: null,
      resumed: false,
    });
  }
  return { ok, refused };
}

const decodeRequest = Schema.decodeUnknownOption(AwayReturnRequest);

const returnHandler = Effect.gen(function* () {
  const who = yield* awayPeerCaller;
  if ("refused" in who) return who.refused;
  const raw = yield* readAwayBody(MAX_BODY_BYTES);
  if (raw.kind === "too-large") return answerJson(413, { error: "The request is too large." });
  const body = decodeRequest(raw.value);
  if (Option.isNone(body))
    return answerJson(400, { error: "The request does not match this version." });
  if (body.value.protocolVersion !== AWAY_RETURN_PROTOCOL_VERSION)
    return answerJson(409, {
      error: "The two machines run different versions of Away mode. Update both.",
    });
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const handoff = yield* HandoffMode;
  const caller: EnvironmentId = who.caller.sourceEnvironmentId;
  const threads = yield* Effect.forEach(body.value.threadIds, (threadId) =>
    projections.getThread(threadId).pipe(
      Effect.map((thread) => ({
        id: threadId,
        sourceEnvironmentId: thread.execution?.sourceRoot?.environmentId ?? null,
        found: thread.deletedAt === null,
      })),
      Effect.orElseSucceed(() => ({ id: threadId, sourceEnvironmentId: null, found: false })),
    ),
  );
  const { ok, refused } = returnable(threads, caller);
  const run =
    ok.length === 0
      ? null
      : yield* handoff
          .handOffMachine({
            destinationEnvironmentId: caller,
            reason: "back",
            threadIds: ok.map((id) => ThreadId.make(id)),
          })
          .pipe(Effect.result);
  if (run !== null && run._tag === "Failure")
    return answerJson(409, { error: run.failure.message.slice(0, 500) });
  const results = [...(run === null ? [] : run.success.results), ...refused].map((result) => ({
    threadId: result.threadId,
    outcome: result.outcome,
    detail: result.detail,
    continuedThreadId: result.continuedThreadId,
  }));
  const coordinators: Array<AwayHandoverResult> = [];
  if ((body.value.projectIds ?? []).length > 0) {
    const projects = yield* ProjectService.ProjectService;
    const handover = yield* CoordinatorPlannedHandover;
    const all = yield* projects.snapshot.pipe(
      Effect.map((snapshot) => snapshot.projects),
      Effect.orElseSucceed(() => []),
    );
    for (const sourceProjectId of body.value.projectIds ?? []) {
      const copy = linkedCopyOf(all, caller, sourceProjectId);
      if (copy === undefined) {
        coordinators.push({
          projectId: sourceProjectId,
          outcome: "failed",
          detail: "This project has no linked copy on this machine.",
        });
        continue;
      }
      const handed = yield* handover.handOver({
        projectId: copy.id,
        targetEnvironmentId: caller,
        reason: "back",
      });
      coordinators.push({ ...handed, projectId: sourceProjectId });
    }
  }
  return answerJson(200, { results, coordinators } satisfies AwayReturnResponse);
});

// The projection store is taken when the route is built: a route's own
// requirements are resolved per request, where this store is not provided.
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return HttpRouter.add(
      "POST",
      AWAY_RETURN_PATH,
      returnHandler.pipe(Effect.provideService(ProjectionStore.ProjectionStoreV2, projections)),
    );
  }),
);
