import type { ProviderInstanceId } from "@specweave-studio/contracts";
import type { FallbackOption, FallbackOptionGroup } from "@specweave-studio/shared/fallbackOptions";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** Whether, and why not, a limited thread can continue on this model now. */
export function fallbackOptionStatusLabel(option: FallbackOption): string {
  switch (option.status) {
    case "ready":
      return "Can take a limited thread";
    case "unverified":
      return "Signed in, usage not read yet";
    case "current":
      return "This thread's model";
    case "excluded":
      return "Excluded from automatic fallback";
    case "disabled":
      return "Turned off";
    case "signed-out":
      return "Signed out";
    case "not-ready":
      return "Not set up on this machine";
    case "limited":
      return "At its limit";
    case "full":
      return option.resetAt === null ? "Full" : `Full until ${clock(option.resetAt)}`;
    case "per-token":
      return "Billed per token: only when you name it or allow API credits";
    case "never-automatic":
      return "Bills a Google Cloud project: never automatic";
    case "named-only":
      return "Billing unknown: only when you name it";
  }
}

/** What backs the access, as far as SpecWithCode can see. */
export function fallbackOptionAccessLabel(option: FallbackOption): string {
  switch (option.access) {
    case "usage-read":
      return option.usedPercent === null
        ? "Plan usage reported"
        : `Plan usage ${Math.round(option.usedPercent)}% used`;
    case "no-usage-reported":
      return "Signed in; provider reports no usage";
    case "per-token":
      return "Billed per token";
    case "unknown":
      return "Access unknown";
  }
}

const usable = (option: FallbackOption) =>
  option.status === "ready" || option.status === "unverified";

/**
 * Every model on this machine a limited thread could continue on, by family,
 * with an Exclude toggle per model. Excluding the models below the one you
 * trust in a family is how that family gets its minimum.
 */
export function FallbackOptionsPanel(props: {
  readonly groups: ReadonlyArray<FallbackOptionGroup>;
  readonly onToggleExcluded: (model: string, instanceId?: ProviderInstanceId) => void;
  readonly disabled?: boolean;
}) {
  const { groups, onToggleExcluded, disabled } = props;
  if (groups.length === 0)
    return <p className="text-sm text-muted-foreground">No providers on this machine yet.</p>;
  return (
    <div className="flex flex-col gap-3" data-testid="fallback-options">
      {groups.map((group) => (
        <section key={group.family} aria-label={`${group.label} models`}>
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">{group.label}</h4>
          <ul className="flex flex-col gap-1">
            {group.options.map((option) => {
              const provider = option.provider.displayName ?? option.provider.instanceId;
              const name = `${option.modelName} on ${provider}`;
              return (
                <li
                  key={`${option.selection.instanceId}:${option.selection.model}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/70 px-2 py-1.5 text-sm"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      usable(option)
                        ? "bg-emerald-500"
                        : option.status === "current"
                          ? "bg-muted-foreground/40"
                          : "bg-amber-500",
                    )}
                  />
                  <span className="min-w-48 flex-1 truncate" title={name}>
                    <span className={cn(option.excluded && "line-through opacity-60")}>
                      {option.modelName}
                    </span>
                    <span className="ml-1.5 text-xs text-muted-foreground">{provider}</span>
                    {option.orderIndex !== null ? (
                      <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">
                        #{option.orderIndex + 1} in order
                      </span>
                    ) : null}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {fallbackOptionStatusLabel(option)} · {fallbackOptionAccessLabel(option)}
                  </span>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={disabled}
                    aria-label={`${option.excluded ? "Include" : "Exclude"} ${option.modelName}`}
                    onClick={() => onToggleExcluded(option.selection.model)}
                  >
                    {option.excluded ? "Include" : "Exclude"}
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <p className="text-xs text-muted-foreground">
        Excluding a model keeps it out of every automatic switch on every provider; you can still
        pick it yourself. New models are allowed until you exclude them. Access shown here is only
        what SpecWithCode can see: GitHub Actions minutes, an X subscription or startup credits are
        not model access unless one of these providers is signed in with them.
      </p>
    </div>
  );
}
