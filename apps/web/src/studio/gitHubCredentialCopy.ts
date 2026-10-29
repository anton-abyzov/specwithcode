import { createEnvironmentRpcCommand } from "@specweave-studio/client-runtime/state/runtime";
import { GITHUB_CREDENTIAL_RPC_METHODS } from "@specweave-studio/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * A machine's GitHub access, and copying another machine's sign-in into it. The copy
 * runs between the two servers; these calls never carry a token.
 */
export const gitHubCredential = {
  state: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "github-credential:state",
    tag: GITHUB_CREDENTIAL_RPC_METHODS.gitHubCredentialState,
  }),
  removeCopied: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "github-credential:remove-copied",
    tag: GITHUB_CREDENTIAL_RPC_METHODS.gitHubCredentialRemoveCopied,
  }),
  copyPreview: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "github-credential:copy-preview",
    tag: GITHUB_CREDENTIAL_RPC_METHODS.gitHubCredentialCopyPreview,
  }),
  copy: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "github-credential:copy",
    tag: GITHUB_CREDENTIAL_RPC_METHODS.gitHubCredentialCopy,
  }),
};
