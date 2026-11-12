/**
 * What a probe of another machine reads from its `orchestrator_capabilities`
 * besides providers, and what this machine adds about itself to a machine
 * list. Kept apart from RemoteWorkers so placement facts grow here.
 */
import type { OrchestratorMcpMachinePlatform } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import { readMachinePlatform } from "./launchNeeds.ts";
import { thisMachinePlatform } from "./thisMachinePlatform.ts";

export type GrantProjectScope = "all" | "linked" | "listed";

export interface MachineProbeFacts {
  /** Which projects the grant there covers; absent from machines older than this field. */
  readonly projectScope?: GrantProjectScope | undefined;
  /** Its operating system and iOS Simulator support; absent from machines older than this field. */
  readonly platform?: OrchestratorMcpMachinePlatform | undefined;
}

const readProjectScope = (capabilities: unknown): GrantProjectScope | undefined => {
  const scope =
    typeof capabilities === "object" && capabilities !== null && !Array.isArray(capabilities)
      ? (capabilities as { readonly grantProjects?: unknown }).grantProjects
      : undefined;
  return scope === "all" || scope === "linked" || scope === "listed" ? scope : undefined;
};

export const readMachineProbeFacts = (capabilities: unknown): MachineProbeFacts => ({
  projectScope: readProjectScope(capabilities),
  platform: readMachinePlatform(capabilities),
});

/** This machine's row in a machine list, with its own platform when it knows it. */
export const withThisMachinePlatform = <A extends object>(local: A) =>
  Effect.map(thisMachinePlatform, (platform) =>
    platform === undefined ? local : { ...local, platform },
  );
