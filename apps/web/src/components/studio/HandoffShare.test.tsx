// @vitest-environment jsdom
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  checkRemote: vi.fn(),
  inspect: vi.fn(),
  clone: vi.fn(),
  job: vi.fn(),
  listed: vi.fn((): unknown[] => []),
  scope: {
    loading: false,
    notice: null,
    selected: {
      repositories: [] as string[],
      repositoryOrigins: [] as Array<{ path: string; kind: string }>,
      truncated: false,
    },
  },
  clone_: null as { phase: string } | null,
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: () => unknown) => command,
}));
vi.mock("~/state/sourceControl", () => ({
  sourceControlEnvironment: {
    checkRemoteAccess: state.checkRemote,
    inspectDestination: state.inspect,
    startProjectClone: state.clone,
  },
}));
vi.mock("./HandoffCopyScope", () => ({ useCopyScope: () => state.scope }));
vi.mock("~/state/entities", () => ({ waitForProject: async () => undefined }));
vi.mock("~/state/projectClones", () => ({ useProjectClone: () => state.clone_ }));
vi.mock("~/studio/addToMachine", async (original) => ({
  ...(await original<typeof import("~/studio/addToMachine")>()),
  writeAddToMachineJob: state.job,
  listAddToMachineJobs: state.listed,
}));
vi.mock("~/studio/addToMachineCopy", () => ({
  ADD_TO_MACHINE_JOBS_EVENT: "jobs",
  messageOf: (_cause: unknown, fallback: string) => fallback,
  notifyAddToMachineJobs: () => undefined,
  unwrap: (value: { value: unknown }) => value.value,
}));
vi.mock("../handoff/MachineOptionRows", () => ({ MachineOptionRows: () => null }));
vi.mock("./HandoffCopyActions", () => ({
  HandoffCopyActions: ({ children }: { children: ReactElement }) => <>{children}</>,
}));
vi.mock("./ProjectMoveOptions", () => ({
  MoreOptions: ({ children }: { children: ReactElement }) => <>{children}</>,
}));

const { HandoffShare } = await import("./HandoffShare");

const project = {
  environmentId: "m4",
  id: "source",
  title: "Project",
  workspaceRoot: "/work/project",
  repositoryIdentity: {
    canonicalKey: "github.com/acme/project",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:acme/project.git",
    },
    provider: "github",
    owner: "acme",
    name: "project",
  },
};
const base = {
  project: project as never,
  sourceLabel: "M4",
  machines: [],
  machine: "m1" as never,
  machineLabel: "Ministorm",
  linked: false,
  joined: false,
  uncommittedFiles: 0,
  loading: false,
  canClone: true,
  onMachineChange: () => undefined,
  onMove: vi.fn(),
  onCopyInstead: vi.fn(),
  onPrepareRepositories: vi.fn(),
  onNeedsFolderChoice: vi.fn(),
  onBusyChange: () => undefined,
  onClose: () => undefined,
};
let root: Root, container: HTMLDivElement;
const show = (props: Partial<typeof base> = {}) =>
  act(async () => root.render(<HandoffShare {...base} {...props} />));
const button = (name: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent === name);

beforeEach(() => {
  vi.clearAllMocks();
  state.scope = {
    loading: false,
    notice: null,
    selected: { repositories: [], repositoryOrigins: [], truncated: false },
  };
  state.listed.mockReturnValue([]);
  state.clone_ = null;
  state.job.mockImplementation((job: unknown) => state.listed.mockReturnValue([job]));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.checkRemote.mockResolvedValue({ value: { status: "ok" } });
  state.inspect.mockResolvedValue({ value: { path: "/work/project", state: "missing" } });
  state.clone.mockResolvedValue({ _tag: "Success", value: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("offers one Add button, and cloning copies no files and no secrets", async () => {
  await show();
  await act(async () => button("Add Ministorm")!.click());
  expect(state.clone).toHaveBeenCalledOnce();
  expect(state.job).toHaveBeenCalledWith(
    expect.objectContaining({ copyIgnored: false, secrets: [] }),
  );
  expect(container.textContent).toContain("Ministorm is cloning this project");
});

it("keeps waiting for the link after a finished clone clears its job", async () => {
  await show();
  await act(async () => button("Add Ministorm")!.click());
  state.listed.mockReturnValue([]);
  await act(async () => {
    window.dispatchEvent(new Event("jobs"));
  });
  expect(container.textContent).toContain("Ministorm is cloning this project");
  expect(button("Add Ministorm")).toBeUndefined();
});

it("tells the reader when the other machine cannot read the repository", async () => {
  state.checkRemote.mockResolvedValue({ value: { status: "denied" } });
  await show();
  await act(async () => button("Add Ministorm")!.click());
  expect(state.clone).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("can't read");
});

it("hands the choice to a person when a folder is already there", async () => {
  state.inspect.mockResolvedValue({
    value: { path: "/work/project", state: "repository", sameRepository: true },
  });
  await show();
  await act(async () => button("Add Ministorm")!.click());
  expect(base.onNeedsFolderChoice).toHaveBeenCalledOnce();
  expect(state.clone).not.toHaveBeenCalled();
});

it("hands off directly when the machine already has the project", async () => {
  await show({ linked: true });
  await act(async () => button("Hand off to Ministorm")!.click());
  expect(base.onMove).toHaveBeenCalledOnce();
  expect(button("Add Ministorm")).toBeUndefined();
});

it("offers only the copy when the project has no Git remote", async () => {
  await show({ project: { ...project, repositoryIdentity: null } as never });
  expect(container.textContent).toContain("has no Git remote");
  expect(button("Add Ministorm")).toBeUndefined();
  expect(button("Copy files instead")).toBeDefined();
});

it("says uncommitted files stay here", async () => {
  await show({ uncommittedFiles: 2 });
  expect(container.textContent).toContain("2 uncommitted files stay on M4");
});

it("moves the coordinator only once the clone is linked, not when its checkout appears", async () => {
  await show();
  const box = container.querySelector('[data-slot="handoff-share-move"] [role="checkbox"]');
  await act(async () => (box as HTMLElement).click());
  await act(async () => button("Add Ministorm")!.click());
  await show({ linked: true });
  expect(base.onMove).not.toHaveBeenCalled();
  await show({ linked: true, joined: true });
  expect(base.onMove).toHaveBeenCalledOnce();
});

it("shows a clone still running from a closed dialog instead of offering Add again", async () => {
  await show();
  await act(async () => button("Add Ministorm")!.click());
  const job = state.job.mock.calls[0]![0];
  state.listed.mockReturnValue([job]);
  await act(async () => root.unmount());
  root = createRoot(container);
  await show();
  expect(button("Add Ministorm")).toBeUndefined();
  expect(container.textContent).toContain("Ministorm is cloning this project");
});

it("offers Add again and says so when the clone failed", async () => {
  await show();
  await act(async () => button("Add Ministorm")!.click());
  state.clone_ = { phase: "failed" };
  await act(async () => root.unmount());
  root = createRoot(container);
  await show();
  expect(button("Add Ministorm")).toBeDefined();
  expect(container.textContent).toContain("did not finish");
});

it("offers Add again once the job ended with no link", async () => {
  await show();
  await act(async () => button("Add Ministorm")!.click());
  vi.useFakeTimers();
  state.listed.mockReturnValue([]);
  await act(async () => window.dispatchEvent(new Event("jobs")));
  expect(button("Add Ministorm")).toBeUndefined();
  await act(async () => vi.advanceTimersByTime(120_000));
  vi.useRealTimers();
  expect(button("Add Ministorm")).toBeDefined();
});

it("names nested origins and routes an umbrella to the mixed transfer review", async () => {
  state.scope.selected = {
    repositories: ["repositories/acme/api", "local"],
    repositoryOrigins: [
      { path: "repositories/acme/api", kind: "remote" },
      { path: "local", kind: "copy" },
    ],
    truncated: false,
  };
  await show({ project: { ...project, repositoryIdentity: null } as never, uncommittedFiles: 57 });
  expect(container.textContent).toContain("repositories/acme/api");
  expect(container.textContent).toContain("Clone from origin if accessible");
  expect(container.textContent).toContain("Copy required");
  expect(container.textContent).not.toContain("nothing to clone");
  expect(container.textContent).not.toContain("Commit and push");
  expect(container.textContent).not.toContain("files stay");
  await act(async () => button("Review repositories and local files")!.click());
  expect(base.onPrepareRepositories).toHaveBeenCalledOnce();
  expect(state.clone).not.toHaveBeenCalled();
});

it("keeps old-source discovery and truncated lists explicitly uncertain", async () => {
  state.scope.selected = { repositories: ["api"], repositoryOrigins: [], truncated: true };
  await show({ project: { ...project, repositoryIdentity: null } as never });
  expect(container.textContent).toContain("Check in transfer review");
  expect(container.textContent).toContain("list is incomplete");
});

const tick = (label: string) =>
  [...container.querySelectorAll("label")]
    .find((item) => item.textContent?.startsWith(label))
    ?.querySelector<HTMLElement>('[role="checkbox"]');

it("says ignored files and secrets stay behind, with both ticks off", async () => {
  await show();
  expect(container.textContent).toContain(
    "Files Git ignores and secret files, such as .env, stay on M4",
  );
  expect(tick("Copy ignored files")?.getAttribute("aria-checked")).toBe("false");
  expect(tick("Include secrets")?.getAttribute("aria-checked")).toBe("false");
});

it("sends ignored files with the clone when ticked", async () => {
  await show();
  await act(async () => tick("Copy ignored files")!.click());
  await act(async () => button("Add Ministorm")!.click());
  expect(state.job).toHaveBeenCalledWith(
    expect.objectContaining({ copyIgnored: true, secrets: [] }),
  );
});

it("opens the full review to pick secrets when Include secrets is ticked", async () => {
  await show();
  await act(async () => tick("Include secrets")!.click());
  await act(async () => button("Add Ministorm")!.click());
  expect(base.onNeedsFolderChoice).toHaveBeenCalledOnce();
  expect(state.clone).not.toHaveBeenCalled();
  expect(state.job).not.toHaveBeenCalled();
});

it("shows no extras ticks once the machine has the project", async () => {
  await show({ linked: true });
  expect(tick("Copy ignored files")).toBeUndefined();
});
