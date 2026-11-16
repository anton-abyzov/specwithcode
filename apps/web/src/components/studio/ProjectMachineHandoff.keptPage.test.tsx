// @vitest-environment jsdom
import { act, Activity, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { KeptProjectPages } from "./KeptProjectPages";
import type { MachineHandoffDialog } from "./MachineHandoffDialog";
import { ProjectMachineHandoff } from "./ProjectMachineHandoff";

// A project page left for another machine stays mounted, hidden, and runs its effects again
// when it is shown. A copy dialog the person closed must not come back with it.
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
let root: Root, container: HTMLDivElement;
const props = () => state.props!;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
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
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

/** The m4 project page with its copy dialog, as the workspace renders it. */
const m4Page = (extra: Partial<ComponentProps<typeof ProjectMachineHandoff>>) => (
  <ProjectMachineHandoff
    project={source as never}
    coordinatorId={"coordinator" as never}
    showTrigger={false}
    {...extra}
  />
);
const otherPage = <p>Another machine's page</p>;
const show = (pageKey: string, page: React.ReactElement) =>
  act(async () =>
    root.render(<KeptProjectPages pageKey={pageKey} page={page} isLive={() => true} />),
  );

it("does not reopen a closed copy dialog when its kept page is shown again", async () => {
  // The menu's "Copy to another machine…" on the m4 page.
  const picked = { mode: "copy", seq: 1 } as const;
  const page = m4Page({ openRequest: picked });
  await show("m4:source", page);
  expect(props().open).toBe(true);
  await act(async () => props().onOpenChange(false));
  expect(props().open).toBe(false);
  // The window switches to another machine and back: the m4 page is hidden, then shown.
  await show("m5:source", otherPage);
  await show("m4:source", page);
  expect(props().open).toBe(false);
  await show("m5:source", otherPage);
  await show("m4:source", m4Page({ openRequest: picked }));
  expect(props().open).toBe(false);
  // A new menu pick still opens it.
  await show("m4:source", m4Page({ openRequest: { mode: "copy", seq: 2 } }));
  expect(props().open).toBe(true);
});

it("does not replay a request when a hidden page's effects run again", async () => {
  const picked = { mode: "copy", seq: 1 } as const;
  const render = (mode: "visible" | "hidden") =>
    act(async () =>
      root.render(<Activity mode={mode}>{m4Page({ openRequest: picked })}</Activity>),
    );
  await render("visible");
  expect(props().open).toBe(true);
  await act(async () => props().onOpenChange(false));
  await render("hidden");
  await render("visible");
  expect(props().open).toBe(false);
});

it("opens for a requested machine once, and again only after the request was cleared", async () => {
  const render = (mode: "visible" | "hidden", requestedTarget: string | null) =>
    act(async () => root.render(<Activity mode={mode}>{m4Page({ requestedTarget })}</Activity>));
  await render("visible", "m1:target");
  expect(props().open).toBe(true);
  await act(async () => props().onOpenChange(false));
  // A parent that keeps the target while the page is hidden does not bring the dialog back.
  await render("hidden", "m1:target");
  await render("visible", "m1:target");
  expect(props().open).toBe(false);
  // Cleared and asked again, as "Move coordinator to X" does on its next click.
  await render("visible", null);
  await render("visible", "m1:target");
  expect(props().open).toBe(true);
});
