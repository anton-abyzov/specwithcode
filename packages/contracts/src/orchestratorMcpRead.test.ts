import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { OrchestratorMcpThreadReadInput } from "./orchestratorMcp.ts";

describe("thread read acknowledgement contract", () => {
  it("preserves the explicit no-ack flag and leaves ordinary reads unchanged", () => {
    const decode = Schema.decodeUnknownSync(OrchestratorMcpThreadReadInput);
    expect(decode({ threadId: "child", acknowledgeResult: false })).toEqual({
      threadId: "child",
      acknowledgeResult: false,
    });
    expect(decode({ threadId: "child" })).toEqual({ threadId: "child" });
    expect(decode({ threadId: "child", acknowledgeResult: true }).acknowledgeResult).toBe(true);
    expect(() => decode({ threadId: "child", acknowledgeResult: "false" })).toThrow();
  });
});
