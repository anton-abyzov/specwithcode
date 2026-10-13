// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { ComponentProps } from "react";
import type { MachineHandoffDialog } from "./MachineHandoffDialog";
import { machineHandoffStorageKey } from "../../studio/machineHandoffPending";
import { buildProjectGroups } from "../../logicalProject";
import { ProjectMachineHandoff } from "./ProjectMachineHandoff";

const state = vi.hoisted(() => ({
  prepare: vi.fn(),
  receive: vi.fn(),
  navigate: vi.fn(),
  props: null as ComponentProps<typeof MachineHandoffDialog> | null,
  denied: new Set<string>(),
  projects: [] as Array<Record<string, unknown>>,
  order: [] as string[],
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../studio/machineHandoff", () => ({
  machineHandoff: { prepare: "prepare", receive: "receive" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (name: "prepare" | "receive") => state[name],
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (failure: { error: Error }) => failure.error,
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      { environmentId: "m4", label: "M4", connection: { phase: "connected" } },
      { environmentId: "m1", label: "M1", connection: { phase: "connected" } },
    ],
  }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => state.projects,
}));
vi.mock("../../state/session", () => ({
  useEnvironmentsWithScope: (_environments: unknown, scope: string) =>
    new Set(state.denied.has(scope) ? ["m4"] : ["m4", "m1"]),
}));
vi.mock("../../lib/utils", () => ({ randomUUID: () => "7307ab55-fc59-4e07-abeb-de54be69215f" }));
vi.mock("./shell/Tip", () => ({ Tip: ({ children }: React.PropsWithChildren) => <>{children}</> }));
vi.mock("./MachineHandoffDialog", () => ({
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
const ready = { operationId, phase: "ready", projectId: "target", coordinatorThreadId: null };
const started = {
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
  state.projects = [source, target];
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
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ operationId, targetKey: "m1:target" });
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
  expect(props().error).toContain("destination workspace is missing");
});
