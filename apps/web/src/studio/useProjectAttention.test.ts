import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import type { AttentionMember } from "@specweave-studio/client-runtime/state/projectAttention";

import { memberFreshness, sameAttentionMembers } from "./useProjectAttention";

const snapshot = (projectIds: string[]) =>
  Option.some({ projects: projectIds.map((id) => ({ id })) } as never);

describe("memberFreshness", () => {
  it("reads a project on a live machine as live", () => {
    expect(memberFreshness({ snapshot: snapshot(["a"]), status: "live" }, "a", false)).toBe("live");
  });

  it("reads a project a live machine no longer has as live, not catching up forever", () => {
    expect(memberFreshness({ snapshot: snapshot(["a"]), status: "live" }, "gone", false)).toBe(
      "live",
    );
  });

  it("waits for a machine that is still synchronizing or only cached", () => {
    expect(
      memberFreshness({ snapshot: snapshot(["a"]), status: "synchronizing" }, "a", false),
    ).toBe("synchronizing");
    expect(
      memberFreshness({ snapshot: snapshot(["a"]), status: "synchronizing" }, "gone", false),
    ).toBe("empty");
    expect(memberFreshness({ snapshot: snapshot(["a"]), status: "cached" }, "gone", false)).toBe(
      "empty",
    );
    expect(memberFreshness({ snapshot: Option.none(), status: "empty" }, "a", false)).toBe("empty");
  });

  it("reads an unreachable machine as offline", () => {
    expect(memberFreshness({ snapshot: snapshot(["a"]), status: "live" }, "a", true)).toBe(
      "offline",
    );
  });
});

describe("sameAttentionMembers", () => {
  const member: AttentionMember = {
    environmentId: "host",
    projectId: "project",
    coordinatorThreadId: "coordinator",
    freshness: "live",
    includeUserRoots: false,
    remoteWorkers: [{ environmentId: "m1", remoteThreadId: "t1", state: "running" }],
    remoteWorkersComplete: true,
  };

  it("lets the earlier reading stand when a poll answers the same", () => {
    const again = {
      ...member,
      remoteWorkers: member.remoteWorkers!.map((worker) => ({ ...worker })),
    };
    expect(sameAttentionMembers([member], [again])).toBe(true);
  });

  it("tells a changed worker, freshness, coverage or member apart", () => {
    const worker = member.remoteWorkers![0]!;
    for (const changed of [
      { ...member, remoteWorkers: [{ ...worker, state: "paused_auth" }] },
      { ...member, remoteWorkers: [{ ...worker, remoteThreadId: null }] },
      { ...member, remoteWorkers: [] },
      { ...member, freshness: "cached" as const },
      { ...member, remoteWorkersComplete: false },
      { ...member, coordinatorThreadId: "other" },
    ])
      expect(sameAttentionMembers([member], [changed])).toBe(false);
    expect(sameAttentionMembers([member], [member, member])).toBe(false);
  });
});
