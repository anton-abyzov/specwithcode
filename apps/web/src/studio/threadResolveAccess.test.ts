import { describe, expect, it } from "vite-plus/test";

import {
  threadResolveAction,
  threadResolveBlockedReason,
  type ThreadResolveAccessInput,
} from "./threadResolveAccess";

describe("threadResolveAction", () => {
  it("resolves an open thread and reopens a resolved or archived one", () => {
    expect(threadResolveAction({ archivedAt: null, settledOverride: null })).toEqual({
      action: "resolve",
      needsSettlement: true,
    });
    expect(threadResolveAction({ archivedAt: null, settledOverride: "settled" })).toEqual({
      action: "reopen",
      needsSettlement: true,
    });
    expect(threadResolveAction({ archivedAt: "2026-10-14", settledOverride: "settled" })).toEqual({
      action: "reopen",
      needsSettlement: true,
    });
  });

  it("needs no settlement support to restore history a server only archived", () => {
    expect(threadResolveAction({ archivedAt: "2026-10-14", settledOverride: null })).toEqual({
      action: "reopen",
      needsSettlement: false,
    });
  });
});

describe("threadResolveBlockedReason", () => {
  const base: ThreadResolveAccessInput = {
    access: "granted",
    connection: { phase: "connected" },
    machinesLoaded: true,
    supportsSettlement: true,
    environmentId: "dd2fc230",
    machineLabel: "Ministorm",
    action: "resolve",
    needsSettlement: true,
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
    expect(
      threadResolveBlockedReason({
        ...base,
        connection: { phase: "disconnected", blockedReason: "authentication" },
      }),
    ).toBe("This browser is signed out of Ministorm. Sign in to it again to resolve this thread.");
    expect(threadResolveBlockedReason({ ...base, access: "signed-out", action: "reopen" })).toBe(
      "This browser is signed out of Ministorm. Sign in to it again to reopen this thread.",
    );
    expect(threadResolveBlockedReason({ ...base, access: "denied" })).toBe(
      "This connection can't change threads on Ministorm.",
    );
  });

  it("tells a machine this device never paired with from one that dropped", () => {
    // Reconnecting fixes a dropped machine and never an unknown one, so they read differently.
    for (const connection of [null, undefined])
      expect(threadResolveBlockedReason({ ...base, connection })).toBe(
        "This device is not paired with Ministorm, so this thread can't be resolved from here.",
      );
  });

  it("does not call a machine unpaired while the list of machines is still loading", () => {
    for (const connection of [null, undefined])
      expect(threadResolveBlockedReason({ ...base, connection, machinesLoaded: false })).toBe(
        "Still loading Ministorm's details. Try again in a moment.",
      );
    // A machine already listed speaks for itself, loaded list or not.
    expect(threadResolveBlockedReason({ ...base, machinesLoaded: false })).toBeNull();
  });

  it("tells a grant or a machine that is still loading from a refusal", () => {
    expect(threadResolveBlockedReason({ ...base, access: "unknown" })).toBe(
      "Still checking this browser's access to Ministorm. Try again in a moment.",
    );
    expect(threadResolveBlockedReason({ ...base, supportsSettlement: undefined })).toBe(
      "Still loading Ministorm's details. Try again in a moment.",
    );
    expect(threadResolveBlockedReason({ ...base, supportsSettlement: false })).toBe(
      "Ministorm runs an older version that can't resolve threads. Update it first.",
    );
  });

  it("restores history a server only archived, whatever that server's version", () => {
    const archivedOnly = { ...base, action: "reopen", needsSettlement: false } as const;
    expect(threadResolveBlockedReason({ ...archivedOnly, supportsSettlement: false })).toBeNull();
    // Not while the version is still unknown: a server that does resolve threads must
    // also clear the settlement, and reopening then would skip that without a word.
    expect(threadResolveBlockedReason({ ...archivedOnly, supportsSettlement: undefined })).toBe(
      "Still loading Ministorm's details. Try again in a moment.",
    );
    // The restore still runs on that machine, so its connection and grant still decide.
    expect(threadResolveBlockedReason({ ...archivedOnly, access: "denied" })).toBe(
      "This connection can't change threads on Ministorm.",
    );
    expect(
      threadResolveBlockedReason({ ...archivedOnly, connection: { phase: "reconnecting" } }),
    ).toContain("isn't connected");
  });

  it("reports the connection before the grant and the version", () => {
    // A disconnected machine keeps its last grant and details, so neither says anything yet.
    expect(
      threadResolveBlockedReason({
        ...base,
        connection: { phase: "reconnecting" },
        access: "denied",
        supportsSettlement: false,
      }),
    ).toContain("isn't connected");
  });

  it("never shows a machine's raw ID", () => {
    expect(
      threadResolveBlockedReason({
        ...base,
        connection: { phase: "connecting" },
        machineLabel: "dd2fc230",
      }),
    ).toBe("That machine isn't connected right now, so this thread can't be resolved.");
    expect(threadResolveBlockedReason({ ...base, connection: null, machineLabel: "dd2fc230" })).toBe(
      "This device is not paired with that machine, so this thread can't be resolved from here.",
    );
    expect(threadResolveBlockedReason({ ...base, access: "denied", machineLabel: undefined })).toBe(
      "This connection can't change threads there.",
    );
    expect(threadResolveBlockedReason({ ...base, access: "unknown", machineLabel: "dd2fc230" })).toBe(
      "Still checking this browser's access to that machine. Try again in a moment.",
    );
    expect(
      threadResolveBlockedReason({ ...base, supportsSettlement: false, machineLabel: "dd2fc230" }),
    ).toBe("That machine runs an older version that can't resolve threads. Update it first.");
  });

  it("stays blocked while a machine reconnects, and says so instead of disconnected", () => {
    const reconnecting = {
      ...base,
      connection: { phase: "reconnecting" },
      reach: "reconnecting",
    } as const;
    expect(threadResolveBlockedReason(reconnecting)).toBe(
      "Reconnecting to Ministorm. Try again in a moment.",
    );
    expect(
      threadResolveBlockedReason({ ...reconnecting, reach: "not-answering" }),
    ).toBe("Ministorm isn't connected right now, so this thread can't be resolved.");
  });
});
