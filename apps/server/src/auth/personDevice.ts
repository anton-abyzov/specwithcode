/**
 * "A person's own approved device", for features only the owner may use from
 * afar (screen sharing, 1490). No scope says this: every session defaults to a
 * device principal, and `deviceApprover` also admits the startup link and dev
 * tokens. So the session is named by how it began and what it holds:
 *
 * - it began as a Connect sign-in or a phone link (never a pairing code, the
 *   local command line, a management key or an MCP client);
 * - it proved a key of its own (`jkt:`), and that key is on this machine's
 *   approved list (1327);
 * - it acts for no one else: no coordinator principal, no device binding from
 *   a credential another session minted, and it is not a bot.
 *
 * The app on this machine is told apart the other way round (`isOwnApp`): the
 * desktop proof, straight from this machine, never over Connect.
 */
import { AuthAccessWriteScope } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import { isValidScreenShareHostProof } from "@specweave-studio/shared/desktopBootstrapToken";

import * as ConnectDeviceTrust from "../fleet/ConnectDeviceTrust.ts";
import {
  arrivedFromThisMachine,
  DESKTOP_OWNER_SUBJECT,
  desktopOwnerProofMatches,
} from "./deviceApprover.ts";

export interface PersonDeviceSession extends ConnectDeviceTrust.DeviceSessionFacts {
  readonly principal?: { readonly kind: string } | undefined;
  readonly deviceKey?: string | undefined;
}

export interface PersonDevice {
  /** The approved-list key, `jkt:<thumbprint>`. */
  readonly key: string;
  /** The RFC 7638 thumbprint of the device's proof key. */
  readonly thumbprint: string;
  readonly kind: ConnectDeviceTrust.DeviceKind;
  /**
   * The name to show a person. From `personDeviceOf` it is the name on this
   * machine's approved list, which the owner saw when approving: a device
   * cannot change it by signing in under another name.
   */
  readonly label: string;
  /** What the device calls itself in this sign-in, when that differs from the list. */
  readonly claimedLabel?: string;
  readonly shortId: string;
}

/** Why a session is not a person's device, for logs and tests; never shown to the caller. */
export type PersonDeviceRefusal =
  | "coordinator"
  | "not_a_device_sign_in"
  | "no_device_key"
  | "acts_for_another"
  | "bot"
  | "not_approved";

const JKT_PREFIX = "jkt:";

/** The device behind a session before the approved list is asked, or why there is none. */
export const personDeviceCandidate = (
  session: PersonDeviceSession,
): { readonly device: PersonDevice } | { readonly refusal: PersonDeviceRefusal } => {
  if (session.principal?.kind === "coordinator") return { refusal: "coordinator" };
  const gated = ConnectDeviceTrust.gatedDevice(session);
  if (gated === null) return { refusal: "not_a_device_sign_in" };
  if (gated.key === null || !gated.key.startsWith(JKT_PREFIX)) return { refusal: "no_device_key" };
  if (session.boundDevice !== undefined) return { refusal: "acts_for_another" };
  if (session.deviceKey !== undefined && session.deviceKey !== gated.key)
    return { refusal: "acts_for_another" };
  if (session.clientDeviceType === "bot") return { refusal: "bot" };
  return {
    device: {
      key: gated.key,
      thumbprint: gated.key.slice(JKT_PREFIX.length),
      kind: gated.kind,
      label: gated.label,
      shortId: ConnectDeviceTrust.deviceShortIdOfKey(gated.key),
    },
  };
};

/**
 * The approved device a session belongs to, or the reason it is not one.
 * `approvedName` answers the name stored for a key on the approved list, or
 * null when the key is not on it.
 */
export const personDeviceOf = (
  session: PersonDeviceSession,
  approvedName: (key: string) => Effect.Effect<string | null>,
): Effect.Effect<{ readonly device: PersonDevice } | { readonly refusal: PersonDeviceRefusal }> =>
  Effect.gen(function* () {
    const candidate = personDeviceCandidate(session);
    if ("refusal" in candidate) return candidate;
    const name = yield* approvedName(candidate.device.key);
    if (name === null) return { refusal: "not_approved" };
    const { label: claimed, ...device } = candidate.device;
    return {
      device: {
        ...device,
        label: name,
        ...(claimed === name ? {} : { claimedLabel: claimed }),
      },
    };
  });

/** A name a person can read at the prompt. A blank one is no name: the device is refused. */
const approvedLabel = (label: string | undefined): string | null => {
  const name = label?.trim() ?? "";
  return name.length > 0 ? name : null;
};

/** `approvedName` from the approved list: a damaged or unreadable list approves no one. */
export const approvedNameFrom =
  (trust: Pick<ConnectDeviceTrust.ConnectDeviceTrustShape, "snapshot">) =>
  (key: string): Effect.Effect<string | null> =>
    trust.snapshot.pipe(
      Effect.map((snapshot) =>
        snapshot.health === "ok"
          ? approvedLabel(snapshot.devices.find((device) => device.key === key)?.label)
          : null,
      ),
      Effect.orElseSucceed(() => null),
    );

export interface OwnAppSession {
  readonly subject: string;
  readonly scopes: ReadonlyArray<string> | ReadonlySet<string>;
  readonly principal?: { readonly kind: string } | undefined;
  readonly clientDeviceType?: string | undefined;
  readonly deviceKey?: string | undefined;
  readonly boundDevice?: unknown;
}

const hasScope = (scopes: OwnAppSession["scopes"], scope: string) =>
  Array.isArray(scopes)
    ? (scopes as ReadonlyArray<string>).includes(scope)
    : (scopes as ReadonlySet<string>).has(scope);

/**
 * This machine's own app, on a request that came straight from this machine.
 * The startup link and dev tokens are owners for device approval but are not
 * the app, so they are refused here.
 */
export const isOwnApp = (
  session: OwnAppSession,
  request: HttpServerRequest.HttpServerRequest,
  addresses?: ReadonlyArray<string>,
): boolean =>
  session.subject === DESKTOP_OWNER_SUBJECT &&
  session.principal?.kind !== "coordinator" &&
  hasScope(session.scopes, AuthAccessWriteScope) &&
  session.clientDeviceType !== "bot" &&
  session.boundDevice === undefined &&
  session.deviceKey === undefined &&
  arrivedFromThisMachine(request, addresses);

/** The longest proof worth checking. The owner proof is 43 characters. */
const MAX_OWN_APP_PROOF_LENGTH = 512;

/**
 * Which secret a proof from the app matches, checked on every connection that
 * must be the app and not merely hold its kind of session:
 *
 * - `launch`: the screen sharing host proof of the secret this backend was
 *   started with. Only the app's main process holds that secret. It is not the
 *   bootstrap token, which the app's window holds: a different label derives
 *   it, so the window's token says nothing about it. It lasts minutes, and
 *   the app sends a new one over its open link.
 * - `owner`: the desktop owner proof, against the verifier file. The file can
 *   change later.
 *
 * The caller keeps the proof and checks it again when a viewer opens, whichever
 * kind it was.
 *
 * Null for anything else. A process that rewrites this user's files can make
 * its own proof match the verifier; that is the limit `deviceApprover.ts` names.
 */
export const ownAppProofKind = (input: {
  readonly proof: string;
  readonly launchSecret: string | undefined;
  /** The verifier file's bytes, or null when there is none or it cannot be read. */
  readonly verifier: Uint8Array | null;
  readonly nowMs: number;
}): "launch" | "owner" | null => {
  if (input.proof.length === 0 || input.proof.length > MAX_OWN_APP_PROOF_LENGTH) return null;
  if (
    input.launchSecret !== undefined &&
    isValidScreenShareHostProof(input.launchSecret, input.proof, input.nowMs)
  )
    return "launch";
  return input.verifier !== null && desktopOwnerProofMatches(input.proof, input.verifier)
    ? "owner"
    : null;
};
