import { ManagedRelay } from "@specweave-studio/client-runtime/relay";
import {
  environmentEndpointUrl,
  executeAuthenticatedEnvironmentHttpRequest,
  RemoteEnvironmentAuthorization,
} from "@specweave-studio/client-runtime/studio";
import type { PreparedConnection } from "@specweave-studio/client-runtime/connection";
import { executeAtomQuery } from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentId } from "@specweave-studio/contracts";
import type {
  DeviceSignInApproveResult,
  DeviceSignInApprovedDevice,
  DeviceSignInPollResult,
  DeviceSignInStartResult,
} from "@specweave-studio/contracts/deviceSignIn";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "../connection/runtime";
import { PrimaryEnvironmentHttpClient } from "../environments/primary/httpClient";
import { runPrimaryHttp } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readPreparedConnection } from "../state/session";

/** "K7F3QX" reads more easily as "K7F-3QX" when two people compare it. */
export function formatDeviceSignInCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}

/** "Safari on iOS", falling back to the device type. */
export function describeSignInDevice(request: DeviceSignInApprovedDevice): string {
  const named = [request.browser, request.os].filter(Boolean).join(" on ");
  if (named) return named;
  return request.deviceType === "mobile"
    ? "A phone"
    : request.deviceType === "tablet"
      ? "A tablet"
      : "A computer";
}

/** Ask the server this page came from to let this browser in. */
export function startDeviceSignIn(): Promise<DeviceSignInStartResult> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.deviceSignIn.start({ payload: {} })),
    ),
  );
}

export function pollDeviceSignIn(
  request: Pick<DeviceSignInStartResult, "requestId" | "pollToken">,
): Promise<DeviceSignInPollResult> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.deviceSignIn.poll({
          payload: { requestId: request.requestId, pollToken: request.pollToken },
        }),
      ),
    ),
  );
}

export function approveDeviceSignIn(prepared: PreparedConnection, code: string, confirm: boolean) {
  return Effect.gen(function* () {
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared,
      signer,
      remoteAuthorization,
      group: "deviceSignIn",
      method: "POST",
      url: (base) => environmentEndpointUrl(base, "/api/auth/device-sign-in/approve"),
      timeoutMs: 15000,
      request: ({ client, headers }) => client.approve({ headers, payload: { code, confirm } }),
    });
  });
}

/** "Safari on iOS (100.64.0.7, asked 2 minutes ago)". */
export function describeWaitingDevice(
  device: DeviceSignInApprovedDevice,
  now = Date.now(),
): string {
  const details: Array<string> = [];
  if (device.address) details.push(device.address);
  const askedAt = device.askedAt ? Date.parse(device.askedAt) : Number.NaN;
  if (Number.isFinite(askedAt)) {
    const minutes = Math.max(0, Math.round((now - askedAt) / 60_000));
    details.push(
      minutes === 0
        ? "asked just now"
        : minutes === 1
          ? "asked 1 minute ago"
          : `asked ${minutes} minutes ago`,
    );
  }
  const name = describeSignInDevice(device);
  return details.length > 0 ? `${name} (${details.join(", ")})` : name;
}

/** True when a typed code has six of the characters codes are made of. */
export function isCompleteDeviceSignInCode(code: string): boolean {
  return /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/.test(code.replace(/[\s-]/g, "").toUpperCase());
}

/** Look up (confirm false) or approve (confirm true) the device showing this code. */
export async function submitDeviceSignInCode(
  environmentId: EnvironmentId,
  code: string,
  confirm: boolean,
): Promise<DeviceSignInApproveResult> {
  const prepared = readPreparedConnection(environmentId);
  if (!prepared) throw new Error("This machine is not connected.");
  const result = await executeAtomQuery(
    appAtomRegistry,
    connectionAtomRuntime.atom(approveDeviceSignIn(prepared, code, confirm)),
    { reportFailure: false, reportDefect: false },
  );
  if (result._tag === "Failure") throw new Error("Could not reach this machine. Try again.");
  return result.value;
}
