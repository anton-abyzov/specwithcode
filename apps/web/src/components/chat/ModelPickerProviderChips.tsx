import { Toolbar } from "@base-ui/react/toolbar";
import { type ProviderInstanceId } from "@specweave-studio/contracts";
import { memo, useLayoutEffect, useRef } from "react";
import { LayersIcon, SparklesIcon, StarIcon } from "lucide-react";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import {
  isProviderInstancePickerSelectable,
  shouldShowInstanceBadge,
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

const CHIP_CLASS =
  "sws-picker-chip relative isolate inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs whitespace-nowrap transition-colors focus-visible:outline-none";

/**
 * Provider chips under the search: All, Favorites and one per configured instance. They
 * replace the old icon column; each keeps its usage mark, "new" badge, disabled state
 * and tooltip. The row scrolls sideways when the providers do not fit.
 */
export const ModelPickerProviderChips = memo(function ModelPickerProviderChips(props: {
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
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  // Keep the chosen chip in view when the row scrolls sideways.
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
          className={CHIP_CLASS}
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
        </Toolbar.Button>
      </div>
    );
  };

  return (
    <Toolbar.Root
      className="shrink-0 overflow-hidden"
      data-model-picker-sidebar="true"
      data-model-picker-chips="true"
      aria-label="Providers"
      orientation="horizontal"
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key === "ArrowUp") {
          event.preventDefault();
          props.onFocusSearch();
        }
      }}
    >
      <div
        ref={rowRef}
        className="flex items-center gap-1 overflow-x-auto overscroll-x-contain px-2 pb-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {plainChip("all", "All", LayersIcon)}
        {plainChip("favorites", "Favorites", StarIcon)}
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
                CHIP_CLASS,
                isDisabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
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
                showBadge={shouldShowInstanceBadge(entry, props.instanceEntries)}
                className="size-4 shrink-0"
                iconClassName="size-4"
                {...(entry.accentColor ? { badgeClassName: "h-3 min-w-3 px-0.5 text-5xs" } : {})}
              />
              <span className="max-w-28 truncate">{entry.displayName}</span>
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
                <TooltipPopup side="bottom" align="center">
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
