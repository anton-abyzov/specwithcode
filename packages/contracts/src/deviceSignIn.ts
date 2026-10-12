/**
 * Approve-a-device sign-in. A browser that has no session asks to sign in and
 * shows a short code; the owner types that code on a client already signed in
 * with `access:write`. Nothing pushes the request to the owner, so there is no
 * prompt a stranger can trick them into approving. Approval mints an ordinary one-time
 * pairing credential, which only the asking browser can collect with the poll
 * token it was given, and which it exchanges like any pairing link.
 */
import * as Schema from "effect/Schema";
import { IsoDateTime } from "./baseSchemas.ts";

const DeviceSignInRequestId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{16,64}$/));
const DeviceSignInPollToken = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{32,128}$/));

/** Exact object: no other keys, so a request can not grow into a different one. */
const exact = <S extends Schema.Struct<Schema.Struct.Fields>>(
  struct: S,
  keys: ReadonlyArray<string>,
) =>
  Schema.StructWithRest(struct, [Schema.Record(Schema.String, Schema.Unknown)]).check(
    Schema.makeFilter((value) => Object.keys(value).every((key) => keys.includes(key))),
  );

export const DeviceSignInStartInput = exact(Schema.Struct({}), []);
export const DeviceSignInStartResult = Schema.Struct({
  requestId: DeviceSignInRequestId,
  pollToken: DeviceSignInPollToken,
  code: Schema.String,
  expiresAt: IsoDateTime,
  pollIntervalMs: Schema.Number,
});
export type DeviceSignInStartResult = typeof DeviceSignInStartResult.Type;

export const DeviceSignInPollInput = exact(
  Schema.Struct({ requestId: DeviceSignInRequestId, pollToken: DeviceSignInPollToken }),
  ["requestId", "pollToken"],
);
export const DeviceSignInPollStatus = Schema.Literals(["pending", "approved", "expired"]);
export type DeviceSignInPollStatus = typeof DeviceSignInPollStatus.Type;
export const DeviceSignInPollResult = Schema.Struct({
  status: DeviceSignInPollStatus,
  credential: Schema.optionalKey(Schema.String),
});
export type DeviceSignInPollResult = typeof DeviceSignInPollResult.Type;

/** Six code characters, with optional spaces or a dash as the owner typed them. */
const DeviceSignInTypedCode = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9 -]{4,10}[A-Za-z0-9]$/),
);

/** `confirm: false` only looks the code up, so the owner sees which device it is first. */
export const DeviceSignInApproveInput = exact(
  Schema.Struct({ code: DeviceSignInTypedCode, confirm: Schema.Boolean }),
  ["code", "confirm"],
);
export const DeviceSignInApprovedDevice = Schema.Struct({
  deviceType: Schema.String,
  browser: Schema.NullOr(Schema.String),
  os: Schema.NullOr(Schema.String),
  /** The client address, the forwarded one behind a local proxy. */
  address: Schema.optionalKey(Schema.String),
  askedAt: Schema.optionalKey(IsoDateTime),
});
export type DeviceSignInApprovedDevice = typeof DeviceSignInApprovedDevice.Type;
export const DeviceSignInApproveResult = Schema.Struct({
  status: Schema.Literals(["found", "approved", "not-found"]),
  device: Schema.optionalKey(DeviceSignInApprovedDevice),
});
export type DeviceSignInApproveResult = typeof DeviceSignInApproveResult.Type;
