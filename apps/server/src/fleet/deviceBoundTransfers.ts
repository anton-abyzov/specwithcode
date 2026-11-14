/**
 * What a Connect device or linked phone asks this machine to mint (1327): a
 * folder-copy bearer, an asset or upload URL. Each carries the device's
 * binding on its own record, so Remove stops it and a damaged or repaired
 * device list refuses it instead of reading it as unbound.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ConnectDeviceTrust from "./ConnectDeviceTrust.ts";

/**
 * The approved device behind this call: its RPC connection's, else the MCP
 * client session's. An MCP client a device approved is that device's even
 * where no request context was passed down, so it is never read as exempt.
 */
export const currentRequestDevice: Effect.Effect<string | null> = Effect.gen(function* () {
  const device = yield* ConnectDeviceTrust.RequestDevice;
  if (device !== null) return device;
  const invocation = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
  return Option.isSome(invocation) ? (invocation.value.client?.deviceKey ?? null) : null;
});

/**
 * The binding a credential minted for this call must carry: undefined when no
 * device is behind it (this machine's own app, a worker), null when that
 * device is not approved here, so nothing may be minted.
 */
export const requestDeviceBinding = (
  trust: ConnectDeviceTrust.ConnectDeviceTrustShape,
): Effect.Effect<ConnectDeviceTrust.DeviceBinding | null | undefined> =>
  Effect.gen(function* () {
    const device = yield* currentRequestDevice;
    return device === null ? undefined : yield* trust.bindingFor(device);
  });

/**
 * For a URL signed for this call: the device's binding, or one that never
 * matches when that device is not approved, so the URL is dead on arrival.
 */
export const requestDeviceClaim = (
  trust: ConnectDeviceTrust.ConnectDeviceTrustShape,
): Effect.Effect<ConnectDeviceTrust.DeviceBinding | undefined> =>
  Effect.gen(function* () {
    const device = yield* currentRequestDevice;
    if (device === null) return undefined;
    return (yield* trust.bindingFor(device)) ?? { key: device, approval: "" };
  });

/** True when a credential carries a binding this machine no longer honours. */
export const bindingRefused = (
  trust: ConnectDeviceTrust.ConnectDeviceTrustShape,
  binding: ConnectDeviceTrust.DeviceBinding | undefined,
) =>
  binding === undefined
    ? Effect.succeed(false)
    : trust.checkBinding(binding).pipe(Effect.map((verdict) => verdict._tag === "refused"));

const OPERATION_PATH = /^\/([a-f0-9-]{36})\//;

/** True when the request names a copy whose device's approval no longer stands. */
export const transferRefusedForDevice = (
  trust: ConnectDeviceTrust.ConnectDeviceTrustShape,
  read: (
    operationId: string,
  ) => Promise<{ readonly device?: ConnectDeviceTrust.DeviceBinding } | null>,
  path: string,
) =>
  Effect.gen(function* () {
    const operationId = OPERATION_PATH.exec(path)?.[1];
    if (operationId === undefined) return false;
    const record = yield* Effect.promise(() => read(operationId).catch(() => null));
    return yield* bindingRefused(trust, record?.device);
  });
