/**
 * Which human devices may use this machine (1327).
 *
 * A device signed in to the owner's SpecWithCode Connect account (subject
 * `cloud-connect`), or a phone a hub machine linked here (`phone-link:`), gets
 * no access until someone on this machine types the 6-character code that
 * device shows. Machine-to-machine sessions (`mcp-client` worker grants, the
 * `fleet-invitation` management token) and everything paired locally are not
 * gated here: they passed their own approval.
 *
 * A device is its DPoP key (`jkt:<thumbprint>`). A hub-linked phone that holds
 * no key here is its link subject, which names the hub's phone session, so a
 * hub cannot fan one phone out to another machine without that machine's own
 * approval.
 *
 * The list lives in `connect-devices.json` beside `work-grants.json`, written
 * the same way (temp file, 0600, fsync, rename) under one lock. Codes are kept
 * only as hashes; the plain code lives in memory so the asking device can be
 * told it again, and a restart gives a waiting device a fresh one.
 *
 * The first start after the update (no list and no `connect-devices.migrated`
 * marker) keeps the devices that hold a session at that moment, before this
 * machine answers any request, marked for one review; then it writes the
 * marker. After that a missing list is a fault, like one that does not parse:
 * every gated device is refused until the owner repairs it on this machine.
 * Local sessions are never affected.
 *
 * Credentials a device turns into something else (an MCP client session, a
 * folder-copy bearer) are bound here to that device's key and approval, so
 * Remove ends them too and a waiting device cannot launder its credential.
 *
 * @module ConnectDeviceTrust
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - codes need constant-time comparison and synchronous random bytes, as in DeviceSignInRequests.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  generateDeviceSignInCode,
  normalizeDeviceSignInCode,
} from "../auth/DeviceSignInRequests.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

const FILE_NAME = "connect-devices.json";
/** Written once, after the first start kept its devices; never removed. */
const MARKER_NAME = "connect-devices.migrated";
export const DEVICE_APPROVAL_PENDING_TTL_MS = 10 * 60_000;
export const DEVICE_APPROVAL_DENY_MS = 24 * 60 * 60_000;
export const DEVICE_APPROVAL_MAX_PENDING = 20;
/** Per account (Connect) or per hub (linked phones), so one source cannot fill the list. */
export const DEVICE_APPROVAL_MAX_PENDING_PER_ACCOUNT = 3;
/** Wrong codes typed by approved devices before typing pauses; the local owner is never paused. */
export const DEVICE_APPROVAL_MAX_WRONG_CODES = 10;
const WRONG_CODE_WINDOW_MS = 10 * 60_000;
const NOTICE_KEEP_MS = 24 * 60 * 60_000;
const MAX_NOTICES = 20;

export const CONNECT_SUBJECT = "cloud-connect";
export const PHONE_LINK_PREFIX = "phone-link:";

export type DeviceKind = "connect" | "phone";

/** What a session says about itself that decides whether it is gated, and as which device. */
export interface DeviceSessionFacts {
  readonly subject: string;
  readonly proofKeyThumbprint?: string | undefined;
  readonly clientLabel?: string | undefined;
  readonly clientDeviceType?: string | undefined;
}

export interface GatedDevice {
  readonly kind: DeviceKind;
  /** Null when the session carries nothing that names one device. */
  readonly key: string | null;
  readonly account: string;
  readonly label: string;
  readonly deviceType: string | undefined;
}

export const deviceKeyOfThumbprint = (thumbprint: string) => `jkt:${thumbprint}`;

/** The device a session belongs to, or null when this machine does not gate it. */
export const gatedDevice = (session: DeviceSessionFacts): GatedDevice | null => {
  const thumbprint = session.proofKeyThumbprint?.trim() || undefined;
  if (session.subject === CONNECT_SUBJECT)
    return {
      kind: "connect",
      key: thumbprint === undefined ? null : deviceKeyOfThumbprint(thumbprint),
      account: "connect",
      label: session.clientLabel?.trim() || "SpecWithCode Connect device",
      deviceType: session.clientDeviceType,
    };
  if (session.subject.startsWith(PHONE_LINK_PREFIX)) {
    const hub = session.subject.slice(PHONE_LINK_PREFIX.length).split(":")[0] ?? "";
    return {
      kind: "phone",
      key: thumbprint === undefined ? `link:${session.subject}` : deviceKeyOfThumbprint(thumbprint),
      account: `hub:${hub}`,
      label: session.clientLabel?.trim() || "Phone",
      deviceType: session.clientDeviceType ?? "mobile",
    };
  }
  return null;
};

// ---------------------------------------------------------------------------
// The file.

const DeviceRecord = Schema.Struct({
  key: Schema.String,
  kind: Schema.Literals(["connect", "phone"]),
  label: Schema.String,
  deviceType: Schema.optionalKey(Schema.String),
  approvedAt: Schema.String,
  /** Who approved it, in words: "this machine", a device's name, or "the update". */
  approvedBy: Schema.String,
  keptByUpdate: Schema.Boolean,
  /** Names this approval: what the device minted dies with it, even if approved again. */
  approvalId: Schema.optionalKey(Schema.String),
});
export type DeviceRecord = typeof DeviceRecord.Type;

const PendingRecord = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  kind: Schema.Literals(["connect", "phone"]),
  label: Schema.String,
  deviceType: Schema.optionalKey(Schema.String),
  account: Schema.String,
  codeHash: Schema.String,
  createdAt: Schema.String,
  expiresAt: Schema.String,
});
type PendingRecord = typeof PendingRecord.Type;

const DeniedRecord = Schema.Struct({ key: Schema.String, until: Schema.String });

const NoticeRecord = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  message: Schema.String,
});

/** A credential minted from a device's session; valid while that approval stands. */
const BoundRecord = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  /** The device's approval when bound: a later re-approval does not revive it. */
  approval: Schema.String,
  expiresAt: Schema.String,
});
type BoundRecord = typeof BoundRecord.Type;

const StoreFile = Schema.Struct({
  version: Schema.Literal(1),
  initializedAt: Schema.String,
  /** When the owner last confirmed the list; devices kept by the update are flagged until then. */
  reviewedAt: Schema.NullOr(Schema.String),
  devices: Schema.Array(DeviceRecord),
  pending: Schema.Array(PendingRecord),
  denied: Schema.Array(DeniedRecord),
  notices: Schema.Array(NoticeRecord),
  bound: Schema.optionalKey(Schema.Array(BoundRecord)),
});
type StoreFile = typeof StoreFile.Type;

const StoreFileJson = Schema.fromJsonString(StoreFile);
const decodeStoreFile = Schema.decodeUnknownOption(StoreFileJson);
const encodeStoreFile = Schema.encodeEffect(StoreFileJson);

// ---------------------------------------------------------------------------
// The service.

/** Binding ids for what a device can mint. */
export const sessionBindingId = (sessionId: string) => `session:${sessionId}`;
export const transferBindingId = (operationId: string) => `transfer:${operationId}`;

export type TrustVerdict =
  | {
      readonly _tag: "allowed";
      /** Set when the session was minted from a device's credential. */
      readonly deviceKey?: string;
    }
  | {
      readonly _tag: "refused";
      /** Shown on the device as is. */
      readonly message: string;
      readonly approvalCode?: string;
    };

export interface PendingSummary {
  readonly id: string;
  readonly kind: DeviceKind;
  readonly label: string;
  readonly deviceType?: string;
  readonly askedAt: string;
  readonly expiresAt: string;
}

export interface TrustSnapshot {
  readonly machine: string;
  /** `damaged`: the file does not parse; remote devices are refused until it is repaired. */
  readonly health: "ok" | "damaged";
  readonly devices: ReadonlyArray<DeviceRecord>;
  readonly pending: ReadonlyArray<PendingSummary>;
  /** Devices the update kept wait for the owner to look at the list once. */
  readonly needsReview: boolean;
  readonly notices: ReadonlyArray<{
    readonly id: string;
    readonly at: string;
    readonly message: string;
  }>;
}

export type ApproveOutcome =
  | { readonly status: "approved"; readonly device: DeviceRecord }
  | { readonly status: "not-found" }
  | { readonly status: "self" }
  | { readonly status: "paused" };

export class DeviceTrustError extends Schema.TaggedError<DeviceTrustError>()("DeviceTrustError", {
  reason: Schema.Literals(["storage", "damaged", "unwired"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason === "damaged"
      ? "The list of devices that can use this machine is damaged. Repair it in Settings > Machines."
      : this.reason === "unwired"
        ? "This machine cannot check devices."
        : "Could not save the list of devices that can use this machine.";
  }
}

export interface ConnectDeviceTrustShape {
  /**
   * Whether a gated device may go on. Other sessions are allowed unless a
   * device minted them (see `bindCredential`) and that device is no longer
   * approved. Never fails.
   */
  readonly check: (
    session: DeviceSessionFacts & { readonly sessionId?: string | undefined },
  ) => Effect.Effect<TrustVerdict>;
  /**
   * Ties a credential minted from an approved device's session to that
   * device. False, with nothing recorded, when the key is not approved.
   */
  readonly bindCredential: (input: {
    readonly id: string;
    readonly key: string;
    readonly expiresAtMillis: number;
  }) => Effect.Effect<boolean, DeviceTrustError>;
  /** Allowed when `id` is unbound or its device's approval still stands. */
  readonly checkBound: (id: string) => Effect.Effect<TrustVerdict>;
  /** The live credentials bound to one device, for Remove. */
  readonly boundIds: (key: string) => Effect.Effect<ReadonlyArray<string>>;
  /**
   * Called when Connect mints a pairing credential for a device key: answers
   * the refusal that stops the mint (denied key, too many waiting), else null
   * after recording the key as waiting when it is new.
   */
  readonly refuseAtMint: (input: { readonly thumbprint: string }) => Effect.Effect<string | null>;
  readonly isApproved: (key: string) => Effect.Effect<boolean>;
  readonly snapshot: Effect.Effect<TrustSnapshot, DeviceTrustError>;
  readonly approve: (input: {
    readonly code: string;
    readonly approvedBy: string;
    /** The approving device's own key; null for this machine's local owner. */
    readonly approverKey: string | null;
  }) => Effect.Effect<ApproveOutcome, DeviceTrustError>;
  readonly deny: (pendingId: string) => Effect.Effect<boolean, DeviceTrustError>;
  /** Forgets one device; the caller ends its sessions. Answers the removed record. */
  readonly remove: (key: string) => Effect.Effect<DeviceRecord | null, DeviceTrustError>;
  readonly confirmReview: Effect.Effect<void, DeviceTrustError>;
  /** Replaces a damaged file with an empty list. */
  readonly repair: Effect.Effect<void, DeviceTrustError>;
}

const refusedUnwired: TrustVerdict = {
  _tag: "refused",
  message: "This machine cannot check new devices yet. Open SpecWithCode on it and update.",
};

/** Without the store a gated device is refused: failing closed is the point of the gate. */
const unwired: ConnectDeviceTrustShape = {
  check: (session) =>
    Effect.succeed(gatedDevice(session) === null ? { _tag: "allowed" } : refusedUnwired),
  bindCredential: () => Effect.fail(new DeviceTrustError({ reason: "unwired" })),
  checkBound: () => Effect.succeed({ _tag: "allowed" }),
  boundIds: () => Effect.succeed([]),
  refuseAtMint: () => Effect.succeed(refusedUnwired.message),
  isApproved: () => Effect.succeed(false),
  snapshot: Effect.fail(new DeviceTrustError({ reason: "unwired" })),
  approve: () => Effect.fail(new DeviceTrustError({ reason: "unwired" })),
  deny: () => Effect.fail(new DeviceTrustError({ reason: "unwired" })),
  remove: () => Effect.fail(new DeviceTrustError({ reason: "unwired" })),
  confirmReview: Effect.fail(new DeviceTrustError({ reason: "unwired" })),
  repair: Effect.fail(new DeviceTrustError({ reason: "unwired" })),
};

export const ConnectDeviceTrust = Context.Reference<ConnectDeviceTrustShape>(
  "studio/fleet/ConnectDeviceTrust",
  { defaultValue: () => unwired },
);

/**
 * The approved device behind the current request, when there is one: set per
 * RPC from its connection's session, so what the request mints can be bound.
 */
export const RequestDevice = Context.Reference<string | null>(
  "studio/fleet/ConnectDeviceTrust/RequestDevice",
  { defaultValue: () => null },
);

const hashCode = (code: string) =>
  createHash("sha256").update(normalizeDeviceSignInCode(code), "utf8").digest("hex");

const codeMatches = (code: string, hash: string) => {
  const presented = Buffer.from(hashCode(code), "hex");
  const stored = Buffer.from(hash, "hex");
  return presented.length === stored.length && timingSafeEqual(presented, stored);
};

const approvalOf = (device: DeviceRecord) => device.approvalId ?? device.approvedAt;

const isoOf = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const millisOf = (iso: string) => Date.parse(iso);

export interface MakeOptions {
  readonly random?: (size: number) => Buffer;
}

type State =
  | { readonly _tag: "unread" }
  | { readonly _tag: "ok"; readonly file: StoreFile }
  | { readonly _tag: "damaged" };

export const makeWith = (options: MakeOptions = {}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const sessions = yield* SessionStore.SessionStore;
    // The CLI's auth layer runs without the full environment; it never shows a device the name.
    const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
    const random = options.random ?? randomBytes;
    const filePath = path.join(config.stateDir, FILE_NAME);
    const markerPath = path.join(config.stateDir, MARKER_NAME);
    const lock = yield* Semaphore.make(1);
    const state = yield* Ref.make<State>({ _tag: "unread" });
    // Plain codes by device key, so a waiting device can be told its code again.
    const codes = new Map<string, string>();
    let wrongCodes: { windowStart: number; count: number } = { windowStart: 0, count: 0 };

    const machine = Option.isNone(environment)
      ? Effect.succeed("this machine")
      : environment.value.getDescriptor.pipe(
          Effect.map((descriptor) => descriptor.label.trim() || "this machine"),
        );

    const storageError = (cause: unknown) => new DeviceTrustError({ reason: "storage", cause });

    const write = (file: StoreFile) =>
      Effect.gen(function* () {
        const text = yield* encodeStoreFile(file);
        const temporary = `${filePath}.${random(4).toString("hex")}.tmp`;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* fileSystem.open(temporary, { flag: "w", mode: 0o600 });
            yield* handle.writeAll(new TextEncoder().encode(text));
            yield* handle.sync;
          }),
        );
        yield* fileSystem.chmod(temporary, 0o600);
        yield* fileSystem.rename(temporary, filePath);
        yield* Ref.set(state, { _tag: "ok", file });
      }).pipe(Effect.mapError(storageError));

    /** Devices with a live session at the first start after the update, before any request: kept, flagged. */
    const keptByUpdate = (now: string) =>
      Effect.gen(function* () {
        const active = yield* sessions.listActive();
        const kept = new Map<string, DeviceRecord>();
        for (const session of active) {
          if (session.subject !== CONNECT_SUBJECT && !session.subject.startsWith(PHONE_LINK_PREFIX))
            continue;
          const binding = yield* sessions.readProofKeyBinding(session.sessionId);
          const device = gatedDevice({
            subject: session.subject,
            proofKeyThumbprint: Option.isSome(binding)
              ? (binding.value.proofKeyThumbprint ?? undefined)
              : undefined,
            clientLabel: session.client.label,
            clientDeviceType: session.client.deviceType,
          });
          if (device?.key == null || kept.has(device.key)) continue;
          kept.set(device.key, {
            key: device.key,
            kind: device.kind,
            label: device.label,
            ...(device.deviceType === undefined ? {} : { deviceType: device.deviceType }),
            approvedAt: now,
            approvedBy: "the update",
            keptByUpdate: true,
            approvalId: random(9).toString("base64url"),
          });
        }
        return [...kept.values()];
      }).pipe(Effect.orElseSucceed((): ReadonlyArray<DeviceRecord> => []));

    const writeMarker = (at: string) =>
      fileSystem
        .writeFileString(markerPath, `${at}\n`, { mode: 0o600 })
        .pipe(Effect.mapError(storageError));

    /**
     * The file, read once at start; later reads come from memory. Only the
     * lock holder writes. With no file, the marker tells the first start after
     * the update (keep the devices in use now) from a lost list (refuse).
     */
    const load: Effect.Effect<State> = Effect.gen(function* () {
      const current = yield* Ref.get(state);
      if (current._tag !== "unread") return current;
      const exists = (file: string) =>
        fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false));
      const marked = yield* exists(markerPath);
      if (yield* exists(filePath)) {
        const text = yield* fileSystem.readFileString(filePath).pipe(Effect.option);
        const decoded = Option.flatMap(text, decodeStoreFile);
        const next: State = Option.isSome(decoded)
          ? { _tag: "ok", file: decoded.value }
          : { _tag: "damaged" };
        if (next._tag === "damaged")
          yield* Effect.logWarning(
            "The list of devices that can use this machine is damaged; remote devices are refused until it is repaired.",
          );
        else if (!marked)
          yield* writeMarker(next.file.initializedAt).pipe(
            Effect.catch(() =>
              Effect.logWarning("Could not mark the device list as set up; it is kept as is."),
            ),
          );
        yield* Ref.set(state, next);
        return next;
      }
      if (marked) {
        yield* Effect.logWarning(
          "The list of devices that can use this machine is missing; remote devices are refused until it is repaired.",
        );
        yield* Ref.set(state, { _tag: "damaged" });
        return { _tag: "damaged" } as const;
      }
      const now = isoOf(yield* Clock.currentTimeMillis);
      const devices = yield* keptByUpdate(now);
      const file: StoreFile = {
        version: 1,
        initializedAt: now,
        reviewedAt: devices.length === 0 ? now : null,
        devices,
        pending: [],
        denied: [],
        notices: [],
      };
      // List first, then the marker: a start that dies between them keeps this list.
      const written = yield* write(file).pipe(Effect.andThen(writeMarker(now)), Effect.result);
      if (written._tag === "Failure") {
        // Another start must not take a later snapshot, so refuse until repaired.
        yield* Effect.logWarning(
          "Could not save the list of devices that can use this machine; remote devices are refused until it is repaired.",
        );
        yield* Ref.set(state, { _tag: "damaged" });
        return { _tag: "damaged" } as const;
      }
      return { _tag: "ok", file } as const;
    });

    const withLock = <A, E>(effect: Effect.Effect<A, E>) => lock.withPermit(effect);

    /** Drops expired waiting entries and denials. */
    const pruned = (file: StoreFile, now: number): StoreFile => ({
      ...file,
      pending: file.pending.filter((entry) => millisOf(entry.expiresAt) > now),
      denied: file.denied.filter((entry) => millisOf(entry.until) > now),
      notices: file.notices.filter((entry) => millisOf(entry.at) + NOTICE_KEEP_MS > now),
      bound: (file.bound ?? []).filter((entry) => millisOf(entry.expiresAt) > now),
    });

    const changed = (before: StoreFile, after: StoreFile) =>
      before.pending.length !== after.pending.length ||
      before.denied.length !== after.denied.length ||
      before.notices.length !== after.notices.length ||
      (before.bound ?? []).length !== (after.bound ?? []).length;

    /** Runs `change` on the current file under the lock; writes only when it says so. */
    const modify = <A>(
      change: (file: StoreFile, now: number) => readonly [A, StoreFile | undefined],
    ): Effect.Effect<A, DeviceTrustError> =>
      withLock(
        Effect.gen(function* () {
          const loaded = yield* load;
          if (loaded._tag !== "ok") return yield* new DeviceTrustError({ reason: "damaged" });
          const now = yield* Clock.currentTimeMillis;
          const base = pruned(loaded.file, now);
          const [result, next] = change(base, now);
          const toWrite = next ?? (changed(loaded.file, base) ? base : undefined);
          if (toWrite !== undefined) yield* write(toWrite);
          return result;
        }),
      );

    const newCode = (file: StoreFile, key: string) => {
      const taken = new Set(
        file.pending.flatMap((entry) => (entry.key === key ? [] : [entry.codeHash])),
      );
      let code = generateDeviceSignInCode(random);
      while (taken.has(hashCode(code))) code = generateDeviceSignInCode(random);
      codes.set(key, code);
      return code;
    };

    type Waiting =
      | { readonly _tag: "waiting"; readonly code: string }
      | { readonly _tag: "denied" }
      | { readonly _tag: "full" }
      | { readonly _tag: "approved" };

    /** Records `device` as waiting (once per key), refreshing its code after a restart. */
    const ensureWaiting = (device: GatedDevice & { readonly key: string }) =>
      modify((file, now): readonly [Waiting, StoreFile | undefined] => {
        if (file.devices.some((entry) => entry.key === device.key))
          return [{ _tag: "approved" }, undefined];
        if (file.denied.some((entry) => entry.key === device.key))
          return [{ _tag: "denied" }, undefined];
        const existing = file.pending.find((entry) => entry.key === device.key);
        if (existing !== undefined) {
          const known = codes.get(device.key);
          if (known !== undefined && codeMatches(known, existing.codeHash)) {
            // A better name than the one Connect knew at mint time.
            const relabel =
              existing.label !== device.label && device.label !== "SpecWithCode Connect device";
            return [
              { _tag: "waiting", code: known },
              relabel
                ? {
                    ...file,
                    pending: file.pending.map((entry) =>
                      entry.key === device.key
                        ? {
                            ...entry,
                            label: device.label,
                            ...(device.deviceType === undefined
                              ? {}
                              : { deviceType: device.deviceType }),
                          }
                        : entry,
                    ),
                  }
                : undefined,
            ];
          }
          // Restarted since: the old code is gone from memory, so this device gets a new one.
          const code = newCode(file, device.key);
          return [
            { _tag: "waiting", code },
            {
              ...file,
              pending: file.pending.map((entry) =>
                entry.key === device.key ? { ...entry, codeHash: hashCode(code) } : entry,
              ),
            },
          ];
        }
        if (
          file.pending.length >= DEVICE_APPROVAL_MAX_PENDING ||
          file.pending.filter((entry) => entry.account === device.account).length >=
            DEVICE_APPROVAL_MAX_PENDING_PER_ACCOUNT
        )
          return [{ _tag: "full" }, undefined];
        const code = newCode(file, device.key);
        const entry: PendingRecord = {
          id: random(18).toString("base64url"),
          key: device.key,
          kind: device.kind,
          label: device.label,
          ...(device.deviceType === undefined ? {} : { deviceType: device.deviceType }),
          account: device.account,
          codeHash: hashCode(code),
          createdAt: isoOf(now),
          expiresAt: isoOf(now + DEVICE_APPROVAL_PENDING_TTL_MS),
        };
        return [
          { _tag: "waiting", code },
          { ...file, pending: [...file.pending, entry] },
        ];
      });

    const waitingMessage = (machineName: string, code: string) =>
      `Open SpecWithCode on ${machineName} and type this code: ${code}`;
    const deniedMessage = (machineName: string) =>
      `${machineName} turned this device away. Ask again tomorrow, or approve it in SpecWithCode on ${machineName}.`;
    const fullMessage = (machineName: string) =>
      `Too many devices are waiting for approval on ${machineName}. Try again in a few minutes.`;
    const damagedMessage = (machineName: string) =>
      `The device list on ${machineName} is damaged. Open SpecWithCode on ${machineName} to repair it.`;

    const removedMessage = (machineName: string) =>
      `${machineName} no longer lets this device in. Approve it again in SpecWithCode on ${machineName}.`;

    const checkBound: ConnectDeviceTrustShape["checkBound"] = (id) =>
      Effect.gen(function* () {
        const loaded = yield* withLock(load);
        // A lost or damaged list cannot say; local sessions keep working, and Remove revoked the rest.
        if (loaded._tag !== "ok") return { _tag: "allowed" } as const;
        const now = yield* Clock.currentTimeMillis;
        const binding = (loaded.file.bound ?? []).find(
          (entry) => entry.id === id && millisOf(entry.expiresAt) > now,
        );
        if (binding === undefined) return { _tag: "allowed" } as const;
        const standing = loaded.file.devices.some(
          (entry) => entry.key === binding.key && approvalOf(entry) === binding.approval,
        );
        return standing
          ? ({ _tag: "allowed", deviceKey: binding.key } as const)
          : ({ _tag: "refused", message: removedMessage(yield* machine) } as const);
      });

    const bindCredential: ConnectDeviceTrustShape["bindCredential"] = (input) =>
      modify((file, now) => {
        const device = file.devices.find((entry) => entry.key === input.key);
        if (device === undefined || input.expiresAtMillis <= now)
          return [false, undefined] as const;
        return [
          true,
          {
            ...file,
            bound: [
              ...(file.bound ?? []).filter((entry) => entry.id !== input.id),
              {
                id: input.id,
                key: input.key,
                approval: approvalOf(device),
                expiresAt: isoOf(input.expiresAtMillis),
              },
            ],
          },
        ] as const;
      });

    const boundIds: ConnectDeviceTrustShape["boundIds"] = (key) =>
      Effect.gen(function* () {
        const loaded = yield* withLock(load);
        if (loaded._tag !== "ok") return [];
        const now = yield* Clock.currentTimeMillis;
        return (loaded.file.bound ?? []).flatMap((entry) =>
          entry.key === key && millisOf(entry.expiresAt) > now ? [entry.id] : [],
        );
      });

    const check: ConnectDeviceTrustShape["check"] = (session) =>
      Effect.gen(function* () {
        const device = gatedDevice(session);
        if (device === null)
          return session.sessionId === undefined
            ? ({ _tag: "allowed" } as const)
            : yield* checkBound(sessionBindingId(session.sessionId));
        const machineName = yield* machine;
        if (device.key === null)
          return {
            _tag: "refused",
            message: `Sign in to SpecWithCode Connect again on this device to ask ${machineName} for approval.`,
          } as const;
        const loaded = yield* withLock(load);
        if (loaded._tag === "damaged")
          return { _tag: "refused", message: damagedMessage(machineName) } as const;
        if (loaded._tag === "ok" && loaded.file.devices.some((entry) => entry.key === device.key))
          return { _tag: "allowed" } as const;
        const waiting = yield* ensureWaiting({ ...device, key: device.key }).pipe(
          Effect.orElseSucceed((): Waiting => ({ _tag: "full" })),
        );
        switch (waiting._tag) {
          case "approved":
            return { _tag: "allowed" } as const;
          case "waiting":
            return {
              _tag: "refused",
              message: waitingMessage(machineName, waiting.code),
              approvalCode: waiting.code,
            } as const;
          case "denied":
            return { _tag: "refused", message: deniedMessage(machineName) } as const;
          case "full":
            return { _tag: "refused", message: fullMessage(machineName) } as const;
        }
      });

    const refuseAtMint: ConnectDeviceTrustShape["refuseAtMint"] = ({ thumbprint }) =>
      Effect.gen(function* () {
        const machineName = yield* machine;
        const device = gatedDevice({ subject: CONNECT_SUBJECT, proofKeyThumbprint: thumbprint });
        if (device?.key == null) return null;
        const waiting = yield* ensureWaiting({ ...device, key: device.key }).pipe(Effect.result);
        if (waiting._tag === "Failure")
          return waiting.failure.reason === "damaged" ? damagedMessage(machineName) : null;
        switch (waiting.success._tag) {
          case "denied":
            return deniedMessage(machineName);
          case "full":
            return fullMessage(machineName);
          default:
            return null;
        }
      });

    const isApproved: ConnectDeviceTrustShape["isApproved"] = (key) =>
      withLock(load).pipe(
        Effect.map(
          (loaded) =>
            loaded._tag === "ok" && loaded.file.devices.some((entry) => entry.key === key),
        ),
      );

    const snapshot: ConnectDeviceTrustShape["snapshot"] = Effect.gen(function* () {
      const machineName = yield* machine;
      const loaded = yield* withLock(load);
      if (loaded._tag !== "ok")
        return {
          machine: machineName,
          health: "damaged",
          devices: [],
          pending: [],
          needsReview: false,
          notices: [],
        } satisfies TrustSnapshot;
      const now = yield* Clock.currentTimeMillis;
      const file = pruned(loaded.file, now);
      return {
        machine: machineName,
        health: "ok",
        devices: file.devices,
        pending: file.pending.map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          label: entry.label,
          ...(entry.deviceType === undefined ? {} : { deviceType: entry.deviceType }),
          askedAt: entry.createdAt,
          expiresAt: entry.expiresAt,
        })),
        needsReview: file.reviewedAt === null && file.devices.some((entry) => entry.keptByUpdate),
        notices: file.notices,
      } satisfies TrustSnapshot;
    });

    const approve: ConnectDeviceTrustShape["approve"] = (input) =>
      Effect.gen(function* () {
        const machineName = yield* machine;
        return yield* modify((file, now): readonly [ApproveOutcome, StoreFile | undefined] => {
          if (input.approverKey !== null) {
            if (now - wrongCodes.windowStart >= WRONG_CODE_WINDOW_MS)
              wrongCodes = { windowStart: now, count: 0 };
            if (wrongCodes.count >= DEVICE_APPROVAL_MAX_WRONG_CODES)
              return [{ status: "paused" }, undefined];
          }
          const match = file.pending.find((entry) => codeMatches(input.code, entry.codeHash));
          if (match === undefined) {
            if (input.approverKey !== null) wrongCodes.count += 1;
            return [{ status: "not-found" }, undefined];
          }
          if (match.key === input.approverKey) return [{ status: "self" }, undefined];
          const device: DeviceRecord = {
            key: match.key,
            kind: match.kind,
            label: match.label,
            ...(match.deviceType === undefined ? {} : { deviceType: match.deviceType }),
            approvedAt: isoOf(now),
            approvedBy: input.approvedBy,
            keptByUpdate: false,
            approvalId: random(9).toString("base64url"),
          };
          codes.delete(match.key);
          const notice = {
            id: random(9).toString("base64url"),
            at: isoOf(now),
            message: `New device approved on ${machineName} by ${input.approvedBy}.`,
          };
          return [
            { status: "approved", device },
            {
              ...file,
              devices: [...file.devices.filter((entry) => entry.key !== match.key), device],
              pending: file.pending.filter((entry) => entry.id !== match.id),
              notices: [...file.notices, notice].slice(-MAX_NOTICES),
            },
          ];
        });
      });

    const deny: ConnectDeviceTrustShape["deny"] = (pendingId) =>
      modify((file, now) => {
        const match = file.pending.find((entry) => entry.id === pendingId);
        if (match === undefined) return [false, undefined] as const;
        codes.delete(match.key);
        return [
          true,
          {
            ...file,
            pending: file.pending.filter((entry) => entry.id !== pendingId),
            denied: [
              ...file.denied.filter((entry) => entry.key !== match.key),
              { key: match.key, until: isoOf(now + DEVICE_APPROVAL_DENY_MS) },
            ],
          },
        ] as const;
      });

    const remove: ConnectDeviceTrustShape["remove"] = (key) =>
      modify((file) => {
        const match = file.devices.find((entry) => entry.key === key);
        if (match === undefined) return [null, undefined] as const;
        return [
          match,
          { ...file, devices: file.devices.filter((entry) => entry.key !== key) },
        ] as const;
      });

    const confirmReview: ConnectDeviceTrustShape["confirmReview"] = modify((file, now) => [
      undefined,
      {
        ...file,
        reviewedAt: isoOf(now),
        devices: file.devices.map((entry) =>
          entry.keptByUpdate ? { ...entry, keptByUpdate: false } : entry,
        ),
      },
    ]);

    const repair: ConnectDeviceTrustShape["repair"] = withLock(
      Effect.gen(function* () {
        const loaded = yield* load;
        if (loaded._tag === "ok") return;
        const now = isoOf(yield* Clock.currentTimeMillis);
        codes.clear();
        yield* write({
          version: 1,
          initializedAt: now,
          reviewedAt: now,
          devices: [],
          pending: [],
          denied: [],
          notices: [],
        });
        yield* writeMarker(now);
        yield* Effect.logInfo(
          "Repaired the list of devices that can use this machine; it is empty.",
        );
      }),
    );

    // Read (and on the first start, take the update's snapshot) before any request.
    yield* withLock(load);

    return {
      check,
      bindCredential,
      checkBound,
      boundIds,
      refuseAtMint,
      isApproved,
      snapshot,
      approve,
      deny,
      remove,
      confirmReview,
      repair,
    } satisfies ConnectDeviceTrustShape;
  });

export const make = makeWith();

export const layer = Layer.effect(ConnectDeviceTrust, make);
