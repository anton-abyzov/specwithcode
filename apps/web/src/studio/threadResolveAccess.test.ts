import { describe, expect, it } from "vite-plus/test";

import { threadResolveBlockedReason, type ThreadResolveAccessInput } from "./threadResolveAccess";

describe("threadResolveBlockedReason", () => {
  const base: ThreadResolveAccessInput = {
    canOperate: true,
    connection: { phase: "connected" },
    supportsSettlement: true,
    environmentId: "dd2fc230",
    machineLabel: "Ministorm",
    action: "resolve",
  };

  it("allows a connected machine this browser may operate", () => {
    expect(threadResolveBlockedReason(base)).toBeNull();
    expect(threadResolveBlockedReason({ ...base, action: "reopen" })).toBeNull();
  });

  it("names what stops the resolve", () => {
    expect(threadResolveBlockedReason({ ...base, connection: { phase: "connecting" } })).toBe(
      "Ministorm isn't connected right now, so this thread can't be resolved.",
    );
    expect(
      threadResolveBlockedReason({ ...base, connection: { phase: "error" }, action: "reopen" }),
    ).toBe("Ministorm isn't connected right now, so this thread can't be reopened.");
    expect(threadResolveBlockedReason({ ...base, connection: null })).toContain("isn't connected");
    expect(
      threadResolveBlockedReason({
        ...base,
        connection: { phase: "disconnected", blockedReason: "authentication" },
      }),
    ).toBe("This browser is signed out of Ministorm. Sign in to it again to resolve this thread.");
    expect(threadResolveBlockedReason({ ...base, canOperate: false })).toBe(
      "This connection can't change threads on Ministorm.",
    );
  });

  it("tells a machine that is still loading from one that is too old", () => {
    expect(threadResolveBlockedReason({ ...base, supportsSettlement: undefined })).toBe(
      "Still loading Ministorm's details. Try again in a moment.",
    );
    expect(threadResolveBlockedReason({ ...base, supportsSettlement: false })).toBe(
      "Ministorm runs an older version that can't resolve threads. Update it first.",
    );
  });

  it("reports the connection before the grant and the version", () => {
    // A disconnected machine keeps its last grant and details, so neither says anything yet.
    expect(
      threadResolveBlockedReason({
        ...base,
        connection: { phase: "reconnecting" },
        canOperate: false,
        supportsSettlement: false,
      }),
    ).toContain("isn't connected");
  });

  it("never shows a machine's raw ID", () => {
    expect(
      threadResolveBlockedReason({ ...base, connection: null, machineLabel: "dd2fc230" }),
    ).toBe("That machine isn't connected right now, so this thread can't be resolved.");
    expect(
      threadResolveBlockedReason({ ...base, canOperate: false, machineLabel: undefined }),
    ).toBe("This connection can't change threads there.");
    expect(
      threadResolveBlockedReason({
        ...base,
        supportsSettlement: false,
        machineLabel: "dd2fc230",
      }),
    ).toBe("That machine runs an older version that can't resolve threads. Update it first.");
  });
});
