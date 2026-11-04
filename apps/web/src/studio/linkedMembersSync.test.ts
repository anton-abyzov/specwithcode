import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";

import { membersSyncRequests, sameMemberSet } from "./linkedMembersSync";

const member = (environmentId: string, projectId: string) => ({
  environmentId: environmentId as never,
  projectId: projectId as never,
  coordinatorThreadId: `project-coordinator:${projectId}` as never,
});
const [a, b, c] = [member("m4", "pa"), member("m3", "pb"), member("m1", "pc")];
const copy = (
  self: ReturnType<typeof member>,
  binding: Record<string, unknown>,
  members: ReadonlyArray<ReturnType<typeof member>>,
) =>
  ({
    environmentId: self.environmentId,
    id: self.projectId,
    workspaceSettings: {
      coordinatorBinding: binding,
      logicalProject: { id: "logical:1", title: "EasyChamp", coordinatorId: "c", members },
    },
  }) as unknown as EnvironmentProject;

describe("linked member sync from the app", () => {
  const coordinator = copy(a, { epoch: 2, state: "active" }, [a, b, c]);
  const behind = copy(b, { epoch: 2, state: "transferred", successor: a }, [a, b]);
  const current = copy(c, { epoch: 2, state: "transferred", successor: a }, [c, a, b]);

  it("pushes syncMembers to a capable member whose member set differs", () => {
    expect(membersSyncRequests(coordinator, [coordinator, behind, current], () => true)).toEqual([
      {
        environmentId: "m3",
        input: {
          projectId: "pb",
          logicalProjectId: "logical:1",
          from: a,
          fromEpoch: 2,
          members: [a, b, c],
        },
      },
    ]);
  });

  it("does nothing when the sets match, the member is not capable, or the copy does not coordinate", () => {
    expect(membersSyncRequests(coordinator, [behind], (id) => id !== "m3")).toEqual([]);
    expect(membersSyncRequests(coordinator, [current], () => true)).toEqual([]);
    expect(membersSyncRequests(behind, [coordinator, current], () => true)).toEqual([]);
    expect(sameMemberSet([a, b], [{ ...b, workspaceRoot: "/x" } as never, a])).toBe(true);
  });
});
