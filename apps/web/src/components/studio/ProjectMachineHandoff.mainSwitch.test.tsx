// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { MachineHandoffDialog } from "./MachineHandoffDialog";
import { ProjectMachineHandoff } from "./ProjectMachineHandoff";

// The copy dialog and Main: a source that is not linked to the destination copy's project
// is told so and moves no Main, and a finished copy into a linked copy offers the switch.
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
  machineHandoff: { prepare: "prepare", receive: "receive", copyCapabilities: "copyCapabilities" },
}));
vi.mock("../../studio/projectLink", () => ({
  projectLink: {},
  linkCopyAsWorkers: async () => ({ status: "linked" }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (name: "prepare" | "receive" | "copyCapabilities") => state[name],
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

const repositoryIdentity = {
  canonicalKey: "github.com/example/project",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "https://github.com/example/project.git",
  },
};
/** A checkout of the one repository; `logical` links it to that project at `epoch`. */
const copyOn = (environmentId: string, id: string, logical: string | null, epoch = 1) => ({
  id,
  environmentId,
  title: "Project",
  workspaceRoot: `/${id}`,
  repositoryIdentity: { ...repositoryIdentity, rootPath: `/${id}` },
  workspaceSettings: logical
    ? {
        logicalProject: { id: logical, title: "Project" },
        coordinatorBinding: { state: "active", epoch },
      }
    : null,
});
type Copy = ReturnType<typeof copyOn>;
type Switch = NonNullable<ComponentProps<typeof ProjectMachineHandoff>["mainSwitch"]>;
let root: Root, container: HTMLDivElement;
const props = () => state.props!;
const copyProps = () =>
  (props().copyFlow as { props: Record<string, unknown> }).props as {
    onChoicesChange: (choices: Record<string, unknown>) => void;
  };
const open = async (from: Copy, others: Copy[], mainSwitch: Switch | null = null) => {
  state.projects = [from, ...others];
  await act(async () =>
    root.render(
      <ProjectMachineHandoff
        project={from as never}
        coordinatorId={"coordinator" as never}
        mainSwitch={mainSwitch}
      />,
    ),
  );
  await act(async () => container.querySelector("button")!.click());
};
const choose = (machine: string, over: Record<string, unknown> = {}) =>
  act(async () =>
    copyProps().onChoicesChange({ mode: "copy-only", machine, done: false, ...over }),
  );

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  state.denied.clear();
  state.sourceDenied = false;
  state.catalogReady = true;
  state.retired = new Set();
  state.fleet = null;
  state.props = null;
  state.environments = [
    { environmentId: "m1", label: "m1", connection: { phase: "connected" } },
    { environmentId: "m4", label: "m4", connection: { phase: "connected" } },
    { environmentId: "m5", label: "M5", connection: { phase: "connected" } },
  ];
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

// m4 is Main of the project M5's copy belongs to; m1 holds a separate copy of the repository.
const main = copyOn("m4", "main", "L", 2);
const linked = copyOn("m5", "linked", "L");

it.each([
  ["a copy linked to nothing", copyOn("m1", "own", null)],
  ["a copy of another project", copyOn("m1", "own", "other")],
])("tells %s it is not linked to the destination's project and names its Main", async (_, from) => {
  await open(from, [main, linked]);
  await choose("m5");
  expect(props().intent).toBe("copy");
  expect(props().send).toMatchObject({
    holding: { kind: "copy", copy: { id: "linked" } },
    otherProject: { main: "m4" },
  });
  // Git only would move m1's Main onto M5's copy: the review never starts.
  await act(async () => props().onMethodChange!("folder"));
  expect(props().send?.otherProject).toEqual({ main: "m4" });
  await act(async () => props().onReview());
  expect(state.prepare).not.toHaveBeenCalled();
  expect(props().phase).toBe("choose");
});

it("names the project's real Main for a linked source that is not Main", async () => {
  await open(copyOn("m1", "own", "L"), [main, linked]);
  // Known before a machine is picked, for the header.
  expect(props().mainLabel).toBe("m4");
  await choose("m5");
  expect(props().send).toMatchObject({ mainLabel: "m4", otherProject: null });
});

it("offers the page's Make main switch once a copy into a linked copy is done", async () => {
  const run = vi.fn();
  const offer = {
    key: "m5:linked",
    machine: "M5",
    main: "m4",
    kind: "move",
    reason: null,
    note: null,
  } as const;
  await open(main, [linked], { offers: [offer], run });
  await choose("m5");
  // Not while the copy is being set up or runs.
  expect(props().makeMain).toBeNull();
  await choose("m5", { done: true, projectId: "linked" });
  expect(props().makeMain?.offer).toBe(offer);
  await act(async () => props().makeMain!.run());
  expect(run).toHaveBeenCalledExactlyOnceWith("m5:linked");
  expect(props().open).toBe(false);
});

it("offers no switch after copying into another project's copy, or a copy with no offer", async () => {
  const run = vi.fn();
  const offer = {
    key: "m5:linked",
    machine: "M5",
    main: "m4",
    kind: "move",
    reason: null,
    note: null,
  } as const;
  await open(copyOn("m1", "own", null), [main, linked], { offers: [offer], run });
  await choose("m5", { done: true, projectId: "linked" });
  expect(props().makeMain).toBeNull();
  await open(main, [linked], { offers: [], run });
  await choose("m5", { done: true, projectId: "linked" });
  expect(props().makeMain).toBeNull();
});
