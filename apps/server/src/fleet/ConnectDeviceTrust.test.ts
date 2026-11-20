import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthStandardClientScopes } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ConnectDeviceTrust from "./ConnectDeviceTrust.ts";

const CODE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

/** A fresh machine per test: its own database and state folder. */
const layerMachine = () =>
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerEnvironment.layerIdentity),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "studio-device-trust-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const connect = (thumbprint: string, label = "Anton's iPhone") => ({
  subject: ConnectDeviceTrust.CONNECT_SUBJECT,
  proofKeyThumbprint: thumbprint,
  clientLabel: label,
  clientDeviceType: "mobile",
});

const refusedCode = (verdict: ConnectDeviceTrust.TrustVerdict) => {
  if (verdict._tag !== "refused" || verdict.approvalCode === undefined)
    throw new Error(`expected a waiting refusal, got ${JSON.stringify(verdict)}`);
  return verdict.approvalCode;
};

type Machine = Layer.Success<ReturnType<typeof layerMachine>> | Scope.Scope;

const withMachine = <A, E>(test: Effect.Effect<A, E, Machine>) =>
  Effect.scoped(test.pipe(Effect.provide(layerMachine())));

const storePath = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.stateDir, "connect-devices.json");
});

it("gates Connect devices and hub-linked phones only", () => {
  expect(ConnectDeviceTrust.gatedDevice(connect("abc"))).toMatchObject({
    kind: "connect",
    key: "jkt:abc",
  });
  expect(ConnectDeviceTrust.gatedDevice({ subject: "cloud-connect" })?.key).toBeNull();
  expect(ConnectDeviceTrust.gatedDevice({ subject: "phone-link:hub-1:session-9" })).toMatchObject({
    kind: "phone",
    key: "link:phone-link:hub-1:session-9",
    account: "hub:hub-1",
  });
  expect(
    ConnectDeviceTrust.gatedDevice({ subject: "phone-link:hub-1:s", proofKeyThumbprint: "k" })?.key,
  ).toBe("jkt:k");
  for (const subject of [
    "mcp-client",
    "fleet-invitation",
    "local-cli-owner",
    "desktop-bootstrap",
    "one-time-token",
    "device-approval",
  ])
    expect(ConnectDeviceTrust.gatedDevice({ subject, proofKeyThumbprint: "k" })).toBeNull();
});

it.effect("a new device waits with one 6-character code until the owner types it", () =>
  withMachine(
    Effect.gen(function* () {
      const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
      const first = yield* trust.check(connect("phone-key"));
      const code = refusedCode(first);
      expect(code).toMatch(CODE);
      expect(first).toMatchObject({
        message: `Open SpecWithCode on this machine and type this code: ${code}`,
      });
      // One request per key: asking again shows the same code.
      expect(refusedCode(yield* trust.check(connect("phone-key")))).toBe(code);
      const snapshot = yield* trust.snapshot;
      expect(snapshot.pending).toHaveLength(1);
      expect(snapshot.pending[0]).toMatchObject({ kind: "connect", label: "Anton's iPhone" });
      // The listing never carries the code.
      expect(JSON.stringify(snapshot)).not.toContain(code);

      expect(
        yield* trust.approve({ code: "ZZZZZZ", approvedBy: "this machine", approverKey: null }),
      ).toEqual({ status: "not-found" });
      // The asking device cannot approve itself, even holding its own code.
      expect(
        yield* trust.approve({ code, approvedBy: "Anton's iPhone", approverKey: "jkt:phone-key" }),
      ).toEqual({ status: "self" });
      expect((yield* trust.check(connect("phone-key")))._tag).toBe("refused");

      const approved = yield* trust.approve({
        code: code.toLowerCase().replace(/^(...)/, "$1-"),
        approvedBy: "this machine",
        approverKey: null,
      });
      expect(approved).toMatchObject({
        status: "approved",
        device: { key: "jkt:phone-key", approvedBy: "this machine", keptByUpdate: false },
      });
      expect(yield* trust.check(connect("phone-key"))).toEqual({ _tag: "allowed" });
      const after = yield* trust.snapshot;
      expect(after.pending).toHaveLength(0);
      expect(after.notices.map((notice) => notice.message)).toEqual([
        "New device approved on this machine by this machine.",
      ]);
    }),
  ),
);

it.effect(
  "other approved devices hear of an approval; the approver and the new device do not",
  () =>
    withMachine(
      Effect.gen(function* () {
        const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
        const approveNext = (thumbprint: string, label: string, by: string, key: string | null) =>
          Effect.gen(function* () {
            const code = refusedCode(yield* trust.check(connect(thumbprint, label)));
            yield* trust.approve({ code, approvedBy: by, approverKey: key });
            yield* TestClock.adjust("1 minute");
          });
        yield* approveNext("tablet-key", "iPad", "this machine", null);
        yield* approveNext("laptop-key", "Work laptop", "this machine", null);
        yield* approveNext("phone-key", "Anton's iPhone", "Work laptop", "jkt:laptop-key");

        const snapshot = yield* trust.snapshot;
        const seenBy = (key: string | null) =>
          ConnectDeviceTrust.noticesFor(snapshot, key).map((notice) => notice.message);
        const byOwner = "New device approved on this machine by this machine.";
        const byLaptop = "New device approved on this machine by Work laptop.";
        // This machine's own app approved two, and hears that the laptop approved the phone.
        expect(seenBy(null)).toEqual([byLaptop]);
        // The laptop approved the phone itself; the tablet's approval came before it joined.
        expect(seenBy("jkt:laptop-key")).toEqual([]);
        // The phone was the device let in, and joined after the others.
        expect(seenBy("jkt:phone-key")).toEqual([]);
        // The tablet hears of both later approvals, once each, by id.
        const tablet = ConnectDeviceTrust.noticesFor(snapshot, "jkt:tablet-key");
        expect(tablet.map((notice) => notice.message)).toEqual([byOwner, byLaptop]);
        expect(new Set(tablet.map((notice) => notice.id)).size).toBe(2);
        // The parts let each window translate; who approved stays a name, never a device key.
        expect(Object.keys(tablet[0]!).toSorted()).toEqual([
          "approvedBy",
          "at",
          "id",
          "machine",
          "message",
        ]);
      }),
    ),
);

it.effect("caps waiting devices at 3 per account and 20 overall", () =>
  withMachine(
    Effect.gen(function* () {
      const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
      for (const key of ["a", "b", "c"]) refusedCode(yield* trust.check(connect(key)));
      expect(yield* trust.check(connect("d"))).toEqual({
        _tag: "refused",
        message:
          "Too many devices are waiting for approval on this machine. Try again in a few minutes.",
      });
      expect(yield* trust.refuseAtMint({ thumbprint: "d" })).toContain("Too many devices");
      // A hub's phones count against that hub, not against Connect.
      for (let hub = 0; hub < 6; hub += 1)
        for (let phone = 0; phone < 3; phone += 1)
          yield* trust.check({ subject: `phone-link:hub-${hub}:s-${phone}` });
      const snapshot = yield* trust.snapshot;
      expect(snapshot.pending).toHaveLength(ConnectDeviceTrust.DEVICE_APPROVAL_MAX_PENDING);
    }),
  ),
);

it.effect("a waiting request expires after 10 minutes and survives a restart with a new code", () =>
  withMachine(
    Effect.gen(function* () {
      const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
      const before = refusedCode(yield* trust.check(connect("k1")));
      // A second instance over the same file is this machine after a restart.
      const restarted = yield* ConnectDeviceTrust.make;
      expect((yield* restarted.snapshot).pending).toHaveLength(1);
      const after = refusedCode(yield* restarted.check(connect("k1")));
      // The plain code lived in memory only: the waiting device gets a new one.
      expect(after).not.toBe(before);
      expect((yield* restarted.snapshot).pending).toHaveLength(1);
      expect(
        yield* restarted.approve({ code: before, approvedBy: "x", approverKey: null }),
      ).toEqual({ status: "not-found" });
      expect(refusedCode(yield* restarted.check(connect("k1")))).toBe(after);

      yield* TestClock.adjust("11 minutes");
      expect((yield* restarted.snapshot).pending).toHaveLength(0);
      // Asking again starts a fresh request.
      refusedCode(yield* restarted.check(connect("k2")));
    }),
  ),
);

it.effect("a device that keeps asking keeps its request and its code, for 30 minutes at most", () =>
  withMachine(
    Effect.gen(function* () {
      const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
      const code = refusedCode(yield* trust.check(connect("k1")));
      const [asked] = (yield* trust.snapshot).pending;

      // It asks every few minutes, well past the ten a request lives on its own.
      for (const minutes of [4, 4, 4, 4, 4, 4, 4]) {
        yield* TestClock.adjust(`${minutes} minutes`);
        expect(refusedCode(yield* trust.check(connect("k1")))).toBe(code);
      }
      const [kept] = (yield* trust.snapshot).pending;
      expect(kept!.id).toBe(asked!.id);
      expect(kept!.askedAt).toBe(asked!.askedAt);
      // 28 minutes in: never past 30 minutes from the first ask.
      expect(Date.parse(kept!.expiresAt) - Date.parse(asked!.askedAt)).toBe(
        ConnectDeviceTrust.DEVICE_APPROVAL_PENDING_MAX_MS,
      );
      // The code still allows exactly this device.
      yield* TestClock.adjust("1 minute");
      expect(refusedCode(yield* trust.check(connect("k1")))).toBe(code);

      // Past the ceiling the request is gone, and the next ask starts a new one.
      yield* TestClock.adjust("2 minutes");
      expect((yield* trust.snapshot).pending).toHaveLength(0);
      expect(yield* trust.approve({ code, approvedBy: "x", approverKey: null })).toEqual({
        status: "not-found",
      });
      const renewed = refusedCode(yield* trust.check(connect("k1")));
      expect(renewed).not.toBe(code);
      const [again] = (yield* trust.snapshot).pending;
      expect(again!.id).not.toBe(asked!.id);
      const approved = yield* trust.approve({ code: renewed, approvedBy: "x", approverKey: null });
      expect(approved.status).toBe("approved");
    }),
  ),
);

it.effect("the code a device kept past ten minutes still allows it", () =>
  withMachine(
    Effect.gen(function* () {
      const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
      const code = refusedCode(yield* trust.check(connect("k1")));
      for (const minutes of [6, 6, 6]) {
        yield* TestClock.adjust(`${minutes} minutes`);
        expect(refusedCode(yield* trust.check(connect("k1")))).toBe(code);
      }
      // 18 minutes in, past the ten a request lived before: the owner types it now.
      const approved = yield* trust.approve({
        code,
        approvedBy: "this machine",
        approverKey: null,
      });
      expect(approved.status).toBe("approved");
      expect(yield* trust.check(connect("k1"))).toEqual({ _tag: "allowed" });
    }),
  ),
);

it.effect("a device that stops asking still runs out, and its old code allows nothing", () =>
  withMachine(
    Effect.gen(function* () {
      const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
      const fileSystem = yield* FileSystem.FileSystem;
      const code = refusedCode(yield* trust.check(connect("k1")));
      const first = yield* fileSystem.readFileString(yield* storePath);

      // Asking again early changes nothing on disk: more than half its time is left.
      yield* TestClock.adjust("4 minutes");
      expect(refusedCode(yield* trust.check(connect("k1")))).toBe(code);
      expect(yield* fileSystem.readFileString(yield* storePath)).toBe(first);

      // Its last ask was at 8 minutes, so it lives until 18 and no longer.
      yield* TestClock.adjust("4 minutes");
      expect(refusedCode(yield* trust.check(connect("k1")))).toBe(code);
      yield* TestClock.adjust("9 minutes");
      expect((yield* trust.snapshot).pending).toHaveLength(1);
      yield* TestClock.adjust("2 minutes");
      expect((yield* trust.snapshot).pending).toHaveLength(0);
      expect(yield* trust.approve({ code, approvedBy: "x", approverKey: null })).toEqual({
        status: "not-found",
      });
      expect(refusedCode(yield* trust.check(connect("k1")))).not.toBe(code);
    }),
  ),
);

it.effect("keeping one device waiting never extends another, and Deny still ends it", () =>
  withMachine(
    Effect.gen(function* () {
      const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
      const quiet = refusedCode(yield* trust.check(connect("quiet")));
      const busy = refusedCode(yield* trust.check(connect("busy")));
      for (const minutes of [4, 4, 4]) {
        yield* TestClock.adjust(`${minutes} minutes`);
        expect(refusedCode(yield* trust.check(connect("busy")))).toBe(busy);
      }
      // Twelve minutes in: the one that kept asking waits, the other ran out.
      const waiting = (yield* trust.snapshot).pending;
      expect(waiting).toHaveLength(1);
      expect(yield* trust.approve({ code: quiet, approvedBy: "x", approverKey: null })).toEqual({
        status: "not-found",
      });
      // Deny still ends it at once, whatever its expiry says.
      yield* trust.deny(waiting[0]!.id);
      expect((yield* trust.snapshot).pending).toHaveLength(0);
      expect(yield* trust.isTurnedAway("jkt:busy")).toBe(true);
      expect(yield* trust.approve({ code: busy, approvedBy: "x", approverKey: null })).toEqual({
        status: "not-found",
      });
    }),
  ),
);

it.effect("Deny turns a key away for 24 hours, at mint and on every route", () =>
  withMachine(
    Effect.gen(function* () {
      const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
      refusedCode(yield* trust.check(connect("intruder")));
      const [pending] = (yield* trust.snapshot).pending;
      expect(yield* trust.deny(pending!.id)).not.toBeNull();
      const denied = yield* trust.check(connect("intruder"));
      expect(denied).toMatchObject({ _tag: "refused" });
      expect(denied).not.toHaveProperty("approvalCode");
      expect(yield* trust.refuseAtMint({ thumbprint: "intruder" })).toContain(
        "turned this device away",
      );
      yield* TestClock.adjust("25 hours");
      expect(yield* trust.refuseAtMint({ thumbprint: "intruder" })).toBeNull();
    }),
  ),
);

it.effect("Remove takes only that device off the list", () =>
  withMachine(
    Effect.gen(function* () {
      const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
      for (const key of ["laptop", "phone"]) {
        const code = refusedCode(yield* trust.check(connect(key)));
        yield* trust.approve({ code, approvedBy: "this machine", approverKey: null });
      }
      expect((yield* trust.remove("jkt:phone"))?.key).toBe("jkt:phone");
      expect((yield* trust.check(connect("phone")))._tag).toBe("refused");
      expect(yield* trust.check(connect("laptop"))).toEqual({ _tag: "allowed" });
      expect(yield* trust.remove("jkt:phone")).toBeNull();
    }),
  ),
);

const markerPath = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.stateDir, "connect-devices.migrated");
});

/** This machine's first start after the update: no list and no marker yet. */
const forgetSetup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.remove(yield* storePath, { force: true });
  yield* fileSystem.remove(yield* markerPath, { force: true });
});

it.effect("a waiting device is named from its session, never by the pairing link's label", () =>
  withMachine(
    Effect.gen(function* () {
      const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
      const session = {
        subject: ConnectDeviceTrust.CONNECT_SUBJECT,
        proofKeyThumbprint: "m5-key",
        clientLabel: "SpecWithCode Connect connect",
        clientDeviceType: "desktop",
        clientOs: "macOS",
        clientBrowser: "Electron",
        clientUserAgent: "Mozilla/5.0 (Macintosh) SpecWeaveStudio(Alpha)/1.0.338 Electron/39",
      };
      const code = refusedCode(yield* trust.check(session));
      const waiting = (yield* trust.snapshot).pending[0];
      expect(waiting).toMatchObject({
        label: "A Mac",
        named: false,
        system: "macOS",
        app: "SpecWithCode 1.0.338",
      });
      // The device sends its own name later: the request follows it.
      yield* trust.check({ ...session, clientLabel: "M5" });
      expect((yield* trust.snapshot).pending[0]).toMatchObject({ label: "M5", named: true });
      const approved = yield* trust.approve({
        code,
        approvedBy: "this machine",
        approverKey: null,
      });
      if (approved.status !== "approved")
        throw new Error(`expected approval, got ${approved.status}`);
      expect(approved.device).toMatchObject({
        label: "M5",
        named: true,
        system: "macOS",
        app: "SpecWithCode 1.0.338",
      });
      expect(approved.device?.firstSeenAt).toBe(waiting?.askedAt);
      const listed = JSON.stringify(yield* trust.snapshot);
      expect(listed).not.toContain("SpecWithCode Connect connect");
      // The notice carries its parts, so each window can say it in its own language.
      expect((yield* trust.snapshot).notices.at(-1)).toMatchObject({
        machine: "this machine",
        approvedBy: "this machine",
      });
    }),
  ),
);

it.effect("the first start keeps devices with a live session, flagged for one review", () =>
  withMachine(
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      yield* auth.issueSession({
        subject: "cloud-connect",
        proofKeyThumbprint: "kept-key",
        scopes: AuthStandardClientScopes,
        label: "MacBook",
      });
      yield* auth.issueSession({ subject: "local-cli-owner" });
      // The update's moment: a start with no list and no marker, before any request.
      yield* forgetSetup;
      const trust = yield* ConnectDeviceTrust.make;
      const snapshot = yield* trust.snapshot;
      expect(snapshot.devices).toEqual([
        expect.objectContaining({
          key: "jkt:kept-key",
          approvedBy: "the update",
          keptByUpdate: true,
        }),
      ]);
      expect(snapshot.needsReview).toBe(true);
      expect(yield* trust.check(connect("kept-key"))).toEqual({ _tag: "allowed" });
      yield* trust.confirmReview;
      const reviewed = yield* trust.snapshot;
      expect(reviewed.needsReview).toBe(false);
      expect(reviewed.devices[0]?.keptByUpdate).toBe(false);
    }),
  ),
);

it.effect(
  "the first start keeps a hub-linked phone; a Connect session with no key asks again",
  () =>
    withMachine(
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        yield* auth.issueSession({
          subject: "phone-link:hub-1:session-9",
          scopes: AuthStandardClientScopes,
          label: "iPhone",
        });
        // Stored before Connect sessions recorded their key, and not used since.
        yield* auth.issueSession({ subject: "cloud-connect", scopes: AuthStandardClientScopes });
        yield* forgetSetup;
        const trust = yield* ConnectDeviceTrust.make;
        expect((yield* trust.snapshot).devices.map((device) => device.key)).toEqual([
          "link:phone-link:hub-1:session-9",
        ]);
        expect(yield* trust.check({ subject: "phone-link:hub-1:session-9" })).toEqual({
          _tag: "allowed",
        });
        // No key names that device, so the update cannot keep it: it is asked to
        // sign in again and then waits for one approval, like a new device.
        const keyless = yield* trust.check({ subject: "cloud-connect" });
        expect(keyless).toMatchObject({ _tag: "refused" });
        expect(keyless).not.toHaveProperty("approvalCode");
        refusedCode(yield* trust.check(connect("old-key")));
      }),
    ),
);

it.effect("a device that signs in after the start is never kept by the update", () =>
  withMachine(
    Effect.gen(function* () {
      // The machine has started; a phone redeems a Connect code only now.
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      yield* auth.issueSession({
        subject: "cloud-connect",
        proofKeyThumbprint: "late-phone",
        scopes: AuthStandardClientScopes,
        label: "Late iPhone",
      });
      const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
      expect((yield* trust.snapshot).devices).toEqual([]);
      refusedCode(yield* trust.check(connect("late-phone")));
    }),
  ),
);

it.effect(
  "an approval holds across restarts, and a later start never takes a new snapshot (1416)",
  () =>
    withMachine(
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
        const code = refusedCode(yield* trust.check(connect("m1-key", "Laptop")));
        const approved = yield* trust.approve({
          code,
          approvedBy: "this machine",
          approverKey: null,
        });
        expect(approved.status).toBe("approved");
        const setUpAt = (yield* trust.snapshot).devices[0]!.approvedAt;

        // Restarted twice: the same device is let in, asked nothing, listed once.
        for (let restart = 0; restart < 2; restart++) {
          const restarted = yield* ConnectDeviceTrust.make;
          expect(yield* restarted.check(connect("m1-key", "Laptop"))).toEqual({
            _tag: "allowed",
          });
          const snapshot = yield* restarted.snapshot;
          expect(snapshot.pending).toEqual([]);
          expect(snapshot.devices.map((device) => device.key)).toEqual(["jkt:m1-key"]);
          expect(snapshot.devices[0]!.approvedAt).toBe(setUpAt);
        }

        // A device with a live session at a later start is not kept: only the first start keeps.
        yield* auth.issueSession({
          subject: "cloud-connect",
          proofKeyThumbprint: "signed-in-later",
          scopes: AuthStandardClientScopes,
          label: "MacBook",
        });
        const later = yield* ConnectDeviceTrust.make;
        refusedCode(yield* later.check(connect("signed-in-later", "MacBook")));
        expect((yield* later.snapshot).devices.map((device) => device.key)).toEqual(["jkt:m1-key"]);
      }),
    ),
);

it.effect("a device the update kept is still let in after later restarts (1416)", () =>
  withMachine(
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      yield* auth.issueSession({
        subject: "cloud-connect",
        proofKeyThumbprint: "kept-key",
        scopes: AuthStandardClientScopes,
        label: "MacBook",
      });
      yield* forgetSetup;
      const first = yield* ConnectDeviceTrust.make;
      expect(yield* first.check(connect("kept-key"))).toEqual({ _tag: "allowed" });
      for (let restart = 0; restart < 2; restart++) {
        const restarted = yield* ConnectDeviceTrust.make;
        expect(yield* restarted.check(connect("kept-key"))).toEqual({ _tag: "allowed" });
        expect((yield* restarted.snapshot).devices).toEqual([
          expect.objectContaining({ key: "jkt:kept-key", approvedBy: "the update" }),
        ]);
      }
    }),
  ),
);

it.effect("a lost list after setup refuses remote devices instead of keeping them", () =>
  withMachine(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
      // A device that is waiting, with a live session, when the list goes missing.
      yield* auth.issueSession({
        subject: "cloud-connect",
        proofKeyThumbprint: "waiting-key",
        scopes: AuthStandardClientScopes,
      });
      refusedCode(yield* trust.check(connect("waiting-key")));
      yield* fileSystem.remove(yield* storePath);

      const restarted = yield* ConnectDeviceTrust.make;
      const refused = yield* restarted.check(connect("waiting-key"));
      expect(refused).toMatchObject({ _tag: "refused" });
      expect(refused).not.toHaveProperty("approvalCode");
      expect((yield* restarted.snapshot).health).toBe("damaged");
      expect(yield* restarted.check({ subject: "local-cli-owner" })).toEqual({ _tag: "allowed" });

      yield* restarted.repair;
      expect((yield* restarted.snapshot).devices).toEqual([]);
      refusedCode(yield* restarted.check(connect("waiting-key")));
    }),
  ),
);

it.effect("a credential a device minted lasts only as long as that approval", () =>
  withMachine(
    Effect.gen(function* () {
      const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
      const later = Date.UTC(2100, 0, 1);
      // Only an approved device gets a binding.
      expect(yield* trust.bindingFor("jkt:phone")).toBeNull();
      const code = refusedCode(yield* trust.check(connect("phone")));
      yield* trust.approve({ code, approvedBy: "this machine", approverKey: null });
      const binding = yield* trust.bindingFor("jkt:phone");
      expect(binding?.key).toBe("jkt:phone");
      if (binding === null) return;
      yield* trust.trackCredential({ id: "session:a", binding, expiresAtMillis: later });
      expect(yield* trust.checkBinding(binding)).toEqual({
        _tag: "allowed",
        deviceKey: "jkt:phone",
      });
      expect(yield* trust.check({ subject: "mcp-client", boundDevice: binding })).toEqual({
        _tag: "allowed",
        deviceKey: "jkt:phone",
      });
      expect(yield* trust.check({ subject: "mcp-client" })).toEqual({ _tag: "allowed" });
      expect(yield* trust.boundIds("jkt:phone")).toEqual(["session:a"]);

      yield* trust.remove("jkt:phone");
      expect((yield* trust.check({ subject: "mcp-client", boundDevice: binding }))._tag).toBe(
        "refused",
      );
      // Approving the device again does not revive what it minted before.
      const again = refusedCode(yield* trust.check(connect("phone")));
      yield* trust.approve({ code: again, approvedBy: "this machine", approverKey: null });
      expect((yield* trust.checkBinding(binding))._tag).toBe("refused");
    }),
  ),
);

it.effect("a damaged or repaired list refuses what a device was given, never lets it through", () =>
  withMachine(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
      const code = refusedCode(yield* trust.check(connect("phone")));
      yield* trust.approve({ code, approvedBy: "this machine", approverKey: null });
      const binding = yield* trust.bindingFor("jkt:phone");
      if (binding === null) throw new Error("expected a binding");
      const bound = { subject: "mcp-client", boundDevice: binding };
      expect((yield* trust.check(bound))._tag).toBe("allowed");

      // The list stops parsing: the device's state is unknown, so its credential stops.
      yield* fileSystem.writeFileString(yield* storePath, "{ not json");
      const damaged = yield* ConnectDeviceTrust.make;
      expect((yield* damaged.check(bound))._tag).toBe("refused");
      expect((yield* damaged.checkBinding(binding))._tag).toBe("refused");
      expect(yield* damaged.bindingFor("jkt:phone")).toBeNull();
      // This machine's own sessions keep working.
      expect(yield* damaged.check({ subject: "local-cli-owner" })).toEqual({ _tag: "allowed" });

      // Repair empties the list; the binding the credential carries is still refused.
      yield* damaged.repair;
      expect((yield* damaged.check(bound))._tag).toBe("refused");
    }),
  ),
);

it.effect("a removed or denied key is refused even under subjects the gate exempts", () =>
  withMachine(
    Effect.gen(function* () {
      const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
      const exempt = (thumbprint: string) => ({
        subject: "one-time-token",
        proofKeyThumbprint: thumbprint,
      });
      expect(yield* trust.check(exempt("phone"))).toEqual({ _tag: "allowed" });
      const code = refusedCode(yield* trust.check(connect("phone")));
      yield* trust.approve({ code, approvedBy: "this machine", approverKey: null });
      yield* trust.remove("jkt:phone");
      expect(yield* trust.isTurnedAway("jkt:phone")).toBe(true);
      expect((yield* trust.check(exempt("phone")))._tag).toBe("refused");

      refusedCode(yield* trust.check(connect("laptop")));
      const [waiting] = (yield* trust.snapshot).pending;
      expect(yield* trust.deny(waiting!.id)).toBe("jkt:laptop");
      expect((yield* trust.check(exempt("laptop")))._tag).toBe("refused");

      // Approved again, the key is welcome under any subject.
      const again = refusedCode(yield* trust.check(connect("phone")));
      yield* trust.approve({ code: again, approvedBy: "this machine", approverKey: null });
      expect(yield* trust.check(exempt("phone"))).toEqual({ _tag: "allowed" });
    }),
  ),
);

it.effect(
  "the list is written owner-only, and a damaged one refuses remote devices until repaired",
  () =>
    withMachine(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const file = yield* storePath;
        const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
        yield* trust.snapshot;
        expect(((yield* fileSystem.stat(file)).mode & 0o777).toString(8)).toBe("600");

        yield* fileSystem.writeFileString(file, "{ not json");
        const damaged = yield* ConnectDeviceTrust.make;
        const refused = yield* damaged.check(connect("any"));
        expect(refused).toMatchObject({ _tag: "refused" });
        expect(refused).not.toHaveProperty("approvalCode");
        expect((yield* damaged.snapshot).health).toBe("damaged");
        // Local sessions never pass through the gate.
        expect(yield* damaged.check({ subject: "local-cli-owner" })).toEqual({ _tag: "allowed" });
        expect(yield* damaged.check({ subject: "mcp-client", proofKeyThumbprint: "x" })).toEqual({
          _tag: "allowed",
        });
        // The shared check still allows a proof key when the list cannot be read.
        expect(yield* damaged.listReadable).toBe(false);
        const approveError = yield* damaged
          .approve({ code: "AAAAAA", approvedBy: "this machine", approverKey: null })
          .pipe(Effect.flip);
        expect(approveError.reason).toBe("damaged");

        yield* damaged.repair;
        expect((yield* damaged.snapshot).health).toBe("ok");
        expect(yield* damaged.listReadable).toBe(true);
        refusedCode(yield* damaged.check(connect("any")));
      }),
    ),
);

it.effect("unwired, the gate refuses every gated device and lets local sessions through", () =>
  Effect.gen(function* () {
    const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
    expect((yield* trust.check(connect("k")))._tag).toBe("refused");
    expect((yield* trust.check({ subject: "phone-link:h:s" }))._tag).toBe("refused");
    expect(yield* trust.check({ subject: "desktop-bootstrap" })).toEqual({ _tag: "allowed" });
    // No store: the list was not read, so a caller that asks must hear that.
    expect(yield* trust.listReadable).toBe(false);
  }),
);

// 1406: several devices that look alike.
const SHORT_ID = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;
/** The vectors `packages/shared/src/deviceShortId.test.ts` and the iPhone tests assert. */
const KEY_TSKR = "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs";
const KEY_9229 = "_wAA_0FCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1w";

it("gives every device key a short ID, the thumbprint's own for a Connect device", () => {
  expect(ConnectDeviceTrust.deviceShortIdOfKey(`jkt:${KEY_TSKR}`)).toBe("TSKR");
  expect(ConnectDeviceTrust.deviceShortIdOfKey(`jkt:${KEY_9229}`)).toBe("9229");
  // A hub-linked phone without a key, and a key that is no thumbprint, still get one.
  for (const key of ["link:phone-link:hub-1:session-9", "jkt:k", "jkt:not a thumbprint"]) {
    const id = ConnectDeviceTrust.deviceShortIdOfKey(key);
    expect(id).toMatch(SHORT_ID);
    expect(ConnectDeviceTrust.deviceShortIdOfKey(key)).toBe(id);
  }
});

it.effect("two phones with one name read differently, and the typed code picks the phone", () =>
  withMachine(
    Effect.gen(function* () {
      const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
      const fileSystem = yield* FileSystem.FileSystem;
      refusedCode(yield* trust.check(connect(KEY_TSKR, "iPhone")));
      const secondCode = refusedCode(yield* trust.check(connect(KEY_9229, "iPhone")));
      const waiting = (yield* trust.snapshot).pending;
      expect(waiting.map((request) => [request.label, request.shortId])).toEqual([
        ["iPhone", "TSKR"],
        ["iPhone", "9229"],
      ]);

      // The owner types the second phone's code while the first is listed first.
      const approved = yield* trust.approve({
        code: secondCode,
        approvedBy: "this machine",
        approverKey: null,
      });
      if (approved.status !== "approved")
        throw new Error(`expected approval, got ${approved.status}`);
      expect(approved.device.key).toBe(`jkt:${KEY_9229}`);
      expect(ConnectDeviceTrust.listedDevice(approved.device).shortId).toBe("9229");

      const after = yield* trust.snapshot;
      expect(after.pending.map((request) => request.shortId)).toEqual(["TSKR"]);
      expect(after.devices.map((device) => [device.label, device.shortId])).toEqual([
        ["iPhone", "9229"],
      ]);
      expect((yield* trust.check(connect(KEY_TSKR, "iPhone")))._tag).toBe("refused");
      // The ID is made when the list is read: the file keeps its 1327 shape.
      expect(yield* fileSystem.readFileString(yield* storePath)).not.toContain("shortId");
    }),
  ),
);

it.effect(
  "a waiting device keeps one reference across requests, and a look-alike has another",
  () =>
    withMachine(
      Effect.gen(function* () {
        const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
        const fileSystem = yield* FileSystem.FileSystem;
        // Same name and the same four characters, another key.
        const twin = `${KEY_TSKR.slice(0, 6)}${"A".repeat(KEY_TSKR.length - 6)}`;
        refusedCode(yield* trust.check(connect(KEY_TSKR, "iPhone")));
        refusedCode(yield* trust.check(connect(twin, "iPhone")));
        const [real, alike] = (yield* trust.snapshot).pending;
        expect(real!.shortId).toBe(alike!.shortId);
        expect(real!.device).not.toBe(alike!.device);
        expect(real!.device).toBe(ConnectDeviceTrust.deviceReferenceOfKey(`jkt:${KEY_TSKR}`));
        // The reference is not the key and does not carry it.
        expect(real!.device).not.toContain(KEY_TSKR);

        // Its request runs out and it asks again: a new request, the same reference.
        yield* TestClock.adjust("11 minutes");
        refusedCode(yield* trust.check(connect(KEY_TSKR, "iPhone")));
        const [renewed] = (yield* trust.snapshot).pending;
        expect(renewed!.id).not.toBe(real!.id);
        expect(renewed!.device).toBe(real!.device);
        // Made when the list is read, like the short ID: the file does not hold it.
        expect(yield* fileSystem.readFileString(yield* storePath)).not.toContain(real!.device);
      }),
    ),
);

it.effect("a device that looks like an allowed one gets nothing without its own code", () =>
  withMachine(
    Effect.gen(function* () {
      const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
      const code = refusedCode(yield* trust.check(connect(KEY_TSKR, "iPhone")));
      yield* trust.approve({ code, approvedBy: "this machine", approverKey: null });

      // Same name and, with a ground key, the same four characters.
      const twin = `${KEY_TSKR.slice(0, 6)}${"A".repeat(KEY_TSKR.length - 6)}`;
      expect(ConnectDeviceTrust.deviceShortIdOfKey(`jkt:${twin}`)).toBe("TSKR");
      const twinCode = refusedCode(yield* trust.check(connect(twin, "iPhone")));
      expect(twinCode).not.toBe(code);
      expect((yield* trust.check(connect(twin, "iPhone")))._tag).toBe("refused");
      expect(yield* trust.isApproved(`jkt:${twin}`)).toBe(false);
      // The spent code of the device it imitates does not let it in either.
      expect(yield* trust.approve({ code, approvedBy: "this machine", approverKey: null })).toEqual(
        { status: "not-found" },
      );

      const listed = yield* trust.snapshot;
      expect(listed.devices.map((device) => device.key)).toEqual([`jkt:${KEY_TSKR}`]);
      expect(listed.pending.map((request) => request.shortId)).toEqual(["TSKR"]);
      // Turning the twin away or removing the real one never touches the other.
      yield* trust.deny(listed.pending[0]!.id);
      expect(yield* trust.check(connect(KEY_TSKR, "iPhone"))).toEqual({ _tag: "allowed" });
      yield* trust.remove(`jkt:${KEY_TSKR}`);
      expect(yield* trust.isTurnedAway(`jkt:${twin}`)).toBe(true);
      expect(yield* trust.isApproved(`jkt:${twin}`)).toBe(false);
    }),
  ),
);

it.effect("a list written before short IDs loads unchanged and is listed with them", () =>
  withMachine(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* ConnectDeviceTrust.ConnectDeviceTrust;
      const file = yield* storePath;
      const written = JSON.stringify({
        version: 1,
        initializedAt: "2026-11-17T23:42:28.000Z",
        reviewedAt: null,
        devices: [
          {
            key: `jkt:${KEY_TSKR}`,
            kind: "connect",
            label: "An iPhone",
            deviceType: "mobile",
            named: false,
            system: "iOS",
            app: "SpecWithCode",
            firstSeenAt: "2026-11-17T23:39:59.000Z",
            approvedAt: "2026-11-17T23:42:28.000Z",
            approvedBy: "the update",
            keptByUpdate: true,
            approvalId: "kept-1",
          },
        ],
        pending: [],
        denied: [],
        notices: [],
      });
      yield* fileSystem.writeFileString(file, written);

      const restarted = yield* ConnectDeviceTrust.make;
      const snapshot = yield* restarted.snapshot;
      expect(snapshot.health).toBe("ok");
      expect(snapshot.devices).toMatchObject([
        { label: "An iPhone", shortId: "TSKR", keptByUpdate: true },
      ]);
      expect(yield* restarted.check(connect(KEY_TSKR, "iPhone"))).toEqual({ _tag: "allowed" });
      // Reading the list wrote nothing.
      expect(yield* fileSystem.readFileString(file)).toBe(written);
    }),
  ),
);
