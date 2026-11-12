import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  BackgroundPolicySnapshot,
  ClientActivityClientId,
  ClientActivityReportInput,
} from "./background.ts";

const decodeClientActivityClientId = Schema.decodeUnknownSync(ClientActivityClientId);

describe("ClientActivityClientId", () => {
  it("trims and accepts bounded client identifiers", () => {
    expect(decodeClientActivityClientId("  client-1  ")).toBe("client-1");
    expect(decodeClientActivityClientId("x".repeat(128))).toBe("x".repeat(128));
  });

  it("rejects empty and oversized client identifiers", () => {
    expect(() => decodeClientActivityClientId("   ")).toThrow();
    expect(() => decodeClientActivityClientId("x".repeat(129))).toThrow();
  });
});

/** Decodes what arrives on the socket: JSON, with dates as strings. */
const fromWire = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownSync(Schema.toCodecJson(schema) as never) as (value: unknown) => S["Type"];

describe("activity reports across versions", () => {
  const older = {
    clientId: "phone-1",
    clientKind: "mobile",
    visible: true,
    focused: true,
    recentlyInteracted: true,
    scopes: [],
    ttlMs: 45_000,
    observedAt: "2026-11-12T12:00:00.000Z",
  };
  const newer = {
    ...older,
    lastInteractionAt: "2026-11-12T11:59:58.000Z",
    hostEnvironmentId: "env-host",
  };

  it("takes a report from an older app, which sends neither new field", () => {
    const report = fromWire(ClientActivityReportInput)(older);
    expect("lastInteractionAt" in report).toBe(false);
    expect("hostEnvironmentId" in report).toBe(false);
  });

  it("lets an older server read a newer report, ignoring the new fields", () => {
    const {
      lastInteractionAt: _interaction,
      hostEnvironmentId: _host,
      ...fields
    } = ClientActivityReportInput.fields;
    const report = fromWire(Schema.Struct(fields))(newer);
    expect(report.clientId).toBe("phone-1");
    expect("lastInteractionAt" in report).toBe(false);
  });

  it("lets an older app read a newer snapshot, and a newer app read an older one", () => {
    const snapshot = {
      hostPower: {
        source: "unknown",
        idle: "unknown",
        idleSeconds: null,
        locked: "unknown",
        suspended: false,
        onBattery: "unknown",
        lowPowerMode: "unknown",
        thermalState: "unknown",
        stale: true,
        updatedAt: "2026-11-12T12:00:00.000Z",
      },
      leases: [],
      activeForegroundLeaseCount: 0,
      activeScopeKeys: [],
      shouldRunOpportunisticWork: true,
      updatedAt: "2026-11-12T12:00:00.000Z",
    };
    const decode = fromWire(BackgroundPolicySnapshot);
    expect("notificationTarget" in decode(snapshot)).toBe(false);
    expect(decode({ ...snapshot, notificationTarget: null }).notificationTarget).toBeNull();
    const { notificationTarget: _target, ...fields } = BackgroundPolicySnapshot.fields;
    const old = fromWire(Schema.Struct(fields))({
      ...snapshot,
      notificationTarget: { clientId: "client-1", reason: "recent" },
    });
    expect("notificationTarget" in old).toBe(false);
  });
});
