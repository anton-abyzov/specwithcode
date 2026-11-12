import { CommandId, MessageId, type OrchestrationV2ThreadShell } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";

/** What the resumed turn opens with on this machine. */
export const HANDOFF_RESUME_TEXT =
  "The handoff to another machine did not happen, so this turn continues here. Continue where you left off.";

/** Refused before anything on the thread changes: a child whose owner has not settled it. */
export const UNSETTLED_CHILD_REFUSAL =
  "A child's owning process or machine has not settled its work. Keep it unknown and reconcile it on the owning host before handing off.";

export const hasUnsettledChild = (checkpoint: {
  readonly children?: ReadonlyArray<{ readonly disposition: string }> | undefined;
}) => checkpoint.children?.some((child) => child.disposition === "unknown") === true;

/**
 * Starts the turn a handoff interrupted again here, after the move definitely
 * did not happen, so the thread is not left stopped. One continuation per
 * interrupted run, however often it is asked for; a failure is only logged
 * (the hold's lastError already says what happened).
 */
export const resumeInterruptedTurn = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  shell: OrchestrationV2ThreadShell,
) =>
  shell.activeRunId === null
    ? Effect.void
    : orchestrator
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`handoff-resume:${shell.activeRunId}`),
          messageId: MessageId.make(`handoff-resume:${shell.activeRunId}`),
          threadId: shell.id,
          manualContinuationOfRunId: shell.activeRunId,
          text: HANDOFF_RESUME_TEXT,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Effect.logWarning("Handoff could not resume the turn it interrupted", {
              threadId: shell.id,
              cause,
            }),
          ),
        );
