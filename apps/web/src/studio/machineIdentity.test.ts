import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => undefined } }));

import { mergeMachineNicknames } from "@specweave-studio/shared/machineNicknames";

import {
  machineColorProps,
  machineIdentityPatch,
  resolveMachineIdentities,
} from "./machineIdentity";

const NOW = Date.parse("2026-11-10T21:00:00.000Z");
const labels = new Map([
  ["env-m4", "Anton's MacBook M4MAX"],
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
    });
  });

  it("gives a machine it has never seen a color without changing the others", () => {
    const resolve = resolveMachineIdentities({ nicknames: {}, labels, kinds });
    const before = resolve("env-m4").color;
    expect(resolve("env-unknown").color).toBeTruthy();
    expect(resolve("env-m4").color).toBe(before);
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
    // A paired machine on an older build answers with the entry stripped: nothing is lost.
    expect(
      mergeMachineNicknames(merged, {
        "env-m4": { name: "M4", updatedAt: "2026-11-10T21:00:00.000Z" },
      }),
    ).toBe(merged);
  });
});

describe("machineColorProps", () => {
  it("names the palette id, never a hex", () => {
    expect(machineColorProps({ color: "teal" })).toEqual({ "data-machine-color": "teal" });
    expect(machineColorProps(null)).toEqual({});
  });
});
