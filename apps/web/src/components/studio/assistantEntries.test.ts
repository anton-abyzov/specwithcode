import { describe, expect, it } from "vite-plus/test";
import {
  assistantGroupHint,
  assistantGroupsOf,
  assistantMembersOf,
  assistantRowLabel,
  isLinkedAssistantGroup,
  ownSeatOfLinkedAssistant,
  sortAssistantGroups,
  unlinkedAssistantMembers,
} from "./assistantEntries";
import { personalAssistantSidebarOffer } from "../../studio/personalAssistant";

function makeMember(input: {
  id: string;
  environmentId: string;
  title?: string;
  logicalId?: string | null;
  logicalMemberCount?: number;
}) {
  return {
    id: input.id,
    environmentId: input.environmentId,
    title: input.title ?? "Percy",
    createdAt: "2026-11-20T00:00:00.000Z",
    // The identity lives in workspaceSettings, as on real project shells.
    workspaceSettings: {
      kind: "personal" as const,
      archived: false,
      ...(input.logicalId
        ? {
            logicalProject: {
              id: input.logicalId,
              title: input.title ?? "Percy",
              coordinatorId: "coord",
              members: Array.from({ length: input.logicalMemberCount ?? 2 }, (_, idx) => ({
                environmentId: `env-${idx}`,
                projectId: `project-${idx}`,
                coordinatorThreadId: `coord-${idx}`,
              })),
            },
          }
        : {}),
    },
  } as any;
}

describe("assistantEntries", () => {
  it("collapses linked personal assistant seats into one row that names no machine", () => {
    const m4 = makeMember({
      id: "p-m4",
      environmentId: "env-m4",
      logicalId: "lp-percy",
      logicalMemberCount: 4,
    });
    const m1 = makeMember({
      id: "p-m1",
      environmentId: "env-m1",
      logicalId: "lp-percy",
      logicalMemberCount: 4,
    });
    const win = makeMember({
      id: "p-win",
      environmentId: "env-win",
      logicalId: "lp-percy",
      logicalMemberCount: 4,
    });
    const m5 = makeMember({
      id: "p-m5",
      environmentId: "env-m5",
      logicalId: "lp-percy",
      logicalMemberCount: 4,
    });

    const groups = assistantGroupsOf({
      listed: [
        { memberProjects: [m4] },
        { memberProjects: [m1] },
        { memberProjects: [win] },
        { memberProjects: [m5] },
      ],
      automated: [],
      archived: [],
    });

    expect(groups).toHaveLength(1);
    expect(isLinkedAssistantGroup(groups[0]!)).toBe(true);

    const labels: Record<string, string> = {
      "env-m4": "m4",
      "env-m1": "m1",
      "env-win": "win",
      "env-m5": "m5",
    };
    const members = assistantMembersOf(groups);
    expect(assistantGroupHint(groups[0]!, members, (envId) => labels[envId], 4)).toBeUndefined();
    expect(assistantRowLabel(groups[0]!, members, (envId) => labels[envId])).toBeUndefined();
  });

  it("names an assistant that is not joined by its machine, beside the linked Percy", () => {
    const linked = {
      memberProjects: [
        makeMember({ id: "p-a", environmentId: "env-a", logicalId: "lp-percy" }),
        makeMember({ id: "p-b", environmentId: "env-b", logicalId: "lp-percy" }),
      ],
    };
    const apart = {
      memberProjects: [makeMember({ id: "p-c", environmentId: "env-c", logicalId: null })],
    };
    const labels: Record<string, string> = {
      "env-a": "Studio",
      "env-b": "Laptop",
      "env-c": "Tower",
    };
    const members = assistantMembersOf([linked, apart]);
    expect(assistantGroupHint(apart, members, (envId) => labels[envId], 3)).toBe("not joined");
    expect(assistantRowLabel(apart, members, (envId) => labels[envId])).toEqual({
      text: "{name} on {machine}",
      values: { name: "Percy", machine: "Tower" },
    });
    // The linked row stays plain: one name, no machine.
    expect(assistantGroupHint(linked, members, (envId) => labels[envId], 3)).toBeUndefined();
  });

  it("leaves unlinked rows as before while no linked Percy is listed", () => {
    const a = {
      memberProjects: [makeMember({ id: "p-a", environmentId: "env-a", logicalId: null })],
    };
    const b = {
      memberProjects: [makeMember({ id: "p-b", environmentId: "env-b", logicalId: null })],
    };
    const labels: Record<string, string> = { "env-a": "Studio", "env-b": "Laptop" };
    const members = assistantMembersOf([a, b]);
    expect(assistantGroupHint(a, members, (envId) => labels[envId], 2)).toBe("Studio");
    expect(assistantGroupHint(a, members, (envId) => labels[envId], 1)).toBeUndefined();
    expect(assistantRowLabel(a, members, (envId) => labels[envId])).toBeUndefined();
  });

  it("opens the linked Percy on this window's own seat, and leaves other assistants alone", () => {
    const here = makeMember({ id: "p-a", environmentId: "env-a", logicalId: "lp-percy" });
    const there = makeMember({ id: "p-b", environmentId: "env-b", logicalId: "lp-percy" });
    expect(ownSeatOfLinkedAssistant([there, here], "env-a")).toBe(here);
    expect(ownSeatOfLinkedAssistant([there, here], "env-z")).toBeUndefined();
    expect(ownSeatOfLinkedAssistant([there, here], null)).toBeUndefined();
    const apart = makeMember({ id: "p-c", environmentId: "env-a", logicalId: null });
    expect(ownSeatOfLinkedAssistant([apart], "env-a")).toBeUndefined();
  });

  it("excludes linked seats from distinct icon assignment while keeping unlinked seats distinct", () => {
    const linkedM4 = makeMember({
      id: "p-m4",
      environmentId: "env-m4",
      logicalId: "lp-percy",
      logicalMemberCount: 2,
    });
    const linkedM5 = makeMember({
      id: "p-m5",
      environmentId: "env-m5",
      logicalId: "lp-percy",
      logicalMemberCount: 2,
    });
    const unlinkedWin = makeMember({ id: "p-win", environmentId: "env-win", logicalId: null });
    const leftM1 = makeMember({
      id: "p-m1",
      environmentId: "env-m1",
      logicalId: "lp-solo",
      logicalMemberCount: 1,
    });

    const distinctTargets = unlinkedAssistantMembers([linkedM4, linkedM5, unlinkedWin, leftM1]);
    expect(distinctTargets.map((m) => m.id)).toEqual(["p-win", "p-m1"]);
  });

  it("sorts the linked group containing the current machine first", () => {
    const unlinkedOther = {
      memberProjects: [makeMember({ id: "p-win", environmentId: "env-win", logicalId: null })],
    };
    const linkedWithHere = {
      memberProjects: [
        makeMember({
          id: "p-m4",
          environmentId: "env-m4",
          logicalId: "lp-percy",
          logicalMemberCount: 2,
        }),
        makeMember({
          id: "p-m5",
          environmentId: "env-m5",
          logicalId: "lp-percy",
          logicalMemberCount: 2,
        }),
      ],
    };
    const members = assistantMembersOf([unlinkedOther, linkedWithHere]);
    const sorted = sortAssistantGroups([unlinkedOther, linkedWithHere], members, "env-m5");
    expect(sorted[0]).toBe(linkedWithHere);
  });

  it("offers 'Use my Percy on <machine>' while the switch is off and another machine has Percy", () => {
    const m4 = makeMember({
      id: "p-m4",
      environmentId: "env-m4",
      title: "Percy",
      logicalId: "lp-percy",
      logicalMemberCount: 2,
    });
    const offer = personalAssistantSidebarOffer({
      assistants: [m4],
      ownEnvironmentId: "env-m5",
      ownMachineLabel: "M5",
      machineCount: 2,
      sharedHere: false,
    });
    expect(offer).toEqual({ kind: "share", machine: "M5", label: "Use my Percy on M5" });
  });

  it("offers 'Set up' when no personal assistant exists on any machine", () => {
    const offer = personalAssistantSidebarOffer({
      assistants: [],
      ownEnvironmentId: "env-m5",
      ownMachineLabel: "M5",
      machineCount: 1,
      sharedHere: false,
    });
    expect(offer).toEqual({ kind: "create", label: "Set up" });
  });
});

describe("assistantEntries reads the identity from workspaceSettings", () => {
  it("keeps one-member identities as separate rows and collapses only real links", () => {
    const soloA = makeMember({
      id: "a",
      environmentId: "env-a",
      logicalId: "lp-a",
      logicalMemberCount: 1,
    });
    const soloB = makeMember({
      id: "b",
      environmentId: "env-b",
      logicalId: "lp-b",
      logicalMemberCount: 1,
    });
    const groups = assistantGroupsOf({
      listed: [{ memberProjects: [soloA] }, { memberProjects: [soloB] }],
      automated: [],
      archived: [],
    });
    expect(groups).toHaveLength(2);
    expect(unlinkedAssistantMembers([soloA, soloB]).map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("ignores a stray top-level logicalProject field", () => {
    const stray = {
      ...makeMember({ id: "x", environmentId: "env-x", logicalId: null }),
      logicalProject: { id: "lp", members: [{}, {}] },
    };
    expect(unlinkedAssistantMembers([stray]).map((m) => m.id)).toEqual(["x"]);
  });
});
