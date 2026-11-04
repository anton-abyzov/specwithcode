/**
 * The access request card's lifetime inside the agent's tool call: record it
 * pending, wait for the user's answer (AccessRequests.answer) or for the run
 * to end, and close it as cancelled when the call ends first. Only this call
 * hands the agent its answer, so the card never outlives it.
 *
 * @module accessRequestCard
 */
import {
  type AccessRequestScope,
  type AccessRequestSubject,
  type CommandId,
  type NodeId,
  OrchestratorMcpFailure,
  type RunId,
  type ThreadId,
  type TurnItemId,
} from "@specweave-studio/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import { sha256 } from "../nodeCrypto.ts";
import * as Metrics from "../observability/Metrics.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

/** What an access request card asks for, already resolved for display. */
export interface AccessRequestCardInput {
  readonly accessTitle: string;
  readonly reason: string;
  readonly subjects: ReadonlyArray<AccessRequestSubject>;
  readonly timeoutMs?: number | undefined;
  readonly clientRequestId?: string | undefined;
}

export interface AccessRequestCardResult {
  readonly status: "allowed" | "denied" | "cancelled" | "timed_out";
  readonly scope?: AccessRequestScope;
}

/**
 * The key a card is recorded under: the caller's request key with a stable
 * hash of the subject keys it asks for, sorted and without repeats. A retry
 * with the same clientRequestId and subjects finds its card; the same id
 * with other subjects makes a new card rather than reusing another answer.
 */
export function accessRequestKey(
  requestKey: string,
  subjects: ReadonlyArray<Pick<AccessRequestSubject, "key">>,
): string {
  const keys = [...new Set(subjects.map((subject) => subject.key))].toSorted();
  return `${requestKey}:${sha256([JSON.stringify(keys)], "hex").slice(0, 16)}`;
}

/** A person answers the card, so a slower poll is plenty. */
export const ACCESS_REQUEST_POLL_INTERVAL_MS = 500;

export interface AccessRequestCardDeps {
  readonly threadManagement: ThreadManagementService.ThreadManagementService["Service"];
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly turnItemId: TurnItemId;
  /** The stable command id for recording the card in this state. */
  readonly commandId: (accessStatus: "pending" | "cancelled") => CommandId;
  /** How long to wait for an answer, already capped by the caller. */
  readonly timeoutMs: number;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const failure = (message: string) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message });

/** Shows the card and waits for its answer; at least one subject is required. */
export const waitForAccessRequestCard = (
  deps: AccessRequestCardDeps,
  input: Omit<AccessRequestCardInput, "subjects"> & {
    readonly subjects: readonly [AccessRequestSubject, ...Array<AccessRequestSubject>];
  },
): Effect.Effect<AccessRequestCardResult, OrchestratorMcpFailure> =>
  Effect.gen(function* () {
    const { threadManagement, threadId, runId, nodeId, turnItemId } = deps;
    const record = (accessStatus: "pending" | "cancelled") =>
      threadManagement
        .dispatch({
          type: "access_request.record",
          commandId: deps.commandId(accessStatus),
          threadId,
          runId,
          nodeId,
          turnItemId,
          accessTitle: input.accessTitle,
          reason: input.reason,
          subjects: input.subjects,
          accessStatus,
        })
        .pipe(
          Effect.mapError((error) =>
            failure(`Could not record the access request: ${errorMessage(error)}`),
          ),
        );
    const readCard = threadManagement
      .getThreadRecords(threadId, ["runs", "turnItems"], {
        turnItemTypes: ["access_request"],
        messageRoles: [],
      })
      .pipe(
        Effect.mapError((error) =>
          failure(`Unable to read the access request: ${errorMessage(error)}`),
        ),
      );
    yield* record("pending");
    // Only this call hands the agent its answer, so the card must not
    // outlive it: a timeout, a failed wait or an aborted call closes it.
    const closeCard = record("cancelled").pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not close an access request card", { error: error.message }),
      ),
    );
    const answered = yield* Effect.gen(function* () {
      while (true) {
        const projection = yield* readCard;
        const item = projection.turnItems.find((candidate) => candidate.id === turnItemId);
        if (item?.type === "access_request" && item.accessStatus !== "pending") {
          return {
            status: item.accessStatus,
            ...(item.accessScope === undefined ? {} : { scope: item.accessScope }),
          } satisfies AccessRequestCardResult;
        }
        const current = projection.runs.find((candidate) => candidate.id === runId);
        if (current === undefined || ThreadManagementService.isTerminalRunStatus(current.status)) {
          yield* record("cancelled");
          return { status: "cancelled" } satisfies AccessRequestCardResult;
        }
        yield* Effect.sleep(Duration.millis(ACCESS_REQUEST_POLL_INTERVAL_MS));
      }
    }).pipe(
      Effect.timeoutOption(Duration.millis(deps.timeoutMs)),
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : closeCard)),
    );
    if (Option.isNone(answered)) yield* closeCard;
    // An answer that raced the timeout still wins: the card is answered once.
    const result: AccessRequestCardResult = Option.isSome(answered)
      ? answered.value
      : yield* readCard.pipe(
          Effect.map((records): AccessRequestCardResult => {
            const item = records.turnItems.find((candidate) => candidate.id === turnItemId);
            return item?.type === "access_request" &&
              (item.accessStatus === "allowed" || item.accessStatus === "denied")
              ? {
                  status: item.accessStatus,
                  ...(item.accessScope === undefined ? {} : { scope: item.accessScope }),
                }
              : { status: "timed_out" };
          }),
          Effect.orElseSucceed((): AccessRequestCardResult => ({ status: "timed_out" })),
        );
    yield* Effect.annotateCurrentSpan({ "access_request.status": result.status });
    yield* Metrics.increment(Metrics.accessRequestsTotal, { status: result.status });
    return result;
  });
