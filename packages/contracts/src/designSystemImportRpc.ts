import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { DesignError, DesignSystemGetResult } from "./design.ts";
import {
  DesignSystemConfirmInput,
  DesignSystemDiscardResult,
  DesignSystemProposal,
  DesignSystemProposalAddress,
  DesignSystemProposalsInput,
  DesignSystemProposalsResult,
  DesignSystemProposeInput,
  DesignSystemRescanInput,
  DesignSystemRescanResult,
  DesignSystemScanInput,
  DesignSystemScanResult,
  FigmaDesktopStatus,
} from "./designSystemImport.ts";

export const DESIGN_SYSTEM_IMPORT_RPC_METHODS = {
  designSystemScan: "designSystem.scan",
  designSystemPropose: "designSystem.propose",
  designSystemProposals: "designSystem.proposals",
  designSystemProposal: "designSystem.proposal",
  designSystemConfirm: "designSystem.confirm",
  designSystemDiscard: "designSystem.discard",
  designSystemRescan: "designSystem.rescan",
  designSystemFigmaStatus: "designSystem.figmaStatus",
} as const;

const error = Schema.Union([DesignError, EnvironmentAuthorizationError]);

export const designSystemImportRpcs = [
  Rpc.make(DESIGN_SYSTEM_IMPORT_RPC_METHODS.designSystemScan, {
    payload: DesignSystemScanInput,
    success: DesignSystemScanResult,
    error,
  }),
  Rpc.make(DESIGN_SYSTEM_IMPORT_RPC_METHODS.designSystemPropose, {
    payload: DesignSystemProposeInput,
    success: DesignSystemProposal,
    error,
  }),
  Rpc.make(DESIGN_SYSTEM_IMPORT_RPC_METHODS.designSystemProposals, {
    payload: DesignSystemProposalsInput,
    success: DesignSystemProposalsResult,
    error,
  }),
  Rpc.make(DESIGN_SYSTEM_IMPORT_RPC_METHODS.designSystemProposal, {
    payload: DesignSystemProposalAddress,
    success: DesignSystemProposal,
    error,
  }),
  Rpc.make(DESIGN_SYSTEM_IMPORT_RPC_METHODS.designSystemConfirm, {
    payload: DesignSystemConfirmInput,
    success: DesignSystemGetResult,
    error,
  }),
  Rpc.make(DESIGN_SYSTEM_IMPORT_RPC_METHODS.designSystemDiscard, {
    payload: DesignSystemProposalAddress,
    success: DesignSystemDiscardResult,
    error,
  }),
  Rpc.make(DESIGN_SYSTEM_IMPORT_RPC_METHODS.designSystemRescan, {
    payload: DesignSystemRescanInput,
    success: DesignSystemRescanResult,
    error,
  }),
  Rpc.make(DESIGN_SYSTEM_IMPORT_RPC_METHODS.designSystemFigmaStatus, {
    payload: Schema.Struct({}),
    success: FigmaDesktopStatus,
    error,
  }),
] as const;
