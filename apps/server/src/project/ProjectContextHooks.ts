import type { Options } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import type {
  ProviderAdapterV2ProjectContext,
  ProviderAdapterV2TurnInput,
} from "../orchestration-v2/ProviderAdapter.ts";

/** A hook returning text is not an acknowledgement until the matching prompt is echoed. */
export function makeProjectContextHooks() {
  const current = new Map<string, ProviderAdapterV2TurnInput>();
  const delivered = new WeakSet<ProviderAdapterV2ProjectContext>();
  return {
    register: (nativeId: string, input: ProviderAdapterV2TurnInput) => {
      current.set(nativeId, input);
    },
    canAcknowledge: (context: ProviderAdapterV2ProjectContext) =>
      !context.nativeCommandText || delivered.has(context),
    hooks: (nativeId: string, existing: Options["hooks"]): NonNullable<Options["hooks"]> => ({
      ...existing,
      SessionStart: [
        ...(existing?.SessionStart ?? []),
        {
          hooks: [
            (input) =>
              Effect.runPromise(
                Effect.gen(function* () {
                  if (input.hook_event_name !== "SessionStart") return {};
                  const context = current.get(nativeId)?.projectContext;
                  if (!context) return {};
                  // Ordinary starts already carry the prepared snapshot in their user prompt.
                  const commandStart =
                    (input.source === "startup" || input.source === "resume") &&
                    !!context.nativeCommandText;
                  if (input.source !== "compact" && !commandStart) return {};
                  const text = commandStart ? context.nativeCommandText! : yield* context.restore;
                  if (!text) return {};
                  if (commandStart) delivered.add(context);
                  return {
                    hookSpecificOutput: {
                      hookEventName: "SessionStart" as const,
                      additionalContext: text,
                    },
                  };
                }),
              ),
          ],
        },
      ],
      UserPromptSubmit: [
        ...(existing?.UserPromptSubmit ?? []),
        {
          hooks: [
            (input) =>
              Effect.runPromise(
                Effect.sync(() => {
                  if (input.hook_event_name !== "UserPromptSubmit") return {};
                  const turn = current.get(nativeId);
                  const context = turn?.projectContext;
                  if (
                    !context?.nativeCommandText ||
                    delivered.has(context) ||
                    input.prompt !== turn?.message.text
                  )
                    return {};
                  delivered.add(context);
                  return {
                    hookSpecificOutput: {
                      hookEventName: "UserPromptSubmit" as const,
                      additionalContext: context.nativeCommandText,
                    },
                  };
                }),
              ),
          ],
        },
      ],
    }),
  };
}
