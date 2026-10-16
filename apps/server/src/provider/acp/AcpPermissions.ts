import type { RuntimeMode } from "@specweave-studio/contracts";
import type * as EffectAcpSchema from "@specweave-studio/effect-acp/compat";
import { AcpRequestError } from "@specweave-studio/effect-acp/errors";
import { isProviderAllowAllOption } from "@specweave-studio/shared/providerPermissions";
import * as Effect from "effect/Effect";
import type { AcpSessionRuntime } from "./AcpSessionRuntime.ts";

function permissionValue(option: EffectAcpSchema.SessionConfigOption, enabled: boolean) {
  if (option.type === "boolean") return enabled;
  const values = option.options.flatMap((entry) =>
    "value" in entry ? [entry.value] : entry.options.map((choice) => choice.value),
  );
  const allowed = enabled ? ["true", "on", "enabled"] : ["false", "off", "disabled"];
  return values.find((value) => allowed.includes(value.toLowerCase()));
}

/** Fail closed: a native approval override must never survive an access-mode change. */
export const synchronizeAcpPermissions = Effect.fn("synchronizeAcpPermissions")(function* (
  runtime: Pick<AcpSessionRuntime["Service"], "getConfigOptions" | "setConfigOption">,
  runtimeMode: RuntimeMode,
) {
  const options = (yield* runtime.getConfigOptions).filter((option) =>
    isProviderAllowAllOption(option.id),
  );
  for (const option of options) {
    const enabled = runtimeMode === "full-access";
    const value = permissionValue(option, enabled);
    const failure = (detail: string) =>
      new AcpRequestError({
        method: "session/set_config_option",
        code: -32602,
        errorMessage: `Cannot synchronize provider Allow All with SpecWithCode access mode (${runtimeMode}): ${detail}. Retry after checking the provider permission settings.`,
      });
    if (value === undefined) return yield* failure("unsupported permission values");
    if (option.currentValue === value) continue;
    yield* runtime.setConfigOption(option.id, value).pipe(
      Effect.catchTags({
        AcpRequestError: () => Effect.fail(failure("provider rejected the change")),
      }),
    );
    const effective = (yield* runtime.getConfigOptions).find((entry) => entry.id === option.id);
    if (effective?.currentValue !== value) {
      return yield* failure("provider did not confirm the requested value");
    }
  }
});
