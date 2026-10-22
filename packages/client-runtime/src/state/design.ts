import { WS_METHODS } from "@specweave-studio/contracts";
import type * as Crypto from "effect/Crypto";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentGuardedRpcQueryAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Designs, slides and design systems of one environment. Reads never start a
 * worker; they need filesystem:read, so they go through the guarded query family.
 */
export function createDesignAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  return {
    list: createEnvironmentGuardedRpcQueryAtomFamily(runtime, {
      label: "design:list",
      tag: WS_METHODS.designList,
      staleTimeMs: 5_000,
      idleTtlMs: 30_000,
    }),
    get: createEnvironmentGuardedRpcQueryAtomFamily(runtime, {
      label: "design:get",
      tag: WS_METHODS.designGet,
      staleTimeMs: 0,
      idleTtlMs: 30_000,
    }),
    /** The live document: a new value each time its revision changes on disk. */
    watch: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "design:watch",
      tag: WS_METHODS.designWatch,
      idleTtlMs: 10_000,
    }),
    history: createEnvironmentGuardedRpcQueryAtomFamily(runtime, {
      label: "design:history",
      tag: WS_METHODS.designHistory,
      staleTimeMs: 0,
      idleTtlMs: 30_000,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "design:create",
      tag: WS_METHODS.designCreate,
    }),
    apply: createEnvironmentRpcCommand(runtime, {
      label: "design:apply",
      tag: WS_METHODS.designApply,
    }),
    saveVersion: createEnvironmentRpcCommand(runtime, {
      label: "design:save-version",
      tag: WS_METHODS.designSaveVersion,
    }),
    restore: createEnvironmentRpcCommand(runtime, {
      label: "design:restore",
      tag: WS_METHODS.designRestore,
    }),
    copy: createEnvironmentRpcCommand(runtime, {
      label: "design:copy",
      tag: WS_METHODS.designCopy,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "design:delete",
      tag: WS_METHODS.designDelete,
    }),
    assetPut: createEnvironmentRpcCommand(runtime, {
      label: "design:asset-put",
      tag: WS_METHODS.designAssetPut,
    }),
    exportFile: createEnvironmentRpcCommand(runtime, {
      label: "design:export",
      tag: WS_METHODS.designExport,
    }),
    systemList: createEnvironmentGuardedRpcQueryAtomFamily(runtime, {
      label: "design-system:list",
      tag: WS_METHODS.designSystemList,
      staleTimeMs: 5_000,
      idleTtlMs: 30_000,
    }),
    systemGet: createEnvironmentGuardedRpcQueryAtomFamily(runtime, {
      label: "design-system:get",
      tag: WS_METHODS.designSystemGet,
      staleTimeMs: 5_000,
      idleTtlMs: 30_000,
    }),
    systemCopy: createEnvironmentRpcCommand(runtime, {
      label: "design-system:copy",
      tag: WS_METHODS.designSystemCopy,
    }),
    /** A new name at `expectedRevision`; `conflict` carries the current revision. */
    systemRename: createEnvironmentRpcCommand(runtime, {
      label: "design-system:rename",
      tag: WS_METHODS.designSystemRename,
    }),
    /** Removes the system and its open import proposals; designs keep the id and render without it. */
    systemDelete: createEnvironmentRpcCommand(runtime, {
      label: "design-system:delete",
      tag: WS_METHODS.designSystemDelete,
    }),
    /** `{ designs }`: how many designs of the owner use the system, to warn before a delete. */
    systemUsage: createEnvironmentGuardedRpcQueryAtomFamily(runtime, {
      label: "design-system:usage",
      tag: WS_METHODS.designSystemUsage,
      staleTimeMs: 0,
      idleTtlMs: 30_000,
    }),
  };
}
