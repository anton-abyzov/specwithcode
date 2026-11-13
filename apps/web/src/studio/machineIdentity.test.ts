import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => undefined } }));

import { mergeMachineNicknames } from "@specweave-studio/shared/machineNicknames";

import {
  knownMachineIds,
  machineColorProps,
  machineColorWearers,
  machineIdentityPatch,
  resolveMachineIdentities,
  withFleetLabels,
} from "./machineIdentity";

const NOW = Date.parse("2026-11-10T21:00:00.000Z");
const labels = new Map([
  ["env-m4", "Sam's MacBook M4MAX"],
  ["env-m1", "Mac mini M1"],
  ["env-m3", "Mac Studio M3"],
]);
const kinds = new Map([
  ["env-m4", "laptop"],
  ["env-m1", "mac-mini"],
] as const);

describe("resolveMachineIdentities", () => {
  it("defaults a distinct color per known machine and the icon from its kind", () => {
    const resolve = resolveMachineIdentities({ nicknames: {}, labels, kinds });
    const all = [...labels.keys()].map((id) => resolve(id));
    expect(new Set(all.map((identity) => identity.color)).size).toBe(3);
    expect(resolve("env-m4")).toMatchObject({ name: "MacBook M4MAX", icon: "laptop" });
    expect(resolve("env-m1").icon).toBe("mac-mini");
    // Nothing reported: the generic machine, never a guess.
    expect(resolve("env-m3").icon).toBe("server");
  });

  it("uses the chosen name, color and icon", () => {
    const nicknames = {
      "env-m1": {
        name: "M1",
        updatedAt: "2026-11-10T21:00:00.000Z",
        color: "teal",
        icon: "desktop",
      },
    } as const;
    expect(resolveMachineIdentities({ nicknames, labels, kinds })("env-m1")).toEqual({
      environmentId: "env-m1",
      name: "M1",
      color: "teal",
      icon: "desktop",
      short: "M1",
      derivedShort: "M1",
    });
  });

  it("gives every machine a short label of its own, or the one chosen for it", () => {
    const resolve = resolveMachineIdentities({ nicknames: {}, labels, kinds });
    const shorts = [...labels.keys()].map((id) => resolve(id).short);
    expect(new Set(shorts).size).toBe(3);
    for (const short of shorts) expect(short.length).toBeGreaterThanOrEqual(2);
    const chosen = resolveMachineIdentities({
      nicknames: { "env-m3": { name: "", updatedAt: "2026-11-10T21:00:00.000Z", short: "ST" } },
      labels,
      kinds,
    });
    expect(chosen("env-m3").short).toBe("ST");
    // The rename dialog offers the label it would have with none chosen.
    expect(chosen("env-m3").derivedShort).not.toBe("ST");
    expect(chosen("env-unknown", "linux-mini").short).toBe("LM");
    // A machine resolved on its own never repeats a label another machine shows.
    const showing = new Set([...labels.keys()].map((id) => chosen(id).short));
    expect(showing.has(chosen("env-unknown", "Mac Studio M9").short)).toBe(false);
  });

  it("gives a machine it has never seen a color without changing the others", () => {
    const resolve = resolveMachineIdentities({ nicknames: {}, labels, kinds });
    const before = resolve("env-m4").color;
    expect(resolve("env-unknown").color).toBeTruthy();
    expect(resolve("env-m4").color).toBe(before);
  });
});

describe("machines known only from a fleet list", () => {
  const fleet = ["fleet-a", "fleet-b", "fleet-c", "fleet-d", "fleet-e"];

  it("never draws one default color twice while eight are free", () => {
    const resolve = resolveMachineIdentities({ nicknames: {}, labels, kinds, fleet });
    const colors = [...labels.keys(), ...fleet].map((id) => resolve(id).color);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("keeps each machine's color the same wherever it is resolved", () => {
    const first = resolveMachineIdentities({ nicknames: {}, labels, kinds, fleet });
    const again = resolveMachineIdentities({ nicknames: {}, labels, kinds, fleet });
    for (const id of [...labels.keys(), ...fleet]) {
      expect(again(id).color).toBe(first(id).color);
    }
  });

  it("lists who wears each color, the chosen ones too", () => {
    const nicknames = {
      "env-m1": { name: "M1", updatedAt: "2026-11-10T21:00:00.000Z", color: "teal" },
    } as const;
    const input = { nicknames, labels, kinds, fleet: ["fleet-a"] };
    expect(knownMachineIds(input)).toHaveLength(4);
    const wearers = machineColorWearers(input);
    expect(wearers.get("teal")?.map((identity) => identity.name)).toEqual(["M1"]);
    expect([...wearers.values()].flat()).toHaveLength(4);
  });

  it("names a fleet machine never connected here by its computer name, as its card does", () => {
    const listed = new Map([["env-remote-mini", "Living Room"]]);
    const input = {
      nicknames: {},
      labels: withFleetLabels(labels, listed),
      kinds,
      fleet: [...listed.keys()],
    };
    const mini = [...machineColorWearers(input).values()]
      .flat()
      .find((identity) => identity.environmentId === "env-remote-mini");
    expect(mini?.name).toBe("Living Room");
    expect(mini?.short).toBe("LR");
    // A connected machine's own label still wins over the fleet list's.
    const first = [...labels.keys()][0]!;
    expect(withFleetLabels(labels, new Map([[first, "Other"]])).get(first)).toBe(labels.get(first));
  });
});

describe("machineIdentityPatch", () => {
  it("writes the name, color and icon in one stamped entry that a merge keeps", () => {
    const current = { "env-m4": { name: "M4", updatedAt: "2026-11-10T20:00:00.000Z" } };
    const patch = machineIdentityPatch(
      current,
      "env-m4",
      { name: "  M4  ", color: "violet", icon: "laptop" },
      NOW,
    );
    expect(patch.machineNicknames["env-m4"]).toEqual({
      name: "M4",
      updatedAt: "2026-11-10T21:00:00.000Z",
      color: "violet",
      icon: "laptop",
    });
    const merged = mergeMachineNicknames(current, patch.machineNicknames);
    expect(merged["env-m4"]?.color).toBe("violet");
    // A short label is written only when one is given, and a merge keeps it.
    const withShort = machineIdentityPatch(
      merged,
      "env-m4",
      { name: "M4", color: "violet", icon: "laptop", short: " M 4X " },
      NOW + 1,
    );
    expect(withShort.machineNicknames["env-m4"]?.short).toBe("M4X");
    const kept = machineIdentityPatch(
      mergeMachineNicknames(merged, withShort.machineNicknames),
      "env-m4",
      { name: "Desk", color: "violet", icon: "laptop" },
      NOW + 2,
    );
    expect(kept.machineNicknames["env-m4"]?.short).toBe("M4X");
    // A paired machine on an older build answers with the entry stripped: nothing is lost.
    expect(
      mergeMachineNicknames(merged, {
        "env-m4": { name: "M4", updatedAt: "2026-11-10T21:00:00.000Z" },
      }),
    ).toBe(merged);
  });
});

describe("machineIdentityPatch without an icon", () => {
  it("keeps the stored icon, or writes none so the detected kind still decides", () => {
    const stored = {
      "env-m1": { name: "M1", updatedAt: "2026-11-10T21:00:00.000Z", icon: "desktop" },
    } as const;
    const kept = machineIdentityPatch(stored, "env-m1", { name: "M1", color: "rose" }, NOW);
    expect(kept.machineNicknames["env-m1"]).toMatchObject({ color: "rose", icon: "desktop" });
    const none = machineIdentityPatch({}, "env-m4", { name: "", color: "amber" }, NOW);
    expect(none.machineNicknames["env-m4"]).not.toHaveProperty("icon");
  });
});

describe("machineColorProps", () => {
  it("names the palette id, never a hex", () => {
    expect(machineColorProps({ color: "teal" })).toEqual({ "data-machine-color": "teal" });
    expect(machineColorProps(null)).toEqual({});
  });
});
