import { describe, expect, it } from "@effect/vitest";

import { handoffRunEnding, isResumableHandoffEnding } from "./handoffMode.ts";

describe("handoffRunEnding", () => {
  it("reads a run handoff mode interrupted as the handoff", () => {
    expect(
      handoffRunEnding({ status: "interrupted", interruptCause: "agent", fencedBy: "handoff" }),
    ).toBe("handoff");
    expect(handoffRunEnding({ status: "running", fencedBy: "sleep" })).toBe("sleep");
  });

  it("keeps the user's Stop final even when handoff mode fenced the thread", () => {
    const ending = handoffRunEnding({
      status: "interrupted",
      interruptCause: "user",
      fencedBy: "handoff",
    });
    expect(ending).toBe("user-stop");
    expect(isResumableHandoffEnding(ending)).toBe(false);
  });

  it("reads a service update interrupt without a fence as such", () => {
    expect(handoffRunEnding({ status: "interrupted", interruptCause: "service_update" })).toBe(
      "service-update",
    );
  });
});
