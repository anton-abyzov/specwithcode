import {
  type ClaudeUltracodeDefault,
  type ClaudeWorkflowMode,
  type ModelCapabilities,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProvider,
  type ServerProviderModel,
} from "@specweave-studio/contracts";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
  normalizeModelSlug,
} from "@specweave-studio/shared/model";
import {
  claudeUsagePausesUltracodeDefault,
  effectiveClaudeUltracodeDefault,
  type UltracodeChatKind,
  ultracodeDefaultForChat,
} from "@specweave-studio/shared/ultracodeDefault";
import { type ReactNode, useMemo } from "react";

import type { DraftId } from "../../composerDraftStore";
import { useClockWhile } from "../../hooks/useClockWhile";
import { getProviderModelCapabilities } from "../../providerModels";
import type { ComposerControlSize } from "./ComposerControl";
import type { ModelPickerEffort } from "./ModelPickerEffortStrip";
import {
  shouldRenderTraitsControls,
  TraitsMenuContent,
  TraitsPicker,
  type TraitsUltracodeDefault,
  useTraitsEffortControl,
} from "./TraitsPicker";

export type ComposerProviderStateInput = {
  provider: ProviderDriverKind;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  promptInjectionState?: ComposerPromptInjectionState;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  planModeEnabled: boolean;
};

export type ComposerPromptInjectionState = "none" | "ultrathink";

export type ComposerProviderState = {
  provider: ProviderDriverKind;
  promptEffort: string | null;
  modelOptionsForDispatch: ReadonlyArray<ProviderOptionSelection> | undefined;
  composerFrameClassName?: string;
  composerSurfaceClassName?: string;
  modelPickerIconClassName?: string;
};

type TraitsRenderInput = {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  threadRef?: ScopedThreadRef;
  draftId?: DraftId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
  reportedModelSelection?: ModelSelection | null | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  planModeEnabled: boolean;
  size?: ComposerControlSize;
  hidden?: boolean;
  triggerClassName?: string;
  isComposerOwned?: boolean;
  /** Opt-in: the chat's Ultracode default, shown while its toggle is unset. Display only. */
  ultracodeDefault?: TraitsUltracodeDefault | undefined;
};

/** The settings the Ultracode default reads, already resolved for the chat's project. */
export interface UltracodeDefaultSettings {
  readonly claudeWorkflowMode?: ClaudeWorkflowMode | undefined;
  readonly claudeUltracodeDefault?: ClaudeUltracodeDefault | undefined;
}

/**
 * The Ultracode default a picker shows for one chat, by the same rule the
 * server applies at launch. `provider` is the chat's instance snapshot; without
 * one it reads as a subscription with unknown usage, which never pauses.
 */
export function traitsUltracodeDefault(input: {
  readonly settings: UltracodeDefaultSettings;
  readonly chatKind: UltracodeChatKind;
  readonly provider: ServerProvider | null | undefined;
  readonly model: string | null | undefined;
  readonly nowMs: number;
}): TraitsUltracodeDefault {
  const { state, reason } = ultracodeDefaultForChat({
    workflowMode: input.settings.claudeWorkflowMode,
    ultracodeDefault: input.settings.claudeUltracodeDefault,
    chatKind: input.chatKind,
    provider: input.provider ?? undefined,
    model: input.model,
    nowMs: input.nowMs,
  });
  return {
    state,
    reason,
    scope: effectiveClaudeUltracodeDefault(
      input.settings.claudeWorkflowMode,
      input.settings.claudeUltracodeDefault,
    ),
  };
}

/** What a chat view knows about the chat for its Ultracode default; the composer adds the model. */
export interface ComposerUltracodeDefaultContext {
  readonly settings: UltracodeDefaultSettings;
  readonly chatKind: UltracodeChatKind;
}

/**
 * The composer's Ultracode default for its selected instance and model. A usage
 * reading that crosses the pause share arrives as a new snapshot; while the
 * default is paused a minute clock lets it come back at the reset, and no clock
 * runs otherwise.
 */
export function useComposerUltracodeDefault(input: {
  readonly context: ComposerUltracodeDefaultContext | null | undefined;
  readonly provider: ServerProvider | null | undefined;
  readonly model: string | null | undefined;
}): TraitsUltracodeDefault | undefined {
  const { context, provider, model } = input;
  const reading = useMemo(() => {
    const at = Date.now();
    return {
      at,
      paused: context ? claudeUsagePausesUltracodeDefault(provider ?? undefined, at, model) : false,
    };
  }, [context, provider, model]);
  const clockMs = useClockWhile(reading.paused, 60_000);
  const nowMs = reading.paused ? Math.max(clockMs, reading.at) : reading.at;
  return useMemo(
    () =>
      context
        ? traitsUltracodeDefault({
            settings: context.settings,
            chatKind: context.chatKind,
            provider,
            model,
            nowMs,
          })
        : undefined,
    [context, model, nowMs, provider],
  );
}

/**
 * The Ultracode default a model picker for new threads shows: the chat kind is
 * "thread", read under `settings` (environment or project resolved).
 */
export function useThreadUltracodeDefault(input: {
  readonly settings: UltracodeDefaultSettings | null | undefined;
  readonly provider: ServerProvider | null | undefined;
  readonly model: string | null | undefined;
}): TraitsUltracodeDefault | undefined {
  const workflowMode = input.settings?.claudeWorkflowMode;
  const ultracodeDefault = input.settings?.claudeUltracodeDefault;
  const known = input.settings !== null && input.settings !== undefined;
  const context = useMemo<ComposerUltracodeDefaultContext | null>(
    () =>
      known
        ? {
            settings: { claudeWorkflowMode: workflowMode, claudeUltracodeDefault: ultracodeDefault },
            chatKind: "thread",
          }
        : null,
    [known, ultracodeDefault, workflowMode],
  );
  return useComposerUltracodeDefault({ context, provider: input.provider, model: input.model });
}

export function getComposerPromptInjectionState(prompt: string): ComposerPromptInjectionState {
  return isClaudeUltrathinkPrompt(prompt) ? "ultrathink" : "none";
}

/**
 * Cursor ACP can report `fastMode: true` as the provider default. Studio only
 * treats Fast as selected when the user chose it (draft/sticky/settings).
 * Otherwise inject an explicit `false` so new chats stay Normal and the
 * send path can overwrite a prior Fast session — descriptor defaults are
 * otherwise omitted by `buildExplicitProviderOptionSelectionsFromDescriptors`.
 */
export function withImplicitFastModeDefault(
  caps: ModelCapabilities,
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  const hasExplicitFastMode = modelOptions?.some((selection) => selection.id === "fastMode");
  if (hasExplicitFastMode) {
    return modelOptions ?? undefined;
  }
  const hasFastModeDescriptor = caps.optionDescriptors?.some(
    (descriptor) => descriptor.type === "boolean" && descriptor.id === "fastMode",
  );
  if (!hasFastModeDescriptor) {
    return modelOptions ?? undefined;
  }
  return [...(modelOptions ?? []), { id: "fastMode", value: false }];
}

function resolveComposerOptionSelections(
  models: ReadonlyArray<ServerProviderModel>,
  model: string,
  provider: ProviderDriverKind,
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  planModeEnabled: boolean,
): {
  caps: ModelCapabilities;
  selections: ReadonlyArray<ProviderOptionSelection> | undefined;
} {
  const caps = getProviderModelCapabilities(models, model, provider, planModeEnabled);
  return { caps, selections: withImplicitFastModeDefault(caps, modelOptions) };
}

export function getComposerProviderState(input: ComposerProviderStateInput): ComposerProviderState {
  const {
    provider,
    model,
    models,
    modelOptions,
    promptInjectionState = "none",
    planModeEnabled,
  } = input;
  if (provider === "opencode") {
    const normalizedModel = normalizeModelSlug(model, provider);
    const modelIsInCatalog = models.some((candidate) => candidate.slug === normalizedModel);
    if (!modelIsInCatalog) {
      const preservedOptions = modelOptions?.filter(
        (option) => planModeEnabled || option.id !== "agent" || option.value !== "plan",
      );
      return {
        provider,
        promptEffort: null,
        modelOptionsForDispatch:
          preservedOptions && preservedOptions.length > 0 ? preservedOptions : undefined,
      };
    }
  }
  const { caps, selections } = resolveComposerOptionSelections(
    models,
    model,
    provider,
    modelOptions,
    planModeEnabled,
  );
  const descriptors = getProviderOptionDescriptors({ caps, selections });
  const primarySelectDescriptor = descriptors.find(
    (descriptor): descriptor is Extract<(typeof descriptors)[number], { type: "select" }> =>
      descriptor.type === "select",
  );
  const primaryValue = getProviderOptionCurrentValue(primarySelectDescriptor ?? null);
  const promptEffort = typeof primaryValue === "string" ? primaryValue : null;
  const ultrathinkActive =
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    promptInjectionState === "ultrathink";

  return {
    provider,
    promptEffort,
    modelOptionsForDispatch: buildExplicitProviderOptionSelectionsFromDescriptors(
      descriptors,
      selections,
    ),
    ...(ultrathinkActive
      ? {
          composerFrameClassName: "ultrathink-frame",
          composerSurfaceClassName: "shadow-[0_0_0_1px_rgba(255,255,255,0.07)_inset]",
          modelPickerIconClassName: "ultrathink-chroma",
        }
      : {}),
  };
}

function renderTraitsControl(
  Component: typeof TraitsMenuContent | typeof TraitsPicker,
  input: TraitsRenderInput,
): ReactNode {
  const {
    provider,
    instanceId,
    threadRef,
    draftId,
    model,
    models,
    modelOptions,
    reportedModelSelection,
    prompt,
    onPromptChange,
    planModeEnabled,
    size,
    hidden,
    triggerClassName,
    isComposerOwned,
    ultracodeDefault,
  } = input;
  const hasTarget = threadRef !== undefined || draftId !== undefined;
  const { selections: resolvedModelOptions } = resolveComposerOptionSelections(
    models,
    model,
    provider,
    modelOptions,
    planModeEnabled,
  );
  if (
    !hasTarget ||
    !shouldRenderTraitsControls({
      provider,
      models,
      model,
      modelOptions: resolvedModelOptions,
      prompt,
      planModeEnabled,
    })
  ) {
    return null;
  }
  return (
    <Component
      provider={provider}
      {...(instanceId ? { instanceId } : {})}
      models={models}
      {...(threadRef ? { threadRef } : {})}
      {...(draftId ? { draftId } : {})}
      model={model}
      modelOptions={resolvedModelOptions}
      reportedModelSelection={reportedModelSelection}
      prompt={prompt}
      onPromptChange={onPromptChange}
      planModeEnabled={planModeEnabled}
      {...(size !== undefined ? { size } : {})}
      {...(hidden !== undefined ? { hidden } : {})}
      {...(triggerClassName !== undefined ? { triggerClassName } : {})}
      {...(isComposerOwned ? { isComposerOwned } : {})}
      {...(ultracodeDefault ? { ultracodeDefault } : {})}
    />
  );
}

export function renderProviderTraitsMenuContent(input: TraitsRenderInput): ReactNode {
  return renderTraitsControl(TraitsMenuContent, input);
}

export function renderProviderTraitsPicker(input: TraitsRenderInput): ReactNode {
  return renderTraitsControl(TraitsPicker, input);
}

/**
 * The effort strip the model picker shows for the composer's model, from the same input
 * as the effort control beside it. Null when that control would not render.
 */
export function useProviderEffortControl(input: TraitsRenderInput): ModelPickerEffort | null {
  const { threadRef, draftId, model, models, provider, modelOptions, planModeEnabled } = input;
  const { selections } = resolveComposerOptionSelections(
    models,
    model,
    provider,
    modelOptions,
    planModeEnabled,
  );
  const enabled =
    (threadRef !== undefined || draftId !== undefined) &&
    shouldRenderTraitsControls({
      provider,
      models,
      model,
      modelOptions: selections,
      prompt: input.prompt,
      planModeEnabled,
    });
  return useTraitsEffortControl(
    enabled
      ? {
          provider,
          ...(input.instanceId ? { instanceId: input.instanceId } : {}),
          models,
          ...(threadRef ? { threadRef } : {}),
          ...(draftId ? { draftId } : {}),
          model,
          modelOptions: selections,
          reportedModelSelection: input.reportedModelSelection,
          prompt: input.prompt,
          onPromptChange: input.onPromptChange,
          planModeEnabled,
        }
      : null,
  );
}
