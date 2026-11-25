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
/** Every line break a run history could show as one: CR, LF, NEL and the Unicode separators. */
const LINE_BREAK = /\r\n|[\n\r\u000b\u000c\u0085\u2028\u2029]/;

/** Text up to its first line break; text without one comes back unchanged. */
export function firstLineOf(text: string): string {
  const lineBreak = LINE_BREAK.exec(text);
  return lineBreak === null ? text : text.slice(0, lineBreak.index).trimEnd();
}

/** One line of a note or diagnostic, trimmed and capped, as a task records it. */
export function reasonLine(text: string): string {
  return firstLineOf(text).trim().slice(0, MAX_REASON_LENGTH);
}

/** One line of a failure's own message, trimmed and capped, as a task records it. */
export function shortFailureReason(text: string): string {
  const line = reasonLine(text);
  return line.length > 0 ? line : "The run failed.";
}

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
  return shortFailureReason(text);
}
