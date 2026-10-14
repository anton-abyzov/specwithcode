import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import {
  ProviderAdapterTurnStartError,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2TurnInput,
} from "../orchestration-v2/ProviderAdapter.ts";
import type { ProjectContextDelivery } from "./ProjectContextDelivery.ts";

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
          });
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
          prepared?.text && !nativeCommand
            ? {
                ...input.message,
                text: `${prepared.text}\n\nCurrent user message:\n${input.message.text}`,
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
