import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  ProjectFingerprintInput,
  ProjectFingerprintResult,
  ProjectLinkAcceptInput,
  ProjectLinkAcceptResult,
  ProjectLinkCommitInput,
  ProjectLinkCommitResult,
  ProjectLinkDigest,
  ProjectLinkDigestInput,
  ProjectLinkError,
  ProjectLinkPrepareInput,
  ProjectLinkPrepareResult,
  ProjectLinkPreview,
  ProjectLinkPreviewInput,
  ProjectLinkReplicateInput,
  ProjectLinkReplicateResult,
  ProjectSupersedeInput,
  ProjectSupersedeResult,
  ProjectTakeoverInput,
  ProjectTakeoverResult,
  ProjectUnlinkInput,
  ProjectUnlinkResult,
} from "./projectLink.ts";

export const PROJECT_LINK_RPC_METHODS = {
  projectsFingerprint: "projects.fingerprint",
  projectLinkPreview: "projectLink.preview",
  projectLinkPrepare: "projectLink.prepare",
  projectLinkAccept: "projectLink.accept",
  projectLinkCommit: "projectLink.commit",
  projectUnlink: "projectLink.unlink",
  projectLinkDigest: "projectLink.digest",
  projectLinkReplicate: "projectLink.replicate",
  projectTakeover: "projectLink.takeover",
  projectSupersede: "projectLink.supersede",
} as const;
const error = Schema.Union([ProjectLinkError, EnvironmentAuthorizationError]);
export const projectLinkRpcs = [
  Rpc.make(PROJECT_LINK_RPC_METHODS.projectsFingerprint, {
    payload: ProjectFingerprintInput,
    success: ProjectFingerprintResult,
    error,
  }),
  Rpc.make(PROJECT_LINK_RPC_METHODS.projectLinkPreview, {
    payload: ProjectLinkPreviewInput,
    success: ProjectLinkPreview,
    error,
  }),
  Rpc.make(PROJECT_LINK_RPC_METHODS.projectLinkPrepare, {
    payload: ProjectLinkPrepareInput,
    success: ProjectLinkPrepareResult,
    error,
  }),
  Rpc.make(PROJECT_LINK_RPC_METHODS.projectLinkAccept, {
    payload: ProjectLinkAcceptInput,
    success: ProjectLinkAcceptResult,
    error,
  }),
  Rpc.make(PROJECT_LINK_RPC_METHODS.projectLinkCommit, {
    payload: ProjectLinkCommitInput,
    success: ProjectLinkCommitResult,
    error,
  }),
  Rpc.make(PROJECT_LINK_RPC_METHODS.projectUnlink, {
    payload: ProjectUnlinkInput,
    success: ProjectUnlinkResult,
    error,
  }),
  Rpc.make(PROJECT_LINK_RPC_METHODS.projectLinkDigest, {
    payload: ProjectLinkDigestInput,
    success: ProjectLinkDigest,
    error,
  }),
  Rpc.make(PROJECT_LINK_RPC_METHODS.projectLinkReplicate, {
    payload: ProjectLinkReplicateInput,
    success: ProjectLinkReplicateResult,
    error,
  }),
  Rpc.make(PROJECT_LINK_RPC_METHODS.projectTakeover, {
    payload: ProjectTakeoverInput,
    success: ProjectTakeoverResult,
    error,
  }),
  Rpc.make(PROJECT_LINK_RPC_METHODS.projectSupersede, {
    payload: ProjectSupersedeInput,
    success: ProjectSupersedeResult,
    error,
  }),
] as const;
