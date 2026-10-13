import type { EnvironmentId, ProjectId, ThreadId } from "@specweave-studio/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
  shell: null as { projectId: string; createdBy?: "agent" | "user" } | null,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../components/settings/useSettingsProjectGroups", () => ({
  useSettingsProjectGroups: () => [
    {
      projectKey: "atlas",
      memberProjects: [
        {
          environmentId: "host",
          id: "atlas-project",
          workspaceSettings: { coordinatorThreadId: "project-coordinator:atlas-project" },
        },
      ],
    },
  ],
}));
vi.mock("../state/entities", () => ({ readThreadShell: () => state.shell }));

import { useOpenChat } from "./useOpenChat";

let renderer: ReactTestRenderer | null = null;
const openers: Array<ReturnType<typeof useOpenChat>> = [];
function Probe() {
  openers.push(useOpenChat());
  return null;
}
const openChat = (...args: Parameters<ReturnType<typeof useOpenChat>>) => openers.at(-1)!(...args);
const target = (threadId: string, projectId?: string) => ({
  environmentId: "host" as EnvironmentId,
  threadId: threadId as ThreadId,
  ...(projectId ? { projectId: projectId as ProjectId } : {}),
});

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.navigate.mockClear();
  state.shell = null;
  await act(() => {
    renderer = create(<Probe />);
  });
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  openers.length = 0;
  vi.unstubAllGlobals();
});

describe("useOpenChat", () => {
  it("opens a project workspace's thread in that project's right panel", async () => {
    state.shell = { projectId: "atlas-project", createdBy: "agent" };
    await openChat(target("worker", "atlas-project"));
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/projects/$projectKey",
      params: { projectKey: "atlas" },
      search: { thread: "worker", checkout: "host:atlas-project" },
    });
  });
  it("looks the project up when the caller only has the thread", async () => {
    state.shell = { projectId: "atlas-project", createdBy: "agent" };
    await openChat(target("worker"));
    expect(state.navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ to: "/projects/$projectKey" }),
    );
  });
  it("opens the current coordinator main view on its exact checkout", async () => {
    await openChat(target("project-coordinator:atlas-project", "atlas-project"));
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/projects/$projectKey",
      params: { projectKey: "atlas" },
      search: { checkout: "host:atlas-project" },
    });
  });
  it("keeps a human chat in the same directory independent", async () => {
    state.shell = { projectId: "atlas-project", createdBy: "user" };
    await openChat(target("mine", "atlas-project"));
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "host", threadId: "mine" },
    });
  });
  it("opens any other chat full page", async () => {
    await openChat(target("chat", "elsewhere"));
    await openChat(target("unknown"));
    expect(state.navigate.mock.calls).toEqual([
      [{ to: "/$environmentId/$threadId", params: { environmentId: "host", threadId: "chat" } }],
      [{ to: "/$environmentId/$threadId", params: { environmentId: "host", threadId: "unknown" } }],
    ]);
  });
});
