/**
 * The picker row for a provider turned on from "On your other machines": the
 * step it is on, then what it still needs on this machine.
 */
import type { ProviderQuickSetup, TurnOnStep } from "~/hooks/useProviderQuickSetup";
import { cn } from "~/lib/utils";
import type { ProviderElsewhere, TurnOnOutcome } from "~/providerQuickSetup";

import { InlineButton } from "../ui/button";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

export function machineLabelFor(quickSetup: ProviderQuickSetup): string {
  return quickSetup.machineLabel ? `on ${quickSetup.machineLabel}` : "on this machine";
}

export function turnOnStepLabel(step: TurnOnStep | undefined): string {
  switch (step) {
    case "installing":
      return "Installing…";
    case "checking":
      return "Checking…";
    default:
      return "Turning on…";
  }
}

/** A provider turned on here: its live progress, then what it still needs. */
export function TurnedOnRow(props: {
  provider: ProviderElsewhere;
  quickSetup: ProviderQuickSetup;
  outcome: TurnOnOutcome;
  onOpenSetup: (() => void) | undefined;
}) {
  const { provider, quickSetup, outcome } = props;
  const running = quickSetup.pending.has(provider.identity);
  const error = quickSetup.errors.get(provider.identity);
  const status = running
    ? { text: turnOnStepLabel(quickSetup.steps?.get(provider.identity)), tone: "muted" as const }
    : error
      ? { text: error, tone: "error" as const }
      : outcome.kind === "ready"
        ? { text: "Ready. Pick one of its models above.", tone: "muted" as const }
        : outcome.kind === "checking"
          ? { text: "Checking…", tone: "muted" as const }
          : outcome.kind === "sign-in"
            ? { text: outcome.step, tone: "warning" as const }
            : { text: outcome.message, tone: "warning" as const };
  const action: "retry" | "sign-in" | "check-again" | null = running
    ? null
    : error
      ? "retry"
      : outcome.kind === "sign-in"
        ? "sign-in"
        : outcome.kind === "ready"
          ? null
          : "check-again";
  return (
    <div
      className="px-1 py-1 text-xs leading-snug"
      data-model-picker-turned-on={provider.identity}
      data-turn-on-state={running ? "running" : error ? "error" : outcome.kind}
    >
      <div className="flex items-center gap-2">
        <ProviderInstanceIcon
          driverKind={provider.driverKind}
          displayName={provider.displayName}
          acpRegistryAgentId={provider.entry.acpRegistryAgentId}
          acpRegistryIconUrl={provider.entry.acpRegistryIconUrl}
          className="size-4 shrink-0"
          iconClassName="size-4"
        />
        <span className="min-w-0 flex-1 truncate">{provider.displayName}</span>
        {action === "sign-in" && props.onOpenSetup ? (
          <InlineButton data-model-picker-sign-in={provider.identity} onClick={props.onOpenSetup}>
            {outcome.kind === "sign-in" ? outcome.action : "Sign in"}
          </InlineButton>
        ) : null}
        {action === "retry" || action === "check-again" ? (
          <InlineButton
            data-model-picker-retry={provider.identity}
            disabled={!quickSetup.canManage}
            onClick={() => quickSetup.enableHere(provider)}
          >
            {action === "retry" ? "Retry" : "Check again"}
          </InlineButton>
        ) : null}
      </div>
      <p
        role="status"
        className={cn(
          "mt-0.5",
          status.tone === "error"
            ? "text-destructive-foreground"
            : status.tone === "warning"
              ? "text-warning-foreground"
              : "text-muted-foreground",
        )}
      >
        {status.text}
      </p>
    </div>
  );
}
