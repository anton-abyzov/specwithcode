import { createEnvironmentRpcCommand } from "@specweave-studio/client-runtime/state/runtime";
import { GITHUB_SIGN_IN_RPC_METHODS } from "@specweave-studio/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/** Signing a machine's gh in runs on that machine; these only start, read and stop it. */
export const gitHubSignIn = {
  start: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "github-sign-in:start",
    tag: GITHUB_SIGN_IN_RPC_METHODS.gitHubSignInStart,
  }),
  status: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "github-sign-in:status",
    tag: GITHUB_SIGN_IN_RPC_METHODS.gitHubSignInStatus,
  }),
  cancel: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "github-sign-in:cancel",
    tag: GITHUB_SIGN_IN_RPC_METHODS.gitHubSignInCancel,
  }),
};
