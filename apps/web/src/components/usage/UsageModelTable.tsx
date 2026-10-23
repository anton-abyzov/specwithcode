import type { ModelTotals } from "@specweave-studio/shared/usageMerge";
import { formatPercent, formatTokens } from "@specweave-studio/shared/usageFormat";
import { ProviderLogo, providerBrandFor } from "../ProviderLogo";
import { costText } from "./usageFilters";
import { modelShare } from "./usageBreakdown";
import { PROVIDER_PRESENTATION } from "./usageProviders";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function HeaderHint({ label, hint }: { readonly label: string; readonly hint: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>
        {label}
        <span className="sr-only">: {hint}</span>
      </TooltipTrigger>
      <TooltipPopup>{hint}</TooltipPopup>
    </Tooltip>
  );
}

export function UsageModelTable({
  models,
  metric,
  onSelect,
}: {
  readonly models: readonly ModelTotals[];
  readonly metric: "cost" | "tokens";
  readonly onSelect: (key: string) => void;
}) {
  return (
    <table className="w-full text-xs sm:text-sm">
      <caption className="sr-only">
        Ranked model usage. Cost is an API-equivalent estimate, not billed spend. Cost shares use
        the priced portion only.
      </caption>
      <thead>
        <tr className="border-b border-border text-right text-xs text-muted-foreground">
          <th scope="col" className="py-2 pr-3 text-left font-normal">
            #
          </th>
          <th scope="col" className="w-full py-2 text-left font-normal">
            Model
          </th>
          <th scope="col" className="py-2 pl-3 font-normal sm:pl-6">
            <HeaderHint label="Cost" hint="API-equivalent estimate, not billed spend" />
          </th>
          <th scope="col" className="hidden py-2 pl-6 font-normal sm:table-cell">
            <HeaderHint
              label="Share"
              hint={
                metric === "cost"
                  ? "Share of priced API-equivalent cost"
                  : "Share of processed tokens"
              }
            />
          </th>
          <th scope="col" className="py-2 pl-3 font-normal sm:pl-6">
            Tokens
          </th>
        </tr>
      </thead>
      <tbody>
        {models.length === 0 ? (
          <tr>
            <td colSpan={5} className="py-6 text-center text-muted-foreground">
              No matching models in this window.
            </td>
          </tr>
        ) : (
          models.map((model, index) => {
            const key = `${model.provider}:${model.model}`;
            const share = modelShare(model, metric);
            const brand = providerBrandFor({
              driverKind: PROVIDER_PRESENTATION[model.provider].driverKind,
            });
            const shareLabel =
              share === null
                ? "Cost share unavailable"
                : `${formatPercent(share)} of ${metric === "tokens" ? "tokens" : "priced cost"}`;
            return (
              <tr
                key={key}
                className="relative border-b border-border/50 text-right text-muted-foreground tabular-nums transition-colors hover:bg-muted/50 has-focus-visible:bg-muted/50"
              >
                <td className="py-3 pr-3 text-left text-xs">{index + 1}</td>
                <td className="py-3 text-left">
                  <button
                    type="button"
                    onClick={() => onSelect(key)}
                    className="flex items-center gap-2 break-words text-left text-foreground outline-none after:absolute after:inset-0 after:rounded-sm focus-visible:after:outline-2 focus-visible:after:outline-ring"
                  >
                    {brand ? <ProviderLogo brand={brand} className="size-3.5 shrink-0" /> : null}
                    <span className="[overflow-wrap:anywhere]">{model.model}</span>
                  </button>
                  <div aria-hidden className="mt-1.5 h-1 max-w-md rounded-full bg-muted">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: share !== null && share > 0 ? `max(0.25rem, ${share * 100}%)` : 0,
                        backgroundColor: PROVIDER_PRESENTATION[model.provider].color,
                      }}
                    />
                  </div>
                  <span className="mt-1 block text-2xs text-muted-foreground sm:hidden">
                    {shareLabel}
                  </span>
                </td>
                <td className="py-3 pl-3 whitespace-nowrap text-foreground sm:pl-6">
                  {costText(model).label === costText(model).text ? (
                    costText(model).text
                  ) : (
                    <Tooltip>
                      <TooltipTrigger render={<span />}>
                        <span aria-hidden>{costText(model).text}</span>
                        <span className="sr-only">{costText(model).label}</span>
                      </TooltipTrigger>
                      <TooltipPopup>{costText(model).label}</TooltipPopup>
                    </Tooltip>
                  )}
                </td>
                <td className="hidden py-3 pl-6 sm:table-cell">
                  {share === null ? "—" : formatPercent(share)}
                </td>
                <td className="py-3 pl-3 whitespace-nowrap sm:pl-6">
                  {formatTokens(model.totalTokens)}
                </td>
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}
