import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  DesignAddress,
  DesignApplyInput,
  DesignAssetPutInput,
  DesignAssetPutResult,
  DesignCopyInput,
  DesignCreateInput,
  DesignDeleteInput,
  DesignDeleteResult,
  DesignError,
  DesignExportInput,
  DesignExportResult,
  DesignGetInput,
  DesignGetResult,
  DesignHistoryInput,
  DesignHistoryResult,
  DesignListInput,
  DesignListResult,
  DesignRestoreInput,
  DesignSaveVersionInput,
  DesignSystemAddress,
  DesignSystemCopyInput,
  DesignSystemDeleteInput,
  DesignSystemDeleteResult,
  DesignSystemGetResult,
  DesignSystemListInput,
  DesignSystemListResult,
  DesignSystemRenameInput,
  DesignSystemUsageInput,
  DesignSystemUsageResult,
} from "./design.ts";

export const DESIGN_RPC_METHODS = {
  designList: "design.list",
  designGet: "design.get",
  designCreate: "design.create",
  designApply: "design.apply",
  designHistory: "design.history",
  designSaveVersion: "design.saveVersion",
  designRestore: "design.restore",
  designCopy: "design.copy",
  designDelete: "design.delete",
  designAssetPut: "design.assetPut",
  designExport: "design.export",
  /** Streams the document each time its revision changes (agent or other client edits). */
  designWatch: "design.watch",
  designSystemList: "designSystem.list",
  designSystemGet: "designSystem.get",
  designSystemCopy: "designSystem.copy",
  designSystemRename: "designSystem.rename",
  /** Also discards open import proposals that would update the system. */
  designSystemDelete: "designSystem.delete",
  designSystemUsage: "designSystem.usage",
} as const;

const error = Schema.Union([DesignError, EnvironmentAuthorizationError]);

export const designRpcs = [
  Rpc.make(DESIGN_RPC_METHODS.designList, {
    payload: DesignListInput,
    success: DesignListResult,
    error,
  }),
  Rpc.make(DESIGN_RPC_METHODS.designGet, {
    payload: DesignGetInput,
    success: DesignGetResult,
    error,
  }),
  Rpc.make(DESIGN_RPC_METHODS.designCreate, {
    payload: DesignCreateInput,
    success: DesignGetResult,
    error,
  }),
  Rpc.make(DESIGN_RPC_METHODS.designApply, {
    payload: DesignApplyInput,
    success: DesignGetResult,
    error,
  }),
  Rpc.make(DESIGN_RPC_METHODS.designHistory, {
    payload: DesignHistoryInput,
    success: DesignHistoryResult,
    error,
  }),
  Rpc.make(DESIGN_RPC_METHODS.designSaveVersion, {
    payload: DesignSaveVersionInput,
    success: DesignHistoryResult,
    error,
  }),
  Rpc.make(DESIGN_RPC_METHODS.designRestore, {
    payload: DesignRestoreInput,
    success: DesignGetResult,
    error,
  }),
  Rpc.make(DESIGN_RPC_METHODS.designCopy, {
    payload: DesignCopyInput,
    success: DesignGetResult,
    error,
  }),
  Rpc.make(DESIGN_RPC_METHODS.designDelete, {
    payload: DesignDeleteInput,
    success: DesignDeleteResult,
    error,
  }),
  Rpc.make(DESIGN_RPC_METHODS.designAssetPut, {
    payload: DesignAssetPutInput,
    success: DesignAssetPutResult,
    error,
  }),
  Rpc.make(DESIGN_RPC_METHODS.designExport, {
    payload: DesignExportInput,
    success: DesignExportResult,
    error,
  }),
  Rpc.make(DESIGN_RPC_METHODS.designWatch, {
    payload: DesignAddress,
    success: DesignGetResult,
    error,
    stream: true,
  }),
  Rpc.make(DESIGN_RPC_METHODS.designSystemList, {
    payload: DesignSystemListInput,
    success: DesignSystemListResult,
    error,
  }),
  Rpc.make(DESIGN_RPC_METHODS.designSystemGet, {
    payload: DesignSystemAddress,
    success: DesignSystemGetResult,
    error,
  }),
  Rpc.make(DESIGN_RPC_METHODS.designSystemCopy, {
    payload: DesignSystemCopyInput,
    success: DesignSystemGetResult,
    error,
  }),
  Rpc.make(DESIGN_RPC_METHODS.designSystemRename, {
    payload: DesignSystemRenameInput,
    success: DesignSystemGetResult,
    error,
  }),
  Rpc.make(DESIGN_RPC_METHODS.designSystemDelete, {
    payload: DesignSystemDeleteInput,
    success: DesignSystemDeleteResult,
    error,
  }),
  Rpc.make(DESIGN_RPC_METHODS.designSystemUsage, {
    payload: DesignSystemUsageInput,
    success: DesignSystemUsageResult,
    error,
  }),
] as const;
