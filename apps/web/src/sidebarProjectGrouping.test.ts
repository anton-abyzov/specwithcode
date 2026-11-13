import { EnvironmentId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { remoteOnlyMachines, type SidebarProjectSnapshot } from "./sidebarProjectGrouping";

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
