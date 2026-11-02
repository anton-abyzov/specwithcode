import { EnvironmentId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { FleetConfig, FleetFetch, FleetTarget } from "../studioFleet.ts";
import { fleetProbeFetch, probeFleetList, renderFleetTable } from "./fleetListTable.ts";

const SECRET = "synthetic-management-token";
const CONNECT = "https://prod-0123456789abcdef.spec-weave.com";
const TAILNET = "https://fixture-macbook-pro-m1max-190.fixture000.ts.net";

const machine = (overrides: Partial<FleetTarget> & { id: string }): FleetTarget => ({
  label: overrides.id.toUpperCase(),
  environmentId: EnvironmentId.make(`env-${overrides.id}`),
  url: TAILNET,
  managementToken: SECRET,
  scopes: [] as unknown as FleetTarget["scopes"],
  ...overrides,
});

const fleet = (...machines: FleetTarget[]): FleetConfig => ({ version: 1, machines });

const descriptor = (environmentId: string) =>
  new Response(
    JSON.stringify({
      environmentId,
      label: environmentId,
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "1.0.0",
      capabilities: { repositoryIdentity: true },
    }),
    { status: 200 },
  );

/** Answers per origin; anything unlisted fails like a machine that is off. */
const fetchOf = (answers: Record<string, string>, seen: RequestInit[] = []) =>
  (async (url, init) => {
    seen.push(init ?? {});
    const answer = answers[new URL(String(url)).origin];
    if (answer === undefined) throw new TypeError("fetch failed");
    return descriptor(answer);
  }) as FleetFetch;

describe("fleet list table", () => {
  it("names the live route and the fallback's state, Connect first", async () => {
    const [row] = await probeFleetList({
      config: fleet(machine({ id: "m1", connectUrl: CONNECT })),
      local: null,
      fetch: fetchOf({ [CONNECT]: "env-m1" }),
    });
    expect(row).toMatchObject({
      status: "reachable",
      route: "Connect",
      fallback: "Tailscale no answer",
    });
    expect(row!.addresses.map((address) => address.origin)).toEqual([CONNECT, TAILNET]);
  });

  it("uses the fallback when Connect is down and says both when both answer", async () => {
    const config = fleet(machine({ id: "m1", connectUrl: CONNECT }));
    const [fellBack] = await probeFleetList({
      config,
      local: null,
      fetch: fetchOf({ [TAILNET]: "env-m1" }),
    });
    expect(fellBack).toMatchObject({ route: "Tailscale", fallback: "Connect no answer" });
    const [both] = await probeFleetList({
      config,
      local: null,
      fetch: fetchOf({ [CONNECT]: "env-m1", [TAILNET]: "env-m1" }),
    });
    expect(both).toMatchObject({ route: "Connect", fallback: "Tailscale ok" });
  });

  it("marks this machine, drops its token note and never probes it", async () => {
    const seen: RequestInit[] = [];
    const config = fleet(machine({ id: "m4", managementToken: undefined as never }));
    const [up] = await probeFleetList({
      config,
      local: { environmentId: "env-m4", answering: true },
      fetch: fetchOf({}, seen),
    });
    expect(up).toMatchObject({
      status: "reachable",
      route: "this machine",
      fallback: "-",
      notes: [],
    });
    expect(seen).toEqual([]);
    const [down] = await probeFleetList({
      config,
      local: { environmentId: "env-m4", answering: false },
      fetch: fetchOf({}),
    });
    expect(down).toMatchObject({ status: "unreachable", notes: ["service not answering"] });
  });

  it("keeps the token note for another machine without one", async () => {
    const [row] = await probeFleetList({
      config: fleet(machine({ id: "m1", managementToken: undefined as never })),
      local: { environmentId: "env-m4", answering: true },
      fetch: fetchOf({ [TAILNET]: "env-m1" }),
    });
    expect(row).toMatchObject({ route: "Tailscale", fallback: "none" });
    expect(row!.notes).toEqual(["no management token"]);
  });

  it("does not take a route from an address that answers as another machine", async () => {
    const [mismatch] = await probeFleetList({
      config: fleet(machine({ id: "m1" })),
      local: null,
      fetch: fetchOf({ [TAILNET]: "env-other" }),
    });
    expect(mismatch).toMatchObject({ status: "identity-mismatch", route: "-" });
    const [fallback] = await probeFleetList({
      config: fleet(machine({ id: "m1", connectUrl: CONNECT })),
      local: null,
      fetch: fetchOf({ [CONNECT]: "env-m1", [TAILNET]: "env-other" }),
    });
    expect(fallback).toMatchObject({ route: "Connect", fallback: "Tailscale wrong machine" });
  });

  it("fails a probe to a closed port without a global fetch", async () => {
    await expect(
      fleetProbeFetch("https://127.0.0.1:1/", { signal: AbortSignal.timeout(2_000) }),
    ).rejects.toThrow();
  });

  it("probes in parallel under a short limit and sends no credentials", async () => {
    const seen: RequestInit[] = [];
    const hanging = ((_url, init) => {
      seen.push(init ?? {});
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("timed out")));
      });
    }) as FleetFetch;
    const probing = probeFleetList({
      config: fleet(
        machine({ id: "m1", connectUrl: CONNECT }),
        machine({
          id: "m3",
          url: "https://fixture-macbook-pro.fixture000.ts.net",
          connectUrl: "https://prod-fedcba9876543210.spec-weave.com",
        }),
      ),
      local: null,
      fetch: hanging,
      timeoutMs: 200,
    });
    // Every address is asked before any of them has answered.
    expect(seen).toHaveLength(4);
    const rows = await probing;
    expect(rows.every((row) => row.status === "unreachable")).toBe(true);
    expect(JSON.stringify(seen.map((init) => init.headers ?? null))).not.toContain(SECRET);
  });

  it("aligns under a header, fits a 74-column terminal and prints no token", async () => {
    const rows = await probeFleetList({
      config: fleet(
        machine({ id: "m1", connectUrl: CONNECT }),
        machine({
          id: "fixture-air-machine",
          label: "Fixture Air",
          url: "https://fixture-air-3.fixture000.ts.net",
        }),
      ),
      local: null,
      fetch: fetchOf({ [CONNECT]: "env-m1" }),
    });
    const lines = renderFleetTable(rows);
    expect(lines).toEqual([
      "MACHINE              STATUS       ROUTE    FALLBACK",
      "m1                   reachable    Connect  Tailscale no answer",
      "  Name       M1",
      `  Connect    ${CONNECT}`,
      `  Tailscale  ${TAILNET}`,
      "  Note       management token works over Tailscale only",
      "fixture-air-machine  unreachable  -        -",
      "  Name       Fixture Air",
      "  Tailscale  https://fixture-air-3.fixture000.ts.net",
    ]);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(74);
    expect(lines.join("\n")).not.toContain(SECRET);
  });
});
