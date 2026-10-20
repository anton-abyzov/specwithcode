import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  LinkedMemoryExport,
  LinkedMemoryExportInput,
  LinkedMemoryMergeInput,
  LinkedMemoryMergeResult,
} from "./linkedMemory.ts";
import { ProjectLinkError } from "./projectLink.ts";

/** Served with the other `projectLink.*` methods (see `WsProjectLinkRpcGroup`). */
export const LINKED_MEMORY_RPC_METHODS = {
  projectLinkMemoryExport: "projectLink.memoryExport",
  projectLinkMemoryMerge: "projectLink.memoryMerge",
} as const;
const error = Schema.Union([ProjectLinkError, EnvironmentAuthorizationError]);
export const linkedMemoryRpcs = [
  Rpc.make(LINKED_MEMORY_RPC_METHODS.projectLinkMemoryExport, {
    payload: LinkedMemoryExportInput,
    success: LinkedMemoryExport,
    error,
  }),
  Rpc.make(LINKED_MEMORY_RPC_METHODS.projectLinkMemoryMerge, {
    payload: LinkedMemoryMergeInput,
    success: LinkedMemoryMergeResult,
    error,
  }),
] as const;
