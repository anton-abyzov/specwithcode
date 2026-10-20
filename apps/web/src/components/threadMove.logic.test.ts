import { EnvironmentId, ProjectId, ThreadId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
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
