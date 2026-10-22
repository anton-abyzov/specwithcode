import * as Schema from "effect/Schema";
import {
  MACHINE_HANDOFF_MAX_BYTES,
  MachineHandoffBundle,
  MachineHandoffError,
  type MachineHandoffContext,
  type MachineHandoffPreviewMetadata,
} from "@specweave-studio/contracts";
import { stringifyJson } from "../json.ts";
import { sha256 } from "../nodeCrypto.ts";

export function previewMetadata(bundle: MachineHandoffBundle): MachineHandoffPreviewMetadata {
  const {
    manifest,
    sourceEnvironmentId,
    sourceProjectId,
    sourceThreadId,
    digest,
    logicalProject,
    coordinatorBinding,
    destination,
  } = bundle;
  return {
    manifest,
    sourceEnvironmentId,
    sourceProjectId,
    sourceThreadId,
    digest,
    ...(logicalProject ? { logicalProject } : {}),
    ...(coordinatorBinding ? { coordinatorBinding } : {}),
    ...(destination ? { destination } : {}),
  };
}

/** Stable digest over the exact retained data, independent of object key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${stringifyJson(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function machineHandoffDigest(value: Omit<MachineHandoffBundle, "digest">): string {
  return sha256([canonical(value)], "hex");
}
/** A preview saved before bundles carried the mode still matches the same source. */
export function comparableContext(
  retained: MachineHandoffContext,
  saved: MachineHandoffContext,
): MachineHandoffContext {
  if (saved.runtimeMode !== undefined) return retained;
  const { runtimeMode: _runtimeMode, ...rest } = retained;
  return rest;
}
const isMachineHandoffBundle = Schema.is(MachineHandoffBundle);
export function checkBundle(bundle: MachineHandoffBundle): void {
  if (!isMachineHandoffBundle(bundle)) throw new MachineHandoffError({ code: "invalid" });
  const { digest, ...content } = bundle;
  if (machineHandoffDigest(content) !== digest) throw new MachineHandoffError({ code: "invalid" });
  if (Buffer.byteLength(stringifyJson(bundle)) > MACHINE_HANDOFF_MAX_BYTES)
    throw new MachineHandoffError({ code: "too_large" });
}
