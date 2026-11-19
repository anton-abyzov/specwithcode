// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  groups: [] as unknown[],
  updateProject: vi.fn(async (_input: unknown) => ({ _tag: "Success" as const })),
}));
vi.mock("./useSettingsProjectGroups", () => ({ useSettingsProjectGroups: () => state.groups }));
vi.mock("../../state/entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("../../state/projects", () => ({ projectEnvironment: { update: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.updateProject }));
vi.mock("../../studio/machineNickname", () => ({
  useMachineNicknames: () => (id: string) => id.toUpperCase(),
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ children, title, ...rest }: Record<string, unknown>) => (
    <section {...(rest as object)}>
      <h2>{title as never}</h2>
      {children as never}
    </section>
  ),
  SettingsRow: ({ title, description, control }: Record<string, unknown>) => (
    <div>
      {title as never}
      <p>{description as never}</p>
      {control as never}
    </div>
  ),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, params }: { children: unknown; params: { projectKey: string } }) => (
    <a href={`/projects/${params.projectKey}`}>{children as never}</a>
  ),
}));

const { ArchivedProjectsSections } = await import("./ArchivedProjectsSections");

const project = (key: string, name: string, settings: Record<string, unknown>, root: string) => ({
  projectKey: key,
  displayName: name,
  workspaceRoot: root,
  memberProjects: [
    { environmentId: "m1", id: `${key}-id`, workspaceRoot: root, workspaceSettings: settings },
  ],
});

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  state.updateProject.mockClear();
  state.groups = [
    project("own", "Atlas", { kind: "code", revision: 0 }, "/Users/me/atlas"),
    project("old", "Old site", { kind: "code", archived: true, revision: 3 }, "/Users/me/old"),
    project(
      "check",
      "Run shell acceptance",
      { kind: "code", revision: 1 },
      "/Users/me/.specwithcode/m4/scratch/run/workspace",
    ),
  ];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const show = () => act(async () => root.render(<ArchivedProjectsSections />));
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === label)!;

it("lists archived and automated projects apart, each opening its project page", async () => {
  await show();
  const archived = container.querySelector("[data-archived-projects]")!;
  const automated = container.querySelector("[data-automated-projects]")!;
  expect(archived.textContent).toContain("Old site");
  expect(archived.querySelector("a")?.getAttribute("href")).toBe("/projects/old");
  expect(automated.textContent).toContain("Run shell acceptance");
  expect(automated.textContent).toContain("M1");
  expect(container.textContent).not.toContain("Atlas");
});

it("restores an archived project and moves an automated one to the person's projects", async () => {
  await show();
  await act(async () => button("Restore").click());
  expect(state.updateProject).toHaveBeenLastCalledWith({
    environmentId: "m1",
    input: { projectId: "old-id", workspaceSettings: { expectedRevision: 3, archived: false } },
  });
  await act(async () => button("Move to your projects").click());
  expect(state.updateProject).toHaveBeenLastCalledWith({
    environmentId: "m1",
    input: { projectId: "check-id", workspaceSettings: { expectedRevision: 1, origin: "user" } },
  });
});

it("shows nothing when no project is archived or automated", async () => {
  state.groups = [state.groups[0]];
  await show();
  expect(container.textContent).toBe("");
});
