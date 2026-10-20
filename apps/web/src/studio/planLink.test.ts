import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, type ProjectPlanLinkExport } from "@specweave-studio/contracts";

vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: () => "command",
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { linkedPlanGroups, syncLinkedPlans, type LinkedPlanMember } from "./planLink";

const member = (name: string): LinkedPlanMember => ({
  environmentId: EnvironmentId.make(`env-${name}`),
  projectId: ProjectId.make(`project-${name}`),
  label: `Mac ${name}`,
});
const plan = (name: string) => ({ plan: name }) as unknown as ProjectPlanLinkExport;

describe("syncLinkedPlans", () => {
  it("reads every member before merging each plan into every other member", async () => {
    const calls: string[] = [];
    const [a, b] = [member("a"), member("b")];
    await syncLinkedPlans([a, b], {
      exportPlan: async (item) => {
        calls.push(`export ${item.label}`);
        return plan(item.label);
      },
      mergePlan: async (target, peer, exported) => {
        calls.push(`merge ${(exported as unknown as { plan: string }).plan}→${target.label}`);
        expect(peer.label).toBe((exported as unknown as { plan: string }).plan);
      },
    });
    expect(calls).toEqual([
      "export Mac a",
      "export Mac b",
      "merge Mac a→Mac b",
      "merge Mac b→Mac a",
    ]);
  });

  it("skips a member whose plan cannot be read and keeps going after a failed merge", async () => {
    const merges: string[] = [];
    const [a, b, c] = [member("a"), member("b"), member("c")];
    await syncLinkedPlans([a, b, c], {
      exportPlan: async (item) => {
        if (item === b) throw new Error("offline");
        return plan(item.label);
      },
      mergePlan: async (target, peer) => {
        merges.push(`${peer.label}→${target.label}`);
        if (target === c) throw new Error("conflict");
      },
    });
    expect(merges).toEqual(["Mac a→Mac c", "Mac c→Mac a"]);
  });

  it("does nothing when fewer than two members can be read", async () => {
    const mergePlan = vi.fn(async () => undefined);
    await syncLinkedPlans([member("a"), member("b")], {
      exportPlan: async (item) => (item.label === "Mac a" ? plan("a") : null),
      mergePlan,
    });
    expect(mergePlan).not.toHaveBeenCalled();
  });
});

describe("linkedPlanGroups", () => {
  const project = (environment: string, id: string, logical?: string) =>
    ({
      id: ProjectId.make(id),
      environmentId: EnvironmentId.make(environment),
      ...(logical ? { workspaceSettings: { logicalProject: { id: logical } } } : {}),
    }) as unknown as EnvironmentProject;

  it("groups reachable copies of a linked project and drops groups on one machine", () => {
    const groups = linkedPlanGroups(
      [
        project("env-a", "pa", "atlas"),
        project("env-b", "pb", "atlas"),
        project("env-c", "pc", "atlas"),
        project("env-a", "solo", "beacon"),
        project("env-b", "plain"),
      ],
      (environmentId) => (environmentId === "env-c" ? null : { label: `Mac ${environmentId}` }),
    );
    expect(groups).toEqual([
      [
        { environmentId: "env-a", projectId: "pa", label: "Mac env-a" },
        { environmentId: "env-b", projectId: "pb", label: "Mac env-b" },
      ],
    ]);
  });
});
