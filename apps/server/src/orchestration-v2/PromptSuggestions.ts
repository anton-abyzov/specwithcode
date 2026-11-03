/**
 * Suggested next prompts: one per finished run, shown as ghost text in the
 * composer. Claude's SDK predicts one after its reply; the reactor writes one
 * with the text-generation model for runs that end without it.
 */
import type {
  OrchestrationV2PromptSuggestion,
  OrchestrationV2Run,
  RunId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

/** The longest suggestion kept; longer ones are cut at a word. */
export const PROMPT_SUGGESTION_MAX_LENGTH = 280;

/** The run a suggested next prompt belongs to: the thread's latest by ordinal. */
export function latestPromptSuggestionRun<Run extends Pick<OrchestrationV2Run, "ordinal">>(
  runs: ReadonlyArray<Run>,
): Run | undefined {
  let latest: Run | undefined;
  for (const run of runs) if (latest === undefined || run.ordinal > latest.ordinal) latest = run;
  return latest;
}

/**
 * Whether a suggestion may be recorded on the run: only the reply the person
 * is looking at (the latest run, completed), the provider's own wins over a
 * generated one, and an identical one changes nothing.
 */
export function acceptsPromptSuggestion(
  runs: ReadonlyArray<OrchestrationV2Run>,
  runId: RunId,
  suggestion: OrchestrationV2PromptSuggestion,
): boolean {
  const run = latestPromptSuggestionRun(runs);
  if (run?.id !== runId || run.status !== "completed") return false;
  if (run.promptSuggestion?.source === "provider" && suggestion.source === "generated")
    return false;
  return run.promptSuggestion?.text !== suggestion.text;
}

/** Trims a raw suggestion to one short line, or null when nothing usable is left. */
export function normalizePromptSuggestion(raw: string): string | null {
  let text = raw.replace(/\s+/g, " ").trim();
  // Models sometimes wrap the prompt in quotes or label it.
  text = text.replace(/^(suggested prompt|suggestion|next prompt)\s*:\s*/i, "");
  const quoted = /^["'`“‘](.*)["'`”’]$/.exec(text);
  if (quoted) text = quoted[1]!.trim();
  if (text.length === 0) return null;
  if (text.length > PROMPT_SUGGESTION_MAX_LENGTH) {
    const cut = text.slice(0, PROMPT_SUGGESTION_MAX_LENGTH);
    const space = cut.lastIndexOf(" ");
    text = (space > PROMPT_SUGGESTION_MAX_LENGTH / 2 ? cut.slice(0, space) : cut).trimEnd();
  }
  return text;
}

export interface PromptSuggestionOffer {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly text: string;
}

/**
 * Adapters offer a provider's own suggestion here; the reactor records it.
 * The default reference drops offers, keeping adapter construction
 * dependency-free in tests; the live layer must be the same reference the
 * reactor drains (shared through ProviderOrchestrationAdapterInfrastructure).
 */
export interface PromptSuggestionOffersShape {
  readonly offer: (offer: PromptSuggestionOffer) => Effect.Effect<void>;
  readonly take: Effect.Effect<PromptSuggestionOffer>;
  /** Whether adapters should ask their provider for one; false when the setting is Off. */
  readonly wanted: Effect.Effect<boolean>;
  readonly setWanted: (wanted: boolean) => Effect.Effect<void>;
}

export class PromptSuggestionOffers extends Context.Reference<PromptSuggestionOffersShape>(
  "studio/orchestration-v2/PromptSuggestionOffers",
  {
    defaultValue: () => ({
      offer: () => Effect.void,
      take: Effect.never,
      wanted: Effect.succeed(false),
      setWanted: () => Effect.void,
    }),
  },
) {}

export const layer = Layer.effect(
  PromptSuggestionOffers,
  Effect.gen(function* () {
    // A hint, not a record: when nobody drains, old offers give way to new ones.
    const queue = yield* Queue.sliding<PromptSuggestionOffer>(256);
    // The reactor keeps this in step with the Suggested prompts setting.
    const wanted = yield* Ref.make(true);
    return {
      offer: (offer: PromptSuggestionOffer) => Queue.offer(queue, offer).pipe(Effect.asVoid),
      take: Queue.take(queue),
      wanted: Ref.get(wanted),
      setWanted: (next: boolean) => Ref.set(wanted, next),
    };
  }),
);
