import { WS_METHODS } from "@specweave-studio/contracts";
import type * as Crypto from "effect/Crypto";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentGuardedRpcQueryAtomFamily,
  createEnvironmentRpcCommand,
} from "./runtime.ts";

/**
 * Importing design systems: scans, proposals awaiting review and the Figma
 * desktop status. Only `confirm` writes a system; agents may propose too.
 * Reads need filesystem:read, so they go through the guarded query family;
 * the system list itself is `design.systemList`.
 */
export function createDesignSystemImportAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  return {
    proposals: createEnvironmentGuardedRpcQueryAtomFamily(runtime, {
      label: "design-system:proposals",
      tag: WS_METHODS.designSystemProposals,
      staleTimeMs: 2_000,
      idleTtlMs: 30_000,
    }),
    proposal: createEnvironmentGuardedRpcQueryAtomFamily(runtime, {
      label: "design-system:proposal",
      tag: WS_METHODS.designSystemProposal,
      staleTimeMs: 0,
      idleTtlMs: 30_000,
    }),
    figmaStatus: createEnvironmentGuardedRpcQueryAtomFamily(runtime, {
      label: "design-system:figma-status",
      tag: WS_METHODS.designSystemFigmaStatus,
      staleTimeMs: 0,
      idleTtlMs: 10_000,
    }),
    scan: createEnvironmentRpcCommand(runtime, {
      label: "design-system:scan",
      tag: WS_METHODS.designSystemScan,
    }),
    propose: createEnvironmentRpcCommand(runtime, {
      label: "design-system:propose",
      tag: WS_METHODS.designSystemPropose,
    }),
    confirm: createEnvironmentRpcCommand(runtime, {
      label: "design-system:confirm",
      tag: WS_METHODS.designSystemConfirm,
    }),
    discard: createEnvironmentRpcCommand(runtime, {
      label: "design-system:discard",
      tag: WS_METHODS.designSystemDiscard,
    }),
    rescan: createEnvironmentRpcCommand(runtime, {
      label: "design-system:rescan",
      tag: WS_METHODS.designSystemRescan,
    }),
  };
}
