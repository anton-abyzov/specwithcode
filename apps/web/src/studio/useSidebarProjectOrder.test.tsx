// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SidebarProjectOrder } from "@specweave-studio/contracts";

const state = vi.hoisted(() => ({
  config: null as { settings: { sidebarProjectOrder: SidebarProjectOrder } } | null,
  update: vi.fn(),
  client: {
    sidebarProjectGroupingMode: "repository",
    sidebarProjectGroupingOverrides: {},
    projectCoordinatorMachines: {} as Record<string, string>,
  },
  hydration: "ready",
  updateClient: vi.fn(),
  allListed: true,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.config }));
vi.mock("../state/server", () => ({ primaryServerConfigAtom: {} }));
vi.mock("../state/entities", () => ({
  useAllEnvironmentProjectSnapshotsReady: () => state.allListed,
}));
vi.mock("../hooks/useSettings", () => ({
  useUpdatePrimarySettings: () => state.update,
  useClientSettings: (select: (settings: typeof state.client) => unknown) => select(state.client),
  useClientSettingsHydrationStatus: () => state.hydration,
  useUpdateClientSettings: () => state.updateClient,
}));
import { deriveUnlinkedProjectKey } from "../logicalProject";
import { useSidebarProjectOrder } from "./useSidebarProjectOrder";

let root: Root;
let current: ReturnType<typeof useSidebarProjectOrder>;
let groups: Parameters<typeof useSidebarProjectOrder>[0];
function Probe() {
  const result = useSidebarProjectOrder(groups);
  useEffect(() => {
    current = result;
  });
  return null;
}
const render = () => act(async () => root.render(<Probe />));
const host = (order: SidebarProjectOrder) => {
  state.config = { settings: { sidebarProjectOrder: order } };
};

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  state.config = null;
  state.update.mockClear();
  state.updateClient.mockClear();
  state.client.projectCoordinatorMachines = {};
  state.hydration = "ready";
  state.allListed = true;
  groups = undefined;
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
});

describe("useSidebarProjectOrder", () => {
  it("reads the host's order and keeps a copy for the next start", async () => {
    host({ pinned: ["a"], unpinned: ["b"] });
    await render();
    expect(current[0]).toEqual({ pinned: ["a"], unpinned: ["b"] });
    expect(JSON.parse(localStorage.getItem("studio:sidebar-project-order:v1")!)).toEqual({
      pinned: ["a"],
      unpinned: ["b"],
    });
  });

  it("writes a move to the host and shows it before the host answers", async () => {
    host({ pinned: [], unpinned: ["a", "b"] });
    await render();
    await act(async () => current[1]({ pinned: ["b"], unpinned: ["a"] }));
    expect(state.update).toHaveBeenCalledWith({
      sidebarProjectOrder: { pinned: ["b"], unpinned: ["a"] },
    });
    expect(current[0]).toEqual({ pinned: ["b"], unpinned: ["a"] });
    // Another window's newer order replaces the optimistic one.
    host({ pinned: [], unpinned: ["b", "a"] });
    await render();
    expect(current[0]).toEqual({ pinned: [], unpinned: ["b", "a"] });
  });

  it("sends pins from older builds to a host with no order, and keeps them", async () => {
    localStorage.setItem("studio:sidebar-pinned-projects:v1", JSON.stringify(["a"]));
    await render();
    expect(current[0]).toEqual({ pinned: ["a"], unpinned: [] });
    host({ pinned: [], unpinned: [] });
    await render();
    expect(state.update).toHaveBeenCalledWith({
      sidebarProjectOrder: { pinned: ["a"], unpinned: [] },
    });
    expect(localStorage.getItem("studio:sidebar-pinned-projects:v1")).not.toBeNull();
  });

  it("keeps pins across restarts when an older service drops the setting", async () => {
    // Regression: a 1.0.19 service ignored sidebarProjectOrder, the client read
    // its empty default, and the pins moved out of this browser were lost.
    localStorage.setItem(
      "studio:sidebar-pinned-projects:v1",
      JSON.stringify(["github.com/anton-abyzov/specweave", "logical-project:easychamp"]),
    );
    host({ pinned: [], unpinned: [] });
    await render();
    await act(async () =>
      current[1]({
        pinned: ["logical-project:easychamp"],
        unpinned: ["github.com/anton-abyzov/specweave"],
      }),
    );
    // The service sends its settings again, still without an order.
    host({ pinned: [], unpinned: [] });
    await render();
    expect(current[0].pinned).toEqual(["logical-project:easychamp"]);
    // Restart: a new mount reads the same storage and the same empty host.
    await act(async () => root.unmount());
    root = createRoot(document.createElement("div"));
    host({ pinned: [], unpinned: [] });
    await render();
    expect(current[0].pinned).toEqual(["logical-project:easychamp"]);
  });

  it("prefers an order the host holds over this browser's", async () => {
    localStorage.setItem("studio:sidebar-pinned-projects:v1", JSON.stringify(["a"]));
    host({ pinned: ["b"], unpinned: [] });
    await render();
    expect(current[0]).toEqual({ pinned: ["b"], unpinned: [] });
    expect(state.update).not.toHaveBeenCalled();
  });

  it("keeps the order in this browser where no host anchors the app", async () => {
    await render();
    await act(async () => current[1]({ pinned: ["a"], unpinned: [] }));
    expect(state.update).not.toHaveBeenCalled();
    expect(current[0]).toEqual({ pinned: ["a"], unpinned: [] });
  });
});

describe("a link moves the project's key", () => {
  // Machines A and B hold copies of one repository; B's copy is then linked with C's.
  const identity = {
    canonicalKey: "example.com/team/app",
    locator: { source: "git-remote", remoteName: "origin", remoteUrl: "x" },
  };
  const copy = (environmentId: string, id: string, linked = false) => ({
    environmentId,
    id,
    workspaceRoot: `/work/${environmentId}/app`,
    repositoryIdentity: identity,
    workspaceSettings: linked
      ? { logicalProject: { id: "shared-app", title: "App", members: [] } }
      : undefined,
  });
  const repositoryKey = deriveUnlinkedProjectKey(copy("A", "a1") as never);
  const linkedKey = "logical-project:shared-app";
  const beforeLink = [
    { projectKey: repositoryKey, memberProjects: [copy("A", "a1"), copy("B", "b1")] },
    { projectKey: "other", memberProjects: [copy("A", "o1")] },
  ] as never;
  const afterLink = [
    { projectKey: repositoryKey, memberProjects: [copy("A", "a1")] },
    { projectKey: linkedKey, memberProjects: [copy("B", "b1", true), copy("C", "c1", true)] },
    { projectKey: "other", memberProjects: [copy("A", "o1")] },
  ] as never;

  it("moves the pin, its members and the saved machine to B's linked project", async () => {
    host({
      pinned: [repositoryKey],
      unpinned: ["other"],
      pinnedMembers: { [repositoryKey]: ["A:a1", "B:b1"] },
    });
    // The saved choice names a project C no longer has; A's copy cannot honor it.
    state.client.projectCoordinatorMachines = { [repositoryKey]: "C:old-project" };
    groups = beforeLink;
    await render();
    expect(current[0].pinned).toEqual([repositoryKey]);
    expect(state.update).not.toHaveBeenCalled();
    expect(state.updateClient).not.toHaveBeenCalled();

    groups = afterLink;
    await render();
    const moved = {
      pinned: [linkedKey],
      // A's leftovers keep no pin, and keep their place instead of counting as new.
      unpinned: [repositoryKey, "other"],
      pinnedMembers: { [linkedKey]: ["B:b1", "C:c1"] },
    };
    expect(current[0]).toEqual(moved);
    expect(state.update).toHaveBeenCalledTimes(1);
    expect(state.update).toHaveBeenCalledWith({ sidebarProjectOrder: moved });
    expect(state.updateClient).toHaveBeenCalledWith({
      projectCoordinatorMachines: { [linkedKey]: "C:old-project" },
    });
    // The host's next snapshot holds the move: nothing is written again.
    host(moved);
    state.client.projectCoordinatorMachines = { [linkedKey]: "C:old-project" };
    await render();
    // This browser's copy follows once the host holds the move.
    expect(JSON.parse(localStorage.getItem("studio:sidebar-project-order:v1")!)).toEqual(moved);
    expect(state.update).toHaveBeenCalledTimes(1);
    expect(state.updateClient).toHaveBeenCalledTimes(1);
  });

  it("puts an unpinned project's linked project in its place", async () => {
    host({ pinned: [], unpinned: ["other", repositoryKey] });
    groups = afterLink;
    await render();
    expect(current[0].unpinned).toEqual(["other", linkedKey, repositoryKey]);
  });

  it("leaves a pin recorded for the copies that stayed behind", async () => {
    host({ pinned: [repositoryKey], unpinned: [], pinnedMembers: { [repositoryKey]: ["A:a1"] } });
    state.client.projectCoordinatorMachines = { [repositoryKey]: "A:a1" };
    groups = afterLink;
    await render();
    expect(current[0].pinned).toEqual([repositoryKey]);
    expect(state.update).not.toHaveBeenCalled();
    expect(state.updateClient).not.toHaveBeenCalled();
  });

  it("writes nothing before the host's order and the saved choices have loaded", async () => {
    localStorage.setItem(
      "studio:sidebar-project-order:v1",
      JSON.stringify({
        pinned: [repositoryKey],
        unpinned: [],
        pinnedMembers: { [repositoryKey]: ["A:a1", "B:b1"] },
      }),
    );
    state.client.projectCoordinatorMachines = { [repositoryKey]: "C:old-project" };
    state.hydration = "loading";
    groups = afterLink;
    await render();
    // Shown moved at once, written once the host can hold it.
    expect(current[0].pinned).toEqual([linkedKey]);
    expect(state.update).not.toHaveBeenCalled();
    expect(state.updateClient).not.toHaveBeenCalled();
  });

  it("moves a pinned linked project and its saved machine back after an unlink", async () => {
    host({
      pinned: [linkedKey],
      unpinned: [repositoryKey, "other"],
      pinnedMembers: { [linkedKey]: ["B:b1", "C:c1"] },
    });
    state.client.projectCoordinatorMachines = { [linkedKey]: "B:b1" };
    // Unlinked: B's and C's copies group under the repository again, beside A's.
    groups = [
      {
        projectKey: repositoryKey,
        memberProjects: [copy("A", "a1"), copy("B", "b1"), copy("C", "c1")],
      },
      { projectKey: "other", memberProjects: [copy("A", "o1")] },
    ] as never;
    await render();
    const moved = {
      pinned: [repositoryKey],
      unpinned: ["other"],
      pinnedMembers: { [repositoryKey]: ["A:a1", "B:b1", "C:c1"] },
    };
    expect(current[0]).toEqual(moved);
    expect(state.update).toHaveBeenCalledWith({ sidebarProjectOrder: moved });
    expect(state.updateClient).toHaveBeenCalledWith({
      projectCoordinatorMachines: { [repositoryKey]: "B:b1" },
    });
  });

  it("moves the pin to a linked project an older build already saved unpinned", async () => {
    host({
      pinned: [repositoryKey],
      unpinned: [linkedKey, "other"],
      pinnedMembers: { [repositoryKey]: ["A:a1", "B:b1"] },
    });
    groups = afterLink;
    await render();
    expect(current[0]).toEqual({
      pinned: [linkedKey],
      unpinned: [repositoryKey, "other"],
      pinnedMembers: { [linkedKey]: ["B:b1", "C:c1"] },
    });
  });

  it("leaves an unrecorded pin on the copies still listed under it", async () => {
    // Nothing says whether B's copy was ever in the pinned group on this host.
    host({ pinned: [repositoryKey], unpinned: [] });
    groups = afterLink;
    await render();
    expect(current[0].pinned).toEqual([repositoryKey]);
    expect(state.update).not.toHaveBeenCalled();
  });

  it("moves an unrecorded pin when nothing is listed under the old key any more", async () => {
    host({ pinned: [repositoryKey], unpinned: ["other"] });
    groups = [
      { projectKey: linkedKey, memberProjects: [copy("B", "b1", true), copy("C", "c1", true)] },
      { projectKey: "other", memberProjects: [copy("A", "o1")] },
    ] as never;
    // A machine that has not sent its projects may still hold the old group.
    state.allListed = false;
    await render();
    expect(current[0].pinned).toEqual([repositoryKey]);
    expect(state.update).not.toHaveBeenCalled();
    state.allListed = true;
    await render();
    expect(current[0].pinned).toEqual([linkedKey]);
  });

  it("keeps the move in this browser's copy while the host holds no order", async () => {
    localStorage.setItem(
      "studio:sidebar-project-order:v1",
      JSON.stringify({
        pinned: [repositoryKey],
        unpinned: [],
        pinnedMembers: { [repositoryKey]: ["A:a1", "B:b1"] },
      }),
    );
    host({ pinned: [], unpinned: [] });
    groups = afterLink;
    await render();
    expect(JSON.parse(localStorage.getItem("studio:sidebar-project-order:v1")!).pinned).toEqual([
      linkedKey,
    ]);
  });
});
