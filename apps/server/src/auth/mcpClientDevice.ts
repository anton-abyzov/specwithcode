/**
 * An MCP client credential's device facts, kept so a later check can ask
 * again whether its device approval stands (1327, 1427).
 *
 * @module mcpClientDevice
 */
import * as Effect from "effect/Effect";

import type * as ConnectDeviceTrust from "../fleet/ConnectDeviceTrust.ts";

/** Its proof key and the binding in its signed claims. */
export interface McpClientDevice {
  readonly proofKeyThumbprint?: string;
  readonly boundDevice?: { readonly key: string; readonly approval: string };
}

export const mcpClientDeviceOf = (session: {
  readonly proofKeyThumbprint?: string | undefined;
  readonly boundDevice?: { readonly key: string; readonly approval: string } | undefined;
}): McpClientDevice => ({
  ...(session.proofKeyThumbprint ? { proofKeyThumbprint: session.proofKeyThumbprint } : {}),
  ...(session.boundDevice === undefined
    ? {}
    : { boundDevice: { key: session.boundDevice.key, approval: session.boundDevice.approval } }),
});

/**
 * The check `authenticateMcpClient` makes, read only. False when that check
 * refuses or fails. A proof key with no device binding still reads as
 * standing when the device list cannot be read, because the check treats an
 * unreadable list as not turned away. An unbound bearer, with no proof key
 * and no binding, stands when the check allows it.
 */
export const mcpClientDeviceStands = (
  trust: ConnectDeviceTrust.ConnectDeviceTrustShape,
  subject: string,
  device: McpClientDevice,
) =>
  trust.check({ subject, ...device }).pipe(
    Effect.map((verdict) => verdict._tag === "allowed"),
    Effect.catchCause(() => Effect.succeed(false)),
  );
