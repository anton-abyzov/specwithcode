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

it.effect("Deny turns a key away for 24 hours, at mint and on every route", () =>
  withMachine(
    Effect.gen(function* () {
      const trust = yield* ConnectDeviceTrust.ConnectDeviceTrust;
      refusedCode(yield* trust.check(connect("intruder")));
      const [pending] = (yield* trust.snapshot).pending;
      expect(yield* trust.deny(pending!.id)).toBe(true);
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
      // Only an approved device can bind anything.
      expect(
        yield* trust.bindCredential({ id: "session:a", key: "jkt:phone", expiresAtMillis: later }),
      ).toBe(false);
      const code = refusedCode(yield* trust.check(connect("phone")));
      yield* trust.approve({ code, approvedBy: "this machine", approverKey: null });
      expect(
        yield* trust.bindCredential({ id: "session:a", key: "jkt:phone", expiresAtMillis: later }),
      ).toBe(true);
      expect(yield* trust.checkBound("session:a")).toEqual({
        _tag: "allowed",
        deviceKey: "jkt:phone",
      });
      expect(yield* trust.check({ subject: "mcp-client", sessionId: "a" })).toEqual({
        _tag: "allowed",
        deviceKey: "jkt:phone",
      });
      expect(yield* trust.checkBound("session:unbound")).toEqual({ _tag: "allowed" });
      expect(yield* trust.boundIds("jkt:phone")).toEqual(["session:a"]);

      yield* trust.remove("jkt:phone");
      expect((yield* trust.check({ subject: "mcp-client", sessionId: "a" }))._tag).toBe("refused");
      // Approving the device again does not revive what it minted before.
      const again = refusedCode(yield* trust.check(connect("phone")));
      yield* trust.approve({ code: again, approvedBy: "this machine", approverKey: null });
      expect((yield* trust.checkBound("session:a"))._tag).toBe("refused");
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
        const approveError = yield* damaged
          .approve({ code: "AAAAAA", approvedBy: "this machine", approverKey: null })
          .pipe(Effect.flip);
        expect(approveError.reason).toBe("damaged");

        yield* damaged.repair;
        expect((yield* damaged.snapshot).health).toBe("ok");
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
  }),
);
