// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";

const state = vi.hoisted(() => ({
  projects: [] as unknown[],
  connected: new Set<string>(),
  health: new Map<string, string>(),
}));
vi.mock("../../state/entities", () => ({ useProjects: () => state.projects }));
vi.mock("../../state/environments", () => ({
  useEnvironment: (id: string) => ({
    connection: { phase: state.connected.has(id) ? "connected" : "disconnected" },
  }),
}));
vi.mock("../../studio/machineNickname", () => ({
  useMachineNickname: (id: string) => id.toUpperCase(),
}));
vi.mock("../../studio/useProjectFolderHealth", () => ({
  useProjectFolderHealth: (project: { environmentId: string }) =>
    state.health.get(project.environmentId) ?? "unknown",
}));

const { ProjectFolderCopies, otherProjectCopies } = await import("./ProjectFolderCopies");

const copy = (environmentId: string, workspaceRoot: string, logical = "logical-1") =>
  ({
    environmentId,
    id: `${environmentId}-project`,
    workspaceRoot,
    workspaceSettings: { logicalProject: { id: logical } },
  }) as unknown as EnvironmentProject;
const here = copy("m4", "/Users/me/Projects/app");
const m5 = copy("m5", "/Users/me/code/app");
const m1 = copy("m1", "/Users/me/Projects/app");
const unrelated = copy("m1", "/Users/me/Projects/other", "logical-2");

let root: Root, container: HTMLDivElement;
const change = vi.fn((copy: EnvironmentProject) => (
  <p data-change-for={copy.environmentId}>change form</p>
));
const show = () =>
  act(async () =>
    root.render(<ProjectFolderCopies project={here} disabled={false} renderChange={change} />),
  );
const row = (environmentId: string) =>
  container.querySelector<HTMLElement>(`[data-folder-copy="${environmentId}"]`);

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  state.projects = [here, m5, m1, unrelated];
  state.connected = new Set(["m4", "m5"]);
  state.health = new Map();
  change.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("lists the same logical project on other machines, never by path", () => {
  expect(otherProjectCopies(here, state.projects as EnvironmentProject[])).toEqual([m5, m1]);
  expect(otherProjectCopies({ ...here, workspaceSettings: null } as never, [m5])).toEqual([]);
});

it("lists the copies the sidebar groups as this project even when they are not linked", () => {
  const unlinked = (environmentId: string, workspaceRoot: string) =>
    ({ ...copy(environmentId, workspaceRoot), workspaceSettings: null }) as unknown as EnvironmentProject;
  const m1Copy = unlinked("m1", "/Users/me/Projects/app-fleet");
  const m4Copy = unlinked("m4", "/Users/me/Projects/app");
  const stranger = unlinked("m5", "/Users/me/Projects/app");
  const all = [m1Copy, m4Copy, stranger];
  expect(otherProjectCopies(m1Copy, all, [m1Copy, m4Copy])).toEqual([m4Copy]);
  expect(otherProjectCopies(m1Copy, all)).toEqual([]);
  expect(otherProjectCopies(here, state.projects as EnvironmentProject[], [here, m5])).toEqual([
    m5,
    m1,
  ]);
});

it("shows an unlinked member's folder in the list", async () => {
  const m1Copy = {
    ...copy("m1", "/Users/me/Projects/app-fleet"),
    workspaceSettings: null,
  } as unknown as EnvironmentProject;
  const m4Copy = {
    ...copy("m4", "/Users/me/Projects/sw-app"),
    workspaceSettings: null,
  } as unknown as EnvironmentProject;
  state.projects = [m1Copy, m4Copy];
  await act(async () =>
    root.render(
      <ProjectFolderCopies
        project={m1Copy}
        members={[m1Copy, m4Copy]}
        disabled={false}
        renderChange={change}
      />,
    ),
  );
  expect(row("m4")?.textContent).toContain("/Users/me/Projects/sw-app");
  expect(row("m1")).toBeNull();
});

it("names each other machine with its folder", async () => {
  await show();
  expect(row("m5")?.textContent).toContain("M5");
  expect(row("m5")?.textContent).toContain("/Users/me/code/app");
  expect(row("m4")).toBeNull();
  expect(row("m1")).not.toBeNull();
});

it("changes a copy's folder only while its machine is connected, and says why not", async () => {
  await show();
  const offline = row("m1")!.querySelector("button")!;
  expect(offline.disabled).toBe(true);
  expect(row("m1")?.textContent).toContain("M1 is offline");
  const online = row("m5")!.querySelector("button")!;
  expect(online.textContent).toBe("Change…");
  await act(async () => online.click());
  expect(change).toHaveBeenCalledWith(m5, expect.any(Function));
  expect(row("m5")?.querySelector("[data-change-for='m5']")).not.toBeNull();
});

it("shows Folder missing with Relink for a connected machine, and stays silent offline", async () => {
  state.health = new Map([
    ["m5", "missing"],
    ["m1", "missing"],
  ]);
  await show();
  expect(row("m5")?.textContent).toContain("Folder missing");
  expect(row("m5")?.querySelector("button")?.textContent).toBe("Relink…");
  expect(row("m1")?.textContent).not.toContain("Folder missing");
});

it("shows nothing for a project with a single copy", async () => {
  state.projects = [here];
  await show();
  expect(container.innerHTML).toBe("");
});
