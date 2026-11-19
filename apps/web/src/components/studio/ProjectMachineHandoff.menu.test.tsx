// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ComponentProps } from "react";
import type { MachineHandoffDialog } from "./MachineHandoffDialog";
import { machineHandoffStorageKey } from "../../studio/machineHandoffPending";
import { ProjectMachineHandoff } from "./ProjectMachineHandoff";
import { AddHeldByCopy } from "./AddHeldByCopy";
import { HandoffFolderCopy, folderCopyStorageKey } from "./HandoffFolderCopy";
import { toastManager } from "../ui/toast";

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
    new Map([
      ["deskB", { environment: { defaultWorktreesDirectory: "/target/managed/worktrees" } }],
    ]),
}));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../../state/entities", () => ({
  useProjects: () => state.projects,
  useThreadShell: () => ({ worktreePath: "/external/worker-checkout", branch: "feature/source" }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentsWithScope: (_environments: unknown, scope: string) =>
    new Set(
      state.denied.has(scope)
        ? state.sourceDenied
          ? []
          : ["laptopE"]
        : ["laptopE", "deskB", "kioskD", "hubC"],
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
  environmentId: "laptopE",
  title: "Project",
  workspaceRoot: "/source",
  repositoryIdentity,
};
const target = {
  id: "target",
  environmentId: "deskB",
  title: "Project",
  workspaceRoot: "/target",
  repositoryIdentity,
};
const bundle = {
  destination: { executionMode: "project-folder", environmentId: "deskB", projectId: "target" },
  manifest: { operationId, repositories: [{ relativePath: ".", head: "a".repeat(40) }] },
  sourceEnvironmentId: "laptopE",
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
const key = machineHandoffStorageKey("laptopE", "source");
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
    { environmentId: "laptopE", label: "Laptop E", connection: { phase: "connected" } },
    { environmentId: "deskB", label: "Desk B", connection: { phase: "connected" } },
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
  { environmentId: "laptopE", label: "Laptop E", connection: { phase: "connected" } },
  { environmentId: "deskB", label: "Desk B", connection: { phase: "connected" } },
  { environmentId: "kioskD", label: "Kiosk D", connection: { phase: "connected" } },
  { environmentId: "hubC", label: "Hub C", connection: { phase: "offline" } },
];
const allowWorkers = (...ids: string[]) => ({
  machines: ids.map((id) => ({ environmentId: id, workers: { status: "allowed" } })),
});

it("opens Compare all files on the machine's own folder, as the measured copy", async () => {
  state.environments = machineEnvironments;
  state.projects = [
    source,
    { ...target, id: "kioskD-target", environmentId: "kioskD", workspaceRoot: "/kioskD-target" },
  ];
  await act(async () =>
    root.render(
      <ProjectMachineHandoff
        project={source as never}
        coordinatorId={"coordinator" as never}
        showTrigger={false}
        openRequest={{ mode: "sync", seq: 1, target: "kioskD:kioskD-target", method: "copy" }}
      />,
    ),
  );
  expect(props().open).toBe(true);
  expect(props().intent).toBe("copy");
  // The measured per-file compare, not a download: the method radio is on the copy.
  expect(props().method).toBe("copy");
  expect(props().sync).toEqual({ machine: "Kiosk D", folder: "/kioskD-target" });
  const copy = (props().copyFlow as { props: Record<string, unknown> }).props;
  expect(copy).toMatchObject({
    method: "copy",
    preferredMachine: "kioskD",
    machineRequested: true,
    canMove: false,
  });
  expect((copy.savedFolder as (id: string) => string | null)("kioskD")).toBe("/kioskD-target");
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
    // deskB has a saved folder; kioskD is a linked member this window never opened.
    state.projects = [
      {
        ...source,
        workspaceSettings: {
          logicalProject: {
            id: "logical",
            title: "Project",
            coordinatorId: "c",
            members: [
              { environmentId: "laptopE", projectId: "source", coordinatorThreadId: "c" },
              { environmentId: "kioskD", projectId: "far", coordinatorThreadId: "c3" },
            ],
          },
        },
      },
      target,
    ];
    state.fleet = allowWorkers("deskB");
    await add(state.projects[0]);
    expect(props().open).toBe(true);
    expect(offered()).toEqual(["hubC"]);
    expect(copyMachines()).toEqual(["hubC"]);
    expect(props().selected).toBe("");
    expect(props().machine).not.toBe("deskB");
    expect(
      (props().copyFlow as { props: Record<string, unknown> }).props.preferredMachine,
    ).not.toBe("deskB");
    expect(props().wholeFolderOnly).toBe(false);
    expect(props().method).toBe("clone");
  });

  it("stays Add when a move to another machine was left unfinished, and keeps its pointer", async () => {
    state.environments = machineEnvironments;
    const saved = JSON.stringify({ operationId, targetKey: "deskB:target" });
    localStorage.setItem(key, saved);
    await add();
    expect(props().open).toBe(true);
    // The copy-only flow, on no machine yet: never the move, never its machine.
    expect(props().intent).toBe("copy");
    expect(props().method).not.toBe("folder");
    expect(props().selected).toBe("");
    expect(offered()).not.toContain("deskB");
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
    expect(offered()).toEqual(["deskB", "kioskD", "hubC"]);
  });

  it("leaves an unfinished copy to another machine alone, and opens it only when asked", async () => {
    state.environments = machineEnvironments;
    const copyKey = folderCopyStorageKey("laptopE", "source");
    const saved = JSON.stringify({
      operationId,
      environmentId: "deskB",
      mode: "copy-and-move",
      targetFolder: "/work/atlas",
      projectId: null,
    });
    localStorage.setItem(copyKey, saved);
    await add();
    expect(props().open).toBe(true);
    // Add, on no machine: never the move, never its machine, and no copy flow that could
    // open or replace the saved one.
    expect(props().intent).toBe("copy");
    expect(props().selected).toBe("");
    const flow = props().copyFlow as { type: unknown; props: Record<string, unknown> };
    expect(flow.type).toBe(AddHeldByCopy);
    expect(flow.props.machine).toBe("Desk B");
    expect(localStorage.getItem(copyKey)).toBe(saved);
    // Its own button is the separate way back to that copy.
    await act(async () => (flow.props.onOpen as () => void)());
    expect((props().copyFlow as { type: unknown }).type).toBe(HandoffFolderCopy);
    expect(localStorage.getItem(copyKey)).toBe(saved);
  });

  it("starts Add after a move that completed, without a refusal", async () => {
    const toast = vi.spyOn(toastManager, "add");
    await mount();
    await act(async () => props().onReview());
    await act(async () => props().onContinue());
    await act(async () => props().onConsent(true));
    await act(async () => props().onContinue());
    expect(props().phase).toBe("complete");
    await act(async () => props().onOpenChange(false));
    toast.mockClear();
    // The same mounted page: the finished move's result is still in memory.
    await add();
    expect(toast).not.toHaveBeenCalled();
    expect(props().open).toBe(true);
    expect(props().phase).toBe("choose");
    expect(props().intent).toBe("copy");
    expect(props().preview).toBeNull();
    toast.mockRestore();
  });

  it("refuses Add while a published move is unfinished, and offers to finish it", async () => {
    const toast = vi.spyOn(toastManager, "add");
    await mount();
    await act(async () => props().onReview());
    await act(async () => props().onContinue());
    await act(async () => props().onConsent(true));
    // The destination does not take it: the published move stays unfinished.
    state.receive.mockImplementation(async ({ input }) =>
      input.mode === "start"
        ? { _tag: "Failure", error: new Error("The destination did not answer.") }
        : { _tag: "Success", value: ready },
    );
    await act(async () => props().onContinue());
    expect(props().phase).not.toBe("complete");
    await act(async () => props().onOpenChange(false));
    const before = props().open;
    toast.mockClear();
    await add();
    expect(toast).toHaveBeenCalledTimes(1);
    const refusal = toast.mock.calls[0]![0] as {
      title: string;
      actionProps: { children: string; onClick: () => void };
    };
    expect(refusal.title).toBe(
      "A move to another machine is not finished. Finish or cancel it, then add a machine.",
    );
    expect(refusal.actionProps.children).toBe("Finish handoff");
    expect(props().open).toBe(before);
    // The refusal's button opens the move itself, with what it published.
    await act(async () => refusal.actionProps.onClick());
    expect(props().open).toBe(true);
    expect(props().intent).not.toBe("copy");
    // And the move finishes from there once the destination takes it.
    state.receive.mockImplementation(async ({ input }) => ({
      _tag: "Success",
      value: input.mode === "start" ? started : ready,
    }));
    await act(async () => props().onContinue());
    expect(props().phase).toBe("complete");
    toast.mockRestore();
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
