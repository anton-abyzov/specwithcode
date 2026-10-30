import { Toolbar } from "@base-ui/react/toolbar";
import { type ProviderInstanceId } from "@specweave-studio/contracts";
import { memo, useLayoutEffect, useRef } from "react";
import { LayersIcon, SparklesIcon, StarIcon } from "lucide-react";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import {
  isProviderInstancePickerSelectable,
  type ProviderInstanceEntry,
} from "../../providerInstances";

/** Which slice of the list shows: every provider, the favorites, or one provider. */
export type ModelPickerView = ProviderInstanceId | "favorites" | "all";

/**
 * The hover text for a provider chip, by the entry's configured name, so custom instances
 * read as the user named them (e.g. "Codex Personal — Unavailable.").
 */
export function describeUnavailableInstance(entry: ProviderInstanceEntry): string {
  const label = entry.displayName;
  if (!entry.enabled || entry.status === "disabled") {
    return `${label} — Disabled in settings.`;
  }
  if (entry.status === "ready" && entry.isAvailable) {
    return label;
  }
  const kind =
    entry.status === "error" ? "Unavailable" : entry.status === "warning" ? "Limited" : "Not ready";
  const msg = entry.snapshot.message?.trim();
  return msg ? `${label} — ${kind}. ${msg}` : `${label} — ${kind}.`;
}

/**
 * How the providers sit: a labelled column beside the models when the picker is wide, or
 * chips that wrap onto more lines under the search when it is narrow. Neither scrolls
 * sideways, which trackpads and Linux mice handle badly.
 */
export type ModelPickerProvidersLayout = "column" | "wrap";

const CHIP_CLASS =
  "sws-picker-chip relative isolate inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs whitespace-nowrap transition-colors focus-visible:outline-none";
const COLUMN_ITEM_CLASS =
  "sws-picker-provider relative isolate flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-xs transition-colors focus-visible:outline-none";

/**
 * The providers beside or under the search: All, Favorites and one per configured instance,
 * each with its usage mark, "new" badge, disabled state and tooltip. In the column each
 * also says how many models it has.
 */
export const ModelPickerProviderChips = memo(function ModelPickerProviderChips(props: {
  layout: ModelPickerProvidersLayout;
  selected: ModelPickerView;
  onSelect: (view: ModelPickerView) => void;
  onFocusSearch: () => void;
  /** One chip per entry, by `instanceId`, so a custom Codex sits apart from the default. */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  /** Instance ids shown but unavailable in this picker's context (a thread's lock). */
  disabledInstanceIds?: ReadonlySet<ProviderInstanceId>;
  /** Non-ready instances whose selected unavailable model remains reachable. */
  selectableUnavailableInstanceIds?: ReadonlySet<ProviderInstanceId>;
  getDisabledInstanceTooltip?: (entry: ProviderInstanceEntry) => string;
  /** Default built-in instances flagged as new; custom ones never are. */
  newBadgeInstanceIds?: ReadonlySet<ProviderInstanceId>;
  /**
   * A mark from the provider's account-wide windows: amber when little is left or a spent
   * limit still takes extra usage, red when every model on the account is blocked. `text`
   * joins the chip's tooltip and accessible name; the chip stays usable so the list says why.
   */
  getInstanceUsage?: (
    entry: ProviderInstanceEntry,
  ) => { readonly tone: "warn" | "full"; readonly text: string } | null;
  /** While searching: matches per view ("all", "favorites", instance id). Empty ones dim. */
  counts?: ReadonlyMap<string, number>;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const column = props.layout === "column";
  const counts = props.counts;
  // The provider's own model count in the column, or its matches while searching.
  const countBadge = (view: ModelPickerView, total: number | null) => {
    const count = counts ? (counts.get(view) ?? 0) : total;
    if (count === null || (!counts && (!column || count === 0))) return null;
    return (
      <span
        className="ms-auto shrink-0 tabular-nums text-2xs text-muted-foreground"
        data-model-picker-provider-count={count}
        aria-hidden
      >
        {count}
      </span>
    );
  };
  const noMatches = (view: ModelPickerView) => counts !== undefined && !counts.get(view);
  const itemClass = column ? COLUMN_ITEM_CLASS : CHIP_CLASS;
  // Keep the chosen provider in view when the list scrolls.
  const selected = props.selected;
  useLayoutEffect(() => {
    const chip = rowRef.current?.querySelector<HTMLElement>(
      `[data-model-picker-provider="${CSS.escape(selected)}"] button`,
    );
    chip?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selected]);

  const plainChip = (view: "all" | "favorites", label: string, icon: typeof StarIcon) => {
    const Icon = icon;
    return (
      <div className="relative" data-model-picker-provider={view}>
        <Toolbar.Button
          className={cn(itemClass, noMatches(view) && "opacity-55")}
          onClick={() => props.onSelect(view)}
          type="button"
          aria-label={label}
          aria-pressed={props.selected === view}
        >
          <Icon
            className={cn("size-3.5 shrink-0", view === "favorites" && "fill-current")}
            aria-hidden
          />
          {label}
          {countBadge(view, null)}
        </Toolbar.Button>
      </div>
    );
  };

  return (
    <Toolbar.Root
      className={cn(
        "shrink-0 overflow-hidden",
        column && "relative w-40 border-e border-border/60",
      )}
      data-model-picker-sidebar="true"
      data-model-picker-chips="true"
      data-model-picker-providers-layout={props.layout}
      aria-label="Providers"
      orientation={column ? "vertical" : "horizontal"}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const first = rowRef.current?.querySelector("button") === event.target;
        // Up from the wrapped chips, or from the column's first item, returns to the search.
        if (event.key === "ArrowUp" && (!column || first)) {
          event.preventDefault();
          props.onFocusSearch();
        }
      }}
    >
      <div
        ref={rowRef}
        className={cn(
          "overscroll-y-contain",
          column
            ? "absolute inset-0 flex flex-col gap-0.5 overflow-y-auto px-1.5 py-1.5"
            : "flex max-h-[6.25rem] flex-wrap items-center gap-1 overflow-y-auto px-2 pb-2",
        )}
      >
        {plainChip("all", "All", LayersIcon)}
        {plainChip("favorites", "Favorites", StarIcon)}
        {column ? <div className="mx-2 my-1 h-px shrink-0 bg-border/60" aria-hidden /> : null}
        {props.instanceEntries.map((entry) => {
          const isUnavailable = !isProviderInstancePickerSelectable(entry);
          const isContextDisabled = props.disabledInstanceIds?.has(entry.instanceId) ?? false;
          const reachable = props.selectableUnavailableInstanceIds?.has(entry.instanceId) ?? false;
          const isDisabled = (isUnavailable && !reachable) || isContextDisabled;
          const isSelected = props.selected === entry.instanceId;
          const showNewBadge = props.newBadgeInstanceIds?.has(entry.instanceId) ?? false;
          const usageMark = isUnavailable ? null : (props.getInstanceUsage?.(entry) ?? null);
          const baseTooltip = isUnavailable
            ? describeUnavailableInstance(entry)
            : isContextDisabled
              ? (props.getDisabledInstanceTooltip?.(entry) ?? entry.displayName)
              : showNewBadge
                ? `${entry.displayName} — New`
                : entry.displayName;
          const tooltip = usageMark ? `${baseTooltip}: ${usageMark.text}` : baseTooltip;
          const button = (
            <Toolbar.Button
              className={cn(
                itemClass,
                isDisabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
                !isDisabled && noMatches(entry.instanceId) && "opacity-55",
              )}
              data-provider-accent-color={entry.accentColor}
              onClick={() => !isDisabled && props.onSelect(entry.instanceId)}
              disabled={isDisabled}
              focusableWhenDisabled={!isDisabled}
              aria-pressed={isSelected}
              type="button"
              aria-label={
                isUnavailable || isContextDisabled || usageMark
                  ? tooltip
                  : showNewBadge
                    ? `${entry.displayName}, new`
                    : entry.displayName
              }
            >
              <ProviderInstanceIcon
                driverKind={entry.driverKind}
                displayName={entry.displayName}
                accentColor={entry.accentColor}
                acpRegistryAgentId={entry.acpRegistryAgentId}
                acpRegistryIconUrl={entry.acpRegistryIconUrl}
                // The name sits beside the mark, so two Copilots need no initials badge on it.
                showBadge={false}
                className="size-4 shrink-0"
                iconClassName="size-4"
              />
              <span className={column ? "min-w-0 flex-1 truncate" : "max-w-28 truncate"}>
                {entry.displayName}
              </span>
              {showNewBadge ? (
                <SparklesIcon className="size-3 shrink-0 text-update-foreground" aria-hidden />
              ) : null}
              {usageMark ? (
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    usageMark.tone === "full" ? "bg-destructive" : "bg-warning",
                  )}
                  data-model-picker-usage-mark={usageMark.tone}
                  aria-hidden
                />
              ) : null}
              {countBadge(entry.instanceId, entry.models.length)}
            </Toolbar.Button>
          );
          return (
            <div
              key={entry.instanceId}
              className="relative"
              data-model-picker-provider={entry.instanceId}
            >
              <Tooltip>
                <TooltipTrigger
                  render={isDisabled ? <span className="relative block">{button}</span> : button}
                />
                <TooltipPopup side={column ? "right" : "bottom"} align="center">
                  {tooltip}
                </TooltipPopup>
              </Tooltip>
            </div>
          );
        })}
      </div>
    </Toolbar.Root>
  );
});
