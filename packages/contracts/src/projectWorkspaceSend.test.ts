import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ProjectCoordinatorResult, ProjectCoordinatorSendInput } from "./projectWorkspace.ts";

describe("coordinator send transport", () => {
  it("carries a retry's recheck flag and leaves it out of ordinary sends", () => {
    const decode = Schema.decodeUnknownSync(ProjectCoordinatorSendInput);
    const base = { projectId: "project", commandId: "command", prompt: "Hello" };
    expect(decode({ ...base, recheck: true }).recheck).toBe(true);
    expect(decode(base).recheck).toBeUndefined();
    expect(() => decode({ ...base, recheck: false })).toThrow();
  });

  it("returns where the turn was sent, and stays readable without it", () => {
    const decode = Schema.decodeUnknownSync(ProjectCoordinatorResult);
    const routed = decode({
      threadId: "thread",
      created: false,
      routing: {
        selection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
        reason: "saved",
        rechecked: true,
      },
    });
    expect(routed.routing?.selection.instanceId).toBe("claudeAgent");
    expect(routed.routing?.rechecked).toBe(true);
    expect(decode({ threadId: "thread", created: true }).routing).toBeUndefined();
  });
});
