import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { AuthOrchestrationOperateScope } from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { ProjectId } from "./baseSchemas.ts";
import { ProjectNativePlan, ProjectPlanError, ProjectPlanTask } from "./projectPlan.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

const decodeTask = Schema.decodeUnknownSync(ProjectPlanTask);
const decodePlan = Schema.decodeUnknownSync(ProjectNativePlan);

describe("linked plan contracts", () => {
  it("registers both plan link methods", () => {
    expect(WsRpcGroup.requests.has(WS_METHODS.projectLinkPlanExport)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.projectLinkPlanMerge)).toBe(true);
  });
  it("requires operate to merge a peer plan; exporting needs only the server's read grant", () => {
    expect(clientRpcRequiredScopes(WS_METHODS.projectLinkPlanMerge, {})).toEqual([
      AuthOrchestrationOperateScope,
    ]);
    expect(clientRpcRequiredScopes(WS_METHODS.projectLinkPlanExport, {})).toEqual([]);
  });
  it("names the machine holding a refused claim", () => {
    const projectId = ProjectId.make("p");
    expect(new ProjectPlanError({ projectId, code: "claimed", machine: "Mac A" }).message).toBe(
      "This task is claimed by a thread on Mac A. Only the user can release that claim.",
    );
    expect(new ProjectPlanError({ projectId, code: "claimed" }).message).toContain(
      "Release the assignment explicitly",
    );
  });
  it("decodes plans and tasks written before claims carried a machine", () => {
    const task = decodeTask({
      id: "T-1",
      title: "Build",
      criterionIds: [],
      verification: null,
      owner: { kind: "thread", threadId: "t-1" },
      status: "in_progress",
      note: "",
      evidence: [],
    });
    expect(task.owner).toEqual({ kind: "thread", threadId: "t-1" });
    expect(task.claimedAt).toBeUndefined();
    const plan = decodePlan({
      spec: "",
      criteria: [],
      tasks: [task],
      contentRevision: 0,
    });
    expect(plan.machines).toBeUndefined();
  });
});
