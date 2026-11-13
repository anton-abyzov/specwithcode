import { EnvironmentId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  hasNoCopyHere,
  localCopiesFirst,
  remoteOnlyMachines,
  type SidebarProjectSnapshot,
} from "./sidebarProjectGrouping";

const m5 = EnvironmentId.make("env-m5");
const m1 = EnvironmentId.make("env-m1");

function group(
  presence: SidebarProjectSnapshot["environmentPresence"],
  members: ReadonlyArray<{ environmentId: EnvironmentId; environmentLabel: string | null }>,
  allRemoteMembersAreDesktopLocal = false,
) {
  return {
    environmentPresence: presence,
    allRemoteMembersAreDesktopLocal,
    memberProjects: members as unknown as SidebarProjectSnapshot["memberProjects"],
  };
}

const nameOf = (id: EnvironmentId, label: string | null) =>
  id === m5 ? "M5" : (label ?? "another machine");

describe("remoteOnlyMachines", () => {
  it("names each machine of a project with no copy on this device once", () => {
    expect(
      remoteOnlyMachines(
        group("remote-only", [
          { environmentId: m5, environmentLabel: "m5.local" },
          { environmentId: m1, environmentLabel: "M1" },
          { environmentId: m5, environmentLabel: "m5.local" },
        ]),
        nameOf,
      ),
    ).toEqual([
      { environmentId: m5, name: "M5" },
      { environmentId: m1, name: "M1" },
    ]);
  });

  it("marks nothing when this device has a copy", () => {
    const members = [{ environmentId: m5, environmentLabel: null }];
    expect(remoteOnlyMachines(group("mixed", members), nameOf)).toEqual([]);
    expect(remoteOnlyMachines(group("local-only", members), nameOf)).toEqual([]);
  });

  it("marks nothing when the only other copies sit in a sandbox on this device", () => {
    expect(
      remoteOnlyMachines(
        group("remote-only", [{ environmentId: m1, environmentLabel: "Sandbox" }], true),
        nameOf,
      ),
    ).toEqual([]);
  });
});

describe("localCopiesFirst", () => {
  it("lists projects this device can run first, then the rest, each in the person's order", () => {
    const row = (name: string, presence: SidebarProjectSnapshot["environmentPresence"], sandbox = false) => ({
      name,
      environmentPresence: presence,
      allRemoteMembersAreDesktopLocal: sandbox,
    });
    const order = localCopiesFirst([
      row("ai-com", "remote-only"),
      row("easychamp", "mixed"),
      row("firstproject", "local-only"),
      row("sketchmate", "remote-only"),
      row("sandboxed", "remote-only", true),
    ]).map((item) => item.name);
    expect(order).toEqual(["easychamp", "firstproject", "sandboxed", "ai-com", "sketchmate"]);
  });
});

describe("hasNoCopyHere", () => {
  it("counts a sandbox copy on this device even when other copies are on other machines", () => {
    const presence = { environmentPresence: "remote-only" as const, allRemoteMembersAreDesktopLocal: false };
    expect(hasNoCopyHere(presence)).toBe(true);
    expect(hasNoCopyHere({ ...presence, someRemoteMembersAreDesktopLocal: true })).toBe(false);
    expect(hasNoCopyHere({ ...presence, allRemoteMembersAreDesktopLocal: true })).toBe(false);
    expect(hasNoCopyHere({ ...presence, environmentPresence: "mixed" })).toBe(false);
  });
});
