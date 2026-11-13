/**
 * Devices that can use this machine (1327). A Connect device or hub-linked
 * phone waits until the owner types the code it shows into this machine's app
 * (or into a device this machine already approved). The list never carries a
 * waiting device's code: whoever approves must read it off that device.
 */
import * as Schema from "effect/Schema";
import { IsoDateTime } from "./baseSchemas.ts";

/** Exact object: no other keys, so a request can not grow into a different one. */
const exact = <S extends Schema.Struct<Schema.Struct.Fields>>(
  struct: S,
  keys: ReadonlyArray<string>,
) =>
  Schema.StructWithRest(struct, [Schema.Record(Schema.String, Schema.Unknown)]).check(
    Schema.makeFilter((value) => Object.keys(value).every((key) => keys.includes(key))),
  );

export const ConnectDeviceKind = Schema.Literals(["connect", "phone"]);
export type ConnectDeviceKind = typeof ConnectDeviceKind.Type;

export const ConnectDevice = Schema.Struct({
  key: Schema.String,
  kind: ConnectDeviceKind,
  label: Schema.String,
  deviceType: Schema.optionalKey(Schema.String),
  approvedAt: IsoDateTime,
  /** "this machine", a device's name, or "the update". */
  approvedBy: Schema.String,
  /** In use when the update came; shown until the owner confirms the list once. */
  keptByUpdate: Schema.Boolean,
});
export type ConnectDevice = typeof ConnectDevice.Type;

export const ConnectDeviceRequest = Schema.Struct({
  id: Schema.String,
  kind: ConnectDeviceKind,
  label: Schema.String,
  deviceType: Schema.optionalKey(Schema.String),
  askedAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type ConnectDeviceRequest = typeof ConnectDeviceRequest.Type;

export const ConnectDevicesNotice = Schema.Struct({
  id: Schema.String,
  at: IsoDateTime,
  message: Schema.String,
});

export const ConnectDevicesListInput = exact(Schema.Struct({}), []);
export const ConnectDevicesSnapshot = Schema.Struct({
  machine: Schema.String,
  /** `damaged`: remote devices are refused until the owner repairs the list on this machine. */
  health: Schema.Literals(["ok", "damaged"]),
  devices: Schema.Array(ConnectDevice),
  pending: Schema.Array(ConnectDeviceRequest),
  needsReview: Schema.Boolean,
  notices: Schema.Array(ConnectDevicesNotice),
  /** The caller may approve, deny and remove: this machine's owner or an approved device. */
  canApprove: Schema.Boolean,
  /** Only this machine's own app may repair a damaged list. */
  canRepair: Schema.Boolean,
});
export type ConnectDevicesSnapshot = typeof ConnectDevicesSnapshot.Type;

/** Six code characters, with optional spaces or a dash as the owner typed them. */
const TypedCode = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9 -]{4,10}[A-Za-z0-9]$/),
);

export const ConnectDevicesApproveInput = exact(Schema.Struct({ code: TypedCode }), ["code"]);
export const ConnectDevicesApproveResult = Schema.Struct({
  /** `self`: a device typed its own code. `paused`: too many wrong codes from devices. */
  status: Schema.Literals(["approved", "not-found", "self", "paused"]),
  device: Schema.optionalKey(ConnectDevice),
});
export type ConnectDevicesApproveResult = typeof ConnectDevicesApproveResult.Type;

export const ConnectDevicesDenyInput = exact(Schema.Struct({ requestId: Schema.String }), [
  "requestId",
]);
export const ConnectDevicesDenyResult = Schema.Struct({ denied: Schema.Boolean });

export const ConnectDevicesRemoveInput = exact(Schema.Struct({ key: Schema.String }), ["key"]);
export const ConnectDevicesRemoveResult = Schema.Struct({
  removed: Schema.Boolean,
  /** Sessions of that device ended now. */
  endedSessions: Schema.Number,
});

export const ConnectDevicesEmptyInput = exact(Schema.Struct({}), []);
export const ConnectDevicesDone = Schema.Struct({ done: Schema.Boolean });
