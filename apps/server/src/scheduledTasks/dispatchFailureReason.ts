import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";

const isOrchestratorDispatchError = Schema.is(OrchestratorDispatchError);

/** Long enough for any reason a person writes; anything longer is not a reason. */
const MAX_REASON_LENGTH = 500;

/**
 * The reason a refused or failed run records on its task, which agents and the UI read.
 *
 * Only the failure's own message is kept: one line, no stack and no nested causes. A nested
 * cause can carry request data, tokens or paths from deep inside a dispatch, and the full
 * cause still goes to the server log where the run is reported. An orchestration refusal keeps
 * its reason when the orchestrator gave one as text.
 */
export function dispatchFailureReason(cause: Cause.Cause<unknown>): string {
  const failure = Cause.squash(cause);
  const text =
    isOrchestratorDispatchError(failure) && typeof failure.cause === "string"
      ? failure.cause
      : failure instanceof Error
        ? failure.message
        : typeof failure === "string"
          ? failure
          : "The run failed.";
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return (firstLine.length > 0 ? firstLine : "The run failed.").slice(0, MAX_REASON_LENGTH);
}
