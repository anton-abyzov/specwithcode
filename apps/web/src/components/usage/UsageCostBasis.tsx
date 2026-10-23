import type { UsageProviderKind } from "@specweave-studio/contracts";
import { formatPercent } from "@specweave-studio/shared/usageFormat";
import type { CostQuality } from "@specweave-studio/shared/usageMerge";

import { cn } from "../../lib/utils";
import { ProviderLogo, providerBrandFor } from "../ProviderLogo";
import { InlineButton } from "../ui/button";
import type { ProviderBilling, UsageAllowance } from "./usageBilling";
import { PROVIDER_PRESENTATION } from "./usageProviders";

/** Diagonal hatching marks cost that is not known, wherever it is drawn. */
export const UNPRICED_HATCH =
  "repeating-linear-gradient(135deg, color-mix(in oklab, var(--muted-foreground) 55%, transparent) 0 2px, transparent 2px 5px)";

function ago(iso: string, nowMs: number): string {
  const minutes = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(minutes)) return "a while ago";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function allowanceText(allowance: UsageAllowance, nowMs: number) {
  switch (allowance.kind) {
    case "left":
      return {
        value: `${allowance.leftPercent}% left`,
        detail:
          allowance.accounts > 1
            ? `${allowance.windowLabel}, tightest of ${allowance.accounts} fresh reports`
            : allowance.windowLabel,
        tone: allowance.leftPercent <= 10 ? "warning" : "value",
      } as const;
    case "stale":
      return {
        value: "Stale",
        detail: `Last read ${ago(allowance.checkedAt, nowMs)}`,
        tone: "muted",
      } as const;
    default:
      return {
        value: "Not reported",
        detail: "No quota windows from this sign-in",
        tone: "muted",
      } as const;
  }
}

function ProviderName({ provider }: { readonly provider: UsageProviderKind }) {
  const { label, driverKind } = PROVIDER_PRESENTATION[provider];
  const brand = providerBrandFor({ driverKind });
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {brand ? <ProviderLogo brand={brand} className="size-3.5" /> : null}
      <span className="truncate">{label}</span>
    </span>
  );
}

/**
 * Separates the three things a dollar figure on this page could mean: what the
 * tokens would cost at API rates, what was actually billed, and how much plan
 * allowance is left. Only the first is a number SpecWithCode can compute.
 */
export function UsageCostBasis({
  estimateText,
  quality,
  billing,
  nowMs,
  onOpenLimits,
}: {
  readonly estimateText: string;
  readonly quality: CostQuality;
  readonly billing: readonly ProviderBilling[];
  readonly nowMs: number;
  readonly onOpenLimits: () => void;
}) {
  const perToken = billing.filter((entry) => entry.hasApiBilling);
  const plans = billing.filter((entry) => entry.allowance !== null);
  const coverage = [
    {
      key: "reported",
      label: "provider-reported",
      share: quality.providerReportedShare,
      fill: "var(--foreground)",
    },
    {
      key: "priced",
      label: "rate table",
      share: quality.modelPricedShare,
      fill: "color-mix(in oklab, var(--foreground) 45%, transparent)",
    },
    { key: "unpriced", label: "unpriced", share: quality.unpricedShare, fill: UNPRICED_HATCH },
  ].filter((segment) => segment.share > 0);

  return (
    <section aria-labelledby="usage-cost-basis" className="flex flex-col gap-3">
      <h2 id="usage-cost-basis" className="text-sm font-medium text-foreground">
        What these dollars mean
      </h2>
      <div className="grid gap-y-5 border-y border-border py-4 md:grid-cols-3 md:gap-y-0 md:divide-x md:divide-border">
        <div className="flex min-w-0 flex-col gap-1.5 md:pe-6" data-testid="usage-basis-estimate">
          <span className="text-xs text-muted-foreground">API-equivalent estimate</span>
          <span className="text-xl font-semibold text-foreground tabular-nums">{estimateText}</span>
          <p className="text-xs text-muted-foreground">
            Your tokens priced at public API rates. Not a bill.
          </p>
          {coverage.length > 0 ? (
            <div className="mt-1 flex flex-col gap-1.5">
              <div
                className="flex h-1.5 w-full max-w-64 gap-px overflow-hidden rounded-full"
                role="img"
                aria-label={`Priced by ${coverage
                  .map((segment) => `${segment.label} ${formatPercent(segment.share)}`)
                  .join(", ")}`}
              >
                {coverage.map((segment) => (
                  <span
                    key={segment.key}
                    className="h-full"
                    style={{ width: `${segment.share * 100}%`, background: segment.fill }}
                  />
                ))}
              </div>
              <span className="text-2xs text-muted-foreground tabular-nums">
                {coverage
                  .map((segment) => `${formatPercent(segment.share)} ${segment.label}`)
                  .join(", ")}
              </span>
            </div>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-1.5 md:px-6" data-testid="usage-basis-billed">
          <span className="text-xs text-muted-foreground">Billed spend</span>
          <span className="text-xl font-semibold text-muted-foreground">Not reported</span>
          <p className="text-xs text-muted-foreground">
            Connected usage sources do not report invoice charges.
          </p>
          {perToken.length > 0 ? (
            <div className="mt-1 flex flex-col gap-1 text-xs">
              <span className="text-foreground">Billed per token now:</span>
              {perToken.map((entry) => (
                <span key={entry.provider} className="flex items-center justify-between gap-3">
                  <ProviderName provider={entry.provider} />
                  <span className="shrink-0 text-muted-foreground">
                    {entry.mode === "mixed" ? "Some sign-ins" : "API billing"}
                  </span>
                </span>
              ))}
              <span className="text-2xs text-muted-foreground">
                Current sign-in, not historical billing. Check the provider for actual charges.
              </span>
            </div>
          ) : (
            <p className="mt-1 text-2xs text-muted-foreground">
              No per-token billing reported for the tracked sign-ins.
            </p>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-1.5 md:ps-6" data-testid="usage-basis-allowance">
          <span className="text-xs text-muted-foreground">Plan allowance</span>
          {plans.length === 0 ? (
            <>
              <span className="text-xl font-semibold text-muted-foreground">Not reported</span>
              <p className="text-xs text-muted-foreground">
                No subscription allowance reported for the sign-ins in view.
              </p>
            </>
          ) : (
            <>
              <ul className="flex flex-col gap-2 pt-0.5">
                {plans.map((entry) => {
                  const text = allowanceText(entry.allowance!, nowMs);
                  return (
                    <li key={entry.provider} className="flex flex-col gap-0.5">
                      <span className="flex items-baseline justify-between gap-3 text-sm text-foreground">
                        <ProviderName provider={entry.provider} />
                        <span
                          className={cn(
                            "shrink-0 font-medium tabular-nums",
                            text.tone === "muted" && "text-muted-foreground",
                            text.tone === "warning" && "text-warning-foreground",
                          )}
                        >
                          {text.value}
                        </span>
                      </span>
                      <span className="text-2xs text-muted-foreground">{text.detail}</span>
                    </li>
                  );
                })}
              </ul>
              <p className="text-2xs text-muted-foreground">
                Current subscription allowance, separate from the selected usage dates.
              </p>
            </>
          )}
          <InlineButton className="self-start" onClick={onOpenLimits}>
            Open limits
          </InlineButton>
        </div>
      </div>
    </section>
  );
}
