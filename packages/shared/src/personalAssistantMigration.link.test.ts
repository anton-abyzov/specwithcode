import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  executePersonalAssistantMigration,
  type MigrationSeatInput,
  personalLinkIdsFor,
  personalLinkJoinOrder,
  planPersonalAssistantMigration,
} from "./personalAssistantMigration.ts";

// Fictional machines and ids.
const seat = (
  environmentId: string,
  overrides: Partial<MigrationSeatInput> = {},
): MigrationSeatInput => ({
  environmentId: environmentId as EnvironmentId,
  machineLabel: environmentId.toUpperCase(),
  projectId: `percy-${environmentId}` as ProjectId,
  title: "Percy",
  createdAt: "2026-01-01T00:00:00.000Z",
  supportsPersonalLink: true,
  existingLogicalProjectId: null,
  memoryFiles: [],
  ...overrides,
});

const env = (id: string) => id as EnvironmentId;
const onLink = (id: string, members: string[]) => ({
  existingLogicalProjectId: id,
  identityId: id,
  existingMembers: members.map((m) => `${m}:percy-${m}`),
});

describe("planPersonalAssistantMigration (1448 C2)", () => {
  it("reports an unreachable seat apart from one that needs an update", () => {
    const plan = planPersonalAssistantMigration([
      seat("a"),
      seat("b", { supportsPersonalLink: false, previewError: "timed out" }),
      seat("c", { supportsPersonalLink: false }),
    ]);
    expect(plan.unreachableSeats).toEqual([
      { environmentId: "b", machineLabel: "B", message: "timed out" },
    ]);
    expect(plan.unsupportedPeers.map((p) => p.environmentId)).toEqual(["c"]);
    expect(plan.canProceed).toBe(false);
  });

  it("refuses a link that would join two different existing links", async () => {
    const seats = [
      seat("a", onLink("logical:x", ["a", "b"])),
      seat("b", onLink("logical:x", ["a", "b"])),
      seat("c", onLink("logical:y", ["c", "d"])),
      seat("d", onLink("logical:y", ["c", "d"])),
    ];
    const plan = planPersonalAssistantMigration(seats);
    expect(plan.conflictingLinkIds).toEqual(["logical:x", "logical:y"]);
    expect(plan.existingLinkId).toBeNull();
    expect(plan.canProceed).toBe(false);
    const result = await executePersonalAssistantMigration({
      seats,
      ownerApproved: true,
      routineOwnerEnvironmentId: env("a"),
      resolutions: {},
      createSnapshot: async () => "copy",
      linkSeats: async () => {
        throw new Error("must not link");
      },
    });
    expect(result.error?.code).toBe("conflicting_links");
  });

  it("names the existing link when a third machine joins", () => {
    const plan = planPersonalAssistantMigration([
      seat("a", onLink("logical:x", ["a", "b"])),
      seat("b", onLink("logical:x", ["a", "b"])),
      seat("c"),
    ]);
    expect(plan.existingLinkId).toBe("logical:x");
    expect(plan.alreadyLinkedLogicalId).toBeNull();
    expect(plan.canProceed).toBe(true);
  });

  it("refuses while a machine on the existing link is not taking part", async () => {
    // a and b are linked, b is offline and was left out, c is new.
    const seats = [seat("a", onLink("logical:x", ["a", "b"])), seat("c")];
    const plan = planPersonalAssistantMigration(seats);
    expect(plan.missingLinkMembers).toEqual(["b:percy-b"]);
    expect(plan.canProceed).toBe(false);
    const result = await executePersonalAssistantMigration({
      seats,
      ownerApproved: true,
      routineOwnerEnvironmentId: env("a"),
      resolutions: {},
      createSnapshot: async () => "copy",
      linkSeats: async () => {
        throw new Error("must not link");
      },
    });
    expect(result.error?.code).toBe("link_member_missing");
  });

  it("is not already linked while a seat on the link does not list every machine", () => {
    const plan = planPersonalAssistantMigration([
      seat("a", onLink("logical:x", ["a", "b", "c"])),
      seat("b", onLink("logical:x", ["a", "b"])),
      seat("c", onLink("logical:x", ["a", "b", "c"])),
    ]);
    expect(plan.alreadyLinkedLogicalId).toBeNull();
    expect(plan.existingLinkId).toBe("logical:x");
  });

  it("is already linked when every seat lists every machine", () => {
    const plan = planPersonalAssistantMigration([
      seat("a", onLink("logical:x", ["a", "b"])),
      seat("b", onLink("logical:x", ["a", "b"])),
    ]);
    expect(plan.alreadyLinkedLogicalId).toBe("logical:x");
  });
});

describe("personalLinkIdsFor", () => {
  const fresh = [seat("a"), seat("b", { identityId: "logical:solo-b" })];

  it("gives a new link the same id on every opening", () => {
    const first = personalLinkIdsFor({
      canonicalSeats: fresh,
      existingLinkId: null,
      memberKeys: ["a:percy-a", "b:percy-b"],
    });
    const second = personalLinkIdsFor({
      canonicalSeats: [...fresh].reverse(),
      existingLinkId: null,
      memberKeys: ["b:percy-b", "a:percy-a"],
    });
    expect(first).toEqual(second);
    expect(first.logicalProjectId.startsWith("logical:")).toBe(true);
  });

  it("changes the new id once a seat's identity changes (an unlink mints a new one)", () => {
    const before = personalLinkIdsFor({
      canonicalSeats: fresh,
      existingLinkId: null,
      memberKeys: [],
    });
    const after = personalLinkIdsFor({
      canonicalSeats: [seat("a"), seat("b", { identityId: "logical:solo-b-2" })],
      existingLinkId: null,
      memberKeys: [],
    });
    expect(after.logicalProjectId).not.toBe(before.logicalProjectId);
  });

  it("never reuses a seat's own one-member identity id", () => {
    const ids = personalLinkIdsFor({ canonicalSeats: fresh, existingLinkId: null, memberKeys: [] });
    expect(ids.logicalProjectId).not.toBe("logical:solo-b");
  });

  it("reuses an existing link id, with a new operation id when the member set grows", () => {
    const two = personalLinkIdsFor({
      canonicalSeats: fresh,
      existingLinkId: "logical:x",
      memberKeys: ["a:percy-a", "b:percy-b"],
    });
    const three = personalLinkIdsFor({
      canonicalSeats: fresh,
      existingLinkId: "logical:x",
      memberKeys: ["a:percy-a", "b:percy-b", "c:percy-c"],
    });
    expect(two.logicalProjectId).toBe("logical:x");
    expect(three.logicalProjectId).toBe("logical:x");
    expect(three.operationId).not.toBe(two.operationId);
  });
});

describe("personalLinkJoinOrder", () => {
  it("joins the routine runner first on a new link", () => {
    const order = personalLinkJoinOrder([seat("a"), seat("b"), seat("c")], null, env("b"));
    expect(order.map((s) => s.environmentId)).toEqual(["b", "a", "c"]);
  });

  it("joins seats already on the link before new ones, runner first in each group", () => {
    const order = personalLinkJoinOrder(
      [
        seat("c"),
        seat("a", onLink("logical:x", ["a", "b"])),
        seat("b", onLink("logical:x", ["a", "b"])),
        seat("d"),
      ],
      "logical:x",
      env("b"),
    );
    expect(order.map((s) => s.environmentId)).toEqual(["b", "a", "c", "d"]);
  });
});
