import type { OrchestratorMcpMachinePlatform } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { IosSimulatorSupport } from "../device/iosSimulatorSupport.ts";
import { XcodeBuildSupport } from "../device/xcodeBuildSupport.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { localMachinePlatform } from "./launchNeeds.ts";

/**
 * What this machine reports about itself to the others and to its agents:
 * its operating system and whether iOS Simulators and full Xcode builds run
 * here. Undefined without a server environment; never waits for either check.
 */
export const thisMachinePlatform: Effect.Effect<OrchestratorMcpMachinePlatform | undefined> =
  Effect.gen(function* () {
    const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
    if (Option.isNone(environment)) return undefined;
    const descriptor = yield* environment.value.getDescriptor;
    // Test servers may describe themselves without a platform.
    if (descriptor.platform === undefined) return undefined;
    if (descriptor.platform.os !== "darwin")
      return localMachinePlatform(descriptor.platform, false, false);
    const simulators = yield* IosSimulatorSupport;
    const xcode = yield* XcodeBuildSupport;
    return localMachinePlatform(descriptor.platform, simulators.current(), xcode.current());
  });
