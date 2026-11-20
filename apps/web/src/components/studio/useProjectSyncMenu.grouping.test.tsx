// @vitest-environment jsdom
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { ProjectSyncStatusResult } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { orchestratorCopies } from "../../studio/projectCoordinatorMachine";
import { resetSyncStatusForTest } from "../../studio/projectSync";

// The machines the workspace hands the menu are the members of the group the project is in.
// A machine that has the same repository as a project of its own is in another group, and
// in the same one only when nothing is linked. Both lists here come from the real grouping.
const runAtomCommand = vi.hoisted(() => vi.fn());
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: (_runtime: unknown, options: { tag: string }) => options.tag,
  runAtomCommand,
  squashAtomCommandFailure: vi.fn(),
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/session", () => ({ useEnvironmentsScopeAccess: () => new Map() }));
vi.mock("../settings/useReplacedMachineRecords", () => ({
  useRetiredMachineRecords: () => new Map(),
}));

import { useProjectSyncMenu, type SyncAsk } from "./useProjectSyncMenu";

const NAMES: Record<string, string> = { a: "Laptop A", b: "Desk B", c: "Build C" };
const linked = {
  id: "logical:atlas",
  title: "Atlas",
  coordinatorId: "coordinator",
  members: [
    { environmentId: "a", projectId: "p", coordinatorThreadId: "t" },
    { environmentId: "b", projectId: "p", coordinatorThreadId: "t" },
  ],
};
const registration = (environmentId: string, id: string, shared: boolean) =>
  ({
    environmentId,
    id,
    title: "Atlas",
    workspaceRoot: "/home/sam/projects/atlas",
    repositoryIdentity: {
      canonicalKey: "example.com/acme/atlas",
      rootPath: "/home/sam/projects/atlas",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://example.com/acme/atlas.git",
      },
    },
    workspaceSettings: shared
      ? {
          kind: "code",
          logicalProject: linked,
          coordinatorBinding: { epoch: 1, state: environmentId === "a" ? "active" : "transferred" },
        }
      : { kind: "code" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }) as unknown as EnvironmentProject;

/** What the workspace passes for the project on Laptop A: its group's members, as copies. */
function workspaceInput(projects: readonly EnvironmentProject[]) {
  const groups = buildSidebarProjectSnapshots({
    projects: projects as never,
    settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
    primaryEnvironmentId: "a" as never,
    resolveEnvironmentLabel: (id) => NAMES[id] ?? null,
  });
  const group = groups.find((candidate) =>
    candidate.memberProjects.some((member) => member.environmentId === "a"),
  )!;
  return {
    members: group.memberProjects.map((member) => `${member.environmentId}:${member.id}`),
    copies: orchestratorCopies(
      group.memberProjects,
      (member) => NAMES[member.environmentId]!,
      () => false,
    ),
  };
}

const status: ProjectSyncStatusResult = {
  repositories: [{ path: ".", branch: "main", head: "a".repeat(40), clean: true }],
  scanLimited: false,
};

let container: HTMLDivElement;
let root: Root;
let menu: ReturnType<typeof useProjectSyncMenu>;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  runAtomCommand.mockReset();
  runAtomCommand.mockResolvedValue({ _tag: "Success", value: status });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetSyncStatusForTest();
});

function Probe(props: { projects: readonly EnvironmentProject[]; ask: SyncAsk }) {
  menu = useProjectSyncMenu({
    project: props.projects[0]!,
    label: "Laptop A",
    current: "a:p",
    copies: workspaceInput(props.projects).copies,
    unknown: [],
    environments: ["a", "b", "c"].map((environmentId) => ({ environmentId }) as never),
    projects: props.projects,
    nameOf: (environmentId) => NAMES[environmentId]!,
    reachOf: () => "open",
    versionOf: () => null,
    ask: props.ask,
    readOnly: false,
  });
  return null;
}
const asked = () =>
  runAtomCommand.mock.calls.map(([, , value]) => {
    const sent = value as { environmentId: string; input: { projectId: string } };
    return `${sent.environmentId}:${sent.input.projectId}`;
  });

it("lists a separate project the group does not hold, greyed, and reads its status", async () => {
  const projects = [
    registration("a", "p", true),
    registration("b", "p", true),
    registration("c", "q", false),
  ];
  // The grouping keeps the separate registration out of the linked project's members.
  expect(workspaceInput(projects).members).toEqual(["a:p", "b:p"]);
  await act(async () => root.render(<Probe projects={projects} ask={vi.fn<SyncAsk>()} />));
  await act(async () => menu.onSync?.());
  expect(
    menu.dialog?.targets.map((target) => [target.machine.label, target.blocked?.text ?? null]),
  ).toEqual([
    ["Desk B", null],
    ["Build C", "Separate project"],
  ]);
  await act(async () => menu.onMenuOpenChange(true));
  expect(asked().toSorted()).toEqual(["a:p", "b:p", "c:q"]);
  expect(runAtomCommand.mock.calls.every(([, command]) => command === "projectSync.status")).toBe(
    true,
  );
});

it("reads the status of machines that are all separate projects, and offers no Sync", async () => {
  const projects = [registration("a", "p", false), registration("c", "q", false)];
  expect(workspaceInput(projects).members.toSorted()).toEqual(["a:p", "c:q"]);
  await act(async () => root.render(<Probe projects={projects} ask={vi.fn<SyncAsk>()} />));
  expect(menu.onSync).toBeNull();
  await act(async () => menu.onMenuOpenChange(true));
  expect(asked().toSorted()).toEqual(["a:p", "c:q"]);
  expect(menu.syncOf("c:q").sync).toMatchObject({ tone: "same" });
});

it("dates the comparison once the machine shown goes offline, while the other stays open", async () => {
  const projects = [registration("a", "p", true), registration("b", "p", true)];
  function Offline(props: { shownOffline: boolean }) {
    menu = useProjectSyncMenu({
      project: projects[0]!,
      label: "Laptop A",
      current: "a:p",
      copies: workspaceInput(projects).copies,
      unknown: [],
      environments: ["a", "b"].map((environmentId) => ({ environmentId }) as never),
      projects,
      nameOf: (environmentId) => NAMES[environmentId]!,
      reachOf: (key) => (props.shownOffline && key === "a:p" ? "offline" : "open"),
      versionOf: () => null,
      ask: vi.fn<SyncAsk>(),
      readOnly: false,
    });
    return null;
  }
  await act(async () => root.render(<Offline shownOffline={false} />));
  await act(async () => menu.onMenuOpenChange(true));
  expect(menu.syncOf("b:p").sync?.text).toBe("Same as {shown}");
  await act(async () => root.render(<Offline shownOffline />));
  expect(menu.syncOf("b:p").sync?.text).toBe("Same as {shown} · as of {time}");
});
