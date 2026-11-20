import { OrchestratorMcpFailure } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import { CoordinatorMessageOutbox } from "../../../project/CoordinatorMessageOutbox.ts";
import * as Access from "../../McpToolAccess.ts";
import { assertLiveCaller, readCaller } from "../../threadAccess.ts";
import { assertProjectReadable } from "../../workGrantAccess.ts";
import { CoordinatorMessageToolkit } from "./tools.ts";
/** The outbox words its refusals for the agent; anything else gets the generic text. */
const problemOf = (error: unknown, fallback: string): string =>
  typeof error === "object" &&
  error !== null &&
  "message" in error &&
  typeof error.message === "string" &&
  error.message.trim() !== ""
    ? error.message
    : fallback;

export const layer = Access.toLayer(CoordinatorMessageToolkit, {
  studio_coordinator_message_read: Access.reads((input) =>
    Effect.gen(function* () {
      const caller = yield* readCaller();
      if (
        caller.caller === undefined ||
        caller.caller.id !== `project-coordinator:${caller.caller.projectId}`
      )
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only this project's coordinator may read a coordinator report.",
        });
      // A stale or stopped coordinator token cannot read reports another machine trusted it with.
      yield* assertLiveCaller(caller);
      yield* assertProjectReadable(caller, caller.caller.projectId);
      return yield* (yield* CoordinatorMessageOutbox)
        .read({
          ...input,
          offset: input.offset ?? 0,
          projectId: caller.caller.projectId,
          threadId: caller.caller.id,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                code: "capability_denied",
                message: problemOf(
                  error,
                  "The named coordinator report cannot be read under current machine access.",
                ),
              }),
          ),
        );
    }),
  ),
  studio_coordinator_message: Access.writes((input) =>
    Effect.gen(function* () {
      const caller = yield* readCaller();
      if (
        caller.caller === undefined ||
        caller.caller.id !== `project-coordinator:${caller.caller.projectId}`
      )
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only this project's coordinator may send a coordinator message.",
        });
      yield* assertProjectReadable(caller, caller.caller.projectId);
      const { machine, clientRequestId, ...message } = input;
      const sent = yield* (yield* CoordinatorMessageOutbox)
        .send({
          projectId: caller.caller.projectId,
          threadId: caller.caller.id,
          runId: caller.caller.activeRunId,
          machine,
          clientRequestId,
          message,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                code: "invalid_request",
                message: problemOf(
                  error,
                  "The coordinator message could not be sent. Check this project's link, machine access, message limits and reply target.",
                ),
              }),
          ),
        );
      return { messageId: sent.externalId, state: sent.state };
    }),
  ),
});
