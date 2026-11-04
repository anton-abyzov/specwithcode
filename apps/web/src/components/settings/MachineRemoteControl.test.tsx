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
  threads: [] as any[],
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
  useThreadShells: () => state.threads,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, search, children, ...rest }: any) => (
    <a {...rest} href={`${to}?${new URLSearchParams(params ?? search)}`}>
      {children}
    </a>
  ),
}));
import { MachineRemoteControl } from "./MachineRemoteControl";
const shell = (id: string, environmentId: string, title: string, at: string, extra = {}) => ({
  id,
  environmentId,
  projectId: "y",
  title,
  deletedAt: null,
  archivedAt: null,
  createdAt: at,
  latestRun: null,
  latestUserMessageAt: null,
  ...extra,
});
const defaultThreads = () => [
  shell("remote-thread", "remote", "Remote work", "2026-11-04T10:00:00Z"),
  shell("local-thread", "local", "Local work", "2026-11-04T10:00:00Z"),
];
state.threads = defaultThreads();
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  document.body.innerHTML = "";
  state.phase = "connected";
  state.read = true;
  state.operate = true;
  state.groups = [];
  state.threads = defaultThreads();
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
  expect(links.find((link) => link.textContent?.startsWith("Remote work"))?.href).toContain(
    "environmentId=remote",
  );
  expect(document.body.textContent).toContain("No projects on Remote PC yet.");
  expect(state.openPalette).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Work stays on this machine.");
  expect(document.body.textContent).not.toContain("Viewing does not move");
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
    (b) => b.textContent === "Add a project",
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
      (b) => b.textContent === "Add a project",
    )!.disabled,
  ).toBe(true);
});

const projectMember = (environmentId: string, id: string, workspaceRoot?: string) => ({
  environmentId,
  id,
  physicalProjectKey: `${environmentId}:${id}`,
  environmentLabel: environmentId,
  workspaceRoot: workspaceRoot ?? `/${environmentId}/${id}`,
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
  const link = [...document.querySelectorAll("a")].find((a) =>
    a.textContent?.startsWith("Shared project"),
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

const openSheet = async () => {
  await render();
  await act(async () => document.querySelector<HTMLButtonElement>("button")!.click());
};
const buttonNamed = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    b.textContent?.includes(text),
  );

it("lists one row per project name, without the machine suffix, and hides temporary folders", async () => {
  const home = "/Users/anton";
  state.groups = [
    projectGroup("ec", "EasyChamp", [
      projectMember("remote", "ec1", `${home}/Projects/sw-easychamp`),
      projectMember("remote", "ec2", `${home}/Projects/github/easychamp`),
    ]),
    projectGroup("greet", "greet-app", [
      projectMember("remote", "g1", `${home}/Projects/greet-app`),
      projectMember(
        "remote",
        "g2",
        `${home}/.specwithcode/m1/userdata/machine-handoffs/git/abc/workspace`,
      ),
    ]),
  ];
  await openSheet();
  const projects = document.querySelector('[aria-label="Projects on Remote PC"]')!;
  expect(projects.textContent).not.toContain("· remote");
  expect(projects.textContent).toContain("2 folders");
  expect(projects.textContent).toContain("~/Projects/greet-app");
  expect(projects.textContent).not.toContain("Handoff copy");
  const easychamp = buttonNamed("EasyChamp")!;
  expect(easychamp.getAttribute("aria-expanded")).toBe("false");
  await act(async () => easychamp.click());
  expect(
    document.querySelector('[aria-label="EasyChamp folders"]')!.querySelectorAll("a"),
  ).toHaveLength(2);
  await act(async () => buttonNamed("Show 1 temporary workspace")!.click());
  expect(projects.textContent).toContain("Handoff copy");
  expect(buttonNamed("Hide temporary workspaces")).toBeDefined();
});

it("shows repeated thread titles once, at most five, and filters with search", async () => {
  state.threads = [
    shell("c1", "remote", "EasyChamp coordinator", "2026-11-04T09:00:00Z"),
    shell("c2", "remote", "EasyChamp coordinator", "2026-11-04T12:00:00Z"),
    shell("c3", "remote", "EasyChamp coordinator", "2026-11-04T08:00:00Z"),
    ...["A", "B", "C", "D", "E"].map((title, index) =>
      shell(`t${index}`, "remote", `Task ${title}`, `2026-10-0${index + 1}T00:00:00Z`),
    ),
    shell("gone", "remote", "Archived chat", "2026-11-04T13:00:00Z", {
      archivedAt: "2026-11-04T14:00:00Z",
    }),
  ];
  state.groups = [projectGroup("shared", "Shared project", [projectMember("remote", "y")])];
  await openSheet();
  const threads = () => [
    ...document.querySelector('[aria-label="Recent threads on Remote PC"]')!.querySelectorAll("a"),
  ];
  expect(threads()).toHaveLength(5);
  expect(threads()[0]!.href).toContain("threadId=c2");
  expect(threads()[0]!.textContent).toContain("×3");
  expect(document.body.textContent).not.toContain("Archived chat");
  await act(async () => buttonNamed("Show all 6")!.click());
  expect(threads()).toHaveLength(6);

  const search = document.querySelector<HTMLInputElement>('input[aria-label^="Search"]')!;
  const view = search.ownerDocument.defaultView as typeof globalThis;
  const setValue = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(search, "task c");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(threads().map((a) => a.textContent)).toEqual([expect.stringContaining("Task C")]);
  await act(async () => {
    setValue.call(search, "zzz");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(document.body.textContent).toContain("Nothing matches “zzz”.");
});

it("offers search only when the lists are long", async () => {
  await openSheet();
  expect(document.querySelector('input[aria-label^="Search"]')).toBeNull();
});

it("shows the five most recent projects until asked for all", async () => {
  state.groups = ["a", "b", "c", "d", "e", "f", "g"].map((id) =>
    projectGroup(id, `Project ${id}`, [projectMember("remote", id, `/Users/anton/${id}`)]),
  );
  await openSheet();
  const projects = () =>
    document.querySelector('[aria-label="Projects on Remote PC"]')!.querySelectorAll("li");
  expect(projects()).toHaveLength(5);
  await act(async () => buttonNamed("Show all 7 projects")!.click());
  expect(projects()).toHaveLength(7);
});
