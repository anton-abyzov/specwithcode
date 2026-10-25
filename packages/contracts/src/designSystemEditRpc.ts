import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { DesignError, DesignSystemAddress, DesignSystemGetResult } from "./design.ts";
import {
  DesignSystemApplyInput,
  DesignSystemCreateInput,
  DesignSystemFileDeleteInput,
  DesignSystemFileDeleteResult,
  DesignSystemFileMoveInput,
  DesignSystemFilePutInput,
  DesignSystemFilePutResult,
  DesignSystemFileReadInput,
  DesignSystemFileReadResult,
  DesignSystemFilesResult,
} from "./designSystemEdit.ts";

/** Gated by the `designSystemEditing` capability; older servers do not answer these. */
export const DESIGN_SYSTEM_EDIT_RPC_METHODS = {
  designSystemCreate: "designSystem.create",
  designSystemApply: "designSystem.apply",
  designSystemFiles: "designSystem.files",
  designSystemFileRead: "designSystem.fileRead",
  designSystemFilePut: "designSystem.filePut",
  designSystemFileDelete: "designSystem.fileDelete",
  designSystemFileMove: "designSystem.fileMove",
} as const;

const error = Schema.Union([DesignError, EnvironmentAuthorizationError]);

export const designSystemEditRpcs = [
  Rpc.make(DESIGN_SYSTEM_EDIT_RPC_METHODS.designSystemCreate, {
    payload: DesignSystemCreateInput,
    success: DesignSystemGetResult,
    error,
  }),
  Rpc.make(DESIGN_SYSTEM_EDIT_RPC_METHODS.designSystemApply, {
    payload: DesignSystemApplyInput,
    success: DesignSystemGetResult,
    error,
  }),
  Rpc.make(DESIGN_SYSTEM_EDIT_RPC_METHODS.designSystemFiles, {
    payload: DesignSystemAddress,
    success: DesignSystemFilesResult,
    error,
  }),
  Rpc.make(DESIGN_SYSTEM_EDIT_RPC_METHODS.designSystemFileRead, {
    payload: DesignSystemFileReadInput,
    success: DesignSystemFileReadResult,
    error,
  }),
  Rpc.make(DESIGN_SYSTEM_EDIT_RPC_METHODS.designSystemFilePut, {
    payload: DesignSystemFilePutInput,
    success: DesignSystemFilePutResult,
    error,
  }),
  Rpc.make(DESIGN_SYSTEM_EDIT_RPC_METHODS.designSystemFileDelete, {
    payload: DesignSystemFileDeleteInput,
    success: DesignSystemFileDeleteResult,
    error,
  }),
  Rpc.make(DESIGN_SYSTEM_EDIT_RPC_METHODS.designSystemFileMove, {
    payload: DesignSystemFileMoveInput,
    success: DesignSystemFilePutResult,
    error,
  }),
] as const;
