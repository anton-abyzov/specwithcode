import { useEffect, useState } from "react";
import {
  MANUAL_CREDIT_OBSERVATION_MAX_AGE_MS,
  type ManualCodexCreditIntent,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { Button } from "../ui/button";
import {
  deriveExplicitCreditSendOffer,
  consumeExplicitCreditSendOffer,
  type CreditSendContext,
} from "./explicitCreditSend";

export type CreditRecoveryProps = {
  provider: ServerProvider;
  context: CreditSendContext;
  onContinue: (intent: ManualCodexCreditIntent) => Promise<void>;
};

export function formatCreditBalance(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{1,24}(?:\.\d{1,24})?$/.test(value)) return null;
  const [whole, fraction] = value.split(".");
  if (
    !/[1-9]/.test(whole!) &&
    fraction &&
    !/[1-9]/.test(fraction.slice(0, 2)) &&
    /[1-9]/.test(fraction)
  )
    return "<0.01";
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction && /[1-9]/.test(fraction) ? `.${fraction.slice(0, 2)}` : ""}`;
}

export function CreditRecoveryAction({ provider, context, onContinue }: CreditRecoveryProps) {
  const [, tick] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const observed = Date.parse(provider.usageLimits?.nativeAllowanceObservedAt ?? "");
    const remaining = observed + MANUAL_CREDIT_OBSERVATION_MAX_AGE_MS - Date.now();
    if (!Number.isFinite(remaining) || remaining < 0) return;
    const timer = setTimeout(() => tick((value) => value + 1), remaining + 1);
    return () => clearTimeout(timer);
  }, [provider.usageLimits?.nativeAllowanceObservedAt]);
  const offer = deriveExplicitCreditSendOffer(provider, context);
  const balance = formatCreditBalance(provider.usageLimits?.credits?.balance);
  async function continueWithCredits() {
    if (pending) return;
    const result = consumeExplicitCreditSendOffer({
      offer,
      provider,
      context,
      humanSubmit: true,
      dispatchMode: "start_immediately",
      submissionIntent: "foreground",
      prompt: "Continue where you left off.",
    });
    if (!result.accepted || !result.intent) {
      setError("Credit availability changed. Refresh Providers and try again.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onContinue(result.intent);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not continue using credits.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="basis-full space-y-2">
      <p className="text-xs text-muted-foreground">
        {balance !== null
          ? `${balance} credits reported available. `
          : "Credit balance unavailable. "}
        Your included allowance is separate. Continuing uses existing paid credits for this request;
        it does not buy credits or enable automatic reload.
      </p>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={pending || offer === null}
        onClick={() => void continueWithCredits()}
      >
        {pending ? "Continuing…" : "Continue using credits"}
      </Button>
      {offer === null ? (
        <p role="status" className="text-xs text-muted-foreground">
          Refresh Providers to verify this account, model and credit balance before continuing.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}
