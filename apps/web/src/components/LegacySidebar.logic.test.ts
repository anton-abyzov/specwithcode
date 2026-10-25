import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProjectListMember } from "../studio/projectListVisibility";
import {
  legacySidebarProjectSections,
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
