import { describe, expect, it } from "vite-plus/test";

import type { AccountAutoConnectState } from "./grantedAccountMachines";
import {
  CONNECTING_REASON,
  NOT_CONNECTED_REASON,
  handoffAccountMachines,
  handoffFleetOnlyMachines,
} from "./handoffAccountMachines";

const found = (environmentId: string, label: string, availability = "online") => ({
  environment: { environmentId, label },
  availability,
});
const connectOnly = (environmentId: string) => ({
  environmentId,
  label: environmentId.toUpperCase(),
  url: `https://relay.specwithcode.com/e/${environmentId}`,
  workers: { status: "allowed" },
});
const base = {
  savedEnvironmentIds: new Set<string>(["m4"]),
  sourceEnvironmentId: "m4",
  states: new Map<string, AccountAutoConnectState>(),
  fleetPairingSettled: () => false,
};

describe("handoffAccountMachines", () => {
  it("says nothing until the fleet has loaded, so no one is told to grant twice", () => {
    expect(
      handoffAccountMachines({ ...base, discovered: [found("m5", "M5")], fleet: null }),
    ).toEqual({ fallback: [], notAllowed: [] });
  });

  it("shows an allowed machine as connecting while it is saved, with no button", () => {
    expect(
      handoffAccountMachines({
        ...base,
        discovered: [found("m5", "M5")],
        fleet: [connectOnly("m5")],
        states: new Map([["m5", { phase: "connecting" }]]),
      }).fallback,
    ).toEqual([
      {
        environmentId: "m5",
        label: "M5",
        answering: true,
        reason: CONNECTING_REASON,
        connecting: true,
        canConnect: false,
      },
    ]);
  });

  it("keeps a machine's row while the account list is read again", () => {
    expect(
      handoffAccountMachines({
        ...base,
        discovered: [],
        fleet: [connectOnly("m5")],
        states: new Map([["m5", { phase: "connecting" }]]),
      }).fallback.map((machine) => [machine.environmentId, machine.label, machine.connecting]),
    ).toEqual([["m5", "M5", true]]);
  });

  it("names a machine the source has not allowed once, not also as connecting", () => {
    const result = handoffAccountMachines({
      ...base,
      discovered: [found("m5", "M5")],
      fleet: [connectOnly("m5")],
      sourceFleet: [],
      states: new Map([["m5", { phase: "connecting" }]]),
    });
    expect(result.fallback).toEqual([]);
    expect(result.notAllowed.map((machine) => machine.environmentId)).toEqual(["m5"]);
  });

  it("keeps Connect rows while the source machine's fleet cannot be read", () => {
    const result = handoffAccountMachines({
      ...base,
      discovered: [found("m5", "M5")],
      fleet: [connectOnly("m5")],
      sourceFleet: null,
      states: new Map<string, AccountAutoConnectState>([
        ["m5", { phase: "failed", reason: "Could not connect over SpecWithCode Connect." }],
      ]),
    });
    expect(result.fallback.map((machine) => machine.environmentId)).toEqual(["m5"]);
    expect(result.notAllowed).toEqual([]);
  });

  it("offers Connect for a machine that allowed the project's machine but not this one", () => {
    const result = handoffAccountMachines({
      ...base,
      discovered: [found("m6", "M6")],
      fleet: [],
      sourceFleet: [connectOnly("m6")],
    });
    expect(result.fallback.map((machine) => [machine.environmentId, machine.canConnect])).toEqual([
      ["m6", true],
    ]);
    expect(result.notAllowed).toEqual([]);
  });

  it("names a machine whose grant was revoked as not allowed", () => {
    const revoked = { ...connectOnly("m5"), workers: { status: "revoked" } };
    const result = handoffAccountMachines({
      ...base,
      discovered: [found("m5", "M5")],
      fleet: [revoked],
      sourceFleet: [revoked],
    });
    expect(result.notAllowed.map((machine) => machine.environmentId)).toEqual(["m5"]);
  });

  it("offers no Connect while SpecWithCode Connect cannot be reached", () => {
    const [row] = handoffAccountMachines({
      ...base,
      discovered: [found("m5", "M5")],
      fleet: [connectOnly("m5")],
      states: new Map<string, AccountAutoConnectState>([
        ["m5", { phase: "held", reason: "SpecWithCode Connect cannot be reached right now." }],
      ]),
    }).fallback;
    expect(row?.canConnect).toBe(false);
  });

  it("offers Connect with the reason when saving failed or is held", () => {
    const result = handoffAccountMachines({
      ...base,
      discovered: [found("m5", "M5"), found("m6", "M6")],
      fleet: [connectOnly("m5"), connectOnly("m6")],
      states: new Map<string, AccountAutoConnectState>([
        ["m5", { phase: "failed", reason: "Relay refused" }],
        ["m6", { phase: "held", reason: "Removed from this app." }],
      ]),
    });
    expect(
      result.fallback.map((machine) => [machine.environmentId, machine.reason, machine.connecting]),
    ).toEqual([
      ["m5", "Relay refused", false],
      ["m6", "Removed from this app.", false],
    ]);
  });

  it("offers Connect for a tailnet machine once its fleet pairing finished without saving it", () => {
    const tailnet = {
      environmentId: "m1",
      label: "M1",
      url: "https://m1.tail1234.ts.net:3773",
      workers: { status: "allowed" },
    };
    expect(
      handoffAccountMachines({ ...base, discovered: [found("m1", "M1")], fleet: [tailnet] })
        .fallback,
    ).toEqual([]);
    expect(
      handoffAccountMachines({
        ...base,
        discovered: [found("m1", "M1")],
        fleet: [tailnet],
        fleetPairingSettled: (id) => id === "m1",
      }).fallback.map((machine) => machine.reason),
    ).toEqual([NOT_CONNECTED_REASON]);
  });

  it("names an account machine that has not allowed this one yet, by its nickname", () => {
    expect(
      handoffAccountMachines({
        ...base,
        discovered: [found("m7", "Anton M7")],
        fleet: [],
        name: (id, label) => (id === "m7" ? "m7" : label),
      }).notAllowed,
    ).toEqual([{ environmentId: "m7", label: "m7", answering: true }]);
  });
});

describe("handoffFleetOnlyMachines", () => {
  it("names a fleet machine this app cannot reach and the account does not list", () => {
    expect(
      handoffFleetOnlyMachines({
        fleet: [
          { environmentId: "m1", label: "M1", workers: { status: "allowed" } },
          { environmentId: "m5", label: "M5", workers: { status: "allowed" } },
          { environmentId: "m5", label: "M5", workers: { status: "allowed" } },
          { environmentId: "m6", label: "M6", workers: { status: "allowed" } },
          { environmentId: "mini", label: "Mini" },
        ],
        savedEnvironmentIds: new Set(["m1"]),
        sourceEnvironmentId: "mini",
        accountEnvironmentIds: new Set(["m6"]),
      }),
    ).toEqual([{ environmentId: "m5", label: "M5" }]);
  });

  it("does not report machines still pairing, removed here or with a wrong address", () => {
    expect(
      handoffFleetOnlyMachines({
        fleet: [
          {
            environmentId: "m1",
            label: "M1",
            workers: { status: "allowed" },
            url: "https://m1.tail1234.ts.net:3773",
          },
          {
            environmentId: "m2",
            label: "M2",
            workers: { status: "allowed" },
            url: "https://relay.specwithcode.com/e/m2",
          },
          {
            environmentId: "m3",
            workers: { status: "allowed" },
            label: "M3",
            url: "https://relay.specwithcode.com/e/m3",
            status: "identity-mismatch",
          },
        ],
        savedEnvironmentIds: new Set(),
        sourceEnvironmentId: "m4",
        accountEnvironmentIds: new Set(),
        removed: new Set(["m2"]),
        fleetPairingSettled: () => false,
      }),
    ).toEqual([]);
  });
});
