import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import type { StudioFleetRemoteWorker } from "@specweave-studio/contracts/studioFleet";

vi.mock("./shell/Tip", () => ({
  Tip: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../../studio/fleet", () => ({ REMOTE_WORKERS_REFRESH_MS: 10_000 }));
const state = vi.hoisted(() => ({
  bootstrapped: true,
  checking: false,
  shells: [] as { environmentId: string; id: string }[],
}));
vi.mock("../../state/entities", () => ({
  useThreadShells: () => state.shells,
  useAllEnvironmentShellsBootstrapped: () => state.bootstrapped,
}));
vi.mock("../../hooks/useOpenThread", () => ({ useOpenThread: () => ({}) }));
vi.mock("../../hooks/useLiveRefresh", () => ({ useLiveRefresh: () => {} }));
vi.mock("../../studio/machineChecking", () => ({
  useMachineStillChecking: () => () => state.checking,
}));

import { RemoteWorkerCard, RemoteWorkerCardList } from "./RemoteWorkerCards";

const worker: StudioFleetRemoteWorker = {
  id: "rwt:1",
  machineId: "m1",
  machineLabel: "M1",
  environmentId: EnvironmentId.make("env-m1"),
  callerThreadId: ThreadId.make("coordinator"),
  remoteThreadId: ThreadId.make("b-thread"),
  threadRef: "studio://thread/env-m1/b-thread",
  title: "Fix CI",
  state: "idle",
  lastStatus: "completed",
  reachable: true,
  updatedAt: "2026-10-12T00:00:00.000Z",
};

describe("remote worker card", () => {
  it("names the machine and opens the thread there when this browser has it", () => {
    const html = renderToStaticMarkup(<RemoteWorkerCard worker={worker} onOpen={() => {}} />);
    expect(html).toContain('data-machine="m1"');
    expect(html).toContain("Thread Fix CI on M1, Done");
    expect(html).toContain("Open on M1");
  });

  it("says how to reach a machine this browser is not connected to", () => {
    const html = renderToStaticMarkup(<RemoteWorkerCard worker={worker} onOpen={null} />);
    expect(html).not.toContain("<button");
    expect(html).toContain("Connect M1 in Settings &gt; Machines");
  });

  it("says Checking, never Connect it, while that machine is still being checked", () => {
    const html = renderToStaticMarkup(<RemoteWorkerCard worker={worker} onOpen={null} checking />);
    expect(html).not.toContain("<button");
    expect(html).toContain("Checking M1…");
    expect(html).not.toContain("Settings &gt; Machines");
  });

  it("the list says Checking while that machine connects or its threads still load", () => {
    const list = () => renderToStaticMarkup(<RemoteWorkerCardList workers={[worker]} />);
    expect(list()).toContain("Connect M1 in Settings &gt; Machines");
    state.checking = true;
    try {
      expect(list()).toContain("Checking M1…");
    } finally {
      state.checking = false;
    }
    state.bootstrapped = false;
    try {
      expect(list()).toContain("Checking M1…");
      expect(list()).not.toContain("Settings &gt; Machines");
    } finally {
      state.bootstrapped = true;
    }
  });

  it("offers Open, not Connect, for a finished worker whose archived thread is not listed", () => {
    // m4 is connected (its other threads loaded) but the worker's thread was archived there.
    state.shells = [{ environmentId: "env-m1", id: "another-thread" }];
    try {
      const html = renderToStaticMarkup(<RemoteWorkerCardList workers={[worker]} />);
      expect(html).toContain("Open on M1");
      expect(html).not.toContain("Settings &gt; Machines");
    } finally {
      state.shells = [];
    }
  });
});
