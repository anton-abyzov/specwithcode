import * as Schema from "effect/Schema";

import {
  AuthSessionId,
  EnvironmentId,
  RpcClientId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const BackgroundBooleanState = Schema.Literals(["true", "false", "unknown"]);
export type BackgroundBooleanState = typeof BackgroundBooleanState.Type;

export const HostPowerThermalState = Schema.Literals([
  "unknown",
  "nominal",
  "fair",
  "serious",
  "critical",
]);
export type HostPowerThermalState = typeof HostPowerThermalState.Type;

export const HostPowerSource = Schema.Literals([
  "unknown",
  "node-macos-shell",
  "node-macos-native",
  "node-linux",
  "node-windows",
  "electron-main",
]);
export type HostPowerSource = typeof HostPowerSource.Type;

export const HostPowerSnapshot = Schema.Struct({
  source: HostPowerSource,
  idle: BackgroundBooleanState,
  idleSeconds: Schema.NullOr(Schema.Number),
  locked: BackgroundBooleanState,
  suspended: Schema.Boolean,
  onBattery: BackgroundBooleanState,
  lowPowerMode: BackgroundBooleanState,
  thermalState: HostPowerThermalState,
  stale: Schema.Boolean,
  updatedAt: Schema.DateTimeUtc,
});
export type HostPowerSnapshot = typeof HostPowerSnapshot.Type;

export const BackgroundScope = Schema.Union([
  Schema.Struct({ type: Schema.Literal("server-config") }),
  Schema.Struct({
    type: Schema.Literal("provider-status"),
    instanceId: Schema.optionalKey(ProviderInstanceId),
  }),
  Schema.Struct({ type: Schema.Literal("vcs-status"), cwd: Schema.String }),
  Schema.Struct({ type: Schema.Literal("git-refs"), cwd: Schema.String }),
  Schema.Struct({ type: Schema.Literal("diagnostics") }),
  Schema.Struct({ type: Schema.Literal("thread"), threadId: ThreadId }),
]);
export type BackgroundScope = typeof BackgroundScope.Type;

export const ClientKind = Schema.Literals(["web", "desktop-renderer", "mobile", "unknown"]);
export type ClientKind = typeof ClientKind.Type;

export const ClientActivityClientId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ClientActivityClientId = typeof ClientActivityClientId.Type;

export const ClientActivityReportInput = Schema.Struct({
  environmentId: Schema.optionalKey(EnvironmentId),
  clientId: ClientActivityClientId,
  clientKind: ClientKind,
  visible: Schema.Boolean,
  focused: Schema.Boolean,
  recentlyInteracted: Schema.Boolean,
  appState: Schema.optionalKey(Schema.Literals(["active", "inactive", "background", "unknown"])),
  lowPowerMode: Schema.optionalKey(BackgroundBooleanState),
  batteryState: Schema.optionalKey(Schema.Literals(["unknown", "unplugged", "charging", "full"])),
  networkType: Schema.optionalKey(Schema.String),
  scopes: Schema.Array(BackgroundScope),
  ttlMs: Schema.optionalKey(Schema.Number),
  observedAt: Schema.DateTimeUtc,
  /** The last pointer, key, wheel or touch event; for a phone, the last time the app was active. */
  lastInteractionAt: Schema.optionalKey(Schema.DateTimeUtc),
  /** The reporting app's own machine, when it has one. Older clients omit it. */
  hostEnvironmentId: Schema.optionalKey(EnvironmentId),
});
export type ClientActivityReportInput = typeof ClientActivityReportInput.Type;

export const ClientActivityLease = Schema.Struct({
  sessionId: AuthSessionId,
  rpcClientId: RpcClientId,
  clientId: ClientActivityClientId,
  clientKind: ClientKind,
  visible: Schema.Boolean,
  focused: Schema.Boolean,
  recentlyInteracted: Schema.Boolean,
  appState: Schema.optionalKey(Schema.Literals(["active", "inactive", "background", "unknown"])),
  lowPowerMode: Schema.optionalKey(BackgroundBooleanState),
  batteryState: Schema.optionalKey(Schema.Literals(["unknown", "unplugged", "charging", "full"])),
  networkType: Schema.optionalKey(Schema.String),
  scopes: Schema.Array(BackgroundScope),
  lastInteractionAt: Schema.optionalKey(Schema.DateTimeUtc),
  hostEnvironmentId: Schema.optionalKey(EnvironmentId),
  updatedAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
});
export type ClientActivityLease = typeof ClientActivityLease.Type;

/**
 * Why a client is the one that shows this server's desktop notifications.
 * foreground: a desktop or web app in use now. phone: a phone in use now, so
 * no desktop pops up (the phone gets its push). recent: the desktop or web app
 * used last. owner: the app on this server's own machine.
 */
export const NotificationTargetReason = Schema.Literals(["foreground", "phone", "recent", "owner"]);
export type NotificationTargetReason = typeof NotificationTargetReason.Type;

export const NotificationTarget = Schema.Struct({
  clientId: ClientActivityClientId,
  reason: NotificationTargetReason,
});
export type NotificationTarget = typeof NotificationTarget.Type;

export const BackgroundPolicySnapshot = Schema.Struct({
  hostPower: HostPowerSnapshot,
  leases: Schema.Array(ClientActivityLease),
  activeForegroundLeaseCount: Schema.Number,
  activeScopeKeys: Schema.Array(Schema.String),
  shouldRunOpportunisticWork: Schema.Boolean,
  updatedAt: Schema.DateTimeUtc,
  /**
   * The one client that shows desktop notifications for this server's threads.
   * Null when no client qualifies; absent from older servers.
   */
  notificationTarget: Schema.optionalKey(Schema.NullOr(NotificationTarget)),
});
export type BackgroundPolicySnapshot = typeof BackgroundPolicySnapshot.Type;
