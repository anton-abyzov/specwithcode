import { describe, expect, it } from "@effect/vitest";

import { othersRoutineRefusal } from "./routineOwnership.ts";

const work = (kind: "own" | "team") => ({
  coordinatorLabel: "Ministorm",
  grant: { coordinatorEnvironmentId: "env-ministorm" as never, kind },
});
const task = { title: "IG post" };

describe("which routines another machine's work may manage", () => {
  it("lets either kind manage the routines its own grant made", () => {
    const mine = { coordinatorEnvironmentId: "env-ministorm" };
    expect(othersRoutineRefusal(work("team"), task, mine)).toBeNull();
    expect(othersRoutineRefusal(work("own"), task, mine)).toBeNull();
  });

  it("lets own-machine work manage the owner's routines, made here or by any own machine", () => {
    expect(othersRoutineRefusal(work("own"), task, undefined, "run")).toBeNull();
    expect(
      othersRoutineRefusal(
        work("own"),
        task,
        { coordinatorEnvironmentId: "env-m1", kind: "own" },
        "delete",
      ),
    ).toBeNull();
  });

  it("keeps a team machine's routine its own, even from own-machine work", () => {
    expect(
      othersRoutineRefusal(work("own"), task, { coordinatorEnvironmentId: "env-laptop" }),
    ).toContain("another machine's work");
    expect(
      othersRoutineRefusal(work("own"), task, {
        coordinatorEnvironmentId: "env-laptop",
        kind: "team",
      }),
    ).not.toBeNull();
  });

  it("keeps today's rule for team work", () => {
    expect(othersRoutineRefusal(work("team"), task, undefined)).toContain(
      "was set up on this machine",
    );
    expect(
      othersRoutineRefusal(work("team"), task, { coordinatorEnvironmentId: "env-m1", kind: "own" }),
    ).not.toBeNull();
  });
});
