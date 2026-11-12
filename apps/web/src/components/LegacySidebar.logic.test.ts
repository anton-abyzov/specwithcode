import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProjectListMember } from "../studio/projectListVisibility";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import {
  legacySidebarAssistantLinks,
  legacySidebarProjectSections,
  withoutAssistants,
  legacySidebarWaitingCount,
  type LegacySidebarWaitingThread,
} from "./LegacySidebar.logic";

const scratchRootFor = (environmentId: EnvironmentId) =>
  environmentId === "host" ? "/home/user/.studio/scratch" : null;

function group(
  projectKey: string,
  workspaceRoot: string,
  settings?: { archived?: boolean; origin?: "user" | "automated" },
) {
  const member: ProjectListMember = {
    environmentId: "host" as EnvironmentId,
    id: projectKey as ProjectId,
    workspaceRoot,
    ...(settings ? { workspaceSettings: settings } : {}),
  };
  return { projectKey, memberProjects: [member] };
}

const atlas = group("atlas", "/work/atlas");
const scratch = group("scratch", "/home/user/.studio/scratch");
const bot = group("bot", "/work/bot", { origin: "automated" });
const old = group("old", "/work/old", { archived: true });
const groups = [scratch, old, atlas, bot];
const unfolded = { automated: null, archived: null };

describe("legacySidebarProjectSections", () => {
  it("keeps No project and folds automated and archived projects", () => {
    const sections = legacySidebarProjectSections(groups, scratchRootFor, null, unfolded);
    expect(sections.listed).toEqual([scratch, atlas]);
    expect(sections.automated).toEqual([bot]);
    expect(sections.archived).toEqual([old]);
    expect(sections.automatedOpen).toBe(false);
    expect(sections.archivedOpen).toBe(false);
    expect(sections.visible).toEqual([scratch, atlas]);
  });

  it("opens the fold that holds the open project", () => {
    const sections = legacySidebarProjectSections(groups, scratchRootFor, "old", unfolded);
    expect(sections.archived).toEqual([old]);
    expect(sections.archivedOpen).toBe(true);
    expect(sections.automatedOpen).toBe(false);
    expect(sections.visible).toEqual([scratch, atlas, old]);
  });

  it("follows the person's toggle over the open project", () => {
    const closed = legacySidebarProjectSections(groups, scratchRootFor, "old", {
      automated: true,
      archived: false,
    });
    expect(closed.archivedOpen).toBe(false);
    expect(closed.visible).toEqual([scratch, atlas, bot]);
  });

  it("keeps an empty fold closed", () => {
    const sections = legacySidebarProjectSections([atlas], scratchRootFor, null, {
      automated: true,
      archived: true,
    });
    expect(sections.automatedOpen).toBe(false);
    expect(sections.archivedOpen).toBe(false);
    expect(sections.visible).toEqual([atlas]);
  });

  it("keeps a No project folder its machine has not confirmed out of the folds", () => {
    // No config yet for this machine, and a folder under the older home.
    const pending = {
      projectKey: "pending",
      memberProjects: [
        {
          environmentId: "remote" as EnvironmentId,
          id: "pending" as ProjectId,
          workspaceRoot: "/Users/me/.specweave-studio/m3/scratch",
        },
      ],
    };
    const sections = legacySidebarProjectSections([pending, atlas], scratchRootFor, null, unfolded);
    expect(sections.automated).toEqual([]);
    expect(sections.visible).toEqual([pending, atlas]);
  });

  it("counts threads waiting on the person in folded projects", () => {
    const idle = {
      archivedAt: null,
      hasActionableProposedPlan: false,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      interactionMode: "default",
      latestRun: null,
      runtime: null,
    } as unknown as LegacySidebarWaitingThread;
    const settledPlan = {
      ...idle,
      interactionMode: "plan",
      hasActionableProposedPlan: true,
      latestRun: { runId: "run-1", status: "completed", startedAt: null, completedAt: null },
    } as unknown as LegacySidebarWaitingThread;
    const threads = new Map([
      [
        "bot",
        [
          { ...idle, hasPendingApprovals: true },
          { ...idle, hasPendingUserInput: true },
          settledPlan,
          idle,
          { ...idle, archivedAt: "2026-10-24T00:00:00.000Z", hasPendingApprovals: true },
        ],
      ],
      ["atlas", [{ ...idle, hasPendingApprovals: true }]],
    ]);
    expect(legacySidebarWaitingCount([bot], threads)).toBe(3);
    expect(legacySidebarWaitingCount([], threads)).toBe(0);
  });
});

describe("Aide in the legacy sidebars", () => {
  const assistant = (
    projectKey: string,
    environmentId: string,
    environmentLabel: string,
    settings: { archived?: boolean; origin?: "automated" } = {},
  ) =>
    ({
      projectKey,
      displayName: "Aide",
      memberProjects: [
        {
          environmentId,
          id: projectKey,
          environmentLabel,
          workspaceRoot: `/work/${projectKey}`,
          createdAt: "2026-11-01",
          workspaceSettings: { kind: "personal", ...settings },
        },
      ],
    }) as unknown as SidebarProjectSnapshot;
  const own = assistant("aide", "host", "Main Mac");
  const archivedOther = assistant("aide-m1", "m1", "M1", { archived: true });
  const automatedAide = assistant("aide-bot", "m3", "M3", { origin: "automated" });

  it("puts no assistant in any section, automated or archived ones included", () => {
    const sections = legacySidebarProjectSections(
      [...groups, own, archivedOther, automatedAide],
      scratchRootFor,
      "aide",
      { automated: true, archived: true },
    );
    for (const list of [sections.listed, sections.automated, sections.archived, sections.visible]) {
      expect(list.map((entry) => entry.projectKey)).not.toEqual(
        expect.arrayContaining(["aide", "aide-m1", "aide-bot"]),
      );
    }
    expect(sections.listed).toEqual([scratch, atlas]);
    expect(withoutAssistants([atlas, own])).toEqual([atlas]);
  });

  it("links each assistant above the list, this machine's first, naming machines", () => {
    const projects = [atlas as unknown as SidebarProjectSnapshot, archivedOther, own];
    expect(legacySidebarAssistantLinks(projects, "host")).toEqual([
      { projectKey: "aide", title: "Aide", hint: "Main Mac" },
      { projectKey: "aide-m1", title: "Aide", hint: "M1" },
    ]);
    expect(legacySidebarAssistantLinks([own], "host")).toEqual([
      { projectKey: "aide", title: "Aide", hint: undefined },
    ]);
    // Aide off: the sidebars leave it out of their groups, so nothing is linked.
    expect(
      legacySidebarAssistantLinks([atlas as unknown as SidebarProjectSnapshot], "host"),
    ).toEqual([]);
  });
});
