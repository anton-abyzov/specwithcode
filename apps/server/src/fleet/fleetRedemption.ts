/**
 * What a v2 fleet invitation's one-time `redeem` credential is, kept free of
 * the auth service so EnvironmentAuth and the invite code can both use it.
 *
 * The credential is a pairing grant whose subject names how many days the
 * management token it buys will last. Only this server mints such a grant
 * (`issueFleetInvitation`, behind the owner's approval): `/api/auth/pairing-token`
 * always issues subject `one-time-token` and the Connect mint `cloud-connect`.
 */
import {
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
} from "@specweave-studio/contracts";
import * as Duration from "effect/Duration";

/**
 * What the line's token holds: pairing here can only hand out scopes the token
 * holds, so it carries every scope a connection from the primary may ask for,
 * plus access:write to mint those pairings.
 */
export const FLEET_INVITE_SCOPES = [...AuthStandardClientScopes, AuthAccessWriteScope] as const;

/**
 * How long a v2 line's one-time credential can be redeemed. Short on purpose:
 * unlike a v1 line (usable only inside the tailnet), a leaked v2 line can be
 * redeemed from the internet at the Connect address, by anyone's key, until
 * it is used or expires. The line is pasted right away in practice.
 */
export const FLEET_REDEEM_WINDOW = Duration.hours(1);

const REDEEM_SUBJECT_PREFIX = "fleet-invitation-redeem";
const REDEEM_SUBJECT = /^fleet-invitation-redeem:([1-9]\d{0,2})$/;
const MAX_REDEEM_DAYS = 365;

/** The pairing subject of a redeem credential for a token lasting `days`. */
export function fleetRedeemSubject(days: number): string {
  if (!Number.isInteger(days) || days < 1 || days > MAX_REDEEM_DAYS)
    throw new RangeError("A fleet invitation lasts 1 to 365 days.");
  return `${REDEEM_SUBJECT_PREFIX}:${String(days)}`;
}

/** The days a redeem subject grants, or null when `subject` is not one. */
export function parseFleetRedeemSubject(subject: string): number | null {
  const match = REDEEM_SUBJECT.exec(subject);
  if (match === null) return null;
  const days = Number(match[1]);
  return days <= MAX_REDEEM_DAYS ? days : null;
}

/**
 * Any subject in the redeem family, well formed or not. Every other way to
 * spend a pairing grant refuses these, so a redeem credential buys nothing
 * but a proof-bound management token.
 */
export const isFleetRedeemSubject = (subject: string): boolean =>
  subject === REDEEM_SUBJECT_PREFIX || subject.startsWith(`${REDEEM_SUBJECT_PREFIX}:`);

/** Whether `scopes` stay within what a fleet invitation hands out. */
export const withinFleetInviteScopes = (scopes: ReadonlyArray<AuthEnvironmentScope>): boolean =>
  scopes.length > 0 &&
  scopes.every((scope) => (FLEET_INVITE_SCOPES as ReadonlyArray<string>).includes(scope));
