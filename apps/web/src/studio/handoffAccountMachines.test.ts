import { describe, expect, it } from "vite-plus/test";

import {
  AUTO_CONNECT_OFF_REASON,
  NOT_ANSWERING_REASON,
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
});
const base = {
  savedEnvironmentIds: new Set<string>(["m4"]),
  sourceEnvironmentId: "m4",
  autoConnect: true,
  failures: new Map<string, string>(),
};

describe("handoffAccountMachines", () => {
  it("offers no button for an allowed machine that is connecting on its own", () => {
    expect(
      handoffAccountMachines({
        ...base,
        discovered: [found("m5", "M5")],
        fleet: [connectOnly("m5")],
      }),
    ).toEqual({ fallback: [], notAllowed: [] });
  });

  it("offers Connect by hand with the reason when the automatic connection failed", () => {
    expect(
      handoffAccountMachines({
        ...base,
        discovered: [found("m5", "M5")],
        fleet: [connectOnly("m5")],
        failures: new Map([["m5", "Relay refused"]]),
      }).fallback,
    ).toEqual([{ environmentId: "m5", label: "M5", answering: true, reason: "Relay refused" }]);
  });

  it("offers Connect when Connect automatically is off, or the machine is not answering", () => {
    const result = handoffAccountMachines({
      ...base,
      discovered: [found("m5", "M5"), found("m6", "M6", "offline")],
      fleet: [connectOnly("m5"), connectOnly("m6")],
      autoConnect: false,
    });
    expect(result.fallback.map((machine) => [machine.environmentId, machine.reason])).toEqual([
      ["m5", AUTO_CONNECT_OFF_REASON],
      ["m6", AUTO_CONNECT_OFF_REASON],
    ]);
    expect(
      handoffAccountMachines({
        ...base,
        discovered: [found("m6", "M6", "offline")],
        fleet: [connectOnly("m6")],
      }).fallback.map((machine) => machine.reason),
    ).toEqual([NOT_ANSWERING_REASON]);
  });

  it("names an account machine that has not allowed this one yet", () => {
    expect(
      handoffAccountMachines({ ...base, discovered: [found("m7", "M7")], fleet: [] }).notAllowed,
    ).toEqual([{ environmentId: "m7", label: "M7", answering: true }]);
  });

  it("names machines the way the rest of the app does", () => {
    expect(
      handoffAccountMachines({
        ...base,
        discovered: [found("m7", "Anton M7")],
        fleet: [],
        name: (id, label) => (id === "m7" ? "m7" : label),
      }).notAllowed[0]?.label,
    ).toBe("m7");
  });
});

describe("handoffFleetOnlyMachines", () => {
  it("names a fleet machine this app cannot reach and the account does not list", () => {
    expect(
      handoffFleetOnlyMachines({
        fleet: [
          { environmentId: "m1", label: "M1" },
          { environmentId: "m5", label: "M5" },
          { environmentId: "m5", label: "M5" },
          { environmentId: "m6", label: "M6" },
          { environmentId: "mini", label: "Mini" },
        ],
        savedEnvironmentIds: new Set(["m1"]),
        sourceEnvironmentId: "mini",
        accountEnvironmentIds: new Set(["m6"]),
      }),
    ).toEqual([{ environmentId: "m5", label: "M5" }]);
  });
});
