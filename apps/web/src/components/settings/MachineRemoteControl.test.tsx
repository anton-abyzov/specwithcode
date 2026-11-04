// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@specweave-studio/contracts";
const state = vi.hoisted(() => ({
  phase: "connected",
  read: true,
  operate: true,
  groups: [] as any[],
  openPalette: vi.fn(),
}));
vi.mock("./useSettingsProjectGroups", () => ({ useSettingsProjectGroups: () => state.groups }));
vi.mock("../../commandPaletteBus", () => ({ openCommandPalette: state.openPalette }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [{ environmentId: "remote", connection: { phase: state.phase } }],
  }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: (_id: string, scope: string) =>
    scope === "orchestration:operate" ? state.operate : state.read,
}));
vi.mock("../../state/entities", () => ({
  useServerConfigs: () => new Map(),
  useThreadShells: () => [
    { id: "remote-thread", environmentId: "remote", title: "Remote work", deletedAt: null },
    { id: "local-thread", environmentId: "local", title: "Local work", deletedAt: null },
  ],
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, search, children, ...rest }: any) => (
    <a {...rest} href={`${to}?${new URLSearchParams(params ?? search)}`}>
      {children}
    </a>
  ),
}));
import { MachineRemoteControl } from "./MachineRemoteControl";
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  document.body.innerHTML = "";
  state.phase = "connected";
  state.read = true;
  state.operate = true;
  state.groups = [];
  state.openPalette.mockReset();
});
async function render() {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <MachineRemoteControl environmentId={EnvironmentId.make("remote")} name="Remote PC" />,
    ),
  );
}
it("opens only the target machine's view, including when no shared project exists", async () => {
  await render();
  await act(async () => document.querySelector<HTMLButtonElement>("button")!.click());
  expect(document.body.textContent).toContain("Remote work");
  expect(document.body.textContent).not.toContain("Local work");
  const links = [...document.querySelectorAll("a")];
  expect(links.find((link) => link.textContent === "Remote work")?.href).toContain(
    "environmentId=remote",
  );
  expect(document.body.textContent).toContain("No projects on Remote PC yet.");
  expect(state.openPalette).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Viewing does not move");
});
it("labels a read-only grant View", async () => {
  state.operate = false;
  await render();
  expect(document.querySelector("button")?.textContent).toBe("View");
  await act(async () => document.querySelector<HTMLButtonElement>("button")!.click());
  expect(document.body.textContent).toContain("View only");
});
it.each(["disconnected", "connecting"])("cannot open an unavailable %s machine", async (phase) => {
  state.phase = phase;
  await render();
  expect(document.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
});
it("cannot open without read permission", async () => {
  state.read = false;
  await render();
  expect(document.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
});

it("closes the view without changing the selected machine or thread", async () => {
  await render();
  await act(async () => document.querySelector<HTMLButtonElement>("button")!.click());
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector("button")?.textContent).toBe("Remote control");
});

it("starts explicit project setup on the remote without creating work on open", async () => {
  await render();
  await act(async () => document.querySelector<HTMLButtonElement>("button")!.click());
  expect(state.openPalette).not.toHaveBeenCalled();
  const add = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "Add a project on Remote PC",
  )!;
  await act(async () => add.click());
  expect(state.openPalette).toHaveBeenCalledExactlyOnceWith({
    open: "add-project",
    environmentId: "remote",
  });
});
it("does not offer project creation to a read-only remote", async () => {
  state.operate = false;
  await render();
  await act(async () => document.querySelector<HTMLButtonElement>("button")!.click());
  expect(
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Add a project on Remote PC",
    )!.disabled,
  ).toBe(true);
});

const projectMember = (environmentId: string, id: string) => ({
  environmentId,
  projectId: id,
  physicalProjectKey: `${environmentId}:${id}`,
  environmentLabel: environmentId,
  workspaceRoot: `/${environmentId}/${id}`,
  archivedAt: null,
  origin: "user",
  workspaceSettings: null,
});
const projectGroup = (key: string, title: string, members: any[]) => ({
  projectKey: key,
  displayName: title,
  workspaceRoot: members[0].workspaceRoot,
  memberProjects: members,
  workspaceSettings: null,
});
it("does not show local-only projects for an empty remote", async () => {
  state.groups = [projectGroup("local-x", "Local-only project", [projectMember("local", "x")])];
  await render();
  await act(async () => document.querySelector<HTMLButtonElement>("button")!.click());
  expect(document.body.textContent).not.toContain("Local-only project");
  expect(document.body.textContent).toContain("No projects on Remote PC yet.");
});
it("resolves a shared project's local-primary group to the remote checkout", async () => {
  state.groups = [
    projectGroup("shared", "Shared project", [
      projectMember("local", "x"),
      projectMember("remote", "y"),
    ]),
  ];
  await render();
  await act(async () => document.querySelector<HTMLButtonElement>("button")!.click());
  const link = [...document.querySelectorAll("a")].find(
    (a) => a.textContent === "Shared project · remote",
  )!;
  const search = Object.fromEntries(new URL(link.href).searchParams);
  const { resolveSettingsScope } = await import("./settingsScope");
  const scope = resolveSettingsScope(search, state.groups, [
    { environmentId: EnvironmentId.make("local"), label: "Local" },
    { environmentId: EnvironmentId.make("remote"), label: "Remote" },
  ]);
  expect(scope.kind).toBe("checkout");
  expect(scope.members.map((m) => m.environmentId)).toEqual(["remote"]);
  expect(scope.kind === "checkout" && scope.checkout.physicalProjectKey).toBe("remote:y");
});
