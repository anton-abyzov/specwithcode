import { memo } from "react";
import { cn } from "~/lib/utils";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { accountLimitPhrase, isAvailabilityBlocking } from "../../studio/modelAvailability";
import { modelPickerGroupKey } from "./modelPickerKeys";
import type { ModelPickerUsage } from "./ModelUsage";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

/** The plan and account a provider signs in with, from its auth snapshot. */
export function providerGroupAccount(entry: ProviderInstanceEntry): {
  readonly plan: string | null;
  readonly email: string | null;
} {
  const auth = entry.snapshot.auth;
  return {
    plan: auth.status === "authenticated" ? (auth.label ?? null) : null,
    email: auth.status === "authenticated" ? (auth.email ?? null) : null,
  };
}

/** The account-wide limit of a provider, short, with its tone; null when nothing is known. */
export function providerGroupUsage(
  entry: ProviderInstanceEntry,
  usage: ModelPickerUsage | undefined,
): { readonly text: string; readonly tone: "muted" | "warn" | "full" } | null {
  if (!usage) return null;
  const state = usage.availability(entry.instanceId, null);
  const text = accountLimitPhrase(state, {
    nowMs: usage.nowMs,
    short: usage.text(entry.instanceId, state).short,
  });
  if (text === null) return null;
  const tone = isAvailabilityBlocking(state)
    ? "full"
    : state.kind === "exhausted" || (state.kind === "room" && state.tone === "warn")
      ? "warn"
      : "muted";
  return { text, tone };
}

/**
 * The heading over one provider's models in the grouped list: its mark, its name in the
 * shell serif, then small chips for the plan, the account and the account-wide limit.
 * It sits above the group's first row and is never a row itself.
 */
export const ProviderGroupHeader = memo(function ProviderGroupHeader(props: {
  readonly entry: ProviderInstanceEntry;
  readonly usage: ModelPickerUsage | undefined;
}) {
  const { entry } = props;
  const { plan, email } = providerGroupAccount(entry);
  const limit = providerGroupUsage(entry, props.usage);
  return (
    <div
      className="sws-picker-group flex min-w-0 items-center gap-1.5 px-2 pt-2 pb-1"
      data-model-picker-group={modelPickerGroupKey(entry.instanceId)}
    >
      <ProviderInstanceIcon
        driverKind={entry.driverKind}
        displayName={entry.displayName}
        accentColor={entry.accentColor}
        acpRegistryAgentId={entry.acpRegistryAgentId}
        acpRegistryIconUrl={entry.acpRegistryIconUrl}
        className="size-4 shrink-0"
        iconClassName="size-4"
      />
      <span className="sws-picker-group-name shrink-0 truncate text-sm text-foreground">
        {entry.displayName}
      </span>
      {plan ? (
        <span className="sws-picker-pill shrink-0" data-model-picker-group-plan="">
          {plan}
        </span>
      ) : null}
      {email ? (
        <span className="sws-picker-pill min-w-0 truncate" data-model-picker-group-account="">
          {email}
        </span>
      ) : null}
      {limit ? (
        <span
          className={cn(
            "sws-picker-pill ms-auto shrink-0 tabular-nums",
            limit.tone === "full"
              ? "text-destructive-foreground"
              : limit.tone === "warn"
                ? "text-warning-foreground"
                : "text-muted-foreground",
          )}
          data-model-picker-group-usage={limit.tone}
        >
          {limit.text}
        </span>
      ) : null}
    </div>
  );
});
