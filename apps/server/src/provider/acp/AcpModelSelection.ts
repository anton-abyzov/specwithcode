import * as Effect from "effect/Effect";
import { AcpRequestError } from "@specweave-studio/effect-acp/errors";
import type { AcpSessionRuntime, AcpSessionRuntimeStartResult } from "./AcpSessionRuntime.ts";

/**
 * Copilot CLI 1.0.95 advertises no model catalog over ACP yet still accepts
 * session/set_model, so a custom model ID is the only way to choose one. It
 * accepts any non-empty ID and reports no effective model; an ID the account
 * cannot use was served by its auto routing on the plan tested.
 */
const acceptsUnadvertisedSetModel = (started: AcpSessionRuntimeStartResult) =>
  started.initializeResult.agentInfo?.name === "Copilot";

/** Config options are live; legacy model metadata declares session/set_model support. */
export const applyAcpModelSelection = Effect.fn("applyAcpModelSelection")(function* (
  runtime: Pick<AcpSessionRuntime["Service"], "getConfigOptions" | "setModel" | "setSessionModel">,
  started: AcpSessionRuntimeStartResult,
  requestedModel: string,
) {
  const options = yield* runtime.getConfigOptions;
  if (options.some((option) => option.category === "model")) {
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
  if (options.some((option) => option.category === "model")) {
    return false;
  }
  yield* runtime.setSessionModel("auto");
  return true;
});
