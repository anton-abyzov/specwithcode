import type { StudioFleetSnapshot } from "@specweave-studio/contracts/studioFleet";
import type { RelayClientEnvironmentRecord } from "@specweave-studio/contracts/relay";
import { describe, expect, it } from "vite-plus/test";

import {
  accountAutoConnectStates,
  grantedAccountMachinesToConnect,
  grantedMachinesMissingFromAccount,
  publishAccountAutoConnectStates,
} from "./grantedAccountMachines";

const CONNECT_URL = "https://relay.specwithcode.com/e/m5";

const fleet = (
  ...machines: Array<{ environmentId: string; url?: string; status?: string }>
): StudioFleetSnapshot =>
  ({
    machines: machines.map((machine) => ({
      id: `fleet-${machine.environmentId}`,
      label: machine.environmentId.toUpperCase(),
      environmentId: machine.environmentId,
      url: machine.url ?? CONNECT_URL,
      status: machine.status ?? "reachable",
      pairingConfigured: true,
    })),
  }) as unknown as StudioFleetSnapshot;

const account = (...ids: string[]) =>
  new Map(
    ids.map((id) => [
      id,
      {
        environment: { environmentId: id, label: id.toUpperCase() } as RelayClientEnvironmentRecord,
      },
    ]),
  );

describe("grantedAccountMachinesToConnect", () => {
  it("saves a same-account, Connect-only machine that allowed this one, with no shared project", () => {
    // The M5 case: signed in to the same Connect account, no Tailscale address,
    // no copy of any project here, and its grant put it in this server's fleet.
    expect(
      grantedAccountMachinesToConnect({
        snapshot: fleet({ environmentId: "m5" }),
        currentEnvironmentId: "m4",
        savedEnvironmentIds: new Set(["m4"]),
        discovered: account("m4", "m5"),
        skip: new Set(),
      }).map((machine) => machine.environmentId),
    ).toEqual(["m5"]);
  });

  it("leaves tailnet machines to fleet pairing, and skips saved, removed or mismatched ones", () => {
    expect(
      grantedAccountMachinesToConnect({
        snapshot: fleet(
          { environmentId: "m1", url: "https://m1.tail1234.ts.net:3773" },
          { environmentId: "m3" },
          { environmentId: "mini" },
          { environmentId: "m6", status: "identity-mismatch" },
          { environmentId: "m4" },
        ),
        currentEnvironmentId: "m4",
        savedEnvironmentIds: new Set(["m3"]),
        discovered: account("m1", "m3", "mini", "m6", "m4"),
        skip: new Set(["mini"]),
      }),
    ).toEqual([]);
  });

  it("does not save an account machine that never allowed this one", () => {
    expect(
      grantedAccountMachinesToConnect({
        snapshot: fleet(),
        currentEnvironmentId: "m4",
        savedEnvironmentIds: new Set(),
        discovered: account("m5"),
        skip: new Set(),
      }),
    ).toEqual([]);
  });

  it("asks for the account list again when the fleet has a Connect machine it lacks", () => {
    expect(
      grantedMachinesMissingFromAccount({
        snapshot: fleet({ environmentId: "m5" }, { environmentId: "m3" }),
        currentEnvironmentId: "m4",
        savedEnvironmentIds: new Set(),
        discovered: account("m3"),
      }),
    ).toEqual(["m5"]);
  });

  it("includes a tailnet machine only when it was asked for by hand", () => {
    const input = {
      snapshot: fleet({ environmentId: "m1", url: "https://m1.tail1234.ts.net:3773" }),
      currentEnvironmentId: "m4",
      savedEnvironmentIds: new Set<string>(),
      discovered: account("m1"),
    };
    expect(grantedAccountMachinesToConnect(input)).toEqual([]);
    expect(
      grantedAccountMachinesToConnect({ ...input, requested: new Set(["m1"]) }).map(
        (machine) => machine.environmentId,
      ),
    ).toEqual(["m1"]);
  });

  it("publishes one state per machine, and only when it changes", () => {
    publishAccountAutoConnectStates(new Map([["m5", { phase: "connecting" }]]));
    const first = accountAutoConnectStates();
    publishAccountAutoConnectStates(new Map([["m5", { phase: "connecting" }]]));
    expect(accountAutoConnectStates()).toBe(first);
    publishAccountAutoConnectStates(
      new Map([["m5", { phase: "failed", reason: "Relay refused" }]]),
    );
    expect(accountAutoConnectStates().get("m5")).toEqual({
      phase: "failed",
      reason: "Relay refused",
    });
    publishAccountAutoConnectStates(new Map());
  });
});
