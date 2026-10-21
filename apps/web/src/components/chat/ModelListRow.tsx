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
import { ModelRowAvailability } from "./ModelUsage";
import type { AvailabilityText } from "../../studio/modelAvailability";

export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  model: ModelEsque;
  /** Instance the model belongs to — the routing key used in combobox values. */
  instanceId: ProviderInstanceId;
  /** Driver kind of the instance — used for the provider icon glyph. */
  driverKind: ProviderDriverKind;
  /**
   * Display name to show in the secondary line (provider footer). Usually
   * the instance's configured `displayName` so custom instances like
   * "Codex Personal" render with their user-authored label.
   */
  providerDisplayName: string;
  providerAccentColor?: string | undefined;
  acpRegistryAgentId?: string | undefined;
  acpRegistryIconUrl?: string | undefined;
  isFavorite: boolean;
  isSelected: boolean;
  showSelection?: boolean;
  showProvider: boolean;
  preferShortName?: boolean;
  useTriggerLabel?: boolean;
  showNewBadge?: boolean;
  unavailable?: boolean;
  jumpLabel?: string | null;
  disabledReason?: string | null;
  /** The row is disabled by a spent usage limit: its reason stays readable on the row. */
  usageBlocked?: boolean;
  /** Usage for this model, shown after the provider name. */
  availability?: AvailabilityText | null;
  onToggleFavorite: () => void;
}) {
  const providerLabel = props.model.subProvider
    ? `${props.providerDisplayName} · ${props.model.subProvider}`
    : props.providerDisplayName;

  const row = (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={modelPickerModelKey(props.instanceId, props.model.slug)}
      // A usage-blocked row stays fully legible: the picker refuses the pick
      // instead of the combobox fading the reason along with the row.
      disabled={Boolean(props.disabledReason) && !props.usageBlocked}
      aria-disabled={props.usageBlocked ? true : undefined}
      className={cn(
        "group relative w-full !min-w-0 max-w-full",
        props.usageBlocked ? "cursor-not-allowed" : "cursor-pointer",
        props.disabledReason &&
          "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed",
      )}
      data-model-usage-blocked={props.usageBlocked ? "true" : undefined}
    >
      <div className="min-w-0 flex-1 text-left">
        <div className="flex min-w-0 items-center gap-2">
          <div
            className={cn(
              "min-w-0 truncate text-xs font-medium leading-snug",
              props.usageBlocked && "text-muted-foreground",
            )}
          >
            {props.useTriggerLabel
              ? getTriggerDisplayModelLabel(props.model)
              : getDisplayModelName(
                  props.model,
                  props.preferShortName ? { preferShortName: true } : undefined,
                )}
          </div>
          {props.showNewBadge ? (
            <span
              className="shrink-0 rounded border border-update/35 bg-update/15 px-0.5 py-px text-3xs font-bold uppercase leading-none tracking-wide text-update-foreground"
              aria-label="New model"
            >
              New
            </span>
          ) : null}
          {props.unavailable ? (
            <Badge variant="outline" size="sm">
              Unavailable
            </Badge>
          ) : null}
        </div>
        {props.showProvider && (
          <div className="mt-1 flex items-start gap-1.5">
            <ProviderInstanceIcon
              driverKind={props.driverKind}
              displayName={props.providerDisplayName}
              acpRegistryAgentId={props.acpRegistryAgentId}
              acpRegistryIconUrl={props.acpRegistryIconUrl}
              className="mt-[0.1875rem] size-3 shrink-0"
              iconClassName="size-3"
            />
            <span
              className={cn(
                "text-xs font-normal leading-snug text-muted-foreground",
                props.availability ? "max-w-[45%] shrink-0 truncate" : "truncate",
              )}
            >
              {providerLabel}
            </span>
            {props.availability ? (
              <>
                <span className="shrink-0 text-xs text-muted-foreground" aria-hidden>
                  ·
                </span>
                <span className="flex min-w-0 text-xs leading-snug">
                  <ModelRowAvailability text={props.availability} />
                </span>
                {props.usageBlocked ? (
                  <span className="sr-only">{props.availability.long}</span>
                ) : null}
              </>
            ) : null}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {props.showSelection && props.isSelected ? (
          <CheckIcon className="size-3.5" aria-hidden="true" />
        ) : null}
        {props.jumpLabel ? <Kbd>{props.jumpLabel}</Kbd> : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                className="-mr-1 shrink-0"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onToggleFavorite();
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                }}
                // A usage limit is temporary; favorites stay editable through it.
                disabled={Boolean(props.disabledReason) && !props.usageBlocked}
                aria-label={props.isFavorite ? "Remove from favorites" : "Add to favorites"}
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
            {props.isFavorite ? "Remove from favorites" : "Add to favorites"}
          </TooltipPopup>
        </Tooltip>
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
