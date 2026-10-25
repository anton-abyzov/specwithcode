import type {
  OrchestrationV2ContextHandoff,
  OrchestrationV2ProviderThread,
} from "@specweave-studio/contracts";
import type { ProviderAdapterV2HistoricalContext } from "./ProviderAdapter.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CONTEXT_HANDOFF_TOO_LARGE_MESSAGE } from "@specweave-studio/shared/orchestrationV2ThreadError";
import { historyCost, renderHistory, selectHistory } from "./ContextHandoffBudget.ts";

/** A pointer-only handoff is delivered within this many bytes even when the budget is smaller. */
export const POINTER_HANDOFF_FLOOR = 4_096;

/**
 * A provider continuation attaches to wake output the agent produced on its
 * own: adapters never send its text (see ClaudeAdapterV2 and AcpAdapterV2), so
 * history put in front of it reaches nobody.
 */
export function isPromptlessContinuation(message: {
  readonly createdBy: string;
  readonly creationSource: string;
}): boolean {
  return message.createdBy === "agent" && message.creationSource === "provider";
}

/**
 * Persist before/after injection: an ambiguous pending delivery requires a
 * fresh native thread. `rollback` restores the records as they were before
 * this delivery, for a start that failed before its prompt was offered;
 * `delivered` records an accepted inline delivery.
 */
export const deliverContextHandoffs = Effect.fn("orchestrationV2.deliverContextHandoffs")(
  function* <InjectError = never, PersistError = never, BudgetError = never>(input: {
    readonly handoffs: ReadonlyArray<OrchestrationV2ContextHandoff>;
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly budget: number | Effect.Effect<number, BudgetError>;
    readonly deferInline?: boolean;
    /** The turn sends no prompt text (isPromptlessContinuation): deliver and mark nothing. */
    readonly promptless?: boolean;
    /** Text that goes before the coverage marker when it fits, such as a SpecWeave checkpoint note. */
    readonly preface?: string;
    /**
     * Where this conversation's full native transcripts are on this machine
     * (see NativeSessionPointers). Part of the coverage, so it is delivered
     * even when no history item fits.
     */
    readonly nativeSessions?: string | Effect.Effect<string>;
    readonly alreadyDeliveredItemIds: ReadonlySet<string>;
    readonly inject?: (
      history: ProviderAdapterV2HistoricalContext,
    ) => Effect.Effect<boolean, InjectError>;
    readonly persist: (handoff: OrchestrationV2ContextHandoff) => Effect.Effect<void, PersistError>;
  }) {
    const nativeThreadId = input.providerThread.nativeThreadRef?.nativeId ?? undefined;
    const pending = input.handoffs.filter(
      (handoff) =>
        nativeThreadId === undefined ||
        handoff.delivery?.nativeThreadId !== nativeThreadId ||
        handoff.delivery.status === "pending",
    );
    if (
      pending.length === 0 ||
      input.promptless === true ||
      (input.deferInline && input.inject === undefined)
    )
      return { context: "", delivered: Effect.void, rollback: Effect.void };
    const budget = typeof input.budget === "number" ? input.budget : yield* input.budget;
    const nativeSessions =
      input.nativeSessions === undefined || typeof input.nativeSessions === "string"
        ? (input.nativeSessions ?? "")
        : yield* input.nativeSessions;
    let coverage = pending
      .map(
        (handoff) =>
          `Context handoff (${handoff.strategy === "fork_delta_summary" ? "merge_back / fork_delta_summary" : handoff.strategy}):\n${
            handoff.history?.coverage ??
            `From thread ${handoff.threadId}, runs ${handoff.coveredRunOrdinals.from}-${handoff.coveredRunOrdinals.to}. Recover history with studio_thread_read, view=activity; paginate with afterPosition, and use itemId/textOffset for long items.`
          }`,
      )
      .join("\n");
    const strategies = Array.from(new Set(pending.map((handoff) => handoff.strategy)));
    const compactCoverage = `Context handoff (${strategies.join(", ")}). ${pending.length} handoff records; detailed coverage references omitted. Recover history with studio_thread_read({threadId:"${input.providerThread.appThreadId ?? pending[0]!.threadId}",view:"activity",limit:20,maxCharsPerItem:4000}); paginate with afterPosition=nextPosition. Follow fork/handoff source references in activity. For long items use itemId and textOffset=nextTextOffset until null.`;
    // Repeated failures can accumulate many recovery markers. Keep a single
    // thread-level entry point when detailed coverage would crowd out history;
    // its activity includes the original handoff/fork source references.
    if (historyCost([], coverage) > Math.min(4_000, budget / 2)) coverage = compactCoverage;
    const withSessions = (text: string) => (nativeSessions ? `${text}\n${nativeSessions}` : text);
    coverage = withSessions(coverage);
    // The preface is advice for the next turn, not history: it is dropped first
    // when the budget is tight, and never pushes a history message out.
    if (
      input.preface !== undefined &&
      input.preface.length > 0 &&
      historyCost([], `${input.preface}\n\n${coverage}`) + 512 <= budget / 2
    ) {
      coverage = `${input.preface}\n\n${coverage}`;
    }
    const seen = new Set(input.alreadyDeliveredItemIds);
    const messages = pending
      .flatMap((handoff) => handoff.history?.messages ?? [])
      .filter((message) => {
        if (seen.has(message.itemId)) return false;
        seen.add(message.itemId);
        return true;
      });
    // Old preview handoffs remain readable. Their preformatted context is included
    // as a whole when it fits, otherwise the coverage marker points to retrieval.
    const oldContext = pending
      .filter((handoff) => handoff.history === undefined)
      .map((handoff) => handoff.summaryText)
      .join("\n\n");
    const fullCoverage =
      oldContext && historyCost([], `${coverage}\n${oldContext}`) + 512 <= budget
        ? `${coverage}\n${oldContext}`
        : coverage;
    const omittedBefore = pending.reduce(
      (sum, handoff) => sum + (handoff.history?.omittedItems ?? 0),
      0,
    );
    let selected = selectHistory({
      messages,
      coverage: fullCoverage,
      omittedItems: omittedBefore,
      budget,
    });
    if (historyCost(selected.messages, selected.context) > budget) {
      if (input.deferInline) return { context: "", delivered: Effect.void, rollback: Effect.void };
      // No history item fits, but where to find all of it always does: the
      // receiving agent rebuilds context from the thread and native
      // transcripts instead of the run failing. A fresh native session leaves
      // room for this; a full one compacts natively.
      const pointer = selectHistory({
        messages: [],
        coverage: withSessions(compactCoverage),
        omittedItems: omittedBefore + messages.length,
        budget,
      });
      if (historyCost([], pointer.context) > Math.max(budget, POINTER_HANDOFF_FLOOR)) {
        return yield* new ContextHandoffBudgetError();
      }
      selected = { ...pointer, omittedItemIds: messages.map((message) => message.itemId) };
    }
    const omittedItemIds = new Set(selected.omittedItemIds);
    const persist = (status: "pending" | "injected" | "inline") =>
      Effect.forEach(
        pending,
        (handoff) =>
          input.persist({
            ...handoff,
            ...(nativeThreadId === undefined
              ? {}
              : {
                  delivery: {
                    nativeThreadId,
                    status,
                    omittedItemIds: [
                      ...(handoff.history?.omittedItemIds ?? []),
                      ...(handoff.history?.messages ?? [])
                        .filter((message) => omittedItemIds.has(message.itemId))
                        .map((message) => message.itemId),
                    ],
                    itemIds: selected.messages
                      .filter((message) =>
                        handoff.history?.messages.some(
                          (candidate) => candidate.itemId === message.itemId,
                        ),
                      )
                      .map((message) => message.itemId),
                  },
                }),
          }),
        { discard: true },
      );
    if (input.inject !== undefined && nativeThreadId !== undefined) {
      if (
        pending.some(
          (handoff) =>
            handoff.delivery?.nativeThreadId === nativeThreadId &&
            handoff.delivery.status === "pending",
        )
      ) {
        return yield* new ContextHandoffDeliveryUncertainError();
      }
      yield* persist("pending");
      const injected = yield* input.inject({
        messages: selected.messages,
        context: selected.context,
      });
      if (injected) {
        yield* persist("injected");
        return { context: "", delivered: Effect.void, rollback: Effect.void };
      }
    } else {
      // Text-only delivery can also be accepted before a connection drops.
      yield* persist("pending");
    }
    if (input.deferInline) {
      // Compaction APIs cannot accept an inline transcript. Keep it available
      // for the next ordinary turn when native injection is unsupported.
      yield* Effect.forEach(pending, input.persist, { discard: true });
      return { context: "", delivered: Effect.void, rollback: Effect.void };
    }
    return {
      context: renderHistory(selected.messages, selected.context),
      delivered: persist("inline"),
      // Nothing reached the provider: a stale pending marker would make the
      // next start abandon this native session as uncertain.
      rollback: Effect.forEach(pending, input.persist, { discard: true }),
    };
  },
);

/** The stable failure code of a handoff that does not fit (see ContextOverflowRecoveryWorker). */
export const CONTEXT_HANDOFF_BUDGET_FAILURE_CODE = "context_handoff_budget";

export class ContextHandoffBudgetError extends Schema.TaggedError<ContextHandoffBudgetError>()(
  "ContextHandoffBudgetError",
  {},
) {
  get code() {
    return CONTEXT_HANDOFF_BUDGET_FAILURE_CODE;
  }
  override get message() {
    return CONTEXT_HANDOFF_TOO_LARGE_MESSAGE;
  }
}
export class ContextHandoffDeliveryUncertainError extends Schema.TaggedError<ContextHandoffDeliveryUncertainError>()(
  "ContextHandoffDeliveryUncertainError",
  {},
) {
  override get message() {
    return "Historical context delivery is uncertain; replace the native thread before retrying.";
  }
}
