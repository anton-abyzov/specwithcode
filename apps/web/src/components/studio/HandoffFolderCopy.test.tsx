// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { HandoffFolderCopy } from "./HandoffFolderCopy";
import { DEFAULT_COPY_SELECTION } from "../../studio/folderCopy";

const state = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown]>,
  handlers: {} as Record<string, (input: unknown) => unknown>,
  uuid: 0,
  link: null as unknown as (...args: unknown[]) => Promise<unknown>,
}));
vi.mock("../../studio/machineHandoff", () => ({
  machineHandoff: new Proxy({}, { get: (_target, name) => name }),
}));
vi.mock("../../studio/projectLink", () => ({
  projectLink: new Proxy({}, { get: (_target, name) => `link:${String(name)}` }),
  linkCopyAsWorkers: (...args: unknown[]) => state.link(...args),
}));
vi.mock("./ProjectLinkDialog", () => ({
  ProjectLinkDialog: (props: { initialCandidate: unknown; initialKept: string }) => (
    <div data-slot="link-dialog">{JSON.stringify([props.initialCandidate, props.initialKept])}</div>
  ),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (name: string) => async (request: unknown) => {
    state.calls.push([name, request]);
    try {
      return { _tag: "Success", value: await state.handlers[name]!(request) };
    } catch (error) {
      return { _tag: "Failure", error };
    }
  },
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (failure: { error: unknown }) => failure.error,
}));
vi.mock("../../lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/utils")>()),
  randomUUID: () => `00000000-0000-4000-8000-00000000000${++state.uuid}`,
}));

const total = (files: number, bytes: number) => ({ files, bytes });
const summary = {
  totals: {
    repository: total(1, 10),
    tracked: total(1, 10),
    untracked: total(1, 10),
    ignoredData: total(1, 10),
    rebuildable: total(1, 10),
    secret: total(1, 10),
  },
  repositories: [],
  secretFiles: [{ path: ".env", size: 10 }],
  linksOutside: 0,
  warnings: [],
};
const project = {
  id: "source",
  environmentId: "m4",
  title: "Project",
  workspaceRoot: "/Users/me/Projects/project",
};
const copyStatus = (state: string, overrides: Record<string, unknown> = {}) => ({
  operationId: "00000000-0000-4000-8000-000000000001",
  sourceEnvironmentId: "m4",
  sourceProjectId: "source",
  sourceMachine: "M4",
  mode: "copy-only",
  targetFolder: "/Users/me/Projects/project",
  title: "Project",
  selection: DEFAULT_COPY_SELECTION,
  mirror: false,
  state,
  failedStep: null,
  error: null,
  progress: null,
  disk: null,
  rows: [],
  totals: { filesToMove: 5, bytesToMove: 50, bytesPresent: 0, decisionsNeeded: 0 },
  checks: [],
  warnings: [],
  unstable: [],
  committed: state === "applied",
  projectId: state === "applied" ? "copied" : null,
  createdAt: "2026-10-19T20:00:00.000Z",
  updatedAt: "2026-10-19T20:00:00.000Z",
  ...overrides,
});

let root: Root;
let container: HTMLDivElement;
let statuses: Array<Record<string, unknown>>;
const onOpenProject = vi.fn();
const onBusyChange = vi.fn();
const names = () => state.calls.map(([name]) => name);
const button = (label: string) => {
  const element = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!element) throw new Error(`Missing button ${label}: ${container.textContent}`);
  return element;
};
const click = async (label: string) => {
  await act(async () => button(label).click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};
const mount = (overrides: { coordinatorId?: string | null; canMove?: boolean } = {}) =>
  act(async () =>
    root.render(
      <HandoffFolderCopy
        project={project as never}
        coordinatorId={(overrides.coordinatorId ?? "coordinator") as never}
        sourceLabel="M4"
        method="copy"
        machines={[
          { id: "m3" as never, label: "M3", unavailable: null },
          { id: "m1" as never, label: "M1", unavailable: "Connect first" },
        ]}
        savedFolder={() => null}
        canMove={overrides.canMove ?? true}
        onBusyChange={onBusyChange}
        onOpenProject={onOpenProject}
      />,
    ),
  );

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  localStorage.clear();
  state.calls = [];
  state.uuid = 0;
  state.link = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ status: "linked" }));
  statuses = [copyStatus("previewed"), copyStatus("applied")];
  state.handlers = {
    copyOffer: ({ input }: any) => ({
      operationId: input.operationId,
      sourceEnvironmentId: "m4",
      sourceProjectId: "source",
      sourceUrl: "https://m4.example.ts.net",
      sourceMachine: "M4",
      token: "grant",
      title: "Project",
      mode: input.mode,
      status: { state: "scanned", summary, error: null },
    }),
    copyStart: () => copyStatus("scanning"),
    copyStatus: () => statuses.shift() ?? copyStatus("applied"),
    copyApprove: () => copyStatus("approved"),
    copyCancel: () => copyStatus("cancelled"),
    copySourceCancel: () => ({ state: "cancelled" }),
    copyRelease: () => ({ released: true }),
    prepare: ({ input }: any) => ({
      // The source keeps the published bundle; later prepares return it as published.
      publication:
        input.publish || state.calls.filter(([name]) => name === "prepare").length > 2
          ? "published"
          : "unpublished",
      bundle: {
        digest: "d".repeat(64),
        manifest: { operationId: input.operationId, repositories: [] },
        destination: input.destination,
        sourceEnvironmentId: "m4",
        sourceProjectId: "source",
        sourceThreadId: "coordinator",
      },
    }),
    receive: ({ input }: any) => ({
      phase: "started",
      projectId: input.projectId,
      coordinatorThreadId: `project-coordinator:${input.projectId}`,
    }),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("measures, previews and applies a copy that leaves the coordinator on the source", async () => {
  await mount();
  expect(container.textContent).toContain("Folder on M3");
  await click("Measure the folder");
  expect(state.calls[0]).toEqual([
    "copyOffer",
    {
      environmentId: "m4",
      input: {
        projectId: "source",
        operationId: "00000000-0000-4000-8000-000000000001",
        mode: "copy-only",
        destinationEnvironmentId: "m3",
      },
    },
  ]);
  await click("Preview on M3");
  const start = state.calls.find(([name]) => name === "copyStart")![1] as any;
  expect(start.environmentId).toBe("m3");
  expect(start.input).toMatchObject({ token: "grant", targetFolder: project.workspaceRoot });
  expect(start.input.selection).not.toContain("secret");
  expect(start.input).not.toHaveProperty("projectId");
  await click("Copy and apply on M3");
  expect(names()).not.toContain("prepare");
  expect(container.textContent).toContain("M3 has a copy in /Users/me/Projects/project");
  // Copy files only ends linked: the copy runs workers, the coordinator stays on M4.
  expect(state.link).toHaveBeenCalledOnce();
  expect(vi.mocked(state.link).mock.calls[0]![1]).toMatchObject({
    kept: { environmentId: "m4", projectId: "source" },
    joining: { environmentId: "m3", projectId: "copied" },
  });
  expect(container.textContent).toContain("Linked: the copy on M3 runs workers");
  await click("Open on M3");
  expect(onOpenProject).toHaveBeenCalledExactlyOnceWith({
    environmentId: "m3",
    projectId: "copied",
    folder: project.workspaceRoot,
  });
});

it("keeps Apply disabled until every conflict has a decision", async () => {
  statuses = [
    copyStatus("previewed", {
      totals: { filesToMove: 1, bytesToMove: 1, bytesPresent: 0, decisionsNeeded: 1 },
    }),
  ];
  await mount();
  await click("Measure the folder");
  await click("Preview on M3");
  expect(button("Copy and apply on M3").disabled).toBe(true);
});

it("pauses the source coordinator before Apply and starts it on the destination after", async () => {
  statuses = [
    copyStatus("previewed", { mode: "copy-and-move" }),
    copyStatus("applied", {
      mode: "copy-and-move",
      projectId: "00000000-0000-4000-8000-000000000002",
    }),
  ];
  await mount();
  const move = [...container.querySelectorAll<HTMLElement>('[role="radio"]')].find((node) =>
    node.closest("label")?.textContent?.includes("Copy and move the coordinator"),
  )!;
  await act(async () => move.click());
  await click("Measure the folder");
  await click("Preview on M3");
  const start = state.calls.find(([name]) => name === "copyStart")![1] as any;
  expect(start.input.projectId).toBe("00000000-0000-4000-8000-000000000002");
  await click("Copy, apply and move to M3");
  const order = names().filter((name) => ["prepare", "copyApprove", "receive"].includes(name));
  expect(order).toEqual(["prepare", "prepare", "copyApprove", "prepare", "receive"]);
  const published = state.calls.filter(([name]) => name === "prepare")[1]![1] as any;
  expect(published.input).toMatchObject({
    publish: true,
    destination: { transport: "folder-copy", environmentId: "m3" },
  });
  expect(container.textContent).toContain("The coordinator continues on M3");
  expect(localStorage.length).toBe(0);
});

it("drops an unfinished offer the destination never started and keeps one it cannot reach", async () => {
  const key = "specwithcode:folder-copy:m4:source";
  const pending = {
    operationId: "00000000-0000-4000-8000-000000000009",
    environmentId: "m3",
    mode: "copy-only",
    targetFolder: "/target",
    projectId: null,
  };
  localStorage.setItem(key, JSON.stringify(pending));
  state.handlers.copyStatus = () => {
    throw Object.assign(new Error("unreachable"), { _tag: "FolderCopyError", code: "unreachable" });
  };
  await mount();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(names()).not.toContain("copySourceCancel");
  expect(localStorage.getItem(key)).not.toBeNull();
  expect(container.textContent).toContain("A copy to /target on M3 is unfinished.");
  state.handlers.copyStatus = () => {
    throw Object.assign(new Error("gone"), { _tag: "FolderCopyError", code: "not_found" });
  };
  await click("Check the copy again");
  expect(names()).toContain("copySourceCancel");
  expect(localStorage.getItem(key)).toBeNull();
  expect(button("Measure the folder")).toBeTruthy();
});

it("offers the link review when a copy cannot be linked on its own", async () => {
  state.link = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    status: "review",
    reason: "Project notes differ on M3.",
  }));
  await mount();
  await click("Measure the folder");
  await click("Preview on M3");
  await click("Copy and apply on M3");
  expect(container.textContent).toContain("Not linked yet. Project notes differ on M3.");
  await click("Link…");
  expect(container.querySelector('[data-slot="link-dialog"]')?.textContent).toBe(
    JSON.stringify([{ environmentId: "m3", projectId: "copied" }, "here"]),
  );
});
