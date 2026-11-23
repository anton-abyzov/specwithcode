/**
 * Who may change which devices use this machine (B-02). No scope separates the
 * owner from a process with a shell here: `pair --scope access:write` mints the
 * same scopes the app holds. So the owner is named by how the session began,
 * from routes a command cannot reach: the app's bootstrap, the startup link the
 * service prints, or the app's proof below. An approved device is a gated
 * session whose key is on the list. Everything else may not approve.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - a synchronous hash and constant-time compare.
import { createHash, timingSafeEqual } from "node:crypto";

import { AuthAccessWriteScope } from "@specweave-studio/contracts";
import { DESKTOP_OWNER_PROOF_HEADER } from "@specweave-studio/shared/httpObservability";
import * as Effect from "effect/Effect";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as ConnectDeviceTrust from "../fleet/ConnectDeviceTrust.ts";
import { arrivedOverConnect } from "./CredentialFailureLimiter.ts";
import { requestRemoteAddress } from "./utils.ts";

/** Who is asking to approve, deny or remove, in the words the list records. */
export type DeviceApprover =
  | { readonly kind: "owner"; readonly name: string; readonly key: null }
  | { readonly kind: "device"; readonly name: string; readonly key: string };

export interface ApproverSession extends ConnectDeviceTrust.DeviceSessionFacts {
  readonly scopes: ReadonlySet<string>;
  readonly principal?: { readonly kind: string } | undefined;
  readonly deviceKey?: string | undefined;
}

/** `<stateDir>/secrets/desktop-owner-verifier.bin`: the SHA-256 of the app's proof. */
export const DESKTOP_OWNER_VERIFIER_SECRET = "desktop-owner-verifier";
/** The subject the attached app's session takes once its proof is accepted. */
export const DESKTOP_OWNER_SUBJECT = "desktop-bootstrap";

const MACHINE_OWNER_SUBJECTS: ReadonlySet<string> = new Set([
  DESKTOP_OWNER_SUBJECT,
  "administrative-bootstrap",
  "reusable-dev-token",
  "reusable-dev-token-child",
]);

/**
 * `auth session issue` can borrow any subject but always records the client as
 * a bot, so a bot is never the owner. A session acting for a device never is.
 */
export const isMachineOwner = (session: ApproverSession): boolean =>
  session.principal?.kind !== "coordinator" &&
  MACHINE_OWNER_SUBJECTS.has(session.subject) &&
  session.scopes.has(AuthAccessWriteScope) &&
  session.clientDeviceType !== "bot" &&
  session.boundDevice === undefined &&
  session.deviceKey === undefined;

export const deviceApprover = (
  session: ApproverSession,
  isApproved: (key: string) => Effect.Effect<boolean>,
): Effect.Effect<DeviceApprover | null> =>
  Effect.gen(function* () {
    if (session.principal?.kind === "coordinator") return null;
    const device = ConnectDeviceTrust.gatedDevice(session);
    if (device !== null) {
      if (device.key === null || !(yield* isApproved(device.key))) return null;
      return { kind: "device", name: device.label, key: device.key };
    }
    return isMachineOwner(session) ? { kind: "owner", name: "this machine", key: null } : null;
  });

const LOOPBACK_PEER = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1)$/;
const PROXY_HEADER = /^(?:forwarded$|x-forwarded-|x-real-ip$|true-client-ip$|cf-|tailscale-)/i;
/** A proof is 43 characters; anything far longer is not worth hashing. */
const MAX_PROOF_LENGTH = 128;

/**
 * The proof the app sent, when the request came straight from this machine.
 * Tailscale Serve and the Connect tunnel also arrive from loopback, so any
 * header a proxy adds disqualifies it.
 */
export const desktopOwnerProofOf = (
  request: HttpServerRequest.HttpServerRequest,
): string | undefined => {
  const proof = request.headers[DESKTOP_OWNER_PROOF_HEADER];
  if (proof === undefined || proof.length === 0 || proof.length > MAX_PROOF_LENGTH)
    return undefined;
  const peer = requestRemoteAddress(request);
  if (peer === undefined || !LOOPBACK_PEER.test(peer) || arrivedOverConnect(request))
    return undefined;
  return Object.keys(request.headers).some((name) => PROXY_HEADER.test(name)) ? undefined : proof;
};

export const desktopOwnerProofMatches = (proof: string, verifier: Uint8Array): boolean => {
  const digest = createHash("sha256").update(proof, "utf8").digest();
  return verifier.byteLength === digest.byteLength && timingSafeEqual(digest, verifier);
};
