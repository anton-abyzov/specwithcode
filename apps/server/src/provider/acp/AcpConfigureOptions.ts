import type { ModelSelection, ProviderDriverKind } from "@specweave-studio/contracts";
import type * as EffectAcpSchema from "@specweave-studio/effect-acp/compat";
import { isProviderAllowAllOption } from "@specweave-studio/shared/providerPermissions";
import * as Effect from "effect/Effect";
import type { AcpSessionRuntime } from "./AcpSessionRuntime.ts";
import type { ProviderAdapterV2RuntimePolicy } from "../../orchestration-v2/ProviderAdapter.ts";
import { ACP_SESSION_MODE_OPTION_ID } from "./AcpSessionConfig.ts";
import { synchronizeAcpPermissions } from "./AcpPermissions.ts";

export interface AcpNativeBuildConfiguration {
  readonly modeId?: string;
  readonly configOptions: ReadonlyArray<{ readonly id: string; readonly value: string }>;
}

export const configureAcpOptions = Effect.fn("configureAcpOptions")(function* (
  runtime: Pick<
    AcpSessionRuntime["Service"],
    "getConfigOptions" | "setConfigOption" | "getModeState" | "setMode"
  >,
  modelSelection: ModelSelection,
  runtimePolicy: ProviderAdapterV2RuntimePolicy,
  driver: ProviderDriverKind,
  sessionId: string,
  nativeBuildConfigurationBySessionId: Map<string, AcpNativeBuildConfiguration>,
  policyMode?: string,
) {
  const optionSelections = (modelSelection.options ?? []).filter(
    (option) => !isProviderAllowAllOption(option.id),
  );
  const configOptions = yield* runtime.getConfigOptions;
  const availableConfigIds = new Set(configOptions.map((option) => option.id));
  const hasNativeConfigWithSyntheticModeId = availableConfigIds.has(ACP_SESSION_MODE_OPTION_ID);
  const modeSelection = hasNativeConfigWithSyntheticModeId
    ? undefined
    : optionSelections.find((selection) => selection.id === ACP_SESSION_MODE_OPTION_ID);
  const configSelections = hasNativeConfigWithSyntheticModeId
    ? optionSelections
    : optionSelections.filter((selection) => selection.id !== ACP_SESSION_MODE_OPTION_ID);
  // Probe-time descriptors are a per-model union, so a stored
  // selection can reference an option the live session does not
  // expose (Kilo advertises per-model "effort" descriptors while its
  // session config omits them). Failing the open here wedges the run
  // in a retry loop; skip like the out-of-range values below and let
  // the agent default apply.
  const unsupportedConfigIds = configSelections
    .map((selection) => selection.id)
    .filter((id) => !availableConfigIds.has(id));
  if (unsupportedConfigIds.length > 0) {
    yield* Effect.logWarning("ACP session does not expose requested configuration option(s)", {
      driver,
      sessionId: sessionId,
      optionIds: unsupportedConfigIds,
    });
  }
  for (const selection of configSelections) {
    if (!availableConfigIds.has(selection.id)) continue;
    // Tuning knobs degrade instead of failing the session open: agents
    // advertise the union of values across models but can reject a
    // per-model invalid one at set time (codex-acp advertises "ultra"
    // reasoning effort and then rejects it for most models). Skip
    // values the session does not currently offer and downgrade an
    // agent-side set rejection to a warning; the agent's default
    // applies for that option.
    const option = configOptions.find((candidate) => candidate.id === selection.id);
    if (option !== undefined && option.type === "select" && typeof selection.value === "string") {
      const advertisedValues = option.options.flatMap((entry) =>
        "value" in entry ? [entry.value] : entry.options.map((choice) => choice.value),
      );
      if (!advertisedValues.includes(selection.value)) continue;
    }
    yield* runtime.setConfigOption(selection.id, selection.value).pipe(
      Effect.catchTags({
        AcpRequestError: (error) =>
          Effect.logWarning("ACP session rejected a configuration option value", {
            optionId: selection.id,
            value: selection.value,
            detail: error.message,
          }),
      }),
    );
  }
  if (policyMode !== undefined) {
    yield* runtime.setMode(policyMode);
  }
  const modeState = yield* runtime.getModeState;
  // The synthetic mode selection is skipped rather than failed when the
  // agent no longer advertises it: mode sets are volatile across agent
  // versions and a stale persisted mode should not block the turn.
  if (
    modeSelection !== undefined &&
    typeof modeSelection.value === "string" &&
    modeState?.availableModes.some((mode) => mode.id === modeSelection.value) === true &&
    modeState.currentModeId !== modeSelection.value
  ) {
    yield* runtime.setMode(modeSelection.value);
  }
  const effectiveModeState = yield* runtime.getModeState;
  const effectiveConfigOptions = yield* runtime.getConfigOptions;
  const planSensitiveOptions = effectiveConfigOptions.filter(
    (option): option is Extract<EffectAcpSchema.SessionConfigOption, { readonly type: "select" }> =>
      option.type === "select" &&
      (option.category === "mode" || option.category === "collaboration_mode"),
  );
  if (runtimePolicy.interactionMode === "plan") {
    if (!nativeBuildConfigurationBySessionId.has(sessionId)) {
      nativeBuildConfigurationBySessionId.set(sessionId, {
        ...(effectiveModeState === undefined ? {} : { modeId: effectiveModeState.currentModeId }),
        configOptions: planSensitiveOptions.map((option) => ({
          id: option.id,
          value: option.currentValue,
        })),
      });
    }
    const planMode = effectiveModeState?.availableModes.find(
      (mode) => mode.id === "plan" || mode.id === "architect",
    );
    if (planMode !== undefined && effectiveModeState?.currentModeId !== planMode.id) {
      yield* runtime.setMode(planMode.id);
    }
    for (const option of planSensitiveOptions) {
      const choices = option.options.flatMap((entry) =>
        "value" in entry ? [entry.value] : entry.options.map((choice) => choice.value),
      );
      const requested = choices.find((choice) => choice === "plan" || choice === "architect");
      if (requested !== undefined && option.currentValue !== requested) {
        yield* runtime.setConfigOption(option.id, requested);
      }
    }
  } else {
    const nativeBuild = nativeBuildConfigurationBySessionId.get(sessionId);
    if (nativeBuild !== undefined) {
      if (
        nativeBuild.modeId !== undefined &&
        effectiveModeState?.currentModeId !== nativeBuild.modeId &&
        effectiveModeState?.availableModes.some((mode) => mode.id === nativeBuild.modeId) === true
      ) {
        yield* runtime.setMode(nativeBuild.modeId);
      }
      for (const saved of nativeBuild.configOptions) {
        const option = effectiveConfigOptions.find(
          (candidate) => candidate.type === "select" && candidate.id === saved.id,
        );
        if (option === undefined || option.type !== "select") continue;
        const choices = option.options.flatMap((entry) =>
          "value" in entry ? [entry.value] : entry.options.map((choice) => choice.value),
        );
        if (option.currentValue !== saved.value && choices.includes(saved.value)) {
          yield* runtime.setConfigOption(option.id, saved.value);
        }
      }
      nativeBuildConfigurationBySessionId.delete(sessionId);
    }
  }
  yield* synchronizeAcpPermissions(runtime, runtimePolicy.runtimeMode);
});
