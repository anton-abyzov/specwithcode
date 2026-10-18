import type { EnvironmentId } from "@specweave-studio/contracts";
import { useState } from "react";

import { AddApiCreditAccountDialog } from "../settings/AddApiCreditAccountDialog";
import type { ApiCreditAccountDriver } from "../settings/apiCreditAccount";
import { Button } from "../ui/button";

export type ApiCreditTarget = {
  label: string;
  model: string;
  onContinue: () => Promise<void>;
};

export type ApiCreditRecoveryProps = {
  /** API accounts of the thread's provider that list its model, in list order. */
  targets: ReadonlyArray<ApiCreditTarget>;
  /** The project's "Use API credits first" rule continues on the first by itself. */
  automatic: boolean;
  /** Where "Add an API account" creates one, or null where that is not offered. */
  setup: { environmentId: EnvironmentId; driver: ApiCreditAccountDriver } | null;
};

/**
 * The limit banner's way onto API credits: continue the stopped turn on an
 * instance that bills an API account's own credits (a hackathon grant, a
 * prepaid balance), on the same model, or add such an account. Nothing is
 * bought here: the turn draws on the key's existing credits and stops again
 * when they run out.
 */
export function ApiCreditRecoveryAction({ targets, automatic, setup }: ApiCreditRecoveryProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  if (targets.length === 0 && setup === null) return null;
  async function continueOn(target: ApiCreditTarget) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await target.onContinue();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not continue on ${target.label}.`);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="basis-full space-y-2">
      <p className="text-xs text-muted-foreground">
        {targets.length === 0
          ? "Have API credits? Add an API key and this turn can continue on them, billed per token to that account."
          : automatic
            ? `The project rule continues on ${targets[0]!.label} by itself. Turns there are billed per token to that API account, not to your subscription.`
            : "Continue on API credits: the same model, billed per token to that API account at API prices, not to your subscription. Nothing is bought, and the thread stays there until you switch its model back."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {targets.map((target) => (
          <Button
            key={target.label}
            type="button"
            size="xs"
            variant="outline"
            disabled={pending}
            title={`Continue this turn on ${target.label} (${target.model}), billed to that API account's credits`}
            onClick={() => void continueOn(target)}
          >
            {pending
              ? "Continuing…"
              : targets.length === 1
                ? "Continue on API credits"
                : `Continue on ${target.label}`}
          </Button>
        ))}
        {setup !== null ? (
          <Button type="button" size="xs" variant="ghost" onClick={() => setAdding(true)}>
            {targets.length === 0 ? "Add an API key" : "Add another API key"}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
      {setup !== null ? (
        <AddApiCreditAccountDialog
          open={adding}
          onOpenChange={setAdding}
          environmentId={setup.environmentId}
          driver={setup.driver}
        />
      ) : null}
    </div>
  );
}
