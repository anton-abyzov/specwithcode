/** Bring back on the target (1267 AC-08): only threads that came from the caller go back. */
import { EnvironmentId } from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";

import { coordinatorReturnRefusal, returnable } from "./awayReturnRoute.ts";

const m4 = EnvironmentId.make("env-m4");

describe("returnable", () => {
  it("hands back only the caller's continuations and says why the rest stay", () => {
    const result = returnable(
      [
        { id: "from-m4", sourceEnvironmentId: "env-m4", found: true },
        { id: "from-other", sourceEnvironmentId: "env-other", found: true },
        { id: "gone", sourceEnvironmentId: null, found: false },
      ],
      m4,
    );
    expect(result.ok).toEqual(["from-m4"]);
    expect(result.refused.map((entry) => [entry.threadId, entry.outcome, entry.detail])).toEqual([
      ["from-other", "skipped", "That thread did not come here from your machine, so it stays."],
      ["gone", "skipped", "That thread is not on this machine any more."],
    ]);
  });

  it("keeps a thread whose project the caller's grant no longer covers", () => {
    const result = returnable(
      [
        { id: "covered", sourceEnvironmentId: "env-m4", found: true, projectCovered: true },
        { id: "outside", sourceEnvironmentId: "env-m4", found: true, projectCovered: false },
      ],
      m4,
      { owner: "self", revoked: false },
    );
    expect(result.ok).toEqual(["covered"]);
    expect(result.refused.map((entry) => entry.threadId)).toEqual(["outside"]);
  });

  it("hands nothing back under a grant that may not return work to its origin", () => {
    const team = returnable([{ id: "t", sourceEnvironmentId: "env-m4", found: true }], m4, {
      owner: "other",
      revoked: false,
    });
    const revoked = returnable([{ id: "t", sourceEnvironmentId: "env-m4", found: true }], m4, {
      owner: "self",
      revoked: true,
    });
    expect(team.ok).toEqual([]);
    expect(revoked.ok).toEqual([]);
    expect(team.refused[0]?.detail).toBe(
      "Your machine's work grant here does not cover that thread, so it stays.",
    );
  });
});

describe("coordinatorReturnRefusal", () => {
  const copy = (binding: Record<string, unknown> | undefined, id = "proj-here") =>
    ({ id, workspaceSettings: { coordinatorBinding: binding } }) as never;
  const predecessor = (environmentId: string) => ({
    environmentId,
    projectId: "proj-m4",
    coordinatorThreadId: "thread-m4",
  });
  const allGrant = { owner: "self", revoked: false, projects: { kind: "all" } } as const;

  it("hands back a coordinator this copy took from the caller by Away or planned handover", () => {
    for (const operationId of ["away:abc:3", "handover:abc:3"]) {
      expect(
        coordinatorReturnRefusal(
          copy({ state: "active", epoch: 3, operationId, predecessor: predecessor("env-m4") }),
          m4,
          allGrant,
        ),
      ).toBeNull();
    }
  });

  it("keeps a coordinator this machine runs for itself or took from a third machine", () => {
    const own = copy({ state: "active", epoch: 1 });
    const fromOther = copy({
      state: "active",
      epoch: 4,
      operationId: "away:abc:4",
      predecessor: predecessor("env-other"),
    });
    const autoTakeover = copy({
      state: "active",
      epoch: 4,
      operationId: "auto:abc:4",
      predecessor: predecessor("env-m4"),
    });
    const transferred = copy({
      state: "transferred",
      epoch: 4,
      operationId: "away:abc:4",
      predecessor: predecessor("env-m4"),
    });
    for (const project of [own, fromOther, autoTakeover, transferred])
      expect(coordinatorReturnRefusal(project, m4, allGrant)).toBe(
        "This machine did not take this coordinator from yours, so it stays.",
      );
  });

  it("keeps a coordinator whose project the caller's grant does not cover", () => {
    const taken = copy({
      state: "active",
      epoch: 2,
      operationId: "away:abc:2",
      predecessor: predecessor("env-m4"),
    });
    expect(
      coordinatorReturnRefusal(taken, m4, {
        owner: "self",
        revoked: false,
        projects: { kind: "listed", projectIds: ["some-other"] } as never,
      }),
    ).toBe("Your machine's work grant here does not cover this project, so its coordinator stays.");
    expect(
      coordinatorReturnRefusal(taken, m4, {
        owner: "self",
        revoked: false,
        projects: { kind: "listed", projectIds: ["proj-here"] } as never,
      }),
    ).toBeNull();
  });
});
