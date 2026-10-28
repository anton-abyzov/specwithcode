import type {
  EnvironmentId,
  HandoffIncomingReplica,
  HandoffModeSnapshot,
  HandoffThreadState,
  ThreadId,
} from "@specweave-studio/contracts";
import { act, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const M4 = "env-m4" as EnvironmentId;
const MINIS = "env-minis" as EnvironmentId;
const T1 = "thread-1" as ThreadId;

const snapshots = new Map<string, HandoffModeSnapshot>();
const runHandoffMode = vi.fn();

vi.mock("../../studio/handoffMode", async (importActual) => {
  const actual = await importActual<typeof import("../../studio/handoffMode")>();
  return {
    ...actual,
    runHandoffMode: (...args: unknown[]) => runHandoffMode(...args),
    useHandoffModeSnapshot: (environmentId: EnvironmentId | null) => ({
      snapshot: environmentId === null ? null : (snapshots.get(environmentId) ?? null),
      error: null,
    }),
  };
});
vi.mock("../../studio/machineNickname", () => ({
  useMachineNicknames: () => (environmentId: string, fallback?: string | null) =>
    environmentId === MINIS ? "Minis" : (fallback ?? environmentId),
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (options: unknown) => options,
}));
vi.mock("../ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div role="alertdialog">{children}</div> : null,
  AlertDialogPopup: ({ children }: { children: ReactNode }) => children,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => children,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => children,
  AlertDialogClose: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

import { continueHereFailure } from "../../studio/handoffMode";
import { UnreachableHostsContext } from "../../studio/unreachableHosts";
import { toastManager } from "../ui/toast";
import { HandoffBadgeActions, HandoffThreadHeaderBadge } from "./HandoffBadge";

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

const replica = {
  sourceEnvironmentId: M4,
  sourceLabel: "M4",
  sourceThreadId: T1,
  projectId: null,
  title: "Fix the build",
  sourceLastSeenAt: "2026-10-20T20:00:00.000Z",
  sourceUnreachable: true,
  receivedAt: "2026-10-20T20:00:00.000Z",
  continuedThreadId: null,
} as unknown as HandoffIncomingReplica;

let renderer: ReactTestRenderer | null = null;
const mount = (node: ReactElement) => {
  act(() => {
    renderer = create(node);
  });
  return renderer!;
};
const text = () => JSON.stringify(renderer!.toJSON());
const button = (label: string) =>
  renderer!.root.find(
    (node) =>
      node.type === "button" && ([] as unknown[]).concat(node.props.children).join("") === label,
  );
const flush = () => act(async () => {});

beforeEach(() => {
  snapshots.clear();
  runHandoffMode.mockReset();
  vi.mocked(toastManager.add).mockReset();
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe("Resume this Mac…", () => {
  const paused = { kind: "paused", label: "Paused after sleep" } as const;

  it("asks first, and resumes only after the confirm button", async () => {
    runHandoffMode.mockResolvedValue({ ok: true, value: snapshot({}) });
    mount(
      <HandoffBadgeActions
        badge={paused}
        environmentId={M4}
        localEnvironmentId={M4}
        onOpenThread={() => {}}
      />,
    );
    expect(text()).not.toContain("Resume all threads on this Mac?");
    act(() => button("Resume this Mac…").props.onClick());
    expect(text()).toContain("Resume all threads on this Mac?");
    expect(text()).toContain(
      "This Mac handed its threads off before sleeping. Resuming lets them run here again, even if another machine already picked them up.",
    );
    expect(button("Cancel")).toBeTruthy();
    expect(runHandoffMode).not.toHaveBeenCalled();
    act(() => button("Resume this Mac").props.onClick());
    await flush();
    expect(runHandoffMode).toHaveBeenCalledTimes(1);
    expect(runHandoffMode.mock.calls[0]![1]).toEqual({ environmentId: M4, input: {} });
    expect(text()).not.toContain("Resume all threads on this Mac?");
  });
});

describe("Continue here refusals", () => {
  const offline = {
    kind: "source-unreachable",
    label: "M4 is offline",
    machine: "M4",
    replica,
  } as const;

  it("turns a fresh lease into plain advice, keeping the server's words underneath", async () => {
    const server =
      "M4 renewed this thread's lease less than 90 seconds ago; it may still be running it.";
    runHandoffMode.mockResolvedValue({ ok: false, error: server });
    mount(
      <HandoffBadgeActions
        badge={offline}
        environmentId={M4}
        localEnvironmentId={MINIS}
        onOpenThread={() => {}}
      />,
    );
    act(() => button("Continue here").props.onClick());
    await flush();
    expect(toastManager.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "M4 was active moments ago. Try again in a minute.",
        description: server,
      }),
    );
  });

  it("keeps any other refusal as the server wrote it", () => {
    expect(continueHereFailure("Minis needs an update.", "M4")).toEqual({
      title: "Couldn't continue here",
      description: "Minis needs an update.",
    });
  });

  it("shows a Not carried over notice as a warning, not a success", async () => {
    const opened = vi.fn();
    runHandoffMode.mockResolvedValue({
      ok: true,
      value: { environmentId: MINIS, threadId: "t-2", notice: "Not carried over: .env.local" },
    });
    mount(
      <HandoffBadgeActions
        badge={offline}
        environmentId={M4}
        localEnvironmentId={MINIS}
        onOpenThread={opened}
      />,
    );
    act(() => button("Continue here").props.onClick());
    await flush();
    expect(toastManager.add).toHaveBeenCalledWith(
      expect.objectContaining({ type: "warning", title: "Not carried over: .env.local" }),
    );
    expect(opened).toHaveBeenCalledWith("t-2", MINIS);
  });
});

describe("thread header badge", () => {
  it("reads from the local copy when the thread's machine is offline, like the row", () => {
    // M4's last answer still says ready; it is offline, so the header must not trust it.
    snapshots.set(M4, snapshot({ threads: [thread({ badge: "ready" })] }));
    snapshots.set(MINIS, snapshot({ environmentId: MINIS, incoming: [replica] }));
    mount(
      <UnreachableHostsContext.Provider value={new Set([M4])}>
        <HandoffThreadHeaderBadge
          environmentId={M4}
          threadId={T1}
          localEnvironmentId={MINIS}
          onOpenThread={() => {}}
          canOperate
        />
      </UnreachableHostsContext.Provider>,
    );
    expect(text()).toContain("M4 is offline");
    expect(text()).not.toContain("Ready to move");
    expect(button("Continue here")).toBeTruthy();
  });

  it("shows the machine's own state while it answers", () => {
    snapshots.set(M4, snapshot({ threads: [thread({ badge: "ready" })] }));
    mount(
      <HandoffThreadHeaderBadge
        environmentId={M4}
        threadId={T1}
        localEnvironmentId={MINIS}
        onOpenThread={() => {}}
        canOperate
      />,
    );
    expect(text()).toContain("Ready to move");
  });
});
