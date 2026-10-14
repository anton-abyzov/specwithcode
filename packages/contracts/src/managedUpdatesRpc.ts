import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  ManagedUpdateEnrollment,
  ManagedUpdateError,
  ManagedUpdateMutation,
  ManagedUpdateStatus,
  ManagedUpdateTarget,
} from "./managedUpdates.ts";

export const MANAGED_UPDATES_RPC_METHODS = {
  managedUpdatesStatus: "managedUpdates.status",
  managedUpdatesEnroll: "managedUpdates.enroll",
  managedUpdatesRevoke: "managedUpdates.revoke",
  managedUpdatesCheck: "managedUpdates.check",
} as const;
const error = Schema.Union([ManagedUpdateError, EnvironmentAuthorizationError]);
export const managedUpdatesRpcs = [
  Rpc.make(MANAGED_UPDATES_RPC_METHODS.managedUpdatesStatus, {
    payload: Schema.Struct({}),
    success: ManagedUpdateStatus,
    error,
  }),
  Rpc.make(MANAGED_UPDATES_RPC_METHODS.managedUpdatesEnroll, {
    payload: ManagedUpdateEnrollment,
    success: ManagedUpdateStatus,
    error,
  }),
  Rpc.make(MANAGED_UPDATES_RPC_METHODS.managedUpdatesRevoke, {
    payload: ManagedUpdateMutation,
    success: ManagedUpdateStatus,
    error,
  }),
  Rpc.make(MANAGED_UPDATES_RPC_METHODS.managedUpdatesCheck, {
    payload: ManagedUpdateTarget,
    success: ManagedUpdateStatus,
    error,
  }),
] as const;

import {
  ServerPrepareServiceUpdateError,
  ServerPrepareServiceUpdateInput,
  ServerPrepareServiceUpdateResult,
} from "./serviceUpdatePreparation.ts";
import {
  DesktopUpdateCommitInput,
  ServerSelfUpdateError,
  ServerSelfUpdateInput,
  ServerSelfUpdateProgressEvent,
  ServerSelfUpdateResult,
} from "./server.ts";
const WsServerPrepareServiceUpdateRpc = Rpc.make("server.prepareServiceUpdate", {
  payload: ServerPrepareServiceUpdateInput,
  success: ServerPrepareServiceUpdateResult,
  error: Schema.Union([ServerPrepareServiceUpdateError, EnvironmentAuthorizationError]),
});

const WsServerUpdateServerRpc = Rpc.make("server.updateServer", {
  payload: ServerSelfUpdateInput,
  success: ServerSelfUpdateResult,
  error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
});

const WsServerUpdateServerWithProgressRpc = Rpc.make("server.updateServerWithProgress", {
  payload: ServerSelfUpdateInput,
  success: ServerSelfUpdateProgressEvent,
  error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsServerCommitDesktopUpdateRpc = Rpc.make("server.commitDesktopUpdate", {
  payload: DesktopUpdateCommitInput,
  success: ServerSelfUpdateResult,
  error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
});
export const legacyServerUpdateRpcs = [
  WsServerPrepareServiceUpdateRpc,
  WsServerUpdateServerRpc,
  WsServerUpdateServerWithProgressRpc,
  WsServerCommitDesktopUpdateRpc,
] as const;
