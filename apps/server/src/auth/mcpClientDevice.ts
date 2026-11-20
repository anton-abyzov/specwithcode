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
 * The check `authenticateMcpClient` makes, read only: an MCP client is gated
 * by its binding or a turned-away key, and neither check writes. False when
 * it cannot tell.
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
