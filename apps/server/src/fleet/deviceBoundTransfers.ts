/**
 * Folder-copy bearers a Connect device or linked phone asked for (1327): bound
 * to that device's approval, so Remove stops a bearer it kept.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import * as ConnectDeviceTrust from "./ConnectDeviceTrust.ts";
import { TRANSFER_GRANT_MAX_MS } from "./folderTransfer/transferGrant.ts";

/**
 * Binds the offer to the device behind this request, if any. False when that
 * device is not approved here; the caller then withdraws the offer.
 */
export const bindOfferToRequestDevice = (
  trust: ConnectDeviceTrust.ConnectDeviceTrustShape,
  operationId: string,
) =>
  Effect.gen(function* () {
    const device = yield* ConnectDeviceTrust.RequestDevice;
    if (device === null) return true;
    return yield* trust
      .bindCredential({
        id: ConnectDeviceTrust.transferBindingId(operationId),
        key: device,
        expiresAtMillis: (yield* Clock.currentTimeMillis) + TRANSFER_GRANT_MAX_MS,
      })
      .pipe(Effect.orElseSucceed(() => false));
  });

const OPERATION_PATH = /^\/([a-f0-9-]{36})\//;

/** True when the request names a copy whose device is no longer approved. */
export const transferRefusedForDevice = (
  trust: ConnectDeviceTrust.ConnectDeviceTrustShape,
  path: string,
) =>
  Effect.gen(function* () {
    const operationId = OPERATION_PATH.exec(path)?.[1];
    if (operationId === undefined) return false;
    const verdict = yield* trust.checkBound(ConnectDeviceTrust.transferBindingId(operationId));
    return verdict._tag === "refused";
  });
