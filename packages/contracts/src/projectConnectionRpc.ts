import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { EnvironmentAuthorizationError } from "./auth.ts";

import {
  ProjectConnectionError,
  ProjectConnectionsReadInput,
  ProjectConnectionsReadResult,
  ProjectConnectionSaveInput,
  ProjectConnectionActionInput,
  ProjectConnection,
} from "./projectConnections.ts";
export const PROJECT_CONNECTION_RPC_METHODS = {
  projectsConnectionsRead: "projects.connectionsRead",
  projectsConnectionSave: "projects.connectionSave",
  projectsConnectionCheck: "projects.connectionCheck",
  projectsConnectionRevoke: "projects.connectionRevoke",
} as const;
const error = Schema.Union([ProjectConnectionError, EnvironmentAuthorizationError]);
export const projectConnectionRpcs = [
  Rpc.make(PROJECT_CONNECTION_RPC_METHODS.projectsConnectionsRead, {
    payload: ProjectConnectionsReadInput,
    success: ProjectConnectionsReadResult,
    error,
  }),
  Rpc.make(PROJECT_CONNECTION_RPC_METHODS.projectsConnectionSave, {
    payload: ProjectConnectionSaveInput,
    success: ProjectConnection,
    error,
  }),
  Rpc.make(PROJECT_CONNECTION_RPC_METHODS.projectsConnectionCheck, {
    payload: ProjectConnectionActionInput,
    success: ProjectConnection,
    error,
  }),
  Rpc.make(PROJECT_CONNECTION_RPC_METHODS.projectsConnectionRevoke, {
    payload: ProjectConnectionActionInput,
    success: ProjectConnection,
    error,
  }),
] as const;
