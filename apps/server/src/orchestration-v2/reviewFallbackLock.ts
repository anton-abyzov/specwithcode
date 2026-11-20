/**
 * A marked review's limit fallback stays inside its reviewer lock (1390 AC-40).
 *
 * The rule the worker resolves with excludes what the lock forbids, and every
 * step it then returns is checked again: the selection it would dispatch must
 * be a model the lock permits on a sign-in this machine has, else the review
 * waits. The same model through the same driver keeps the review's effort.
 */
import type {
  ModelSelection,
  ServerProvider,
  TaskRoutingDecision,
} from "@specweave-studio/contracts";
import type { ProviderFallbackRule } from "@specweave-studio/shared/providerFallback";
import {
  reviewConstrainedRule,
  reviewEffortOver,
  type ReviewerLock,
  reviewerLockPermits,
} from "@specweave-studio/shared/reviewPolicy";

type Routing = Pick<TaskRoutingDecision, "reviewFamily" | "reviewModel"> | null | undefined;
type LockedThread = {
  readonly providerInstanceId: string;
  readonly modelSelection: ModelSelection;
  readonly routing?: Routing;
};

const lockOf = (routing: Routing): ReviewerLock | null =>
  routing?.reviewFamily === undefined
    ? null
    : {
        families: [routing.reviewFamily],
        ...(routing.reviewModel === undefined ? {} : { model: routing.reviewModel }),
      };

/**
 * The rule a review falls back under: the listed models its lock forbids are
 * excluded, and so is every model the rule itself names outside the lock,
 * listed by its sign-in or not.
 */
export function lockedRule<R extends ProviderFallbackRule>(
  rule: R,
  routing: Routing,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "models">>,
): R {
  const constrained = reviewConstrainedRule(rule, routing, providers);
  const lock = lockOf(routing);
  if (lock === null) return constrained;
  const named = [
    rule.providerLimitFallbackModelSelection,
    rule.defaultModelSelection,
    ...(rule.providerLimitFallbackModels ?? []),
  ].flatMap((selection) =>
    selection === null || reviewerLockPermits(lock, selection.model)
      ? []
      : [{ instanceId: selection.instanceId, model: selection.model }],
  );
  return {
    ...constrained,
    providerLimitExcludedModels: [...(constrained.providerLimitExcludedModels ?? []), ...named],
  };
}

/** The coordinator's working model as a fallback for this thread: only inside its lock. */
export function lockedProven(routing: Routing, proven: ModelSelection | null | undefined) {
  const lock = lockOf(routing);
  if (proven == null) return null;
  return lock === null || reviewerLockPermits(lock, proven.model) ? proven : null;
}

/**
 * The selection a fallback may dispatch for this thread, or null when the
 * lock forbids it. The same model through the same driver takes the review's
 * effort, over any options the fallback order saved for it.
 */
export function lockedSelection(
  thread: LockedThread,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver">>,
  target: ModelSelection,
): ModelSelection | null {
  const lock = lockOf(thread.routing);
  if (lock === null) return target;
  const provider = providers.find((entry) => entry.instanceId === target.instanceId);
  if (provider === undefined || !reviewerLockPermits(lock, target.model)) return null;
  const effort = thread.modelSelection.options;
  const from = providers.find((entry) => entry.instanceId === thread.providerInstanceId)?.driver;
  return effort === undefined ||
    target.model !== thread.modelSelection.model ||
    from !== provider.driver
    ? target
    : { ...target, options: reviewEffortOver(target.options, effort) };
}

/**
 * A limit step as the lock lets it run: unchanged for a thread that is no
 * review, null (the review waits) when its command would leave the lock.
 */
export function lockedStep<S extends object>(
  thread: LockedThread,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver">>,
  step: S | null,
): S | null {
  if (step === null || lockOf(thread.routing) === null) return step;
  const key = "command" in step ? "command" : "continuation" in step ? "continuation" : null;
  if (key === null) return step;
  const command = (step as Record<string, unknown>)[key] as {
    readonly modelSelection?: ModelSelection | null;
  };
  if (command.modelSelection == null) return step;
  const selection = lockedSelection(thread, providers, command.modelSelection);
  return selection === null
    ? null
    : ({ ...step, [key]: { ...command, modelSelection: selection } } as S);
}
