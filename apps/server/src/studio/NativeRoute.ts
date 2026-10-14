import type { CodexSettings, ProviderInstanceConfig } from "@specweave-studio/contracts";
import { CodexSettings as CodexSettingsSchema } from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import { CodexNativeRouteCheckError, probeCodexNativeRoute } from "../provider/CodexProvider.ts";
import { resolveCodexLaunchArgs } from "../provider/codexLaunchArgs.ts";
import { mergeNativeSubscriptionEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { expandHomePath } from "../pathExpansion.ts";

/** External native metadata boundary, separately replaceable in offline tests. */
export class NativeRoute extends Context.Service<NativeRoute, {
  readonly verify: (entry: ProviderInstanceConfig, cwd: string | null, baseEnv: NodeJS.ProcessEnv) => Effect.Effect<boolean, CodexNativeRouteCheckError>;
}>()("specweave-studio/studio/NativeRoute") {}
export const layer = Layer.effect(NativeRoute, Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return NativeRoute.of({ verify: (entry, cwd, baseEnv) => {
    const decoded = Schema.decodeUnknownOption(CodexSettingsSchema)(entry.config ?? {});
    if (Option.isNone(decoded)) return Effect.fail(new CodexNativeRouteCheckError({ reason: "unavailable" }));
    const config: CodexSettings = decoded.value;
    const environment = mergeNativeSubscriptionEnvironment(entry.environment, baseEnv, "codex");
    return probeCodexNativeRoute({ binaryPath: expandHomePath(config.binaryPath),
      homePath: config.shadowHomePath || config.homePath,
      launchArgs: resolveCodexLaunchArgs(config.launchArgs, environment),
      // Native adapter resolves a missing cwd to this same process directory.
      cwd: cwd ?? process.cwd(), environment }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
  } });
}));
