import { EnvironmentId, ProjectId, ThreadId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  HANDOFF_CONTINUED,
  movedAwayBanner,
  threadMoveBanner,
  threadMoveBlockedReason,
  threadMoveStartsByDefault,
  threadMoveTargets,
} from "./threadMove.logic";
import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const here = EnvironmentId.make("env-m4");
const elsewhere = EnvironmentId.make("env-m3");
const specweave = ProjectId.make("project-specweave");
const easychamp = ProjectId.make("project-easychamp");

const thread = (overrides: Partial<Parameters<typeof threadMoveBlockedReason>[0]> = {}) => ({
  environmentId: here,
  id: ThreadId.make("thread-audit"),
  projectId: specweave,
  movedTo: null,
  runtime: null,
  ...overrides,
});

const runtime = (status: "running" | "queued" | "interrupted" | "cancelled") =>
  ({
    status,
    activeRunId: null,
    providerInstanceId: "codex",
    providerName: null,
    lastError: null,
    updatedAt: "2026-10-19T22:00:00.000Z",
  }) as never;

describe("threadMoveBlockedReason", () => {
  it("lets an ordinary thread or delegated task move", () => {
    expect(threadMoveBlockedReason(thread(), { id: specweave })).toBeNull();
  });

  it("keeps a coordinator with its project, by convention or by setting", () => {
    expect(
      threadMoveBlockedReason(thread({ id: ThreadId.make(`project-coordinator:${specweave}`) }), {
        id: specweave,
      }),
    ).toMatch(/coordinator stays/);
    expect(
      threadMoveBlockedReason(thread({ id: ThreadId.make("custom-coordinator") }), {
        id: specweave,
        workspaceSettings: { coordinatorThreadId: "custom-coordinator" },
      }),
    ).toMatch(/coordinator stays/);
  });

  it("does not move a thread twice", () => {
    expect(
      threadMoveBlockedReason(
        thread({
          movedTo: {
            threadId: ThreadId.make("thread-new"),
            projectId: easychamp,
            title: "Audit",
            movedAt: "2026-10-19T22:30:00.000Z",
          },
        }),
        { id: specweave },
      ),
    ).toBe('Already moved to "Audit".');
  });
});

describe("threadMoveTargets", () => {
  it("offers only other unarchived projects on the same machine", () => {
    const projects = [
      { environmentId: here, id: specweave, workspaceRoot: "/repos/specweave" },
      { environmentId: here, id: easychamp, workspaceRoot: "/repos/easychamp" },
      {
        environmentId: here,
        id: ProjectId.make("project-old"),
        workspaceRoot: "/repos/old",
        workspaceSettings: { archived: true },
      },
      { environmentId: here, id: ProjectId.make("project-scratch"), workspaceRoot: "/scratch" },
      { environmentId: elsewhere, id: ProjectId.make("project-m3"), workspaceRoot: "/repos/m3" },
    ];
    expect(
      threadMoveTargets(thread(), projects, () => "/scratch").map((project) => project.id),
    ).toEqual([easychamp]);
  });
});

describe("threadMoveStartsByDefault", () => {
  it("restarts work that was running and leaves stopped work waiting", () => {
    expect(threadMoveStartsByDefault(thread({ runtime: runtime("running") }))).toBe(true);
    expect(threadMoveStartsByDefault(thread({ runtime: runtime("queued") }))).toBe(true);
    expect(threadMoveStartsByDefault(thread({ runtime: runtime("interrupted") }))).toBe(false);
    expect(threadMoveStartsByDefault(thread({ runtime: runtime("cancelled") }))).toBe(false);
    expect(threadMoveStartsByDefault(thread())).toBe(false);
  });
});

describe("move in the thread menu", () => {
  const state: ThreadActionMenuState = {
    canOperate: true,
    branch: null,
    projectFilter: null,
    isPinned: false,
    isSettled: false,
    autoSettleEnabled: true,
    isSnoozed: false,
    canSnoozeNow: true,
    isRegeneratingTitle: false,
    isRunning: true,
    canOpenProjectWindow: false,
    moveToProjectBlockedReason: null,
    supports: {
      settlement: true,
      autoSettleOptOut: true,
      snooze: true,
      pinning: true,
      titleRegeneration: true,
      projectMove: true,
    },
    snoozePresets: [],
  };
  const move = (overrides: Partial<ThreadActionMenuState>) =>
    buildThreadActionMenuItems({ ...state, ...overrides }).find(
      (item) => item.id === "move-to-project",
    );

  it("stays available while the thread runs, since the move stops it", () => {
    expect(move({})).toMatchObject({ label: "Move to another project…", disabled: false });
  });

  it("is disabled for a thread that cannot move and hidden on older servers", () => {
    expect(move({ moveToProjectBlockedReason: "coordinator" })?.disabled).toBe(true);
    expect(move({ supports: { ...state.supports, projectMove: false } })).toBeUndefined();
    expect(move({ moveToProjectBlockedReason: undefined })).toBeUndefined();
  });

  it("needs permission to change threads", () => {
    expect(move({ canOperate: false })?.disabled).toBe(true);
  });
});

describe("threadMoveBanner", () => {
  const minis = EnvironmentId.make("env-minis");
  const sourceId = ThreadId.make("thread-audit");
  const remoteId = ThreadId.make("thread-on-minis");
  const titles = (projectId: string) => (projectId === easychamp ? "EasyChamp" : undefined);
  const link = {
    threadId: remoteId,
    projectId: specweave,
    title: "Audit the release",
    movedAt: "2026-10-20T14:00:00.000Z",
  };
  const on = (overrides: Partial<Parameters<typeof threadMoveBanner>[0]>) =>
    threadMoveBanner({ environmentId: here, id: sourceId, ...overrides }, titles);

  it("is null for a thread that never moved", () => {
    expect(on({})).toBeNull();
    expect(on({ movedTo: null, movedFrom: null, execution: null })).toBeNull();
  });

  it("keeps a project move's wording: archived source, fresh target", () => {
    expect(on({ movedTo: { ...link, projectId: easychamp } })).toEqual({
      id: `thread-moved-to:${sourceId}`,
      title: "Moved to EasyChamp",
      description:
        "This thread was stopped and archived. Its work restarted there as a new thread; this one takes no new messages.",
      actionLabel: "Open new thread",
      target: { environmentId: here, threadId: remoteId },
      targetArchived: false,
    });
    expect(on({ movedFrom: { ...link, kind: "project", projectId: easychamp } })).toMatchObject({
      title: "Moved here from EasyChamp",
      actionLabel: "Find original",
      targetArchived: true,
    });
  });

  it("names the machine a handed-off source continues on, with the limit note", () => {
    expect(
      on({
        movedTo: {
          ...link,
          kind: "handoff",
          environmentId: minis,
          machineLabel: "Minis",
          note: "Hit 95% of Claude on M4 · continued on Minis with Claude Opus 5.5",
        },
      }),
    ).toEqual({
      id: `thread-moved-to:${sourceId}`,
      title: "Continued on Minis",
      description:
        "Hit 95% of Claude on M4 · continued on Minis with Claude Opus 5.5. This thread is read-only now; its work goes on there.",
      actionLabel: "Open on Minis",
      // The continuation lives on Minis, so the link opens it there.
      target: { environmentId: minis, threadId: remoteId },
      targetArchived: false,
    });
  });

  it("never calls a handoff archived, with or without a note", () => {
    const banner = on({
      movedTo: { ...link, kind: "handoff", environmentId: minis, machineLabel: "Minis" },
    });
    expect(banner?.title).toBe("Continued on Minis");
    expect(banner?.description).toBe("This thread is read-only now; its work goes on there.");
    expect(banner?.description).not.toMatch(/archived/);
    // A handoff to another model on this machine has no machine to name.
    expect(on({ movedTo: { ...link, kind: "handoff" } })).toMatchObject({
      title: "Continued in a new thread",
      target: { environmentId: here, threadId: remoteId },
    });
  });

  it("a source whose work moved away leads with the move, not its limit", () => {
    expect(movedAwayBanner(null)).toBe(false);
    const handedOff = on({ movedTo: { ...link, kind: "handoff", machineLabel: "Minis" } });
    expect(movedAwayBanner(handedOff?.id)).toBe(true);
    expect(movedAwayBanner(on({ movedTo: { ...link, projectId: easychamp } })?.id)).toBe(true);
    const arrived = on({ movedFrom: { ...link, kind: "handoff", machineLabel: "M4" } });
    expect(movedAwayBanner(arrived?.id)).toBe(false);
    expect(movedAwayBanner(`${HANDOFF_CONTINUED}thread-1`)).toBe(true);
  });

  it("tells a continuation where it came from and links back there", () => {
    const fromM4 = EnvironmentId.make("env-m4-source");
    const execution = {
      ownerMachineId: fromM4,
      ownerMachineLabel: "M4",
      executionMachineId: here,
      executionMachineLabel: "Minis",
      epoch: 2,
      sourceRoot: {
        environmentId: fromM4,
        machineLabel: "M4",
        projectId: specweave,
        threadId: ThreadId.make("thread-on-m4"),
        workspaceRoot: "/Users/anton/app",
        branch: "feat/limit",
      },
      history: [],
    };
    expect(on({ execution })).toEqual({
      id: `thread-moved-from:${sourceId}`,
      title: "Continued here from M4",
      description: "Its files and a handoff note came from the last checkpoint there.",
      actionLabel: "Open original",
      target: { environmentId: fromM4, threadId: ThreadId.make("thread-on-m4") },
      targetArchived: false,
    });
    // A target link, when there is one, wins and carries its note.
    expect(
      on({
        execution,
        movedFrom: {
          ...link,
          kind: "handoff",
          environmentId: fromM4,
          machineLabel: "M4",
          note: "Hit 95% of Claude on M4 · continued on Minis with Claude Opus 5.5",
        },
      }),
    ).toMatchObject({
      title: "Continued here from M4",
      description:
        "Hit 95% of Claude on M4 · continued on Minis with Claude Opus 5.5. Its files and a handoff note came from the last checkpoint there.",
      target: { environmentId: fromM4, threadId: remoteId },
    });
    // The source, once it moves on again, shows where it went instead.
    expect(
      on({
        execution,
        movedTo: { ...link, kind: "handoff", environmentId: minis, machineLabel: "Minis" },
      })?.title,
    ).toBe("Continued on Minis");
  });

  it("ignores an execution record that came from nowhere else", () => {
    expect(
      on({
        execution: {
          ownerMachineId: here,
          executionMachineId: here,
          epoch: 1,
          sourceRoot: null,
          history: [],
        },
      }),
    ).toBeNull();
  });
});
