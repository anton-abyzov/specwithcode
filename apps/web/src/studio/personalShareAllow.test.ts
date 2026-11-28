import type {
  StudioFleetMachine,
  StudioFleetWorkerAccess,
  StudioFleetWorkers,
} from "@specweave-studio/contracts/studioFleet";
import { describe, expect, it } from "vite-plus/test";

import { allowShareMachine, type ShareAllowDeps } from "./personalShareAllow";

const workers = (
  status: StudioFleetWorkers["status"],
  access: StudioFleetWorkerAccess | null = null,
) => ({ status, access, expiresAt: null, renewable: false, problem: null }) as StudioFleetWorkers;

const machine = (environmentId: string, held?: StudioFleetWorkers) =>
  ({
    id: `id-${environmentId}`,
    label: environmentId,
    environmentId,
    url: "https://example.invalid",
    status: "reachable",
    pairingConfigured: true,
    ...(held === undefined ? {} : { workers: held }),
  }) as unknown as StudioFleetMachine;

const deps = (over: Partial<ShareAllowDeps> & { calls?: string[] } = {}): ShareAllowDeps => {
  const calls = over.calls ?? [];
  return {
    machines: async () => [machine("env-m4", workers("allowed", "full-access"))],
    allowThere: async (id, access) => {
      calls.push(`there ${id} ${access}`);
      return workers("allowed", access);
    },
    allowHere: async (id, access) => {
      calls.push(`here ${id} ${access}`);
      return workers("allowed", access);
    },
    ...over,
  };
};

describe("allowShareMachine: Allow on a Percy row with no access (1448)", () => {
  it("allows work there first, keeping the access level a grant already has", async () => {
    const calls: string[] = [];
    expect(await allowShareMachine(deps({ calls }), "env-m4", "m4")).toEqual({
      ok: true,
      direction: "there",
    });
    expect(calls).toEqual(["there id-env-m4 full-access"]);
  });

  it("lets the other machine run work here when it refuses the first direction", async () => {
    const calls: string[] = [];
    const result = await allowShareMachine(
      deps({
        calls,
        allowThere: async (id) => {
          calls.push(`there ${id}`);
          return workers("not_allowed");
        },
      }),
      "env-m4",
      "m4",
    );
    expect(result).toEqual({ ok: true, direction: "here" });
    expect(calls).toEqual(["there id-env-m4", "here id-env-m4 full-access"]);
  });

  it("says why when both directions fail, and never reports success", async () => {
    const result = await allowShareMachine(
      deps({
        allowThere: async () => {
          throw new Error("That machine could not be reached.");
        },
        allowHere: async () => workers("revoked"),
      }),
      "env-m4",
      "m4",
    );
    expect(result).toEqual({
      ok: false,
      reason: "refused",
      message: "m4 did not allow work with this machine. That machine could not be reached.",
    });
  });

  it("refuses a machine this machine does not list, without calling anything", async () => {
    const calls: string[] = [];
    const result = await allowShareMachine(deps({ calls }), "env-win", "win");
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("hands the line over through Connect when the other machine refuses the saved key (HTTP 401)", async () => {
    const calls: string[] = [];
    const result = await allowShareMachine(
      deps({
        calls,
        allowThere: async () => workers("not_allowed"),
        allowHere: async () => {
          throw new Error("M1 refused: M1 answered HTTP 401.");
        },
        throughAccount: async (access) => {
          calls.push(`account ${access}`);
          return workers("allowed", access);
        },
      }),
      "env-m4",
      "m4",
    );
    expect(result).toEqual({ ok: true, direction: "account" });
    expect(calls).toEqual(["account full-access"]);
  });

  it("never uses the Connect route while a saved key still works", async () => {
    const calls: string[] = [];
    const result = await allowShareMachine(
      deps({
        calls,
        throughAccount: async () => {
          calls.push("account");
          return workers("allowed");
        },
      }),
      "env-m4",
      "m4",
    );
    expect(result).toEqual({ ok: true, direction: "there" });
    expect(calls).toEqual(["there id-env-m4 full-access"]);
  });

  it("allows a machine this machine does not list through Connect, at the default access", async () => {
    const calls: string[] = [];
    const result = await allowShareMachine(
      deps({
        calls,
        throughAccount: async (access) => {
          calls.push(`account ${access}`);
          return workers("allowed", access);
        },
      }),
      "env-win",
      "win",
    );
    expect(result).toEqual({ ok: true, direction: "account" });
    expect(calls).toEqual(["account full-access"]);
  });

  it("names every route's reason when all three fail", async () => {
    const result = await allowShareMachine(
      deps({
        allowThere: async () => workers("not_allowed"),
        allowHere: async () => {
          throw new Error("M1 refused: M1 answered HTTP 401.");
        },
        throughAccount: async () => {
          throw new Error("Connect to m1 first.");
        },
      }),
      "env-m4",
      "m1",
    );
    expect(result).toEqual({
      ok: false,
      reason: "refused",
      message:
        "m1 did not allow work with this machine. M1 refused: M1 answered HTTP 401. Connect to m1 first.",
    });
  });
});
