import { describe, expect, it } from "vitest";
import {
  assistantGroupHint,
  assistantGroupsOf,
  assistantMachineBadges,
  assistantMembersOf,
  isLinkedAssistantGroup,
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
    workspaceSettings: { kind: "personal" as const, archived: false },
    logicalProject: input.logicalId
      ? {
          id: input.logicalId,
          members: Array.from({ length: input.logicalMemberCount ?? 2 }, (_, idx) => ({
            environmentId: `env-${idx}`,
          })),
        }
      : null,
  } as any;
}

describe("assistantEntries", () => {
  it("collapses linked personal assistant seats into one row with ordered machine badges", () => {
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
    const badges = assistantMachineBadges(groups[0]!, (envId) => labels[envId]);
    expect(badges).toEqual(["m4", "m1", "win", "m5"]);

    const hint = assistantGroupHint(
      groups[0]!,
      assistantMembersOf(groups),
      (envId) => labels[envId],
      4,
    );
    expect(hint).toBe("m4 · m1 · win · m5");
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

  it("offers 'Use Percy on <machine>' when this machine lacks a local seat and another machine has Percy", () => {
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
    });
    expect(offer).toMatchObject({
      kind: "join",
      assistantName: "Percy",
      label: "Use Percy on M5",
    });
  });

  it("offers 'Set up' when no personal assistant exists on any machine", () => {
    const offer = personalAssistantSidebarOffer({
      assistants: [],
      ownEnvironmentId: "env-m5",
      ownMachineLabel: "M5",
      machineCount: 1,
    });
    expect(offer).toEqual({ kind: "create", label: "Set up" });
  });
});
