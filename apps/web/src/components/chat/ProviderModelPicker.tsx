import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@specweave-studio/contracts";
import { memo, type ReactNode, use, useEffect, useMemo, useState } from "react";
import { Badge } from "../ui/badge";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import type { ProviderQuickSetup } from "~/hooks/useProviderQuickSetup";
import {
  ModelPickerContent,
  resolveModelPickerSelectedModel,
  type ModelStateHeader,
} from "./ModelPickerContent";
import { ChatGptSharingControl } from "./ChatGptSharingControl";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  ModelEsque,
  getTriggerDisplayModelLabel,
  getTriggerDisplayModelName,
} from "./providerIconUtils";
import { shouldShowInstanceBadge, type ProviderInstanceEntry } from "../../providerInstances";
import {
  ComposerControl,
  ComposerControlChevron,
  type ComposerControlSize,
} from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { shortcutLabelForCommand } from "../../keybindings";
import { ModelUsageMeter, useModelPickerUsage, type ModelPickerUsageConfig } from "./ModelUsage";

import { ModelStateTag, ModelStateTip, modelStateText, type ModelState } from "./ModelStateTag";
import { ModelChipFitContext, useOwnModelChipFit, type ModelChipFit } from "./modelChipFit";

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  /**
   * The instance currently selected in the composer. Drives the trigger
   * icon, label and the default-highlighted combobox row.
   */
  activeInstanceId: ProviderInstanceId;
  model: string;
  selectedModels?: ReadonlyArray<{ instanceId: ProviderInstanceId; model: string }>;
  onToggleModel?: (instanceId: ProviderInstanceId, model: string) => void;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  /** Instance entries rendered in the sidebar + used to resolve display name. */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  activeProviderIconClassName?: string;
  instanceIndicatorBackground?: string;
  size?: ComposerControlSize;
  compact?: boolean;
  isComposerOwned?: boolean;
  disabled?: boolean;
  terminalOpen?: boolean;
  open?: boolean;
  triggerClassName?: string;
  /** Aggregate settings can show a neutral value without claiming one provider is selected. */
  triggerLabel?: string;
  /** Text for a trigger that still names the active provider, so its icon stays. */
  triggerText?: string;
  /** Provider mark for the active execution label, independent of the next-send menu selection. */
  triggerInstanceId?: ProviderInstanceId;
  triggerModel?: string;
  triggerState?: ModelState | null;
  triggerStateDetail?: string | null | undefined;
  /**
   * Name the provider and the model apart. The trigger becomes a model chip that gives up
   * room in a fixed order as its host narrows (modelChipFit.ts).
   */
  triggerParts?: { provider: string; model: string };
  /** How much of the chip shows, from a host that fits it with its other controls. */
  fit?: ModelChipFit | null;
  stateHeader?: ModelStateHeader | null;
  /** Nothing is chosen yet, so `activeInstanceId` only says where the list opens. */
  unset?: boolean;
  triggerAriaLabel?: string;
  onOpenChange?: (open: boolean) => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  quickSetup?: ProviderQuickSetup;
  /** Open the provider list even when every configured model is ready. */
  onManageProviders?: () => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  /**
   * Show usage on the trigger and beside every model, and warn on models whose
   * confirmed limit is spent; they stay selectable. For pickers that choose
   * what a chat runs next; settings pickers leave it off, since a default may
   * point at a model that is only out until its reset.
   */
  usage?: ModelPickerUsageConfig;
  /** Classes that hide the trigger's usage number when the composer is narrow. */
  usageValueHiddenClassName?: string;
  /**
   * A second view of the menu, opened from its footer: the coordinator's limits on
   * every machine. `back` returns to the models, `close` closes the menu.
   */
  secondaryView?: {
    readonly label: string;
    readonly render: (actions: { back: () => void; close: () => void }) => ReactNode;
  };
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const [uncontrolledIsMenuOpen, setUncontrolledIsMenuOpen] = useState(false);
  const isMenuOpen = props.open ?? uncontrolledIsMenuOpen;
  const size = props.size ?? "sm";

  // Resolve the active instance entry by exact routing key. The composer
  // resolves fallbacks before rendering this component; if the selected
  // instance disappears, do not infer a replacement from its driver kind.
  const activeEntry = useMemo(() => {
    return (
      props.instanceEntries.find((entry) => entry.instanceId === props.activeInstanceId) ?? null
    );
  }, [props.activeInstanceId, props.instanceEntries]);

  const activeInstanceId = props.activeInstanceId;
  const selectedInstanceOptions = props.modelOptionsByInstance.get(activeInstanceId) ?? [];
  // Account-specific catalogs must keep the selected model label while unavailable.
  const selectedModel =
    resolveModelPickerSelectedModel({
      driverKind: activeEntry?.driverKind,
      model: props.model,
      options: selectedInstanceOptions,
    }) ??
    (activeEntry?.driverKind === "opencode" || activeEntry?.driverKind === "antigravity"
      ? undefined
      : selectedInstanceOptions[0]);
  const triggerTitle = selectedModel
    ? getTriggerDisplayModelName(selectedModel)
    : props.model === ANTIGRAVITY_DEFAULT_MODEL
      ? "Choose model"
      : props.model || "Choose model";
  const triggerLabel = selectedModel
    ? `${getTriggerDisplayModelLabel(selectedModel)}${selectedModel.isUnavailable ? " (Unavailable)" : ""}`
    : triggerTitle;
  const triggerEntry = props.triggerInstanceId
    ? (props.instanceEntries.find((entry) => entry.instanceId === props.triggerInstanceId) ??
      activeEntry)
    : activeEntry;
  const showInstanceBadge =
    triggerEntry !== null && shouldShowInstanceBadge(triggerEntry, props.instanceEntries);
  const usage = useModelPickerUsage(props.usage, props.instanceEntries, isMenuOpen);
  const showsSingleModel =
    props.selectedModels === undefined && props.triggerLabel === undefined && !props.unset;
  const selectedUsage =
    usage && triggerEntry && showsSingleModel
      ? usage.availability(
          props.triggerInstanceId ?? activeInstanceId,
          props.triggerModel ?? selectedModel?.slug ?? props.model,
        )
      : null;
  const selectedUsageCopy =
    usage && selectedUsage
      ? usage.text(props.triggerInstanceId ?? activeInstanceId, selectedUsage)
      : null;
  const selectedUsageText = selectedUsageCopy?.long ?? null;

  const [showingSecondary, setShowingSecondary] = useState(false);
  const setIsMenuOpen = (open: boolean) => {
    // Every opening starts on the models.
    if (!open) setShowingSecondary(false);
    props.onOpenChange?.(open);
    if (props.open === undefined) {
      setUncontrolledIsMenuOpen(open);
    }
  };

  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }

    const { documentElement, body } = document;
    const previousDocumentOverscrollBehavior = documentElement.style.overscrollBehavior;
    const previousBodyOverflow = body.style.overflow;
    const previousBodyPaddingRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - documentElement.clientWidth;

    documentElement.style.overscrollBehavior = "contain";
    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      body.style.paddingRight = `${scrollbarWidth}px`;
    }

    const shouldAllowOverlayScroll = (target: EventTarget | null) => {
      return target instanceof Element && target.closest("[data-model-picker-content]");
    };
    const preventBackgroundWheel = (event: WheelEvent) => {
      if (shouldAllowOverlayScroll(event.target)) {
        return;
      }
      event.preventDefault();
    };
    const preventBackgroundTouchMove = (event: TouchEvent) => {
      if (shouldAllowOverlayScroll(event.target)) {
        return;
      }
      event.preventDefault();
    };

    document.addEventListener("wheel", preventBackgroundWheel, { capture: true, passive: false });
    document.addEventListener("touchmove", preventBackgroundTouchMove, {
      capture: true,
      passive: false,
    });

    return () => {
      document.removeEventListener("wheel", preventBackgroundWheel, { capture: true });
      document.removeEventListener("touchmove", preventBackgroundTouchMove, { capture: true });
      documentElement.style.overscrollBehavior = previousDocumentOverscrollBehavior;
      body.style.overflow = previousBodyOverflow;
      body.style.paddingRight = previousBodyPaddingRight;
    };
  }, [isMenuOpen]);

  const handleInstanceModelChange = (instanceId: ProviderInstanceId, model: string) => {
    if (props.disabled) return;
    props.onInstanceModelChange(instanceId, model);
    setIsMenuOpen(false);
  };

  const shortcutLabel = props.keybindings
    ? shortcutLabelForCommand(props.keybindings, "modelPicker.toggle")
    : null;
  const selectedEntries = props.selectedModels?.map((selection) => {
    const entry = props.instanceEntries.find(
      (candidate) => candidate.instanceId === selection.instanceId,
    );
    const model = resolveModelPickerSelectedModel({
      driverKind: entry?.driverKind,
      model: selection.model,
      options: props.modelOptionsByInstance.get(selection.instanceId) ?? [],
    });
    return {
      ...selection,
      entry,
      label: model
        ? `${getTriggerDisplayModelName(model)}${model.isUnavailable ? " (Unavailable)" : ""}`
        : selection.model,
    };
  });
  const multipleLabel = selectedEntries
    ? selectedEntries.length === 0
      ? "Choose models"
      : `${selectedEntries
          .slice(0, 2)
          .map((selection) => selection.label)
          .join(", ")}${selectedEntries.length > 2 ? `, ${selectedEntries.length - 2} more` : ""}`
    : undefined;
  const allModelNames = selectedEntries
    ? selectedEntries.map((selection) => selection.label).join(", ") || "Choose models"
    : undefined;
  const activeText = props.triggerText;
  const triggerName =
    props.triggerLabel ??
    allModelNames ??
    (activeText ? `${activeText}. Next message: ${triggerLabel}` : triggerLabel);
  const state =
    props.triggerState?.kind === "fallback" && props.triggerStateDetail
      ? { ...props.triggerState, detail: props.triggerStateDetail }
      : props.triggerState;
  const stateCopy = state ? modelStateText(state) : null;
  const stateAria = stateCopy?.aria.replace(
    "(usage limit)",
    state?.kind === "fallback" && props.triggerStateDetail?.match(/resets (?:at )?([^.;]+)/)?.[1]
      ? `(usage limit, resets ${props.triggerStateDetail.match(/resets (?:at )?([^.;]+)/)![1]})`
      : "(usage limit)",
  );
  const parts =
    props.triggerLabel === undefined && !selectedEntries ? props.triggerParts : undefined;
  const currentLabel = parts ? `${parts.provider} · ${parts.model}` : (activeText ?? triggerLabel);
  const tooltipName = parts ? currentLabel : triggerName;
  const triggerTooltipContent = shortcutLabel ? `${tooltipName} · ${shortcutLabel}` : tooltipName;
  // A chip follows its host's fit; on its own it measures the room its host gives it.
  const hostFit = use(ModelChipFitContext);
  const [chipRow, setChipRow] = useState<HTMLSpanElement | null>(null);
  const ownFit = useOwnModelChipFit(
    chipRow?.closest<HTMLElement>("[data-model-chip]") ?? null,
    parts !== undefined && (props.fit ?? hostFit ?? null) === null,
  );
  const fit = parts ? (props.fit ?? hostFit ?? ownFit) : null;
  // Every fit keeps the whole identity for keyboard and screen reader users.
  const chipAriaLabel =
    parts || stateCopy
      ? `Model: ${currentLabel}${stateAria ?? ""}.${selectedUsageText ? ` ${selectedUsageText.replace(/\.$/, "")}.` : ""} Change model`
      : undefined;

  const tooltip = state ? (
    <ModelStateTip
      current={currentLabel}
      currentNote={selectedUsageText ? ` · ${selectedUsageText}` : null}
      state={state}
    />
  ) : selectedUsageText ? (
    <span className="flex max-w-72 flex-col gap-0.5">
      <span>{triggerTooltipContent}</span>
      <span className="text-muted-foreground">{selectedUsageText}</span>
    </span>
  ) : (
    triggerTooltipContent
  );

  return (
    <Popover
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      {/* The tooltip belongs to the whole control, so keyboard focus shows it too. */}
      <Tooltip disabled={isMenuOpen}>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <ComposerControl
                  aria-label={
                    props.triggerAriaLabel ??
                    chipAriaLabel ??
                    allModelNames ??
                    (selectedUsageText ? `${triggerName}. ${selectedUsageText}` : undefined)
                  }
                  size={size}
                  data-chat-provider-model-picker="true"
                  data-model-state={state?.kind}
                  {...(fit ? { "data-model-chip": "", "data-model-fit": fit } : {})}
                  className={cn(
                    "min-w-0 shrink justify-between whitespace-nowrap",
                    props.compact
                      ? "max-w-42 shrink-0"
                      : !props.isComposerOwned && !parts && "max-w-48 sm:max-w-56",
                    props.triggerClassName,
                    // The fit keeps the chip within its host; the cap only guards a
                    // frame before the first measurement. At `name` a long model name
                    // gives way to the host's other controls and ends in an ellipsis.
                    parts &&
                      (fit === "name" ? "w-auto max-w-full shrink" : "w-max max-w-full shrink-0"),
                  )}
                  disabled={props.disabled}
                />
              }
            >
              <span
                ref={setChipRow}
                className={cn(
                  "flex min-w-0 flex-1 items-center",
                  size === "xs" ? "gap-1" : "gap-1.5",
                )}
              >
                {selectedEntries && props.triggerLabel === undefined ? (
                  <span className="flex shrink-0 items-center -space-x-1" aria-hidden="true">
                    {selectedEntries
                      .slice(0, 3)
                      .map((selection) =>
                        selection.entry ? (
                          <ProviderInstanceIcon
                            key={`${selection.instanceId}:${selection.model}`}
                            driverKind={selection.entry.driverKind}
                            displayName={selection.entry.displayName}
                            accentColor={selection.entry.accentColor}
                            acpRegistryAgentId={selection.entry.acpRegistryAgentId}
                            acpRegistryIconUrl={selection.entry.acpRegistryIconUrl}
                            className="size-4 rounded-full bg-(--chat-composer-glass-surface,var(--background)) ring-2 ring-(--chat-composer-glass-surface,var(--background))"
                            iconClassName="size-4"
                          />
                        ) : null,
                      )}
                    {selectedEntries.length > 3 ? (
                      <span className="relative z-30 flex size-4 items-center justify-center rounded-full bg-(--chat-composer-glass-surface,var(--background)) text-3xs ring-2 ring-(--chat-composer-glass-surface,var(--background))">
                        +{selectedEntries.length - 3}
                      </span>
                    ) : null}
                  </span>
                ) : triggerEntry && props.triggerLabel === undefined ? (
                  <ProviderInstanceIcon
                    driverKind={triggerEntry.driverKind}
                    displayName={triggerEntry.displayName}
                    accentColor={triggerEntry.accentColor}
                    acpRegistryAgentId={triggerEntry.acpRegistryAgentId}
                    acpRegistryIconUrl={triggerEntry.acpRegistryIconUrl}
                    showBadge={showInstanceBadge}
                    className="size-4"
                    iconClassName={cn("size-4", props.activeProviderIconClassName)}
                    indicatorBackground={
                      props.instanceIndicatorBackground ?? "var(--contrast-input)"
                    }
                    badgeClassName={cn(
                      "right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-5xs",
                      size === "xs" && "shadow-none",
                    )}
                  />
                ) : null}
                {parts ? (
                  <>
                    {/* The provider's name and its separator sit one gap from the model. */}
                    <span
                      className="-me-0.5 font-normal text-muted-foreground"
                      data-model-chip-part="provider"
                      data-picker-provider
                      aria-hidden
                    >
                      {parts.provider}
                      <span> ·</span>
                    </span>
                    <span
                      className="min-w-0 shrink! truncate font-medium text-foreground"
                      data-model-chip-part="model"
                      data-picker-model
                      aria-hidden
                    >
                      {parts.model}
                    </span>
                  </>
                ) : (
                  <span
                    className="flex min-w-0 flex-[0_1_auto] items-center gap-1 overflow-hidden"
                    data-chat-provider-model-picker-label="true"
                  >
                    <span className="truncate">
                      {props.triggerLabel ?? multipleLabel ?? props.triggerText ?? triggerTitle}
                    </span>
                  </span>
                )}
                {state ? (
                  <ModelStateTag
                    state={state}
                    className="text-xs"
                    {...(parts
                      ? { chip: true }
                      : {
                          tierClassName:
                            "@max-[639px]/composer-surface:[&_.sws-model-state-full]:hidden @max-[639px]/composer-surface:[&_.sws-model-state-short]:inline! @max-[479px]/composer-surface:[&_.sws-model-state-short]:hidden!",
                        })}
                  />
                ) : null}
                {selectedUsage && selectedUsageCopy ? (
                  <ModelUsageMeter
                    state={selectedUsage}
                    text={selectedUsageCopy}
                    {...(parts ? { chip: true } : {})}
                    {...(!parts && props.usageValueHiddenClassName
                      ? { hideValueClassName: props.usageValueHiddenClassName }
                      : {})}
                  />
                ) : null}
                {selectedModel?.isUnavailable &&
                !props.triggerText &&
                !selectedEntries &&
                props.triggerLabel === undefined ? (
                  <Badge variant="outline" size="sm">
                    Unavailable
                  </Badge>
                ) : null}
              </span>
              <span aria-hidden="true" className="flex shrink-0 items-center">
                <ComposerControlChevron size={size} />
              </span>
            </PopoverTrigger>
          }
        />
        <TooltipPopup side="top">{tooltip}</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        {...(props.isComposerOwned ? composerFloatingLayerProps : {})}
        align="start"
        className="before:hidden"
        padding="none"
      >
        {showingSecondary && props.secondaryView ? (
          <div className="w-screen max-w-90 p-3" data-model-picker-secondary="">
            {props.secondaryView.render({
              back: () => setShowingSecondary(false),
              close: () => setIsMenuOpen(false),
            })}
          </div>
        ) : (
          <ModelPickerContent
            stateHeader={props.stateHeader ?? null}
            activeInstanceId={activeInstanceId}
            model={props.model}
            {...(props.selectedModels !== undefined
              ? { selectedModels: props.selectedModels }
              : {})}
            {...(props.onToggleModel
              ? {
                  onToggleModel: (instanceId: ProviderInstanceId, model: string) => {
                    if (!props.disabled) props.onToggleModel?.(instanceId, model);
                  },
                }
              : {})}
            lockedProvider={props.lockedProvider}
            lockedContinuationGroupKey={props.lockedContinuationGroupKey ?? null}
            instanceEntries={props.instanceEntries}
            {...(props.keybindings ? { keybindings: props.keybindings } : {})}
            modelOptionsByInstance={props.modelOptionsByInstance}
            terminalOpen={props.terminalOpen ?? false}
            onRequestClose={() => setIsMenuOpen(false)}
            {...(props.onOpenProviderSetup
              ? {
                  onOpenProviderSetup: (instanceId: ProviderInstanceId) => {
                    if (!props.disabled) props.onOpenProviderSetup?.(instanceId);
                  },
                }
              : {})}
            {...(props.onManageProviders || props.onOpenProviderSetup
              ? {
                  onManageProviders: () => {
                    if (props.disabled) return;
                    if (props.onManageProviders) props.onManageProviders();
                    else props.onOpenProviderSetup?.(activeInstanceId);
                  },
                }
              : {})}
            {...(props.getModelDisabledReason
              ? { getModelDisabledReason: props.getModelDisabledReason }
              : {})}
            {...(props.quickSetup && !props.disabled ? { quickSetup: props.quickSetup } : {})}
            {...(usage ? { usage } : {})}
            {...(props.secondaryView
              ? {
                  secondaryAction: {
                    label: props.secondaryView.label,
                    onOpen: () => setShowingSecondary(true),
                  },
                }
              : {})}
            onInstanceModelChange={handleInstanceModelChange}
          />
        )}
        {props.selectedModels === undefined && !props.unset ? (
          <ChatGptSharingControl provider={activeEntry?.snapshot ?? null} />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
});
