/**
 * 1390 AC-23 and AC-28's undo: Bring back on one handed-off thread runs the
 * one-thread hand off back to the source, and is refused whenever it is unsure.
 */
import type {
  EnvironmentId,
  OrchestrationV2ThreadProjectMoveLink,
  ThreadId,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { HandoffDestination } from "./HandoffResults";
import { bringBackOffer, bringBackWaitReason, pinnedDestination } from "./bringBack.logic";

const m4 = "env-m4" as EnvironmentId;
const m5 = "env-m5" as EnvironmentId;
const onM4 = "thread-on-m4" as ThreadId;
const onM5 = "thread-on-m5" as ThreadId;
const name = (environmentId: string, label?: string | null) =>
  label ?? (environmentId === m4 ? "M4" : "M5");

const link = (patch: Partial<OrchestrationV2ThreadProjectMoveLink>) =>
  ({
    projectId: "project-1",
    title: "Ship the release",
    movedAt: "2026-11-19T14:02:00.000Z",
    kind: "handoff",
    ...patch,
  }) as OrchestrationV2ThreadProjectMoveLink;

/** The continuation on M5, which came from M4. */
const continued = {
  environmentId: m5,
  id: onM5,
  movedTo: null,
  movedFrom: link({ threadId: onM4, environmentId: m4, machineLabel: "M4", note: "Handed off" }),
};
/** The read-only copy left on M4. */
const original = {
  environmentId: m4,
  id: onM4,
  movedTo: link({ threadId: onM5, environmentId: m5, machineLabel: "M5", note: "Handed off" }),
  movedFrom: null,
};
const idle = { movedTo: null, hasPendingApprovals: false, hasPendingUserInput: false };

describe("on the continued thread", () => {
  it("hands this thread back to the machine it came from", () => {
    expect(
      bringBackOffer({
        thread: { ...continued, hasPendingApprovals: false, hasPendingUserInput: false },
        connected: [m4, m5],
        continuation: null,
        machineName: name,
      }),
    ).toEqual({
      threadRef: { environmentId: m5, threadId: onM5 },
      destinationEnvironmentId: m4,
      machine: "M4",
      refused: null,
    });
  });

  it("works for a move by hand, whose origin is the execution record", () => {
    const offer = bringBackOffer({
      thread: {
        environmentId: m5,
        id: onM5,
        movedTo: null,
        movedFrom: null,
        execution: {
          sourceRoot: { environmentId: m4, machineLabel: "M4", threadId: onM4 },
        } as never,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      },
      connected: [m4, m5],
      continuation: null,
      machineName: name,
    });
    expect(offer?.destinationEnvironmentId).toBe(m4);
    expect(offer?.refused).toBeNull();
  });

  it("refuses while the source is offline or the thread waits on a question or approval", () => {
    const offline = bringBackOffer({
      thread: { ...continued, hasPendingApprovals: false, hasPendingUserInput: false },
      connected: [m5],
      continuation: null,
      machineName: name,
    });
    expect(offline?.refused).toBe("M4 is offline, so the thread can't go back yet.");
    const asking = bringBackOffer({
      thread: { ...continued, hasPendingApprovals: false, hasPendingUserInput: true },
      connected: [m4, m5],
      continuation: null,
      machineName: name,
    });
    expect(asking?.refused).toBe("Answer its question, approval or sign-in first.");
    const approving = bringBackOffer({
      thread: { ...continued, hasPendingApprovals: true, hasPendingUserInput: false },
      connected: [m4, m5],
      continuation: null,
      machineName: name,
    });
    expect(approving?.refused).toBe("Answer its question, approval or sign-in first.");
  });

  it("offers nothing once the thread moved again, or without a known origin", () => {
    expect(
      bringBackOffer({
        thread: {
          ...continued,
          movedTo: link({ threadId: "thread-on-m3" as ThreadId, environmentId: "env-m3" as never }),
          hasPendingApprovals: false,
          hasPendingUserInput: false,
        },
        connected: [m4, m5],
        continuation: null,
        machineName: name,
      }),
    ).toBeNull();
    expect(
      bringBackOffer({
        thread: {
          ...continued,
          movedFrom: link({ threadId: onM4, environmentId: undefined }),
          hasPendingApprovals: false,
          hasPendingUserInput: false,
        },
        connected: [m4, m5],
        continuation: null,
        machineName: name,
      }),
    ).toBeNull();
    // A project move is not a hand off: nothing to bring back.
    expect(
      bringBackOffer({
        thread: {
          ...continued,
          movedFrom: link({ threadId: onM4, environmentId: m4, kind: "project" }),
          hasPendingApprovals: false,
          hasPendingUserInput: false,
        },
        connected: [m4, m5],
        continuation: null,
        machineName: name,
      }),
    ).toBeNull();
  });
});

describe("on the read-only copy left on the source", () => {
  it("hands the continuation back here when this window reaches its machine", () => {
    expect(
      bringBackOffer({
        thread: { ...original, hasPendingApprovals: false, hasPendingUserInput: false },
        connected: [m4, m5],
        continuation: idle,
        machineName: name,
      }),
    ).toEqual({
      threadRef: { environmentId: m5, threadId: onM5 },
      destinationEnvironmentId: m4,
      machine: "M4",
      refused: null,
    });
  });

  it("shows no button when the window can't reach that machine or the thread isn't there", () => {
    const base = {
      thread: { ...original, hasPendingApprovals: false, hasPendingUserInput: false },
      machineName: name,
    };
    expect(bringBackOffer({ ...base, connected: [m4], continuation: idle })).toBeNull();
    expect(bringBackOffer({ ...base, connected: [m4, m5], continuation: null })).toBeNull();
    // Moved on from M5: going back from here would move the wrong copy.
    expect(
      bringBackOffer({
        ...base,
        connected: [m4, m5],
        continuation: { ...idle, movedTo: link({ threadId: "thread-on-m3" as ThreadId }) },
      }),
    ).toBeNull();
  });

  it("refuses while the continuation waits on a question or approval", () => {
    expect(
      bringBackOffer({
        thread: { ...original, hasPendingApprovals: false, hasPendingUserInput: false },
        connected: [m4, m5],
        continuation: { ...idle, hasPendingApprovals: true },
        machineName: name,
      })?.refused,
    ).toBe("Answer its question, approval or sign-in first.");
  });

  it("offers nothing for a project move", () => {
    expect(
      bringBackOffer({
        thread: {
          ...original,
          movedTo: link({ threadId: onM5, environmentId: m4, kind: "project" }),
          hasPendingApprovals: false,
          hasPendingUserInput: false,
        },
        connected: [m4, m5],
        continuation: idle,
        machineName: name,
      }),
    ).toBeNull();
  });
});

describe("a pending sign-in", () => {
  it("refuses on the continuation and on the source's copy", () => {
    expect(
      bringBackOffer({
        thread: {
          ...continued,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasPendingSignIn: true,
        },
        connected: [m4, m5],
        continuation: null,
        machineName: name,
      })?.refused,
    ).toBe("Answer its question, approval or sign-in first.");
    expect(
      bringBackOffer({
        thread: { ...original, hasPendingApprovals: false, hasPendingUserInput: false },
        connected: [m4, m5],
        continuation: { ...idle, hasPendingSignIn: true },
        machineName: name,
      })?.refused,
    ).toBe("Answer its question, approval or sign-in first.");
  });
});

describe("bringBackWaitReason", () => {
  const shell = (kind: string | null) =>
    ({
      hasPendingApprovals: kind === "command",
      hasPendingUserInput: kind === "user_input",
      source: {
        pendingRuntimeRequest:
          kind === null ? null : { id: "r1", kind, createdAt: "2026-11-19T14:02:00.000Z" },
      },
    }) as never;

  it("reads the live thread: a question, approval or sign-in waits", () => {
    for (const kind of ["user_input", "command", "auth_refresh"])
      expect(bringBackWaitReason(shell(kind))).toBe(
        "Answer its question, approval or sign-in first.",
      );
  });

  it("lets an idle thread go, and refuses a thread it can't read", () => {
    expect(bringBackWaitReason(shell(null))).toBeNull();
    expect(bringBackWaitReason(null)).toBe("The thread can't be read here, so it stays.");
  });
});

describe("pinnedDestination", () => {
  const a = { environmentId: m4, label: "M4", state: "reachable" } as const;
  const c = {
    environmentId: "env-m3" as EnvironmentId,
    label: "M3",
    state: "reachable",
  } as const satisfies HandoffDestination;

  it("offers only the source machine", () => {
    expect(pinnedDestination([c, a], m4, name)).toEqual({
      destinations: [a],
      destination: m4,
      refused: null,
    });
  });

  it("never falls back to another machine when the source can't take work", () => {
    const offline = pinnedDestination([c, { ...a, state: "offline", reason: "Offline" }], m4, name);
    expect(offline.destination).toBeNull();
    expect(offline.destinations.map((item) => item.environmentId)).toEqual([m4]);
    expect(offline.refused).toBe("M4 can't take the thread back now: offline.");
    const update = pinnedDestination(
      [c, { ...a, state: "offline", reason: "Needs update" }],
      m4,
      name,
    );
    expect(update.destination).toBeNull();
    expect(update.refused).toBe("M4 can't take the thread back now: needs update.");
  });

  it("refuses when the source is not among the machines at all", () => {
    const missing = pinnedDestination([c], m4, name);
    expect(missing.destination).toBeNull();
    expect(missing.destinations).toEqual([
      { environmentId: m4, label: "M4", state: "offline", reason: "Not connected" },
    ]);
    expect(missing.refused).toBe("M4 can't take the thread back now: not connected.");
  });
});
