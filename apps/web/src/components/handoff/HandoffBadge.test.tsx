import type {
  EnvironmentId,
  HandoffIncomingReplica,
  HandoffModeSnapshot,
  HandoffThreadState,
  ThreadId,
} from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  handoffBadgeFor,
  handoffMachineCandidates,
  incomingReplicaFor,
  isHandoffReadOnly,
  unreachableBadgeFor,
} from "../../studio/handoffMode";
import { HandoffBadgeActions, HandoffBadgeChip } from "./HandoffBadge";

const M4 = "env-m4" as EnvironmentId;
const MINIS = "env-minis" as EnvironmentId;
const T1 = "thread-1" as ThreadId;
const name = (environmentId: string, fallback?: string | null) =>
  environmentId === MINIS ? "Minis" : (fallback ?? environmentId);

const thread = (patch: Partial<HandoffThreadState>): HandoffThreadState =>
  ({
    threadId: T1,
    projectId: "project-1",
    mode: "on",
    effectiveMode: "on",
    badge: null,
    checkpoint: null,
    replicas: [],
    lease: null,
    continuedOn: null,
    fencedBranch: null,
    lastError: null,
    ...patch,
  }) as HandoffThreadState;

const snapshot = (patch: Partial<HandoffModeSnapshot>): HandoffModeSnapshot =>
  ({
    environmentId: M4,
    machineLabel: "M4",
    config: {
      defaultMode: "off",
      noteModel: "cheap",
      pushToOrigin: true,
      sleepTarget: null,
      autoTakeoverMinutes: 0,
    },
    projectModes: {},
    threads: [],
    incoming: [],
    pausedSince: null,
    machineRun: null,
    ...patch,
  }) as HandoffModeSnapshot;

const replica = (patch: Partial<HandoffIncomingReplica>): HandoffIncomingReplica =>
  ({
    sourceEnvironmentId: M4,
    sourceLabel: "M4",
    sourceThreadId: T1,
    projectId: null,
    title: "Fix the build",
    sourceLastSeenAt: "2026-10-20T20:00:00.000Z",
    sourceUnreachable: true,
    receivedAt: "2026-10-20T20:00:00.000Z",
    continuedThreadId: null,
    ...patch,
  }) as HandoffIncomingReplica;

const render = (node: React.ReactElement) => renderToStaticMarkup(node);
const open = () => {};

describe("handoff badges", () => {
  it("shows Ready to move in the accent state once replicated", () => {
    const badge = handoffBadgeFor(snapshot({ threads: [thread({ badge: "ready" })] }), T1, name);
    expect(badge).toEqual({ kind: "ready", label: "Ready to move" });
    const html = render(<HandoffBadgeChip badge={badge!} />);
    expect(html).toContain('data-handoff="ready"');
    expect(html).toContain("Ready to move");
  });

  it("shows Syncing with each lagging machine's reason", () => {
    const badge = handoffBadgeFor(
      snapshot({
        threads: [
          thread({
            badge: "behind",
            replicas: [
              {
                environmentId: MINIS,
                machineLabel: "minis.local",
                state: "needs-grant",
                sequence: 2,
                detail: "no work grant for this project",
                updatedAt: "2026-10-20T20:00:00.000Z",
              },
            ] as HandoffThreadState["replicas"],
          }),
        ],
      }),
      T1,
      name,
    );
    expect(badge).toMatchObject({
      kind: "behind",
      label: "Syncing",
      detail: "Minis: no work grant for this project",
    });
  });

  it("shows Moving… during a transfer", () => {
    expect(
      handoffBadgeFor(snapshot({ threads: [thread({ badge: "handing-off" })] }), T1, name),
    ).toEqual({ kind: "handing-off", label: "Moving…" });
  });

  it("shows Moved to <machine> with a link, and the source turns read-only", () => {
    const state = snapshot({
      threads: [
        thread({
          badge: "continued",
          continuedOn: {
            environmentId: MINIS,
            machineLabel: "minis.local",
            threadId: "thread-2" as ThreadId,
            at: "2026-10-20T20:00:00.000Z",
          },
        }),
      ],
    });
    const badge = handoffBadgeFor(state, T1, name);
    expect(badge).toMatchObject({ kind: "continued", label: "Moved to Minis", machine: "Minis" });
    expect(isHandoffReadOnly(state, T1)).toBe(true);
    const html = render(
      <HandoffBadgeActions
        badge={badge!}
        environmentId={M4}
        localEnvironmentId={M4}
        onOpenThread={open}
      />,
    );
    expect(html).toContain("Open on Minis");
  });

  it("offers one-click Continue here when the source machine is offline", () => {
    const local = snapshot({ environmentId: MINIS, incoming: [replica({})] });
    const badge = unreachableBadgeFor(incomingReplicaFor(local, M4, T1), name);
    expect(badge?.label).toBe("M4 is offline");
    const html = render(
      <HandoffBadgeActions
        badge={badge!}
        environmentId={M4}
        localEnvironmentId={MINIS}
        onOpenThread={open}
      />,
    );
    expect(html).toContain("Continue here");
    // A reachable source or an already continued checkpoint shows nothing.
    expect(
      unreachableBadgeFor(
        incomingReplicaFor(snapshot({ incoming: [replica({ sourceUnreachable: false })] }), M4, T1),
        name,
      ),
    ).toBeNull();
    expect(
      incomingReplicaFor(
        snapshot({ incoming: [replica({ continuedThreadId: "t-3" as ThreadId })] }),
        M4,
        T1,
      ),
    ).toBeNull();
  });

  it("shows Paused after sleep with Resume this Mac… after a fenced wake", () => {
    const badge = handoffBadgeFor(
      snapshot({
        pausedSince: "2026-10-20T20:00:00.000Z",
        threads: [thread({ badge: "ready" })],
      }),
      T1,
      name,
    );
    expect(badge).toEqual({ kind: "paused", label: "Paused after sleep" });
    const html = render(
      <HandoffBadgeActions
        badge={badge!}
        environmentId={M4}
        localEnvironmentId={M4}
        onOpenThread={open}
      />,
    );
    expect(html).toContain("Resume this Mac…");
    // The button only asks; the dialog stays closed until it is pressed.
    expect(html).not.toContain("Resume all threads on this Mac?");
  });

  it("shows nothing for a thread outside handoff mode", () => {
    expect(handoffBadgeFor(snapshot({ threads: [] }), T1, name)).toBeNull();
    expect(handoffBadgeFor(null, T1, name)).toBeNull();
  });

  it("lists only running, not continued, handoff-mode threads for a machine handoff", () => {
    const state = snapshot({
      threads: [
        thread({ threadId: "a" as ThreadId }),
        thread({ threadId: "b" as ThreadId, effectiveMode: "off" }),
        thread({
          threadId: "c" as ThreadId,
          continuedOn: {
            environmentId: MINIS,
            machineLabel: "Minis",
            threadId: "x" as ThreadId,
            at: "2026-10-20T20:00:00.000Z",
          },
        }),
        thread({ threadId: "d" as ThreadId }),
      ],
    });
    const ids = handoffMachineCandidates(state, (id) => id !== "d").map((item) => item.threadId);
    expect(ids).toEqual(["a"]);
  });
});
