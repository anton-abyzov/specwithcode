/**
 * Who may change which devices use this machine (B-02). No scope separates the
 * owner from a process with a shell here: `pair --scope access:write` mints the
 * same scopes the app holds. So the owner is named by how the session began:
 * the app's bootstrap or its proof below, or, only while no app is set up here,
 * the startup link in the service's log (a headless machine's way in, which a
 * shell can read too). An approved device is a gated session whose key is on
 * the list. Everything else may not approve. This stops the commands an agent
 * would use; it is no boundary against a process that rewrites this user's files.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - a synchronous hash and constant-time compare.
import { createHash, timingSafeEqual } from "node:crypto";
import * as NodeOS from "node:os";

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

/** What a session opened with the startup link is called. */
const STARTUP_LINK_SUBJECT = "administrative-bootstrap";

const MACHINE_OWNER_SUBJECTS: ReadonlySet<string> = new Set([
  DESKTOP_OWNER_SUBJECT,
  STARTUP_LINK_SUBJECT,
  "reusable-dev-token",
  "reusable-dev-token-child",
]);

/**
 * `auth session issue` can borrow any subject but always records the client as
 * a bot, so a bot is never the owner. A session acting for a device never is.
 */
export const isMachineOwner = (session: ApproverSession, startupLinkCounts = true): boolean =>
  (startupLinkCounts || session.subject !== STARTUP_LINK_SUBJECT) &&
  session.principal?.kind !== "coordinator" &&
  MACHINE_OWNER_SUBJECTS.has(session.subject) &&
  session.scopes.has(AuthAccessWriteScope) &&
  session.clientDeviceType !== "bot" &&
  session.boundDevice === undefined &&
  session.deviceKey === undefined;

/** `isMachineOwner`, asking about the app only for a session that needs the answer. */
export const machineOwnerNow = (
  session: ApproverSession,
  startupLinkCounts: Effect.Effect<boolean>,
): Effect.Effect<boolean> =>
  session.subject === STARTUP_LINK_SUBJECT
    ? Effect.map(startupLinkCounts, (counts) => isMachineOwner(session, counts))
    : Effect.succeed(isMachineOwner(session));

export const deviceApprover = (
  session: ApproverSession,
  isApproved: (key: string) => Effect.Effect<boolean>,
  startupLinkCounts: Effect.Effect<boolean> = Effect.succeed(true),
): Effect.Effect<DeviceApprover | null> =>
  Effect.gen(function* () {
    if (session.principal?.kind === "coordinator") return null;
    const device = ConnectDeviceTrust.gatedDevice(session);
    if (device !== null) {
      if (device.key === null || !(yield* isApproved(device.key))) return null;
      return { kind: "device", name: device.label, key: device.key };
    }
    return (yield* machineOwnerNow(session, startupLinkCounts))
      ? { kind: "owner", name: "this machine", key: null }
      : null;
  });

const LOOPBACK_PEER = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1)$/;
const PROXY_HEADER = /^(?:forwarded$|x-forwarded-|x-real-ip$|true-client-ip$|cf-|tailscale-)/i;
/** A proof is 43 characters; anything far longer is not worth hashing. */
const MAX_PROOF_LENGTH = 128;

const ownAddresses = (): ReadonlyArray<string> =>
  Object.values(NodeOS.networkInterfaces()).flatMap((entries) =>
    (entries ?? []).map((entry) => entry.address),
  );

/**
 * The proof the app sent, when the request came straight from this machine: over
 * loopback, or from its own address for a service bound to that address.
 * Tailscale Serve and the Connect tunnel also arrive from loopback, so any
 * header a proxy adds disqualifies it.
 */
export const desktopOwnerProofOf = (
  request: HttpServerRequest.HttpServerRequest,
  addresses?: ReadonlyArray<string>,
): string | undefined => {
  const proof = request.headers[DESKTOP_OWNER_PROOF_HEADER];
  if (proof === undefined || proof.length === 0 || proof.length > MAX_PROOF_LENGTH)
    return undefined;
  const peer = requestRemoteAddress(request);
  if (peer === undefined || arrivedOverConnect(request)) return undefined;
  if (!LOOPBACK_PEER.test(peer) && !(addresses ?? ownAddresses()).includes(peer)) return undefined;
  return Object.keys(request.headers).some((name) => PROXY_HEADER.test(name)) ? undefined : proof;
};

export const desktopOwnerProofMatches = (proof: string, verifier: Uint8Array): boolean => {
  const digest = createHash("sha256").update(proof, "utf8").digest();
  return verifier.byteLength === digest.byteLength && timingSafeEqual(digest, verifier);
};
