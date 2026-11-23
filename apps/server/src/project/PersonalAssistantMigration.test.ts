import { describe, expect, it, vi } from "vitest";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import {
  executePersonalAssistantMigration,
  planPersonalAssistantMigration,
  type MigrationSeatInput,
} from "./PersonalAssistantMigration";

function makeSeat(
  overrides: Partial<MigrationSeatInput> & {
    environmentId: string;
    machineLabel: string;
    projectId: string;
    title: string;
  },
): MigrationSeatInput {
  return {
    createdAt: "2026-11-01T00:00:00.000Z",
    supportsPersonalLink: true,
    existingLogicalProjectId: null,
    memoryFiles: [],
    ...overrides,
    environmentId: EnvironmentId.make(overrides.environmentId),
    projectId: ProjectId.make(overrides.projectId),
  };
}

describe("PersonalAssistantMigration", () => {
  it("previews same-name file clashes, excludes localOnly and secretDetected, and flags copied userdata and stale extras", () => {
    const seats = [
      makeSeat({
        environmentId: "env-m4",
        machineLabel: "M4",
        projectId: "proj-shared-copied",
        title: "Percy",
        createdAt: "2026-10-01T00:00:00.000Z",
        memoryFiles: [
          { name: "MEMORY.md", sha256: "aaa", updatedAt: "2026-11-10T00:00:00Z", byteLength: 100 },
          {
            name: "user_local.md",
            sha256: "loc1",
            updatedAt: "2026-11-10T00:00:00Z",
            byteLength: 40,
            localOnly: true,
          },
          {
            name: "api_keys.md",
            sha256: "sec1",
            updatedAt: "2026-11-10T00:00:00Z",
            byteLength: 40,
            secretDetected: true,
          },
        ],
      }),
      // Stale extra row on M4
      makeSeat({
        environmentId: "env-m4",
        machineLabel: "M4",
        projectId: "proj-m4-extra",
        title: "PercyAnton",
        createdAt: "2026-10-15T00:00:00.000Z",
      }),
      // Copied userdata on M1 (same projectId as M4)
      makeSeat({
        environmentId: "env-m1",
        machineLabel: "M1",
        projectId: "proj-shared-copied",
        title: "PercyM1",
        createdAt: "2026-10-05T00:00:00.000Z",
        memoryFiles: [
          { name: "MEMORY.md", sha256: "bbb", updatedAt: "2026-11-12T00:00:00Z", byteLength: 120 },
          {
            name: "user_local.md",
            sha256: "loc2",
            updatedAt: "2026-11-12T00:00:00Z",
            byteLength: 50,
            localOnly: true,
          },
        ],
      }),
    ];

    const plan = planPersonalAssistantMigration(seats);
    expect(plan.canonicalSeats.map((s) => s.title)).toEqual(["Percy", "PercyM1"]);
    expect(plan.staleExtraSeats.map((s) => s.title)).toEqual(["PercyAnton"]);
    expect(plan.copiedUserdataProjectIds).toEqual([ProjectId.make("proj-shared-copied")]);
    expect(plan.clashes).toHaveLength(1);
    expect(plan.clashes[0]!.name).toBe("MEMORY.md");
    expect(plan.excludedLocalOnlyCount).toBe(2);
    expect(plan.excludedSecretCount).toBe(1);
    expect(plan.canProceed).toBe(true);
  });

  it("refuses migration without explicit owner approval", async () => {
    const createSnapshot = vi.fn();
    const linkSeats = vi.fn();
    const result = await executePersonalAssistantMigration({
      seats: [
        makeSeat({ environmentId: "env-m4", machineLabel: "M4", projectId: "p1", title: "Percy" }),
        makeSeat({
          environmentId: "env-m5",
          machineLabel: "M5",
          projectId: "p2",
          title: "PercyM5",
        }),
      ],
      ownerApproved: false,
      routineOwnerEnvironmentId: EnvironmentId.make("env-m4"),
      resolutions: {},
      createSnapshot,
      linkSeats,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("owner_approval_required");
    expect(createSnapshot).not.toHaveBeenCalled();
    expect(linkSeats).not.toHaveBeenCalled();
  });

  it("refuses mixed-version peers lacking personalLink", async () => {
    const createSnapshot = vi.fn();
    const linkSeats = vi.fn();
    const result = await executePersonalAssistantMigration({
      seats: [
        makeSeat({ environmentId: "env-m4", machineLabel: "M4", projectId: "p1", title: "Percy" }),
        makeSeat({
          environmentId: "env-win",
          machineLabel: "Win",
          projectId: "p2",
          title: "PercyWin",
          supportsPersonalLink: false,
        }),
      ],
      ownerApproved: true,
      routineOwnerEnvironmentId: EnvironmentId.make("env-m4"),
      resolutions: {},
      createSnapshot,
      linkSeats,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("peer_unsupported_version");
    expect(result.error?.message).toContain("Win");
    expect(createSnapshot).not.toHaveBeenCalled();
    expect(linkSeats).not.toHaveBeenCalled();
  });

  it("refuses unresolved same-name file clashes (no silent overwrite)", async () => {
    const createSnapshot = vi.fn();
    const linkSeats = vi.fn();
    const result = await executePersonalAssistantMigration({
      seats: [
        makeSeat({
          environmentId: "env-m4",
          machineLabel: "M4",
          projectId: "p1",
          title: "Percy",
          memoryFiles: [
            { name: "notes.md", sha256: "h1", updatedAt: "2026-11-01T00:00:00Z", byteLength: 10 },
          ],
        }),
        makeSeat({
          environmentId: "env-m5",
          machineLabel: "M5",
          projectId: "p2",
          title: "PercyM5",
          memoryFiles: [
            { name: "notes.md", sha256: "h2", updatedAt: "2026-11-02T00:00:00Z", byteLength: 12 },
          ],
        }),
      ],
      ownerApproved: true,
      routineOwnerEnvironmentId: EnvironmentId.make("env-m4"),
      resolutions: {},
      createSnapshot,
      linkSeats,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("unresolved_clashes");
    expect(result.error?.details).toEqual(["notes.md"]);
    expect(createSnapshot).not.toHaveBeenCalled();
  });

  it("takes pre-merge DB snapshots on every participating machine before linking and aborts if any snapshot fails", async () => {
    const linkSeats = vi.fn();
    const failedResult = await executePersonalAssistantMigration({
      seats: [
        makeSeat({ environmentId: "env-m4", machineLabel: "M4", projectId: "p1", title: "Percy" }),
        makeSeat({
          environmentId: "env-m5",
          machineLabel: "M5",
          projectId: "p2",
          title: "PercyM5",
        }),
      ],
      ownerApproved: true,
      routineOwnerEnvironmentId: EnvironmentId.make("env-m4"),
      resolutions: {},
      createSnapshot: async (seat) => {
        if (seat.environmentId === "env-m5") throw new Error("disk full");
        return `/tmp/snap-${seat.environmentId}.sqlite`;
      },
      linkSeats,
    });

    expect(failedResult.ok).toBe(false);
    expect(failedResult.error?.code).toBe("snapshot_failed");
    expect(linkSeats).not.toHaveBeenCalled();

    const okLinkSeats = vi.fn(async () => ({ logicalProjectId: "lp-percy-1" }));
    const okResult = await executePersonalAssistantMigration({
      seats: [
        makeSeat({
          environmentId: "env-m4",
          machineLabel: "M4",
          projectId: "p1",
          title: "Percy",
          memoryFiles: [
            { name: "notes.md", sha256: "h1", updatedAt: "2026-11-01T00:00:00Z", byteLength: 10 },
          ],
        }),
        makeSeat({
          environmentId: "env-m5",
          machineLabel: "M5",
          projectId: "p2",
          title: "PercyM5",
          memoryFiles: [
            { name: "notes.md", sha256: "h2", updatedAt: "2026-11-02T00:00:00Z", byteLength: 12 },
          ],
        }),
      ],
      ownerApproved: true,
      routineOwnerEnvironmentId: EnvironmentId.make("env-m4"),
      resolutions: {
        "notes.md": { strategy: "keep-both" },
      },
      createSnapshot: async (seat) => `/tmp/snap-${seat.environmentId}.sqlite`,
      linkSeats: okLinkSeats,
    });

    expect(okResult.ok).toBe(true);
    expect(okResult.alreadyLinked).toBe(false);
    expect(okResult.logicalProjectId).toBe("lp-percy-1");
    expect(okResult.snapshots).toHaveLength(2);
    expect(okLinkSeats).toHaveBeenCalledTimes(1);
  });

  it("is idempotent on retry when participating seats are already linked", async () => {
    const createSnapshot = vi.fn();
    const linkSeats = vi.fn();
    const result = await executePersonalAssistantMigration({
      seats: [
        makeSeat({
          environmentId: "env-m4",
          machineLabel: "M4",
          projectId: "p1",
          title: "Percy",
          existingLogicalProjectId: "lp-percy-1",
        }),
        makeSeat({
          environmentId: "env-m5",
          machineLabel: "M5",
          projectId: "p2",
          title: "Percy",
          existingLogicalProjectId: "lp-percy-1",
        }),
      ],
      ownerApproved: true,
      routineOwnerEnvironmentId: EnvironmentId.make("env-m4"),
      resolutions: {},
      createSnapshot,
      linkSeats,
    });

    expect(result.ok).toBe(true);
    expect(result.alreadyLinked).toBe(true);
    expect(result.logicalProjectId).toBe("lp-percy-1");
    expect(createSnapshot).not.toHaveBeenCalled();
    expect(linkSeats).not.toHaveBeenCalled();
  });
});
