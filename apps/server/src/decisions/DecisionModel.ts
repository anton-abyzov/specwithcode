import {
  teamRulesHoldRefusal,
  teamRulesSelectionRefusal,
} from "@specweave-studio/shared/teamRules";
import { currentTeamRules } from "../teamRules/TeamRules.ts";
import { DEFAULT_SERVER_SETTINGS, type DecisionModelSettings } from "@specweave-studio/contracts";
import type { DecisionRequest, DecisionResponse } from "@specweave-studio/shared/decisionModel";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import { JEV_DEFAULT_MODELS, type JevConfig, requestJevDecision } from "./jevClient.ts";

/** A worker's launch waits at most this long for a routing answer. */
export const ROUTING_DECISION_TIMEOUT_MS = 2_000;
/** A question the coordinator asks outright may take longer. */
export const ASKED_DECISION_TIMEOUT_MS = 10_000;

export class DecisionModelError extends Data.TaggedError("DecisionModelError")<{
  /** `off`: no decision model is set up; `failed`: the request did not produce an answer. */
  readonly kind: "off" | "failed";
  readonly message: string;
}> {}

/** The Jev settings to call with, or null when the decision model is off or has no key. */
export function jevConfigFromSettings(settings: DecisionModelSettings): JevConfig | null {
  if (settings.provider === "off") return null;
  const apiKey = settings.apiKey.trim();
  if (apiKey.length === 0) return null;
  return {
    provider: settings.provider,
    apiKey,
    model: settings.model.trim() || JEV_DEFAULT_MODELS[settings.provider],
  };
}

/**
 * Asks the decision model `request`. Reads the key from the server's settings
 * (the secret store) here; it never leaves the server. Fails with `off` when
 * no decision model is set up, so a caller that only uses it when available
 * can tell that apart from a failed call.
 */
export const askDecisionModel = Effect.fn("decisions.ask")(function* (
  request: DecisionRequest,
  options: {
    readonly timeoutMs: number;
    readonly send?: typeof fetch;
    /** The settings service a long-lived caller captured; else the current context's. */
    readonly settings?: Option.Option<ServerSettings.ServerSettingsService["Service"]>;
  },
) {
  const service =
    options.settings !== undefined && Option.isSome(options.settings)
      ? options.settings
      : yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const settings = Option.isSome(service)
    ? yield* service.value.getSettings.pipe(
        // No cause: a settings decode error can quote a hand-edited key.
        Effect.mapError(
          () => new DecisionModelError({ kind: "failed", message: "Could not read settings." }),
        ),
      )
    : DEFAULT_SERVER_SETTINGS;
  const config = jevConfigFromSettings(settings.decisionModel);
  // A hosted router is a provider like any other, so it must be on the list.
  const rules = yield* currentTeamRules;
  const teamRulesRefusal =
    config === null
      ? null
      : (teamRulesHoldRefusal(rules) ??
        teamRulesSelectionRefusal(rules, {
          driver: settings.decisionModel.provider,
          // Left empty, the router's default model is on the rules' list or nothing is.
          model: settings.decisionModel.model,
        }));
  if (teamRulesRefusal !== null) {
    return yield* new DecisionModelError({ kind: "off", message: teamRulesRefusal.message });
  }
  if (config === null)
    return yield* new DecisionModelError({
      kind: "off",
      message:
        "No decision model is set up. Choose OpenRouter or TypeSafe and add its API key in Settings > Providers > Decision model.",
    });
  return yield* Effect.tryPromise({
    try: (signal): Promise<DecisionResponse> =>
      requestJevDecision(
        config,
        request,
        { signal, timeoutMs: options.timeoutMs },
        options.send ?? fetch,
      ),
    catch: (cause) =>
      new DecisionModelError({
        kind: "failed",
        message: cause instanceof Error && cause.message ? cause.message : "Jev did not answer.",
      }),
  });
});
