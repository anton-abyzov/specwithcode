/**
 * `POST /api/away/v1/return`: Bring back, on the target. The machine that left
 * asks for the threads this machine continued for it; each goes back through
 * the normal move with reason `back` (its queued messages too). Only threads
 * that came from that machine are handed, and only to it. It also asks for
 * the coordinators it handed here: this machine hands each linked copy back
 * by the same planned handover (reason `back`), so two never coordinate.
 *
 * A thread goes back only when the caller's grant here could send it there
 * (`mayReturnToOrigin`) and covers its project. A coordinator goes back only
 * when this copy took it from the caller by Away or a planned handover and the
 * grant covers the project; a coordinator this machine runs for itself, or
 * took from a third machine, stays.
 */
import {
  AWAY_RETURN_PATH,
  AwayHandoverResult,
  type EnvironmentId,
  type HandoffMachineThreadResult,
  NonNegativeInt,
  type Project,
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

import {
  type EffectiveWorkGrant,
  mayReturnToOrigin,
  projectInGrant,
} from "../fleet/workGrantPolicy.ts";
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

type ReturnGrant = Pick<EffectiveWorkGrant, "owner" | "revoked">;

/** Whether `grant` lets work that came from `caller` go back there. */
const mayGoBack = (grant: ReturnGrant | null, caller: EnvironmentId) =>
  grant === null ||
  mayReturnToOrigin({
    grant,
    origin: { coordinatorEnvironmentId: caller, path: [caller], hops: 1 },
    targetEnvironmentId: caller,
  });

/**
 * Which of `threadIds` came here from `caller` and may go back under its
 * grant; the rest stay, with why. `projectCovered` is whether the caller's
 * grant covers the thread's project here (absent: covered).
 */
export function returnable(
  threads: ReadonlyArray<{
    readonly id: string;
    readonly sourceEnvironmentId: string | null;
    readonly found: boolean;
    readonly projectCovered?: boolean;
  }>,
  caller: EnvironmentId,
  grant: ReturnGrant | null = null,
): {
  readonly ok: ReadonlyArray<string>;
  readonly refused: ReadonlyArray<HandoffMachineThreadResult>;
} {
  const ok: Array<string> = [];
  const refused: Array<HandoffMachineThreadResult> = [];
  const allowed = mayGoBack(grant, caller);
  for (const thread of threads) {
    const fromCaller = thread.found && thread.sourceEnvironmentId === caller;
    if (fromCaller && allowed && thread.projectCovered !== false) {
      ok.push(thread.id);
      continue;
    }
    refused.push({
      threadId: ThreadId.make(thread.id),
      title: thread.id.slice(0, 500),
      outcome: "skipped",
      detail: !thread.found
        ? "That thread is not on this machine any more."
        : !fromCaller
          ? "That thread did not come here from your machine, so it stays."
          : "Your machine's work grant here does not cover that thread, so it stays.",
      continuedThreadId: null,
      resumed: false,
    });
  }
  return { ok, refused };
}

/**
 * Why the linked copy `copy` here may not hand its coordinator back to
 * `caller`, or null when it may: this copy coordinates, it took over from the
 * caller by Away (`away:`) or a planned handover (`handover:`), and the
 * caller's grant covers the project.
 */
export function coordinatorReturnRefusal(
  copy: Pick<Project, "id" | "workspaceSettings">,
  caller: EnvironmentId,
  grant: (ReturnGrant & Pick<EffectiveWorkGrant, "projects">) | null,
): string | null {
  const binding = copy.workspaceSettings?.coordinatorBinding;
  const operationId = binding?.operationId ?? "";
  const handedHere =
    binding?.state === "active" &&
    binding.predecessor?.environmentId === caller &&
    (operationId.startsWith("away:") || operationId.startsWith("handover:"));
  if (!handedHere) return "This machine did not take this coordinator from yours, so it stays.";
  if (
    grant !== null &&
    (!mayGoBack(grant, caller) || !projectInGrant(grant.projects, caller, copy))
  )
    return "Your machine's work grant here does not cover this project, so its coordinator stays.";
  return null;
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
  const grant = who.caller.grant;
  const projects = yield* ProjectService.ProjectService;
  const all: ReadonlyArray<Project> = yield* projects.snapshot.pipe(
    Effect.map((snapshot) => snapshot.projects),
    Effect.orElseSucceed(() => []),
  );
  const covers = (projectId: string) => {
    if (grant === null) return true;
    const project = all.find((entry) => entry.id === projectId);
    return project !== undefined && projectInGrant(grant.projects, caller, project);
  };
  const threads = yield* Effect.forEach(body.value.threadIds, (threadId) =>
    projections.getThread(threadId).pipe(
      Effect.map((thread) => ({
        id: threadId,
        sourceEnvironmentId: thread.execution?.sourceRoot?.environmentId ?? null,
        found: thread.deletedAt === null,
        projectCovered: covers(thread.projectId),
      })),
      Effect.orElseSucceed(() => ({ id: threadId, sourceEnvironmentId: null, found: false })),
    ),
  );
  const { ok, refused } = returnable(threads, caller, grant);
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
    const handover = yield* CoordinatorPlannedHandover;
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
      const refusal = coordinatorReturnRefusal(copy, caller, grant);
      if (refusal !== null) {
        coordinators.push({ projectId: sourceProjectId, outcome: "skipped", detail: refusal });
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
