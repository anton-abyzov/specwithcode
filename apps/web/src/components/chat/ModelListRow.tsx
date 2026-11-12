import { useTx } from "../../i18n";
import { type ProviderDriverKind, type ProviderInstanceId } from "@specweave-studio/contracts";
import { memo } from "react";
import { CheckIcon, StarIcon } from "lucide-react";
import {
  getDisplayModelName,
  getTriggerDisplayModelLabel,
  type ModelEsque,
} from "./providerIconUtils";
import { ComboboxItem } from "../ui/combobox";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { modelPickerModelKey } from "./modelPickerKeys";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ModelStatusIcons, type ModelStatusIcon } from "./modelStatusIcons";

/**
 * Shown on hover, on keyboard focus of the row and while the command key is held (the
 * picker marks itself then); always on touch screens, where nothing hovers.
 */
const QUIET =
  "opacity-0 transition-opacity group-hover:opacity-100 group-data-highlighted:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100 [[data-model-picker-meta-held]_&]:opacity-100";

export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  model: ModelEsque;
  /** Instance the model belongs to — the routing key used in combobox values. */
  instanceId: ProviderInstanceId;
  /** Driver kind of the instance — used for the provider icon glyph. */
  driverKind: ProviderDriverKind;
  /**
   * The instance's configured `displayName`, so custom instances like "Codex Personal"
   * are named as the person named them: in the logo's tooltip and for screen readers.
   */
  providerDisplayName: string;
  providerAccentColor?: string | undefined;
  acpRegistryAgentId?: string | undefined;
  acpRegistryIconUrl?: string | undefined;
  isFavorite: boolean;
  isSelected: boolean;
  showSelection?: boolean;
  /**
   * A header above names the model (search and Favorites group one model across
   * providers), so the row is its provider: the logo, then a short account label.
   */
  providerAsTitle?: { readonly label: string | null } | undefined;
  /** The provider, account, harness and model facts in full, for the tooltip on the row's lead. */
  identity?: string | undefined;
  /** Usage and billing as icons; their words are in each icon's tooltip. */
  status?: ReadonlyArray<ModelStatusIcon> | undefined;
  preferShortName?: boolean;
  useTriggerLabel?: boolean;
  unavailable?: boolean;
  jumpLabel?: string | null;
  disabledReason?: string | null;
  /** A usage warning stays readable without blocking deliberate selection. */
  warningReason?: string | null;
  /** Its part in a fallback: `Now`, `Your pick`, `Fallback 2`. */
  fallbackRole?: { readonly label: string; readonly tone: "now" | "pick" | "order" } | null;
  onToggleFavorite: () => void;
}) {
  const tx = useTx();
  const providerLabel = props.model.subProvider
    ? `${props.providerDisplayName} · ${props.model.subProvider}`
    : props.providerDisplayName;
  const modelName = props.useTriggerLabel
    ? getTriggerDisplayModelLabel(props.model)
    : getDisplayModelName(
        props.model,
        props.preferShortName ? { preferShortName: true } : undefined,
      );

  const lead = props.providerAsTitle ? (
    <>
      <ProviderInstanceIcon
        driverKind={props.driverKind}
        displayName={props.providerDisplayName}
        accentColor={props.providerAccentColor}
        acpRegistryAgentId={props.acpRegistryAgentId}
        acpRegistryIconUrl={props.acpRegistryIconUrl}
        showBadge={false}
        className="size-4 shrink-0"
        iconClassName="size-4"
      />
      {props.providerAsTitle.label ? (
        <span
          className="min-w-0 truncate text-sm leading-snug text-muted-foreground group-data-selected:text-foreground"
          data-model-row-account=""
          aria-hidden
        >
          {props.providerAsTitle.label}
        </span>
      ) : null}
      {/* The header shows the model and the logo the provider; screen readers hear both. */}
      <span className="sr-only">
        {providerLabel}, {modelName}
      </span>
    </>
  ) : (
    <>
      <span className="min-w-0 truncate text-sm leading-snug">{modelName}</span>
      <span className="sr-only">{providerLabel}</span>
    </>
  );

  const row = (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={modelPickerModelKey(props.instanceId, props.model.slug)}
      disabled={Boolean(props.disabledReason)}
      className={cn(
        "group relative w-full !min-w-0 max-w-full",
        "cursor-pointer",
        props.disabledReason &&
          "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed",
      )}
      data-model-usage-warning={props.warningReason ? "true" : undefined}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
        {props.identity ? (
          <Tooltip>
            <TooltipTrigger
              render={<span className="flex min-w-0 items-center gap-2" data-model-row-lead="" />}
            >
              {lead}
            </TooltipTrigger>
            <TooltipPopup side="top" align="start" className="max-w-72 whitespace-pre-line">
              {props.identity}
            </TooltipPopup>
          </Tooltip>
        ) : (
          <span className="flex min-w-0 items-center gap-2" data-model-row-lead="">
            {lead}
          </span>
        )}
        {props.fallbackRole ? (
          <span
            className={cn(
              "shrink-0 rounded border px-1 py-px text-3xs font-semibold leading-none",
              props.fallbackRole.tone === "now"
                ? "border-warning/40 bg-warning/15 text-warning-foreground"
                : props.fallbackRole.tone === "pick"
                  ? "border-primary/35 bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground",
            )}
            data-fallback-role={props.fallbackRole.tone}
          >
            {props.fallbackRole.label}
          </span>
        ) : null}
        {props.unavailable ? (
          <Badge variant="outline" size="sm">
            {tx("Unavailable")}
          </Badge>
        ) : null}
        {props.warningReason ? <span className="sr-only">{props.warningReason}</span> : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {props.status ? <ModelStatusIcons icons={props.status} /> : null}
        {props.showSelection && props.isSelected ? (
          <CheckIcon className="size-3.5 text-primary" aria-hidden="true" />
        ) : null}
        {props.jumpLabel ? (
          <span className={cn(QUIET, "inline-flex pointer-coarse:hidden")} data-model-row-jump="">
            <Kbd>{props.jumpLabel}</Kbd>
          </span>
        ) : null}
        <span
          className={cn("inline-flex", !props.isFavorite && QUIET)}
          data-model-row-star={props.isFavorite ? "on" : "off"}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  // A filled star is state, not an action waiting for the pointer: it always shows.
                  className="-mr-1 shrink-0"
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onToggleFavorite();
                  }}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                  }}
                  // A usage limit is temporary; favorites stay editable through it.
                  disabled={Boolean(props.disabledReason)}
                  aria-label={
                    props.isFavorite ? tx("Remove from favorites") : tx("Add to favorites")
                  }
                  aria-pressed={props.isFavorite}
                >
                  <StarIcon
                    className={cn(
                      "size-3.5 sm:size-3",
                      props.isFavorite && "fill-current text-warning-foreground",
                    )}
                  />
                </Button>
              }
            />
            <TooltipPopup side="top" align="center">
              {props.isFavorite ? tx("Remove from favorites") : tx("Add to favorites")}
            </TooltipPopup>
          </Tooltip>
        </span>
      </div>
    </ComboboxItem>
  );

  if (!props.disabledReason) {
    return row;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipPopup side="left" align="center">
        {props.disabledReason}
      </TooltipPopup>
    </Tooltip>
  );
});
