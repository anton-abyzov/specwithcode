import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import {
  ProviderAdapterTurnStartError,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2TurnInput,
} from "../orchestration-v2/ProviderAdapter.ts";
import type { ProjectContextDelivery } from "./ProjectContextDelivery.ts";
import { currentTimeLine } from "./currentTimeLine.ts";

/**
 * Drivers that confirm each delivered prompt, so the next turn sends only
 * changed sections. Others get the full snapshot every turn and therefore
 * receive project knowledge as a catalog to search.
 */
const RECEIPT_DRIVERS = new Set(["claudeAgent", "codex"]);

/** Last boundary before native dispatch, after historical handoffs are composed. */
export function withProjectContext(
  session: ProviderAdapterV2SessionRuntime,
  delivery: ProjectContextDelivery["Service"],
): ProviderAdapterV2SessionRuntime {
  const start = (input: ProviderAdapterV2TurnInput, compact = false) =>
    Effect.gen(function* () {
      const projectId = input.appThread.projectId;
      const restoring = delivery.restore(projectId, input.threadId).pipe(
        Effect.catchCause(() =>
          Effect.logWarning("Project context restoration unavailable", {
            threadId: input.threadId,
          }).pipe(Effect.as("")),
        ),
      );
      // Native continuation consumes already queued work. Never use it to acknowledge a prompt.
      const nativeOnly = compact || input.restartContinuationOfRunId !== undefined;
      const nativeCommand = /^\/goal(?:\s|$)/.test(input.message.text.trim());
      const prepared = nativeOnly
        ? null
        : yield* delivery.prepare({
            projectId,
            threadId: input.threadId,
            runId: input.runId,
            driver: session.driver,
            providerInstanceId: input.modelSelection.instanceId,
            providerThreadId: input.providerThread.id,
            nativeThreadId: input.providerThread.nativeThreadRef?.nativeId ?? null,
            inlineKnowledge: RECEIPT_DRIVERS.has(session.driver) && !nativeCommand,
          });
      // Native slash commands must stay at the start of the prompt, so only
      // a turn that carries the user's words gets the clock line.
      const clock =
        nativeOnly || nativeCommand || input.message.text.trimStart().startsWith("/")
          ? null
          : currentTimeLine(yield* Clock.currentTimeMillis);
      const context = [clock, prepared?.text && !nativeCommand ? prepared.text : null]
        .filter((part): part is string => part !== null && part !== "")
        .join("\n\n");
      const contextInput: ProviderAdapterV2TurnInput = {
        ...input,
        projectContext: {
          restore: restoring,
          ...(nativeCommand && prepared ? { nativeCommandText: prepared.text } : {}),
          accepted:
            prepared?.accepted.pipe(
              Effect.catchCause(() =>
                Effect.logWarning(
                  "Project context acceptance receipt unavailable; restore on next real prompt",
                  { threadId: input.threadId, runId: input.runId },
                ),
              ),
            ) ?? Effect.void,
        },
        message:
          context !== ""
            ? {
                ...input.message,
                text: `${context}\n\nCurrent user message:\n${input.message.text}`,
              }
            : input.message,
      };
      return yield* compact && session.compactThread
        ? session.compactThread(contextInput)
        : session.startTurn(contextInput);
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(ProviderAdapterTurnStartError)(cause)
          ? cause
          : new ProviderAdapterTurnStartError({
              driver: session.driver,
              threadId: input.threadId,
              providerThreadId: input.providerThread.id,
              runId: input.runId,
              cause,
            }),
      ),
    );
  return {
    ...session,
    startTurn: (input) => start(input),
    ...(session.compactThread
      ? { compactThread: (input: ProviderAdapterV2TurnInput) => start(input, true) }
      : {}),
  };
}
