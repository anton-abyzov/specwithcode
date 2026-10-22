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
  homes: {} as Record<string, string | null>,
  link: null as unknown as (...args: unknown[]) => Promise<unknown>,
}));
vi.mock("../../state/filesystem", () => ({
  filesystemEnvironment: { browse: (input: unknown) => input },
  useFilesystemReadAccess: () => ({ canReadFiles: true }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (input: { environmentId: string } | null) => ({
    data:
      input && state.homes[input.environmentId]
        ? { parentPath: state.homes[input.environmentId], entries: [] }
        : null,
    isPending: !!input && !state.homes[input.environmentId],
  }),
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
vi.mock("../settings/MachineReadinessChecklist", () => ({
  MachineReadinessChecklist: (props: { environmentId: string; projectId: string }) => (
    <p data-slot="readiness-stub">
      Readiness {props.environmentId} {props.projectId}
    </p>
  ),
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
const mount = (
  overrides: {
    coordinatorId?: string | null;
    canMove?: boolean;
    savedFolder?: string;
    m1Available?: boolean;
    savedProject?: (environmentId: string, folder: string) => Record<string, unknown> | null;
  } = {},
) =>
  act(async () =>
    root.render(
      <HandoffFolderCopy
        project={project as never}
        coordinatorId={(overrides.coordinatorId ?? "coordinator") as never}
        sourceLabel="M4"
        method="copy"
        machines={[
          { id: "m3" as never, label: "M3", unavailable: null },
          {
            id: "m1" as never,
            label: "M1",
            unavailable: overrides.m1Available ? null : "Connect first",
          },
        ]}
        savedFolder={() => overrides.savedFolder ?? null}
        savedProject={overrides.savedProject as never}
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
  state.homes = { m3: "/home/anton", m1: "/Users/anton" };
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
      phase: input.mode === "preview" ? "ready" : "started",
      executionMode: "project-folder",
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
  expect(start.input).toMatchObject({
    token: "grant",
    targetFolder: "/home/anton/Projects/project",
  });
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

it("sends no secret file unless it is ticked and confirmed for that machine", async () => {
  state.handlers.copySecrets = ({ input }: any) => ({
    state: "scanned",
    summary,
    error: null,
    secrets: {
      files: [{ path: ".env", size: 10 }],
      approvedAt: 1,
      destinationLabel: input.destinationLabel,
    },
  });
  statuses = [
    copyStatus("previewed"),
    copyStatus("applied", {
      secrets: [{ path: ".env", writtenAs: ".env", size: 10, state: "written" }],
    }),
  ];
  await mount();
  await click("Measure the folder");
  await click("Preview on M3");
  const box = container.querySelector<HTMLElement>('[aria-label="Send .env"]')!;
  expect(box.getAttribute("aria-checked")).toBe("false");
  expect(container.textContent).not.toContain("API_TOKEN");
  await act(async () => box.click());
  expect(button("Copy and apply on M3").disabled).toBe(true);
  expect(container.textContent).toContain("Send this secret file to M3");
  const confirm = container.querySelector<HTMLElement>(
    '[data-slot="copy-secrets-confirm"] [data-slot="checkbox"]',
  )!;
  await act(async () => confirm.click());
  await click("Copy and apply on M3");
  const order = names();
  expect(order.indexOf("copySecrets")).toBeLessThan(order.indexOf("copyApprove"));
  expect(state.calls.find(([name]) => name === "copySecrets")![1]).toEqual({
    environmentId: "m4",
    input: {
      operationId: "00000000-0000-4000-8000-000000000001",
      paths: [".env"],
      destinationLabel: "M3",
    },
  });
  expect(container.textContent).toContain(".env is in place, readable only by you.");
  expect(container.textContent).toContain("Readiness m3 copied");
});

it("copies without asking the source for secrets when none are ticked", async () => {
  await mount();
  await click("Measure the folder");
  await click("Preview on M3");
  await click("Copy and apply on M3");
  expect(names()).not.toContain("copySecrets");
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

it("checks the destination after Apply before fencing the source and starting context there", async () => {
  statuses = [
    copyStatus("previewed", { mode: "copy-and-move" }),
    copyStatus("applied", {
      mode: "copy-and-move",
      projectId: "00000000-0000-4000-8000-000000000002",
    }),
  ];
  await mount();
  const move = [...container.querySelectorAll<HTMLElement>('[role="radio"]')].find((node) =>
    node.closest("label")?.textContent?.includes("Copy and transfer coordinator context"),
  )!;
  await act(async () => move.click());
  await click("Measure the folder");
  await click("Preview on M3");
  const start = state.calls.find(([name]) => name === "copyStart")![1] as any;
  expect(start.input.projectId).toBe("00000000-0000-4000-8000-000000000002");
  await click("Copy and transfer context to M3");
  const order = names().filter((name) => ["prepare", "copyApprove", "receive"].includes(name));
  expect(order).toEqual(["copyApprove", "prepare", "receive", "prepare", "receive"]);
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

const inputFolder = () =>
  container.querySelector<HTMLInputElement>('input[aria-label="Folder on M3"]')!;
const editFolder = async (value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      inputFolder(),
      value,
    );
    inputFolder().dispatchEvent(new Event("input", { bubbles: true }));
  });
const selectMove = async () =>
  act(async () => {
    [...container.querySelectorAll<HTMLElement>('[role="radio"]')]
      .find((node) =>
        node.closest("label")?.textContent?.includes("Copy and transfer coordinator context"),
      )!
      .click();
  });
const deferredCopy = () => {
  statuses = [
    copyStatus("previewed", { mode: "copy-and-move" }),
    copyStatus("applied", {
      mode: "copy-and-move",
      projectId: "00000000-0000-4000-8000-000000000002",
    }),
  ];
};

it("uses the destination home and discloses the exact source root", async () => {
  await mount();
  expect(inputFolder().value).toBe("/home/anton/Projects/project");
  expect(container.querySelector('[data-slot="copy-source-folder"]')?.textContent).toContain(
    project.workspaceRoot,
  );
  expect(container.textContent).toContain(
    "Folders outside this root and linked folders are not followed",
  );
});

it("preserves a saved destination and typed path when remote home arrives late", async () => {
  state.homes.m3 = null;
  await mount({ savedFolder: "/srv/saved/project" });
  expect(inputFolder().value).toBe("/srv/saved/project");
  await editFolder("/srv/custom/project");
  state.homes.m3 = "/home/late";
  await mount({ savedFolder: "/srv/saved/project" });
  expect(inputFolder().value).toBe("/srv/custom/project");
});

it("does not use a previous machine's late home response", async () => {
  state.homes.m3 = null;
  await mount({ m1Available: true });
  expect(inputFolder().value).toBe("");
  await act(async () =>
    [...container.querySelectorAll<HTMLElement>('[role="radio"]')]
      .find((node) => node.closest("label")?.textContent?.trim() === "M1")!
      .click(),
  );
  state.homes.m3 = "/home/late-m3";
  await mount({ m1Available: true });
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Folder on M1"]')!.value).toBe(
    "/Users/anton/Projects/project",
  );
});

it("finishes the copy while busy and transfers context only on an explicit retry", async () => {
  deferredCopy();
  state.handlers.prepare = () => {
    throw Object.assign(new Error("busy"), { code: "busy" });
  };
  await mount();
  await selectMove();
  await click("Measure the folder");
  await click("Preview on M3");
  await click("Copy and transfer context to M3");
  expect(container.querySelector('[data-slot="copy-done"]')).not.toBeNull();
  expect(container.textContent).toContain("The files are copied. Work is still running on M4");
  expect(names().indexOf("copyApprove")).toBeLessThan(names().indexOf("prepare"));
  expect(names()).not.toContain("receive");
  const prepares = names().filter((name) => name === "prepare").length;
  await mount();
  expect(names().filter((name) => name === "prepare")).toHaveLength(prepares);
  state.handlers.prepare = ({ input }: any) => ({
    publication: "published",
    bundle: {
      manifest: { operationId: input.operationId },
      destination: input.destination,
    },
  });
  await click("Transfer coordinator context");
  expect(names()).toContain("receive");
  expect(container.textContent).toContain("The coordinator continues on M3");
});

it("keeps a changed-source copy successful and asks for a fresh copy", async () => {
  deferredCopy();
  state.handlers.prepare = () => {
    throw Object.assign(new Error("changed"), { code: "source_changed" });
  };
  await mount();
  await selectMove();
  await click("Measure the folder");
  await click("Preview on M3");
  await click("Copy and transfer context to M3");
  expect(container.querySelector('[data-slot="copy-done"]')).not.toBeNull();
  expect(container.textContent).toContain("Copy again before transferring coordinator context");
  expect(button("Copy again")).toBeTruthy();
  expect(names()).not.toContain("receive");
});

it("reopening an applied copy never automatically transfers coordinator context", async () => {
  localStorage.setItem(
    "specwithcode:folder-copy:m4:source",
    JSON.stringify({
      operationId: "00000000-0000-4000-8000-000000000009",
      environmentId: "m3",
      mode: "copy-and-move",
      targetFolder: "/home/anton/project",
      projectId: "copied",
    }),
  );
  statuses = [copyStatus("applied", { mode: "copy-and-move" })];
  await mount();
  expect(container.textContent).toContain("Transfer coordinator context when you are ready");
  expect(names()).not.toContain("prepare");
  expect(names()).not.toContain("receive");
});

it("does not fence or transfer after copied files were unstable", async () => {
  deferredCopy();
  statuses[1] = { ...statuses[1], unstable: ["work-in-progress.ts"] };
  await mount();
  await selectMove();
  await click("Measure the folder");
  await click("Preview on M3");
  await click("Copy and transfer context to M3");
  expect(container.querySelector('[data-slot="copy-done"]')).not.toBeNull();
  expect(button("Copy again")).toBeTruthy();
  expect(names()).not.toContain("prepare");
});

it.each(["offline", "busy"])(
  "keeps the recovery pointer after publication and a %s receive",
  async (code) => {
    deferredCopy();
    state.handlers.receive = ({ input }: any) => {
      if (input.mode === "preview")
        return { phase: "ready", executionMode: "project-folder", projectId: input.projectId };
      throw Object.assign(new Error("Destination unavailable"), { code });
    };
    await mount();
    await selectMove();
    await click("Measure the folder");
    await click("Preview on M3");
    await click("Copy and transfer context to M3");
    expect(container.querySelector('[data-slot="copy-done"]')).not.toBeNull();
    expect(container.textContent).toContain("Coordinator context transfer is pending");
    expect(button("Start a new copy").disabled).toBe(true);
    expect(localStorage.getItem("specwithcode:folder-copy:m4:source")).not.toBeNull();
    expect(button("Transfer coordinator context").disabled).toBe(false);
  },
);

it.each([true, false])(
  "checks source recovery before restarting a reopened unstable copy (safe=%s)",
  async (safe) => {
    const key = "specwithcode:folder-copy:m4:source";
    localStorage.setItem(
      key,
      JSON.stringify({
        operationId: "00000000-0000-4000-8000-000000000009",
        environmentId: "m3",
        mode: "copy-and-move",
        targetFolder: "/home/anton/project",
        projectId: "copied",
      }),
    );
    statuses = [copyStatus("applied", { mode: "copy-and-move", unstable: ["changing.ts"] })];
    state.handlers.copyRelease = () => {
      if (!safe)
        throw new Error(
          "This context transfer is already published; recover it before starting another copy.",
        );
      return { released: false };
    };
    await mount();
    await click("Transfer coordinator context");
    await click("Copy again");
    expect(names()).toContain("copyRelease");
    expect(names()).not.toContain("prepare");
    if (safe) {
      expect(button("Measure the folder")).toBeTruthy();
      expect(localStorage.getItem(key)).toBeNull();
    } else {
      expect(container.textContent).toContain("recover it before starting another copy");
      expect(localStorage.getItem(key)).not.toBeNull();
      expect(container.querySelector('[data-slot="copy-done"]')).not.toBeNull();
    }
  },
);

it.each(["same", "folder", "machine"])(
  "reuses a completed copy registration only for its exact destination (%s)",
  async (change) => {
    deferredCopy();
    const originalId = "00000000-0000-4000-8000-000000000002";
    statuses[1] = { ...statuses[1], targetFolder: "/home/anton/Projects/project" };
    state.handlers.prepare = () => {
      throw Object.assign(new Error("busy"), { code: "busy" });
    };
    await mount({ m1Available: true });
    await selectMove();
    await click("Measure the folder");
    await click("Preview on M3");
    await click("Copy and transfer context to M3");
    await click("Start a new copy");
    if (change === "folder") await editFolder("/home/anton/other-project");
    if (change === "machine") {
      // Same spelling on another machine must never reuse the registration.
      state.homes.m1 = "/home/anton";
      await mount({ m1Available: true });
      await act(async () =>
        [...container.querySelectorAll<HTMLElement>('[role="radio"]')]
          .find((node) => node.closest("label")?.textContent?.trim() === "M1")!
          .click(),
      );
    }
    statuses = [copyStatus("previewed", { mode: "copy-and-move" })];
    await click("Measure the folder");
    await click(`Preview on ${change === "machine" ? "M1" : "M3"}`);
    const starts = state.calls.filter(([name]) => name === "copyStart");
    const request = starts.at(-1)![1] as any;
    if (change === "same") expect(request.input.projectId).toBe(originalId);
    else expect(request.input.projectId).not.toBe(originalId);
    if (change === "same") expect(request.input.targetFolder).toBe("/home/anton/Projects/project");
  },
);

it("uses the existing project registration for a known destination folder", async () => {
  await mount({
    savedFolder: "/srv/project/",
    savedProject: (machine, folder) =>
      machine === "m3" && folder === "/srv/project/"
        ? { id: "existing-project", environmentId: "m3", workspaceRoot: "/srv/project" }
        : null,
  });
  await selectMove();
  await click("Measure the folder");
  await click("Preview on M3");
  const request = state.calls.find(([name]) => name === "copyStart")![1] as any;
  expect(request.input.projectId).toBe("existing-project");
});

it.each(["project-coordinator:existing-project", "custom-coordinator"])(
  "previews the full existing destination identity before publishing (%s)",
  async (coordinatorThreadId) => {
    const existing = {
      id: "existing-project",
      environmentId: "m3",
      workspaceRoot: "/srv/project",
      workspaceSettings: {
        coordinatorThreadId,
        logicalProject: { id: "existing-logical-project" },
      },
    };
    statuses = [
      copyStatus("previewed", { mode: "copy-and-move" }),
      copyStatus("applied", {
        mode: "copy-and-move",
        targetFolder: "/srv/project",
        projectId: "existing-project",
      }),
    ];
    const prepare = state.handlers.prepare!;
    state.handlers.prepare = async (request) => {
      const prepared = (await prepare(request)) as any;
      return {
        ...prepared,
        bundle: {
          ...prepared.bundle,
          context: { goal: "private goal", threads: [{ messages: ["private conversation"] }] },
          logicalProject: { id: "source-logical-project" },
          coordinatorBinding: { state: "active" },
        },
      };
    };
    await mount({ savedFolder: "/srv/project/", savedProject: () => existing });
    await selectMove();
    await click("Measure the folder");
    await click("Preview on M3");
    await click("Copy and transfer context to M3");
    const prepares = state.calls.filter(([name]) => name === "prepare");
    expect((prepares[0]![1] as any).input.destination).toMatchObject({
      projectId: "existing-project",
      coordinatorThreadId,
      logicalProjectId: "existing-logical-project",
      joinExistingProject: true,
    });
    const receive = state.calls.find(([name]) => name === "receive")![1] as any;
    expect(receive.input).toMatchObject({
      mode: "preview",
      projectId: "existing-project",
      destination: { coordinatorThreadId, logicalProjectId: "existing-logical-project" },
      logicalProject: { id: "source-logical-project" },
      coordinatorBinding: { state: "active" },
    });
    expect(receive.input).not.toHaveProperty("bundle");
    expect(receive.input).not.toHaveProperty("context");
    expect(JSON.stringify(receive)).not.toContain("private");
    expect(state.calls.indexOf(prepares[1]!)).toBeGreaterThan(names().indexOf("receive"));
    expect(container.textContent).toContain("The coordinator continues on M3");
  },
);

it.each(["busy", "conflict", "invalid"])(
  "keeps a destination preview refusal actionable without publishing (%s)",
  async (code) => {
    deferredCopy();
    state.handlers.receive = () => {
      throw Object.assign(new Error("Check the destination project"), { code });
    };
    await mount();
    await selectMove();
    await click("Measure the folder");
    await click("Preview on M3");
    await click("Copy and transfer context to M3");
    expect(container.querySelector('[data-slot="copy-done"]')).not.toBeNull();
    expect(container.textContent).toContain("M3 is not ready for coordinator context");
    expect(container.textContent).not.toContain("Work is still running on M4");
    expect(state.calls.filter(([name]) => name === "prepare")).toHaveLength(1);
    expect((state.calls.find(([name]) => name === "prepare")![1] as any).input.publish).toBe(false);
    expect(button("Start a new copy").disabled).toBe(false);
    expect(button("Transfer coordinator context").disabled).toBe(false);
    expect(localStorage.getItem("specwithcode:folder-copy:m4:source")).not.toBeNull();
    await click("Start a new copy");
    expect(names()).toContain("copyRelease");
    expect(button("Measure the folder")).toBeTruthy();
  },
);

it("retains a restored fence if source release refuses after a destination preview refusal", async () => {
  const key = "specwithcode:folder-copy:m4:source";
  localStorage.setItem(
    key,
    JSON.stringify({
      operationId: "00000000-0000-4000-8000-000000000009",
      environmentId: "m3",
      mode: "copy-and-move",
      targetFolder: "/home/anton/project",
      projectId: "copied",
    }),
  );
  statuses = [copyStatus("applied", { mode: "copy-and-move" })];
  state.handlers.receive = () => {
    throw new Error("Destination changed");
  };
  state.handlers.copyRelease = () => {
    throw new Error("Recover the published context transfer");
  };
  await mount();
  await click("Transfer coordinator context");
  await click("Start a new copy");
  expect(container.textContent).toContain("Recover the published context transfer");
  expect(localStorage.getItem(key)).not.toBeNull();
  expect(button("Transfer coordinator context")).toBeTruthy();
});

it("reads a destination registration that arrived while Apply was running", async () => {
  deferredCopy();
  let registration: Record<string, unknown> | null = null;
  const options = { savedProject: () => registration };
  state.handlers.copyApprove = async () => {
    registration = {
      id: "00000000-0000-4000-8000-000000000002",
      environmentId: "m3",
      workspaceRoot: project.workspaceRoot,
      workspaceSettings: {
        coordinatorThreadId: "arrived-coordinator",
        logicalProject: { id: "arrived-logical-project" },
      },
    };
    await mount(options);
    return copyStatus("approved");
  };
  await mount(options);
  await selectMove();
  await click("Measure the folder");
  await click("Preview on M3");
  await click("Copy and transfer context to M3");
  const prepared = state.calls.find(([name]) => name === "prepare")![1] as any;
  expect(prepared.input.destination).toMatchObject({
    coordinatorThreadId: "arrived-coordinator",
    logicalProjectId: "arrived-logical-project",
  });
});
