import type { ServerConfig } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findMachineNameHolder,
  knownMachineLabels,
  machineNicknamePatch,
  mergeServerNicknames,
  renameMachineLockText,
  resolveMachineNickname,
} from "./machineNickname";

const config = (machineNicknames: Record<string, { name: string; updatedAt: string }>) =>
  ({ settings: { machineNicknames } }) as unknown as ServerConfig;

describe("resolveMachineNickname", () => {
  it("shows the nickname, else the host label without its owner, else the id", () => {
    const nicknames = { "env-m4": { name: "M4", updatedAt: "2026-10-20T21:00:00.000Z" } };
    expect(resolveMachineNickname(nicknames, "env-m4", "Anton's MacBook M4MAX")).toBe("M4");
    expect(resolveMachineNickname(nicknames, "env-mini", "Anton's Mac mini")).toBe("Mac mini");
    expect(resolveMachineNickname(nicknames, "env-mini")).toBe("env-mini");
  });

  it("keeps an owner-like nickname whole and treats a blank one as the default", () => {
    const nicknames = {
      a: { name: "Anton's Mac", updatedAt: "2026-10-20T21:00:00.000Z" },
      b: { name: "  ", updatedAt: "2026-10-20T21:00:00.000Z" },
    };
    expect(resolveMachineNickname(nicknames, "a", "Host A")).toBe("Anton's Mac");
    expect(resolveMachineNickname(nicknames, "b", "Anna's MacBook Air")).toBe("MacBook Air");
  });
});

describe("mergeServerNicknames", () => {
  it("keeps the newest name for each machine across servers", () => {
    const merged = mergeServerNicknames([
      config({
        m4: { name: "Old", updatedAt: "2026-10-20T20:00:00.000Z" },
        mini: { name: "Mini", updatedAt: "2026-10-20T20:00:00.000Z" },
      }),
      config({ m4: { name: "M4", updatedAt: "2026-10-20T21:00:00.000Z" } }),
    ]);
    expect(merged.m4?.name).toBe("M4");
    expect(merged.mini?.name).toBe("Mini");
  });
});

describe("machineNicknamePatch", () => {
  it("clamps the name to 16 characters and stamps it after the previous rename", () => {
    const previous = { m4: { name: "M4", updatedAt: "2026-10-20T21:00:00.000Z" } };
    const patch = machineNicknamePatch(
      previous,
      "m4",
      "  A very long machine name  ",
      Date.parse("2026-10-20T20:00:00.000Z"),
    );
    expect(patch.machineNicknames.m4?.name).toBe("A very long mach");
    expect(patch.machineNicknames.m4!.updatedAt > previous.m4.updatedAt).toBe(true);
  });

  it("restores the default with an empty name", () => {
    const patch = machineNicknamePatch({}, "m4", "", Date.parse("2026-10-20T21:00:00.000Z"));
    expect(patch.machineNicknames.m4).toEqual({ name: "", updatedAt: "2026-10-20T21:00:00.000Z" });
  });
});

it("explains why a rename is unavailable", () => {
  expect(renameMachineLockText("unsupported")).toMatch(/Update SpecWithCode/);
  expect(renameMachineLockText("no-access")).toMatch(/can't change settings/);
  expect(renameMachineLockText(null)).toBeNull();
});

describe("findMachineNameHolder", () => {
  const nicknames = {
    stale: { name: "m5", updatedAt: "2026-11-11T00:00:00.000Z" },
    live: { name: "m5", updatedAt: "2026-11-13T00:00:00.000Z" },
    m3: { name: "M3", updatedAt: "2026-11-13T00:00:00.000Z" },
  };

  it("ignores a nickname no known machine carries", () => {
    const known = knownMachineLabels({
      saved: new Map(),
      labels: new Map([["live", "Anton M5MAX PROLED"]]),
      fleet: new Map(),
      removed: new Set(),
    });
    expect(findMachineNameHolder(nicknames, known, "live", "M5")).toBeNull();
  });

  it("names a known holder with its computer name, compared without case", () => {
    const known = knownMachineLabels({
      saved: new Map(),
      labels: new Map([
        ["live", "Anton M5MAX PROLED"],
        ["m3", "Mac Studio M3"],
      ]),
      fleet: new Map([["stale", "Anton M5MAX PROLED"]]),
      removed: new Set(),
    });
    expect(findMachineNameHolder(nicknames, known, "live", "m3")).toEqual({
      environmentId: "m3",
      name: "M3",
      label: "Mac Studio M3",
    });
    expect(findMachineNameHolder(nicknames, known, "live", "M5")?.environmentId).toBe("stale");
    expect(findMachineNameHolder(nicknames, known, "stale", "M5")?.environmentId).toBe("live");
  });

  it("forgets a fleet machine removed here", () => {
    const known = knownMachineLabels({
      saved: new Map(),
      labels: new Map([["live", "Anton M5MAX PROLED"]]),
      fleet: new Map([["stale", "Anton M5MAX PROLED"]]),
      removed: new Set(["stale"]),
    });
    expect(findMachineNameHolder(nicknames, known, "live", "M5")).toBeNull();
  });

  it("counts a machine saved here with no config yet, removed before or not", () => {
    const known = knownMachineLabels({
      labels: new Map([["live", "Anton M5MAX PROLED"]]),
      saved: new Map([["stale", "Anton M5MAX PROLED"]]),
      fleet: new Map(),
      removed: new Set(["stale"]),
    });
    expect(findMachineNameHolder(nicknames, known, "live", "M5")).toEqual({
      environmentId: "stale",
      name: "m5",
      label: "Anton M5MAX PROLED",
    });
  });
});
