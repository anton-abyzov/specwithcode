import {
  MANUAL_CREDIT_OBSERVATION_MAX_AGE_MS,
  type ManualCodexCreditIntent,
  type ModelSelection,
  type ServerProvider,
} from "@specweave-studio/contracts";

/** UI binding only. The wire intent contains no persistent spending permission. */
export interface CreditSendContext {
  readonly environmentId: string;
  readonly projectId: string | null;
  readonly threadId: string | null;
  readonly draftId: string | null;
  readonly runtimeMode: string;
  readonly selection: ModelSelection;
  readonly allowed: boolean;
}

export interface ExplicitCreditSendOffer {
  readonly intent: ManualCodexCreditIntent;
  readonly binding: string;
  consumed: boolean;
}

const fresh = (value: string | undefined, now: number): boolean => {
  const age = now - Date.parse(value ?? "");
  return Number.isFinite(age) && age >= 0 && age <= MANUAL_CREDIT_OBSERVATION_MAX_AGE_MS;
};
const positiveBalance = (value: unknown): boolean =>
  typeof value === "string" && /^\d{1,24}(?:\.\d{1,24})?$/.test(value) && /[1-9]/.test(value);

function binding(context: CreditSendContext): string {
  return JSON.stringify([
    context.environmentId,
    context.projectId,
    context.threadId,
    context.draftId,
    context.runtimeMode,
    context.selection.instanceId,
    context.selection.model,
    context.selection.options ?? null,
  ]);
}

export function deriveExplicitCreditSendOffer(
  provider: ServerProvider | null | undefined,
  context: CreditSendContext,
  now = Date.now(),
): ExplicitCreditSendOffer | null {
  const limits = provider?.usageLimits as
    | (NonNullable<ServerProvider["usageLimits"]> & {
        readonly nativeCreditDenialObservedAt?: string;
      })
    | undefined;
  if (
    !context.allowed ||
    !provider ||
    provider.instanceId !== context.selection.instanceId ||
    provider.driver !== "codex" ||
    !provider.enabled ||
    !provider.installed ||
    provider.availability === "unavailable" ||
    provider.status === "error" ||
    provider.status === "disabled" ||
    provider.auth.status !== "authenticated" ||
    provider.auth.type !== "chatgpt" ||
    !provider.models.some((model) => model.slug === context.selection.model) ||
    !fresh(provider.checkedAt, now) ||
    !limits ||
    limits.unavailable ||
    !fresh(limits.checkedAt, now) ||
    limits.ordinaryUsageAllowed !== false ||
    limits.spendControlReached !== false ||
    limits.rateLimitReachedType !== "rate_limit_reached" ||
    limits.nativeRouteVerified !== true ||
    !fresh(limits.nativeAllowanceObservedAt, now) ||
    !fresh(limits.quotaPoolObservedAt, now) ||
    !fresh(limits.nativeRouteObservedAt, now) ||
    limits.nativeAllowanceObservedAt !== limits.quotaPoolObservedAt ||
    !/^codex:sha256:[a-f0-9]{64}$/.test(limits.quotaPoolId ?? "") ||
    limits.credits?.hasCredits !== true ||
    limits.credits.unlimited !== false ||
    !positiveBalance(limits.credits.balance)
  )
    return null;
  for (const denial of [limits.nativeDenialObservedAt, limits.nativeCreditDenialObservedAt]) {
    if (denial === undefined) continue;
    const denialAt = Date.parse(denial);
    if (!Number.isFinite(denialAt) || denialAt >= Date.parse(limits.nativeAllowanceObservedAt!))
      return null;
  }
  return {
    intent: {
      type: "human-submit-existing-credits",
      instanceId: context.selection.instanceId,
      model: context.selection.model,
      expectedQuotaPoolId: limits.quotaPoolId!,
      observedAt: limits.nativeAllowanceObservedAt!,
    },
    binding: binding(context),
    consumed: false,
  };
}

export function explicitCreditSendStillMatches(
  intent: ManualCodexCreditIntent,
  capturedContext: CreditSendContext,
  currentContext: CreditSendContext,
  provider: ServerProvider | null | undefined,
  now = Date.now(),
): boolean {
  const current = deriveExplicitCreditSendOffer(provider, currentContext, now);
  return (
    current !== null &&
    binding(capturedContext) === binding(currentContext) &&
    intent.instanceId === current.intent.instanceId &&
    intent.model === current.intent.model &&
    intent.expectedQuotaPoolId === current.intent.expectedQuotaPoolId &&
    intent.observedAt === current.intent.observedAt
  );
}

/** Called only from the explicit button/form/keyboard path, once per rendered offer. */
export function consumeExplicitCreditSendOffer(input: {
  offer: ExplicitCreditSendOffer | null;
  provider: ServerProvider | null | undefined;
  context: CreditSendContext;
  humanSubmit: boolean;
  dispatchMode: string;
  submissionIntent?: string | undefined;
  prompt: string;
  now?: number;
}): { accepted: boolean; intent?: ManualCodexCreditIntent } {
  if (
    !input.humanSubmit ||
    !input.offer ||
    !["auto", "start_immediately"].includes(input.dispatchMode) ||
    (input.submissionIntent !== undefined && input.submissionIntent !== "foreground")
  )
    return { accepted: true };
  const offer = input.offer;
  if (
    offer.consumed ||
    /^\s*\/(?:goal|compact)(?:\s|$)/i.test(input.prompt) ||
    offer.binding !== binding(input.context) ||
    !explicitCreditSendStillMatches(
      offer.intent,
      input.context,
      input.context,
      input.provider,
      input.now,
    )
  ) {
    return { accepted: false };
  }
  offer.consumed = true;
  return { accepted: true, intent: offer.intent };
}
