// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ComponentProps } from "react";
import type { MachineHandoffDialog } from "./MachineHandoffDialog";
import { machineHandoffStorageKey } from "../../studio/machineHandoffPending";
import { ProjectMachineHandoff } from "./ProjectMachineHandoff";

vi.mock("../../state/filesystem", () => ({
  filesystemEnvironment: { browse: (input: unknown) => input },
  useFilesystemReadAccess: () => ({ canReadFiles: false }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, isPending: false }),
}));
vi.mock("./HandoffFolderPicker", () => ({ HandoffFolderPicker: () => null }));
vi.mock("./HandoffAccountMachines", () => ({ HandoffAccountMachines: () => null }));
vi.mock("../chat/AddToMachineDialog", () => ({ AddToMachineDialog: () => null }));
vi.mock("../settings/useReplacedMachineRecords", () => ({
  useRetiredMachineRecords: () => state.retired,
}));
vi.mock("./useHandoffSourceChanges", () => ({ useHandoffSourceChanges: () => null }));
vi.mock("../../studio/fleet", () => ({
  useStudioFleet: () => ({ snapshot: state.fleet }),
}));
const state = vi.hoisted(() => ({
  retired: new Set<string>() as ReadonlySet<string>,
  fleet: null as { machines: Array<Record<string, unknown>> } | null,
  environments: [] as Array<Record<string, unknown>>,
  prepare: vi.fn(),
  receive: vi.fn(),
  copyCapabilities: vi.fn(),
  copyRelease: vi.fn(),
  navigate: vi.fn(),
  props: null as ComponentProps<typeof MachineHandoffDialog> | null,
  denied: new Set<string>(),
  /** A denied scope is denied on this machine (the source) too, not only on destinations. */
  sourceDenied: false,
  projects: [] as Array<Record<string, unknown>>,
  order: [] as string[],
  catalogReady: true as boolean | undefined,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../studio/machineHandoff", () => ({
  machineHandoff: {
    prepare: "prepare",
    receive: "receive",
    copyCapabilities: "copyCapabilities",
    copyRelease: "copyRelease",
  },
}));
vi.mock("../../studio/projectLink", () => ({
  projectLink: {},
  linkCopyAsWorkers: async () => ({ status: "linked" }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (name: "prepare" | "receive" | "copyCapabilities" | "copyRelease") => state[name],
}));
vi.mock("../../hooks/useScratchProject", () => ({
  useScratchProject: () => ({ scratchWorkspaceRootFor: () => null }),
}));
vi.mock("../settings/MachineReadinessChecklist", () => ({ MachineReadinessChecklist: () => null }));
// The credentials list has its own test (CopyCredentialsChecklist.test.tsx).
vi.mock("./CopyCredentialsChecklist", () => ({ CopyCredentialsChecklist: () => null }));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (failure: { error: Error }) => failure.error,
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments, isReady: state.catalogReady }),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () =>
    new Map([["m1", { environment: { defaultWorktreesDirectory: "/target/managed/worktrees" } }]]),
}));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../../state/entities", () => ({
  useProjects: () => state.projects,
  useThreadShell: () => ({ worktreePath: "/external/worker-checkout", branch: "feature/source" }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentsWithScope: (_environments: unknown, scope: string) =>
    new Set(
      state.denied.has(scope) ? (state.sourceDenied ? [] : ["m4"]) : ["m4", "m1", "m3", "m2"],
    ),
}));
vi.mock("../../lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/utils")>()),
  randomUUID: () => "7307ab55-fc59-4e07-abeb-de54be69215f",
}));
vi.mock("../../studio/machineNickname", () => ({
  useMachineNicknames: () => (_id: string, label?: string | null) => label ?? "Machine",
}));
vi.mock("./shell/Tip", () => ({ Tip: ({ children }: React.PropsWithChildren) => <>{children}</> }));
vi.mock("./MachineHandoffDialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./MachineHandoffDialog")>()),
  MachineHandoffDialog: (props: ComponentProps<typeof MachineHandoffDialog>) => {
    state.props = props;
    return null;
  },
}));

const operationId = "7307ab55-fc59-4e07-abeb-de54be69215f";
const repositoryIdentity = {
  canonicalKey: "github.com/example/project",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "https://github.com/example/project.git",
  },
};
const source = {
  id: "source",
  environmentId: "m4",
  title: "Project",
  workspaceRoot: "/source",
  repositoryIdentity,
};
const target = {
  id: "target",
  environmentId: "m1",
  title: "Project",
  workspaceRoot: "/target",
  repositoryIdentity,
};
const bundle = {
  destination: { executionMode: "project-folder", environmentId: "m1", projectId: "target" },
  manifest: { operationId, repositories: [{ relativePath: ".", head: "a".repeat(40) }] },
  sourceEnvironmentId: "m4",
  sourceProjectId: "source",
  sourceThreadId: "coordinator",
  createdAt: "2026-10-13T20:00:00.000Z",
  context: {
    goal: "PRIVATE_GOAL",
    instructions: "PRIVATE_INSTRUCTIONS",
    notes: [{ name: "private", content: "PRIVATE_NOTE" }],
    threads: [{ messages: [{ text: "PRIVATE_MESSAGE" }] }],
  },
  digest: "b".repeat(64),
};
const ready = {
  executionMode: "project-folder",
  workspacePath: "/target/project-folder",
  operationId,
  phase: "ready",
  projectId: "target",
  coordinatorThreadId: null,
};
const started = {
  executionMode: "project-folder",
  operationId,
  phase: "started",
  projectId: "isolated",
  coordinatorThreadId: "new-coordinator",
  workspacePath: "/isolated-target",
};
const key = machineHandoffStorageKey("m4", "source");
let root: Root, container: HTMLDivElement;
const props = () => state.props!;
/**
 * Opens the dialog the way its button does. It opens on the copy; most of these tests then
 * switch to the Git handoff ("folder"), as "Continue the coordinator here" opens it.
 */
const mount = async (method: "git" | "as-opened" = "git") => {
  await act(async () =>
    root.render(
      <ProjectMachineHandoff project={source as never} coordinatorId={"coordinator" as never} />,
    ),
  );
  await act(async () => container.querySelector("button")!.click());
  if (method === "git" && state.props?.open && state.props.onMethodChange)
    await act(async () => props().onMethodChange!("folder"));
};
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  state.order = [];
  state.denied.clear();
  state.sourceDenied = false;
  state.catalogReady = true;
  state.projects = [source, target];
  state.retired = new Set();
  state.fleet = null;
  state.environments = [
    { environmentId: "m4", label: "M4", connection: { phase: "connected" } },
    { environmentId: "m1", label: "M1", connection: { phase: "connected" } },
  ];
  localStorage.clear();
  state.navigate.mockResolvedValue(undefined);
  state.prepare.mockImplementation(async ({ input }) => {
    state.order.push(input.publish ? "publish" : "inspect");
    return {
      _tag: "Success",
      value: { bundle, publication: input.publish ? "published" : "unpublished", messageCount: 5 },
    };
  });
  state.receive.mockImplementation(async ({ input }) => {
    state.order.push(input.mode);
    return { _tag: "Success", value: input.mode === "start" ? started : ready };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const machineEnvironments = [
  { environmentId: "m4", label: "M4", connection: { phase: "connected" } },
  { environmentId: "m1", label: "M1", connection: { phase: "connected" } },
  { environmentId: "m3", label: "M3", connection: { phase: "connected" } },
  { environmentId: "m2", label: "M2", connection: { phase: "offline" } },
];
const allowWorkers = (...ids: string[]) => ({
  machines: ids.map((id) => ({ environmentId: id, workers: { status: "allowed" } })),
});

it("opens Compare all files on the machine's own folder, as the measured copy", async () => {
  state.environments = machineEnvironments;
  state.projects = [
    source,
    { ...target, id: "m3-target", environmentId: "m3", workspaceRoot: "/m3-target" },
  ];
  await act(async () =>
    root.render(
      <ProjectMachineHandoff
        project={source as never}
        coordinatorId={"coordinator" as never}
        showTrigger={false}
        openRequest={{ mode: "sync", seq: 1, target: "m3:m3-target", method: "copy" }}
      />,
    ),
  );
  expect(props().open).toBe(true);
  expect(props().intent).toBe("copy");
  // The measured per-file compare, not a download: the method radio is on the copy.
  expect(props().method).toBe("copy");
  expect(props().sync).toEqual({ machine: "M3", folder: "/m3-target" });
  const copy = (props().copyFlow as { props: Record<string, unknown> }).props;
  expect(copy).toMatchObject({
    method: "copy",
    preferredMachine: "m3",
    machineRequested: true,
    canMove: false,
  });
  expect((copy.savedFolder as (id: string) => string | null)("m3")).toBe("/m3-target");
});

describe("Add from the machine menu", () => {
  const add = async (project: Record<string, unknown> = source) =>
    act(async () =>
      root.render(
        <ProjectMachineHandoff
          project={project as never}
          coordinatorId={"coordinator" as never}
          showTrigger={false}
          openRequest={{ mode: "add", seq: 1 }}
        />,
      ),
    );
  const offered = () => props().machines?.map((machine) => machine.value);
  const copyMachines = () =>
    (
      (props().copyFlow as { props: Record<string, unknown> }).props.machines as Array<{
        id: string;
      }>
    ).map((machine) => machine.id);

  it("offers only machines without the project, and preselects none that has it", async () => {
    state.environments = machineEnvironments;
    // m1 has a saved folder; m3 is a linked member this window never opened.
    state.projects = [
      {
        ...source,
        workspaceSettings: {
          logicalProject: {
            id: "logical",
            title: "Project",
            coordinatorId: "c",
            members: [
              { environmentId: "m4", projectId: "source", coordinatorThreadId: "c" },
              { environmentId: "m3", projectId: "far", coordinatorThreadId: "c3" },
            ],
          },
        },
      },
      target,
    ];
    state.fleet = allowWorkers("m1");
    await add(state.projects[0]);
    expect(props().open).toBe(true);
    expect(offered()).toEqual(["m2"]);
    expect(copyMachines()).toEqual(["m2"]);
    expect(props().selected).toBe("");
    expect(props().machine).not.toBe("m1");
    expect(
      (props().copyFlow as { props: Record<string, unknown> }).props.preferredMachine,
    ).not.toBe("m1");
    expect(props().wholeFolderOnly).toBe(false);
    expect(props().method).toBe("clone");
  });

  it("stays Add when a move to another machine was left unfinished, and keeps its pointer", async () => {
    state.environments = machineEnvironments;
    const saved = JSON.stringify({ operationId, targetKey: "m1:target" });
    localStorage.setItem(key, saved);
    await add();
    expect(props().open).toBe(true);
    // The copy-only flow, on no machine yet: never the move, never its machine.
    expect(props().intent).toBe("copy");
    expect(props().method).not.toBe("folder");
    expect(props().selected).toBe("");
    expect(offered()).not.toContain("m1");
    // The unfinished move is still there for the page's own button to resume.
    expect(localStorage.getItem(key)).toBe(saved);
  });

  it("starts a new copy: a finished one is not shown again", async () => {
    state.environments = machineEnvironments;
    state.projects = [source];
    await add();
    expect((props().copyFlow as { props: Record<string, unknown> }).props.machineRequested).toBe(
      true,
    );
  });

  it("keeps every machine on the page's own button", async () => {
    state.environments = machineEnvironments;
    await mount("as-opened");
    expect(offered()).toEqual(["m1", "m3", "m2"]);
  });

  it("copies the whole folder for a project with no Git remote: the only way", async () => {
    state.environments = machineEnvironments;
    const local = { ...source, repositoryIdentity: null };
    state.projects = [local];
    await add(local);
    expect(props().wholeFolderOnly).toBe(true);
    expect(props().method).toBe("copy");
  });
});
