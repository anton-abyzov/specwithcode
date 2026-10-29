import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  OrchestrationV2AppThreadJson,
  OrchestrationV2Command,
  OrchestrationV2ThreadOrigin,
  OrchestrationV2ThreadShellJson,
} from "./orchestrationV2.ts";

const at = "2026-10-28T00:00:00.000Z";

const appThreadRow = {
  createdBy: "agent",
  creationSource: "mcp",
  id: "thread-1",
  projectId: "project-1",
  title: "Thread",
  providerInstanceId: "claudeAgent",
  modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-1" },
  forkedFrom: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  deletedAt: null,
};

const shellRow = {
  ...appThreadRow,
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  settledOverride: null,
  settledAt: null,
};

const fleetOrigin = {
  kind: "fleet_machine",
  label: "SpecWithCode",
  machineLabel: "m4-studio",
  environmentId: "env-coordinator",
  parentThreadRef: { environmentId: "env-coordinator", threadId: "parent-thread" },
} as const;

const decodeAppThread = Schema.decodeUnknownSync(OrchestrationV2AppThreadJson);
const encodeAppThread = Schema.encodeSync(OrchestrationV2AppThreadJson);
const decodeShell = Schema.decodeUnknownSync(OrchestrationV2ThreadShellJson);
const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);
const decodeOrigin = Schema.decodeUnknownSync(OrchestrationV2ThreadOrigin);

describe("thread origin", () => {
  it("decodes rows written before origin existed without one", () => {
    expect(decodeAppThread(appThreadRow).origin).toBeUndefined();
    expect(decodeShell(shellRow).origin).toBeUndefined();
  });

  it("round-trips an MCP client origin and a fleet origin on stored threads", () => {
    const client = decodeAppThread({
      ...appThreadRow,
      origin: { kind: "mcp_client", label: "Claude.ai" },
    });
    expect(client.origin).toEqual({ kind: "mcp_client", label: "Claude.ai" });
    const fleet = decodeAppThread({ ...appThreadRow, origin: fleetOrigin });
    expect(fleet.origin).toEqual(fleetOrigin);
    expect(decodeAppThread(encodeAppThread(fleet))).toEqual(fleet);
    expect(decodeShell({ ...shellRow, origin: fleetOrigin }).origin).toEqual(fleetOrigin);
  });

  it("strips an origin a client sends on thread.create", () => {
    const command = decodeCommand({
      type: "thread.create",
      createdBy: "agent",
      creationSource: "mcp",
      commandId: "command-1",
      threadId: "thread-1",
      projectId: "project-1",
      title: "Thread",
      modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      origin: { kind: "mcp_client", label: "ChatGPT" },
    });
    // Only the server sets a thread's origin; the public command drops it.
    expect(command.type).toBe("thread.create");
    expect(command).not.toHaveProperty("origin");
  });

  it("refuses an unknown kind and a blank label", () => {
    expect(() => decodeOrigin({ kind: "browser", label: "x" })).toThrow();
    expect(() => decodeOrigin({ kind: "mcp_client", label: "   " })).toThrow();
  });
});
