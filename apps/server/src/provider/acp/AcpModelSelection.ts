import * as Effect from "effect/Effect";
import type { SessionConfigOption } from "@specweave-studio/effect-acp/compat";
import { AcpRequestError } from "@specweave-studio/effect-acp/errors";
import { collectSessionConfigOptionValues } from "./AcpRuntimeModel.ts";
import type { AcpSessionRuntime, AcpSessionRuntimeStartResult } from "./AcpSessionRuntime.ts";

/**
 * Copilot CLI 1.0.95 omits its model catalog; 1.0.97 can expose only `auto`.
 * Forward custom IDs through its legacy model method in these cases. Acceptance
 * of an ID alone does not establish entitlement or the effective inference model.
 */
const acceptsUnadvertisedSetModel = (started: AcpSessionRuntimeStartResult) =>
  started.initializeResult.agentInfo?.name === "Copilot";

const isAutoOnlyModelConfig = (option: SessionConfigOption) => {
  const values = collectSessionConfigOptionValues(option);
  return values.length > 0 && values.every((value) => value === "auto");
};

/** Config options are live; legacy model metadata declares session/set_model support. */
export const applyAcpModelSelection = Effect.fn("applyAcpModelSelection")(function* (
  runtime: Pick<AcpSessionRuntime["Service"], "getConfigOptions" | "setModel" | "setSessionModel">,
  started: AcpSessionRuntimeStartResult,
  requestedModel: string,
) {
  const options = yield* runtime.getConfigOptions;
  const modelOption = options.find((option) => option.category === "model");
  if (
    modelOption !== undefined &&
    requestedModel !== "auto" &&
    acceptsUnadvertisedSetModel(started) &&
    isAutoOnlyModelConfig(modelOption)
  ) {
    yield* runtime.setSessionModel(requestedModel);
  } else if (modelOption !== undefined) {
    yield* runtime.setModel(requestedModel);
  } else if (started.sessionSetupResult.models != null || acceptsUnadvertisedSetModel(started)) {
    // Let the provider validate custom IDs; its catalog need not be exhaustive.
    yield* runtime.setSessionModel(requestedModel);
  } else {
    return yield* new AcpRequestError({
      method: "session/set_model",
      code: -32601,
      errorMessage: "The ACP agent does not advertise model selection. Select its default model.",
    });
  }
  return requestedModel;
});

/**
 * Leaving a forwarded custom model for the default entry must tell the agent,
 * or the session keeps running, and billing, the custom model. Returns whether
 * a reset was sent.
 */
export const resetAcpModelSelection = Effect.fn("resetAcpModelSelection")(function* (
  runtime: Pick<AcpSessionRuntime["Service"], "getConfigOptions" | "setSessionModel">,
  started: AcpSessionRuntimeStartResult,
) {
  if (started.sessionSetupResult.models != null || !acceptsUnadvertisedSetModel(started)) {
    return false;
  }
  const options = yield* runtime.getConfigOptions;
  const modelOption = options.find((option) => option.category === "model");
  if (modelOption !== undefined && !isAutoOnlyModelConfig(modelOption)) {
    return false;
  }
  yield* runtime.setSessionModel("auto");
  return true;
});
