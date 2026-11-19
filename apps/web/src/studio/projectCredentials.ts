import { createEnvironmentRpcCommand } from "@specweave-studio/client-runtime/state/runtime";
import {
  type EnvironmentId,
  PROJECT_CREDENTIALS_RPC_METHODS,
  type ProjectCredentialId,
  type ProjectId,
} from "@specweave-studio/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * The credentials a project uses: listed on the machine that has the project,
 * checked on the machine it is copied to. Names, commands and status words
 * only; no value, token or file content passes through here.
 */
export const projectCredentials = {
  scan: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-credentials:scan",
    tag: PROJECT_CREDENTIALS_RPC_METHODS.projectCredentialsScan,
  }),
  save: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-credentials:save",
    tag: PROJECT_CREDENTIALS_RPC_METHODS.projectCredentialsSave,
  }),
  probe: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-credentials:probe",
    tag: PROJECT_CREDENTIALS_RPC_METHODS.projectCredentialsProbe,
  }),
};

/**
 * The rows a person marked as not needed, per project. Kept while the app is
 * open, so the choice holds from the review to the Done screen of one copy
 * to one machine.
 * `null` until the person changes something: the saved list's skips apply.
 */
export const credentialSkipsAtom = Atom.family(
  // Per destination too: what one machine does not need, another may.
  (_key: `${EnvironmentId}:${ProjectId}:${EnvironmentId}`) =>
    Atom.make<ReadonlyArray<ProjectCredentialId> | null>(null).pipe(Atom.keepAlive),
);
