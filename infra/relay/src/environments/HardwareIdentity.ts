/**
 * The relay's form of a machine's hardware identity. The machine sends its own
 * hash of its hardware id and home folder; the relay hashes it again with the
 * account's user id, so the stored value cannot be matched across accounts.
 */
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

export const accountHardwareIdentity = Effect.fn("relay.hardware_identity.for_account")(function* (
  userId: string,
  machineHash: string,
) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest(
    "SHA-256",
    new TextEncoder().encode(`specwithcode-connect-account-hardware-v1\n${userId}\n${machineHash}`),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
});
