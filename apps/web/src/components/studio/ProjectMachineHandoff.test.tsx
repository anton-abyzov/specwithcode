// @vitest-environment jsdom
import {
  copyOpener,
  currentCopyWatches,
  resetCopyActivityForTests,
} from "../../studio/folderCopyActivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { ComponentProps } from "react";
import type { MachineHandoffDialog } from "./MachineHandoffDialog";
import { machineHandoffStorageKey } from "../../studio/machineHandoffPending";
import { buildProjectGroups } from "../../logicalProject";
import { ProjectMachineHandoff } from "./ProjectMachineHandoff";
import { handoffMachinePreferenceKey } from "../../studio/handoffMachinePreference";
import { MoveDialogHold } from "../../studio/moveDialogHold";

vi.mock("../../state/filesystem", () => ({
  filesystemEnvironment: { browse: (input: unknown) => input },
  useFilesystemReadAccess: () => ({ canReadFiles: false }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, isPending: false }),
}));
vi.mock("./HandoffFolderPicker", () => ({ HandoffFolderPicker: () => null }));
vi.mock("./useHandoffSourceChanges", () => ({ useHandoffSourceChanges: () => null }));
vi.mock("../../studio/fleet", () => ({
  useStudioFleet: () => ({ snapshot: state.fleet }),
}));
const state = vi.hoisted(() => ({
  fleet: null as { machines: Array<Record<string, unknown>> } | null,
  environments: [] as Array<Record<string, unknown>>,
  prepare: vi.fn(),
  receive: vi.fn(),
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
  machineHandoff: { prepare: "prepare", receive: "receive" },
}));
vi.mock("../../studio/projectLink", () => ({
  projectLink: {},
  linkCopyAsWorkers: async () => ({ status: "linked" }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (name: "prepare" | "receive") => state[name],
}));
vi.mock("../../hooks/useScratchProject", () => ({
  useScratchProject: () => ({ scratchWorkspaceRootFor: () => null }),
}));
vi.mock("../settings/MachineReadinessChecklist", () => ({ MachineReadinessChecklist: () => null }));
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
const mount = async () => {
  await act(async () =>
    root.render(
      <ProjectMachineHandoff project={source as never} coordinatorId={"coordinator" as never} />,
    ),
  );
  await act(async () => container.querySelector("button")!.click());
};
const review = () => act(async () => props().onReview());
const consent = () => act(async () => props().onConsent(true));
const transfer = () => act(async () => props().onContinue());
it("reviews a handoff using the canonical EasyChamp name instead of its checkout label", async () => {
  await act(async () =>
    root.render(
      <ProjectMachineHandoff
        project={
          {
            ...source,
            title: "sw-easychamp product handoff 0907",
            workspaceSettings: {
              logicalProject: {
                id: "easychamp",
                title: "EasyChamp",
                coordinatorId: "coordinator",
                members: [],
              },
            },
          } as never
        }
        coordinatorId={"coordinator" as never}
      />,
    ),
  );
  await act(async () => container.querySelector("button")!.click());
  expect(props().projectTitle).toBe("EasyChamp");
});
it("reports dialog open, close and unmount so the workspace can suspend background commands", async () => {
  const onOpenChange = vi.fn();
  await act(async () =>
    root.render(
      <ProjectMachineHandoff
        project={source as never}
        coordinatorId={"coordinator" as never}
        onOpenChange={onOpenChange}
      />,
    ),
  );
  await act(async () => container.querySelector("button")!.click());
  expect(onOpenChange).toHaveBeenLastCalledWith(true);
  await act(async () => props().onOpenChange(false));
  expect(onOpenChange).toHaveBeenLastCalledWith(false);
  await act(async () => container.querySelector("button")!.click());
  await act(async () => root.render(<div>Another checkout</div>));
  expect(onOpenChange).toHaveBeenLastCalledWith(false);
});
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  state.order = [];
  state.denied.clear();
  state.sourceDenied = false;
  state.catalogReady = true;
  state.projects = [source, target];
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

it("previews without publishing, then rechecks the selected machine before one explicit transfer", async () => {
  await mount();
  await review();
  expect(props().phase).toBe("review");
  expect(state.order).toEqual(["inspect", "preview"]);
  expect(props().workspaceContext).toMatchObject({
    checkout: "/external/worker-checkout",
    branch: "feature/source",
    mode: "worktree",
  });
  expect(props().destinationCheckout).toBe(ready.workspacePath);
  expect(props().destinationWorktreeStorage).toBe("/target/managed/worktrees");
  expect(state.receive.mock.calls[0]?.[0]).toEqual({
    environmentId: "m1",
    input: {
      projectId: "target",
      operationId,
      mode: "preview",
      manifest: bundle.manifest,
      sourceEnvironmentId: "m4",
      sourceProjectId: "source",
      sourceThreadId: "coordinator",
      digest: bundle.digest,
      destination: bundle.destination,
    },
  });
  expect(JSON.stringify(state.receive.mock.calls)).not.toContain("PRIVATE_");
  await transfer();
  expect(state.order).toEqual(["inspect", "preview"]);
  await consent();
  await transfer();
  expect(state.order).toEqual(["inspect", "preview", "preview", "publish", "start"]);
  expect(state.receive.mock.calls[1]?.[0]).toEqual(state.receive.mock.calls[0]?.[0]);
  expect(state.prepare.mock.calls[1]?.[0]).toMatchObject({
    environmentId: "m4",
    input: { operationId, publish: true, expectedDigest: bundle.digest },
  });
  expect(state.receive.mock.calls.at(-1)?.[0]).toMatchObject({
    environmentId: "m1",
    input: { projectId: "target", operationId, bundle },
  });
  expect(props().phase).toBe("complete");
  expect(localStorage.getItem(key)).toBeNull();
  await act(async () => props().onOpenDestination());
  expect(state.navigate).toHaveBeenCalledWith(
    expect.objectContaining({
      params: { projectKey: "m1:/isolated-target" },
      search: { checkout: "m1:isolated" },
    }),
  );
});
it("blocks duplicate review clicks before React paints the pending state", async () => {
  let resolve!: (value: unknown) => void;
  state.prepare.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await mount();
  await act(async () => {
    props().onReview();
    props().onReview();
  });
  expect(state.prepare).toHaveBeenCalledTimes(1);
  expect(props().phase).toBe("checking");
  await act(async () =>
    resolve({ _tag: "Success", value: { bundle, publication: "unpublished", messageCount: 5 } }),
  );
  expect(props().phase).toBe("review");
});
it("does not publish when destination access changes after the review", async () => {
  await mount();
  await review();
  await consent();
  state.receive.mockResolvedValueOnce({
    _tag: "Failure",
    error: new Error("Destination has local changes"),
  });
  await transfer();
  expect(state.prepare).toHaveBeenCalledTimes(1);
  expect(props().error).toBe("Destination has local changes");
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ operationId, targetKey: "m1:target" });
});
it("recovers an ambiguous start after remount without launching another coordinator", async () => {
  await mount();
  await review();
  await consent();
  state.receive.mockImplementation(async ({ input }) =>
    input.mode === "start"
      ? { _tag: "Failure", error: new Error("Connection lost") }
      : { _tag: "Success", value: ready },
  );
  await transfer();
  expect(props().phase).toBe("review");
  expect(localStorage.getItem(key)).not.toBeNull();
  await act(async () => root.render(null));
  state.receive.mockResolvedValue({ _tag: "Success", value: { ...started, replayed: true } });
  state.prepare.mockClear();
  await mount();
  await review();
  expect(props().phase).toBe("complete");
  expect(state.prepare).toHaveBeenCalledTimes(1);
  expect(state.prepare).toHaveBeenCalledWith(
    expect.objectContaining({ input: expect.objectContaining({ operationId, publish: false }) }),
  );
  expect(state.receive.mock.calls.at(-1)?.[0].input.mode).toBe("preview");
});
it("allows a new preview only after an explicit source-changed refusal", async () => {
  await mount();
  await review();
  await consent();
  state.prepare.mockResolvedValueOnce({
    _tag: "Failure",
    error: Object.assign(new Error("Source changed"), { code: "source_changed" }),
  });
  await transfer();
  expect(props().onRestart).toBeTypeOf("function");
  await act(async () => props().onRestart?.());
  expect(props().preview).toBeNull();
  expect(props().phase).toBe("choose");
  expect(props().consent).toBe(false);
  expect(localStorage.getItem(key)).toBeNull();
});
it("disables destinations missing permission to configure the isolated project", async () => {
  state.denied.add("settings:write");
  await mount();
  expect(props().destinations[0]?.unavailable).toContain("permission");
});

it("keeps a successful receipt visible if browser pointer cleanup fails", async () => {
  await mount();
  await review();
  await consent();
  const cleanup = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  try {
    await transfer();
    expect(props().phase).toBe("complete");
    expect(props().error).toBeNull();
  } finally {
    cleanup.mockRestore();
  }
});

it("opens with an actionable error when browser storage cannot be read", async () => {
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  try {
    await mount();
    expect(props().open).toBe(true);
    expect(props().error).toBe("Storage unavailable");
    await review();
    expect(state.prepare).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});

it("retains the reviewed operation if its restart pointer cannot be removed", async () => {
  await mount();
  await review();
  await consent();
  state.prepare.mockResolvedValueOnce({
    _tag: "Failure",
    error: Object.assign(new Error("Source changed"), { code: "source_changed" }),
  });
  await transfer();
  const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  try {
    await act(async () => props().onRestart?.());
    expect(props().phase).toBe("review");
    expect(props().preview).not.toBeNull();
    expect(props().error).toBe("Storage unavailable");
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({
      operationId,
      targetKey: "m1:target",
      publishing: true,
    });
  } finally {
    remove.mockRestore();
  }
});

it("offers matching registered destinations even when sidebar grouping keeps the source separate", async () => {
  const groups = buildProjectGroups({
    projects: state.projects as never,
    settings: { sidebarProjectGroupingMode: "separate", sidebarProjectGroupingOverrides: {} },
  });
  expect(groups.map((group) => group.members.map((member) => member.project.id))).toEqual([
    [source.id],
    [target.id],
  ]);
  await mount();
  expect(props().destinations.map((destination) => destination.key)).toEqual(["m1:target"]);
});

it("excludes archived, wrong-repository, unknown-identity and same-host projects", async () => {
  state.projects = [
    source,
    target,
    { ...target, id: "archived", workspaceSettings: { archived: true } },
    {
      ...target,
      id: "wrong",
      repositoryIdentity: { ...repositoryIdentity, canonicalKey: "github.com/example/other" },
    },
    { ...target, id: "unknown", repositoryIdentity: null },
    { ...target, id: "same-host", environmentId: source.environmentId },
    {
      ...target,
      id: "fork",
      repositoryIdentity: {
        ...repositoryIdentity,
        origin: { canonicalKey: "github.com/fork/project" },
      },
    },
  ];
  await mount();
  expect(props().destinations.map((destination) => destination.key)).toEqual(["m1:target"]);
});

it("updates destinations when a registered checkout identity resolves", async () => {
  state.projects = [source, { ...target, repositoryIdentity: null }];
  await mount();
  expect(props().destinations).toEqual([]);
  state.projects = [source, target];
  await mount();
  expect(props().destinations.map((destination) => destination.key)).toEqual(["m1:target"]);
});

it("removes deleted projects when the shell removes their registration", async () => {
  await mount();
  expect(props().destinations).toHaveLength(1);
  state.projects = [source];
  await mount();
  expect(props().destinations).toEqual([]);
  await review();
  expect(state.prepare).not.toHaveBeenCalled();
});

it("requires the selected source to have a verified repository identity", async () => {
  const unresolved = { ...source, repositoryIdentity: null };
  await act(async () =>
    root.render(
      <ProjectMachineHandoff
        project={unresolved as never}
        coordinatorId={"coordinator" as never}
      />,
    ),
  );
  await act(async () => container.querySelector("button")!.click());
  expect(props().destinations).toEqual([]);
});

it("refuses destination navigation if the receipt omits its isolated workspace", async () => {
  state.receive.mockImplementation(async ({ input }) => ({
    _tag: "Success",
    value: input.mode === "start" ? { ...started, workspacePath: undefined } : ready,
  }));
  await mount();
  await review();
  await consent();
  await transfer();
  await act(async () => props().onOpenDestination());
  expect(state.navigate).not.toHaveBeenCalled();
  expect(props().error).toContain("did not report where the project is");
});

it("binds the picker destination and retains a fenced transfer until source acknowledgment succeeds", async () => {
  const logicalProject = {
    id: "one",
    title: "One project",
    coordinatorId: "one-coordinator",
    members: [],
  };
  const inspected = {
    ...bundle,
    logicalProject,
    destination: { environmentId: "m1", projectId: "target", executionMode: "project-folder" },
    coordinatorBinding: { epoch: 0, state: "active" },
  };
  const published = {
    ...inspected,
    digest: "c".repeat(64),
    coordinatorBinding: { epoch: 0, state: "transferring" },
  };
  let launched = false;
  let ackAttempts = 0;
  state.prepare.mockImplementation(async ({ input }) => {
    expect(input.destination).toMatchObject({ environmentId: "m1", projectId: "target" });
    if (input.acknowledgment) {
      expect(input.acknowledgment.digest).toBe(published.digest);
      ackAttempts += 1;
      if (ackAttempts === 1)
        return { _tag: "Failure", error: new Error("Source disconnected before acknowledgment") };
    }
    return {
      _tag: "Success",
      value: {
        bundle: input.publish || launched ? published : inspected,
        messageCount: 5,
        publication: input.publish ? "published" : "unpublished",
      },
    };
  });
  state.receive.mockImplementation(async ({ input }) => {
    if (input.mode === "start") launched = true;
    return {
      _tag: "Success",
      value: launched ? { ...started, logicalProject, environmentId: "m1" } : ready,
    };
  });
  await act(async () =>
    root.render(
      <ProjectMachineHandoff
        project={source as never}
        coordinatorId={"coordinator" as never}
        requestedTarget="m1:target"
      />,
    ),
  );
  expect(props().open).toBe(true);
  expect(props().selected).toBe("m1:target");
  await review();
  await consent();
  await transfer();
  expect(props().phase).toBe("review");
  expect(props().error).toContain("Source disconnected");
  expect(localStorage.getItem(key)).not.toBeNull();
  expect(state.navigate).not.toHaveBeenCalled();
  await transfer();
  expect(ackAttempts).toBe(2);
  expect(state.receive.mock.calls.filter(([call]) => call.input.mode === "start")).toHaveLength(1);
  expect(state.receive.mock.calls.at(-1)?.[0].input.digest).toBe(published.digest);
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/projects/$projectKey",
    params: { projectKey: "logical-project:one" },
    search: {},
  });
  expect(localStorage.getItem(key)).toBeNull();
});

it("lets an unpublished legacy preview restart without publishing its old checkout plan", async () => {
  localStorage.setItem(key, JSON.stringify({ operationId, targetKey: "m1:target" }));
  state.prepare.mockResolvedValue({
    _tag: "Success",
    value: {
      bundle: { ...bundle, destination: { environmentId: "m1", projectId: "target" } },
      publication: "unpublished",
      messageCount: 5,
    },
  });
  await mount();
  await review();
  expect(state.prepare.mock.calls[0]?.[0].input.destination).toBeUndefined();
  expect(props().onRestart).toBeDefined();
  expect(state.receive).not.toHaveBeenCalled();
  await act(async () => props().onRestart!());
  expect(localStorage.getItem(key)).toBeNull();
  expect(props().phase).toBe("choose");
});

it("recovers a pointer persisted before an interrupted first source request", async () => {
  localStorage.setItem(key, JSON.stringify({ operationId, targetKey: "m1:target" }));
  state.prepare.mockResolvedValueOnce({
    _tag: "Failure",
    error: Object.assign(new Error("No saved plan"), { code: "invalid" }),
  });
  await mount();
  await review();
  expect(state.prepare.mock.calls[0]?.[0].input.destination).toBeUndefined();
  expect(state.prepare.mock.calls[1]?.[0].input).toMatchObject({
    operationId,
    publish: false,
    destination: { projectId: "target", executionMode: "project-folder" },
  });
  expect(props().phase).toBe("review");
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
const preferenceKey = handoffMachinePreferenceKey("m4", "source");
const picker = () =>
  (props().folderPicker as { props: Record<string, unknown> } | undefined)?.props;

it("opens the folder picker on the only online machine allowed for workers when no folder is saved", async () => {
  state.projects = [source];
  state.environments = machineEnvironments;
  state.fleet = allowWorkers("m3");
  await mount();
  expect(props().selected).toBe("");
  expect(props().machine).toBe("m3");
  expect(picker()).toMatchObject({ machine: "m3", sourceFolder: "/source" });
  const machines = picker()!.machines as Array<Record<string, unknown>>;
  expect(machines.map((machine) => [machine.id, machine.online, machine.hasProjectFolder])).toEqual(
    [
      ["m1", true, false],
      ["m3", true, false],
      ["m2", false, false],
    ],
  );
  expect(props().machines?.map((machine) => [machine.value, machine.tone, machine.reason])).toEqual(
    [
      ["m1", "ready", null],
      ["m3", "ready", null],
      ["m2", "off", "Offline"],
    ],
  );
  expect("rememberMachine" in props()).toBe(false);
});

it("prefers the remembered machine, then the last handoff target, over worker heuristics", async () => {
  state.environments = machineEnvironments;
  state.fleet = allowWorkers("m3");
  localStorage.setItem(preferenceKey, JSON.stringify({ remembered: "m1", lastUsed: "m3" }));
  await mount();
  // M1 has the saved project folder, so its destination is selected and the picker targets it.
  expect(props().selected).toBe("m1:target");
  expect(props().machine).toBe("m1");
  expect(picker()).toMatchObject({ machine: "m1" });

  await act(async () => props().onOpenChange(false));
  localStorage.setItem(preferenceKey, JSON.stringify({ lastUsed: "m3" }));
  await act(async () => container.querySelector("button")!.click());
  expect(props().selected).toBe("");
  expect(props().machine).toBe("m3");
  expect(picker()).toMatchObject({ machine: "m3" });
});

it("remembers the machine silently, only once a move succeeds", async () => {
  await mount();
  expect(props().selected).toBe("m1:target");
  await review();
  await consent();
  expect(localStorage.getItem(preferenceKey)).toBeNull();
  await transfer();
  expect(props().phase).toBe("complete");
  expect(JSON.parse(localStorage.getItem(preferenceKey)!)).toEqual({
    remembered: "m1",
    lastUsed: "m1",
  });
});

it("remembers the copy flow's machine once its copy is done", async () => {
  state.environments = machineEnvironments;
  await mount();
  const copy = () =>
    (props().copyFlow as { props: Record<string, (...args: never[]) => void> }).props;
  await act(async () =>
    copy().onChoicesChange!({ mode: "copy-only", machine: "m3", done: false } as never),
  );
  expect(localStorage.getItem(preferenceKey)).toBeNull();
  expect(props().intent).toBe("copy");
  await act(async () =>
    copy().onChoicesChange!({ mode: "copy-only", machine: "m3", done: true } as never),
  );
  expect(JSON.parse(localStorage.getItem(preferenceKey)!)).toEqual({
    remembered: "m3",
    lastUsed: "m3",
  });
});

it("opens as a move, and switching the Git move to files only uses the copy flow", async () => {
  state.environments = machineEnvironments;
  await mount();
  expect(props().intent).toBe("move");
  expect((props().copyFlow as { props: Record<string, unknown> }).props.defaultMode).toBe(
    "copy-and-move",
  );
  await act(async () => props().onMethodChange!("folder"));
  expect(props().intent).toBe("move");
  await act(async () => props().onIntentChange!("copy"));
  expect(props().method).toBe("copy");
  expect(props().intent).toBe("copy");
  expect((props().copyFlow as { props: Record<string, unknown> }).props.defaultMode).toBe(
    "copy-only",
  );
});

it("chooses a machine's saved folder, or the folder picker when it has none", async () => {
  state.environments = machineEnvironments;
  await mount();
  await act(async () => props().onMethodChange!("folder"));
  await act(async () => props().onMachineChange!("m3"));
  expect(props().selected).toBe("");
  expect(props().machine).toBe("m3");
  expect(picker()).toMatchObject({ machine: "m3" });
  await act(async () => props().onMachineChange!("m1"));
  expect(props().selected).toBe("m1:target");
  expect(props().machine).toBe("m1");
});

it("keeps the copy flow's machine when switching to Git", async () => {
  state.environments = machineEnvironments;
  state.projects = [source, target, { ...target, id: "m3-target", environmentId: "m3" }];
  await mount();
  const copy = (props().copyFlow as { props: Record<string, (...args: never[]) => void> }).props;
  await act(async () =>
    copy.onChoicesChange!({ mode: "copy-and-move", machine: "m3", done: false } as never),
  );
  await act(async () => props().onMethodChange!("folder"));
  expect(props().selected).toBe("m3:m3-target");
  expect(props().machine).toBe("m3");
});

it("goes back from an unpublished review to editable choices and a fresh operation", async () => {
  await mount();
  await act(async () => props().onMethodChange!("folder"));
  await review();
  await consent();
  expect(props().phase).toBe("review");
  expect(props().onBack).toBeDefined();
  await act(async () => props().onBack!());
  expect(props().phase).toBe("choose");
  expect(props().preview).toBeNull();
  expect(props().consent).toBe(false);
  expect(localStorage.getItem(key)).toBeNull();
  expect(props().method).toBe("folder");
  await act(async () => props().onMethodChange!("clone"));
  expect(props().method).toBe("clone");
});

it("drops an unpublished review when a choice changes", async () => {
  await mount();
  await act(async () => props().onMethodChange!("folder"));
  await review();
  await act(async () => props().onMethodChange!("copy"));
  expect(props().method).toBe("copy");
  expect(props().preview).toBeNull();
  expect(props().phase).toBe("choose");
  expect(localStorage.getItem(key)).toBeNull();
});

it("starts over from the default choices after closing a review", async () => {
  await mount();
  expect(props().method).toBe("copy");
  await act(async () => props().onMethodChange!("folder"));
  await review();
  await act(async () => props().onOpenChange(false));
  expect(localStorage.getItem(key)).toBeNull();
  await act(async () => container.querySelector("button")!.click());
  expect(props().phase).toBe("choose");
  expect(props().preview).toBeNull();
  expect(props().method).toBe("copy");
});

it("keeps a published checkpoint frozen until it finishes or is recovered", async () => {
  await mount();
  await act(async () => props().onMethodChange!("folder"));
  await review();
  await consent();
  state.receive
    .mockResolvedValueOnce({ _tag: "Success", value: ready })
    .mockResolvedValueOnce({ _tag: "Failure", error: new Error("Destination offline") });
  await transfer();
  expect(props().phase).toBe("review");
  expect(props().error).toBe("Destination offline");
  expect(props().onBack).toBeUndefined();
  await act(async () => props().onMethodChange!("copy"));
  await act(async () => props().onOpenChange(false));
  expect(props().method).toBe("folder");
  expect(props().preview).not.toBeNull();
  expect(localStorage.getItem(key)).not.toBeNull();
});

it("suggests the preferred machine in the folder picker and the copy flow", async () => {
  state.environments = machineEnvironments;
  localStorage.setItem(preferenceKey, JSON.stringify({ remembered: "m3" }));
  await mount();
  expect(picker()).toMatchObject({ machine: "m3" });
  const copy = (props().copyFlow as { props: Record<string, unknown> }).props;
  expect(copy.preferredMachine).toBe("m3");
});

it("keeps a review whose publish attempt failed, since the source may be fenced", async () => {
  await mount();
  await act(async () => props().onMethodChange!("folder"));
  await review();
  await consent();
  state.prepare.mockResolvedValueOnce({ _tag: "Failure", error: new Error("Lost response") });
  await transfer();
  expect(props().phase).toBe("review");
  expect(props().onBack).toBeUndefined();
  await act(async () => props().onSelect("m1:other"));
  await act(async () => props().onOpenChange(false));
  expect(props().selected).toBe("m1:target");
  expect(props().preview).not.toBeNull();
  expect(JSON.parse(localStorage.getItem(key)!).operationId).toBe(operationId);
});

it("starts fresh after closing a review whose destination check failed", async () => {
  await mount();
  await act(async () => props().onMethodChange!("folder"));
  state.receive.mockResolvedValueOnce({ _tag: "Failure", error: new Error("Destination busy") });
  await review();
  expect(props().phase).toBe("choose");
  expect(localStorage.getItem(key)).not.toBeNull();
  await act(async () => props().onOpenChange(false));
  expect(localStorage.getItem(key)).toBeNull();
  await act(async () => container.querySelector("button")!.click());
  expect(props().method).toBe("copy");
  expect(props().error).toBeNull();
});

it("lets a late folder save leave an unpublished review but never a frozen one", async () => {
  await mount();
  await act(async () => props().onMethodChange!("folder"));
  const onSaved = picker()!.onSaved as (environment: string, project: string) => void;
  await review();
  await act(async () => onSaved("m3", "late"));
  expect(props().phase).toBe("choose");
  expect(props().selected).toBe("m3:late");
  await act(async () => props().onSelect("m1:target"));
  await review();
  await consent();
  state.prepare.mockResolvedValueOnce({ _tag: "Failure", error: new Error("Lost response") });
  await transfer();
  await act(async () => onSaved("m3", "late"));
  expect(props().selected).toBe("m1:target");
  expect(props().preview).not.toBeNull();
});

it("never offers to drop an operation a transfer tried to publish, even after a reload", async () => {
  await mount();
  await act(async () => props().onMethodChange!("folder"));
  await review();
  await consent();
  state.prepare.mockResolvedValueOnce({ _tag: "Failure", error: new Error("Push failed") });
  await transfer();
  expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ operationId, publishing: true });
  await act(async () => root.unmount());
  root = createRoot(container);
  await mount();
  expect(props().method).toBe("folder");
  expect(props().selected).toBe("m1:target");
  await review();
  expect(props().phase).toBe("review");
  expect(props().onBack).toBeUndefined();
  await act(async () => props().onOpenChange(false));
  expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ operationId, publishing: true });
});

it("refuses a new handoff elsewhere while an interrupted publish is pending", async () => {
  localStorage.setItem(
    key,
    JSON.stringify({ operationId, targetKey: "m1:target", publishing: true }),
  );
  state.environments = machineEnvironments;
  state.projects = [source, target, { ...target, id: "other", environmentId: "m3" }];
  await mount();
  await act(async () => props().onSelect("m3:other"));
  await review();
  expect(props().error).toContain("stopped while publishing");
  expect(state.prepare).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem(key)!).targetKey).toBe("m1:target");
});

it("does not let a folder save landing before the review renders strand that review", async () => {
  await mount();
  await act(async () => props().onMethodChange!("folder"));
  const onSaved = picker()!.onSaved as (environment: string, project: string) => void;
  await act(async () => {
    props().onReview();
    // The review settles, then the save lands, all before React commits the review.
    await new Promise((resolve) => setTimeout(resolve, 0));
    onSaved("m3", "late");
  });
  expect(state.order).toEqual(["inspect", "preview"]);
  expect(props().phase).toBe("choose");
  expect(props().preview).toBeNull();
  expect(props().selected).toBe("m3:late");
  expect(localStorage.getItem(key)).toBeNull();
});

it("keeps the review editable when the publish marker cannot be saved", async () => {
  await mount();
  await act(async () => props().onMethodChange!("folder"));
  await review();
  await consent();
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Quota exceeded");
  });
  try {
    await transfer();
  } finally {
    write.mockRestore();
  }
  expect(state.order).toEqual(["inspect", "preview", "preview"]);
  expect(props().error).toBe("Quota exceeded");
  expect(props().onBack).toBeDefined();
});

it("resolves a full saved copy registration only by destination machine and exact folder", async () => {
  const target = state.projects.find((project) => project.id === "target")!;
  target.workspaceSettings = {
    coordinatorThreadId: "custom-target-coordinator",
    logicalProject: { id: "known-logical-project" },
  };
  await mount();
  const resolve = (
    props().copyFlow as {
      props: {
        savedProject: (environmentId: string, folder: string) => Record<string, unknown> | null;
      };
    }
  ).props.savedProject;
  expect(resolve(String(target.environmentId), `${target.workspaceRoot}/`)).toBe(target);
  expect(
    resolve(String(target.environmentId), `${target.workspaceRoot}/`)?.workspaceSettings,
  ).toEqual({
    coordinatorThreadId: "custom-target-coordinator",
    logicalProject: { id: "known-logical-project" },
  });
  expect(resolve("another-machine", String(target.workspaceRoot))).toBeNull();
  expect(resolve(String(target.environmentId), `${target.workspaceRoot}-other`)).toBeNull();
});

it("lets a running folder copy close, keeps it, and watches it app wide until the dialog reopens", async () => {
  resetCopyActivityForTests();
  state.environments = machineEnvironments;
  await mount();
  expect(props().method).toBe("copy");
  const copy = () => (props().copyFlow as { props: Record<string, any> }).props;
  await act(async () => copy().onCloseLockChange(true));
  expect(props().copyLocked).toBe(true);
  await act(async () => copy().onCloseLockChange(false));
  await act(async () => copy().onBusyChange(true));
  expect(props().copyBusy).toBe(true);
  expect(props().copyLocked).toBe(false);
  const pointer = "specwithcode:folder-copy:m4:source";
  localStorage.setItem(pointer, JSON.stringify({ operationId: "op", environmentId: "m3" }));
  expect(currentCopyWatches().size).toBe(0);
  await act(async () => props().onOpenChange(false));
  expect(localStorage.getItem(pointer)).not.toBeNull();
  const watch = currentCopyWatches().get("m4:source");
  expect(watch).toMatchObject({ environmentId: "m4", projectId: "source", sourceLabel: "M4" });
  expect(watch!.machineLabel("m3")).toBe("M3");
  // A background toast's Open reopens this dialog while the project is on screen.
  await act(async () => copyOpener("m4:source")!());
  expect(props().open).toBe(true);
  // Reopening keeps the copy method and hands the operation back to the dialog.
  expect(props().method).toBe("copy");
  expect(currentCopyWatches().size).toBe(0);
  await act(async () => props().onOpenChange(false));
  expect(currentCopyWatches().has("m4:source")).toBe(true);
});

it("opens Move coordinator to X as a move with X chosen for the copy and the Git move", async () => {
  state.environments = machineEnvironments;
  state.projects = [source, target, { ...target, id: "m3-target", environmentId: "m3" }];
  localStorage.setItem(preferenceKey, JSON.stringify({ remembered: "m1" }));
  await act(async () =>
    root.render(
      <ProjectMachineHandoff
        project={source as never}
        coordinatorId={"coordinator" as never}
        requestedTarget="m3:m3-target"
      />,
    ),
  );
  expect(props().open).toBe(true);
  expect(props().intent).toBe("move");
  expect(props().selected).toBe("m3:m3-target");
  expect(props().machine).toBe("m3");
  const copy = (props().copyFlow as { props: Record<string, unknown> }).props;
  expect(copy.preferredMachine).toBe("m3");
  // Requested, so a saved draft or last copy cannot swap the machine or the move.
  expect(copy.machineRequested).toBe(true);
  expect(copy.defaultMode).toBe("copy-and-move");
});

it("says why Move project is off: a focusable button that describes the reason and does nothing", async () => {
  await act(async () =>
    root.render(<ProjectMachineHandoff project={source as never} coordinatorId={null} />),
  );
  const wrap = container.querySelector('[data-slot="handoff-trigger-wrap"]')!;
  const reason = () => {
    const button = wrap.querySelector("button")!;
    return document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent;
  };
  const button = wrap.querySelector("button")!;
  // Focusable, so a keyboard or screen reader reaches it and hears the reason.
  expect(button.disabled).toBe(false);
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(reason()).toBe("Send this project its first message, then you can hand it off.");
  await act(async () => button.click());
  expect(props().open).toBe(false);
  state.environments = [
    { environmentId: "m4", label: "M4", connection: { phase: "disconnected" } },
    { environmentId: "m1", label: "M1", connection: { phase: "connected" } },
  ];
  await act(async () =>
    root.render(
      <ProjectMachineHandoff project={source as never} coordinatorId={"coordinator" as never} />,
    ),
  );
  expect(reason()).toBe("Connect this machine to hand off this project.");
  expect(wrap.querySelector("button")!.getAttribute("aria-disabled")).toBe("true");
});

it("says when this connection lacks permission to move the project", async () => {
  state.denied.add("source-control:write");
  state.sourceDenied = true;
  await act(async () =>
    root.render(
      <ProjectMachineHandoff project={source as never} coordinatorId={"coordinator" as never} />,
    ),
  );
  const button = container.querySelector('[data-slot="handoff-trigger-wrap"] button')!;
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe(
    "This connection needs permission to hand off projects.",
  );
});

it("an available Move project has no blocked reason and is not an extra tab stop", async () => {
  await act(async () =>
    root.render(
      <ProjectMachineHandoff project={source as never} coordinatorId={"coordinator" as never} />,
    ),
  );
  const wrap = container.querySelector('[data-slot="handoff-trigger-wrap"]')!;
  const button = wrap.querySelector("button")!;
  expect(wrap.hasAttribute("tabindex")).toBe(false);
  expect(button.hasAttribute("aria-disabled")).toBe(false);
  expect(button.hasAttribute("aria-describedby")).toBe(false);
  expect(button.disabled).toBe(false);
});

it("while machines load, hides those still connecting and tells the dialog it is loading", async () => {
  state.catalogReady = false;
  state.environments = [
    { environmentId: "m4", label: "M4", connection: { phase: "connected" } },
    { environmentId: "m1", label: "M1", connection: { phase: "connected" } },
    { environmentId: "m3", label: "M3", connection: { phase: "connecting" } },
  ];
  await mount();
  expect(props().machinesLoading).toBe(true);
  expect(props().machines?.map((machine) => machine.label)).toEqual(["M1"]);
  state.catalogReady = true;
  state.environments = [
    { environmentId: "m4", label: "M4", connection: { phase: "connected" } },
    { environmentId: "m1", label: "M1", connection: { phase: "connected" } },
    { environmentId: "m3", label: "M3", connection: { phase: "disconnected" } },
  ];
  await act(async () =>
    root.render(
      <ProjectMachineHandoff project={source as never} coordinatorId={"coordinator" as never} />,
    ),
  );
  expect(props().machinesLoading).toBe(false);
  expect(props().machines?.map((machine) => [machine.label, machine.reason ?? null])).toEqual([
    ["M1", null],
    ["M3", "Offline"],
  ]);
});

it("holds the workspace page on this checkout while the move dialog is open", async () => {
  const hold = vi.fn();
  await act(async () =>
    root.render(
      <MoveDialogHold value={hold}>
        <ProjectMachineHandoff project={source as never} coordinatorId={"coordinator" as never} />
      </MoveDialogHold>,
    ),
  );
  await act(async () => container.querySelector("button")!.click());
  expect(hold).toHaveBeenLastCalledWith(true);
  await act(async () => props().onOpenChange(false));
  expect(hold).toHaveBeenLastCalledWith(false);
  await act(async () => container.querySelector("button")!.click());
  expect(hold).toHaveBeenLastCalledWith(true);
  // Leaving the page lets go of the hold.
  await act(async () => root.render(<div>Another checkout</div>));
  expect(hold).toHaveBeenLastCalledWith(false);
});
