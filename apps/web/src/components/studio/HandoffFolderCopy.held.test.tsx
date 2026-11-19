// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { HandoffFolderCopy } from "./HandoffFolderCopy";
import { DEFAULT_COPY_SELECTION } from "../../studio/folderCopy";
import { isDisabled, openMore } from "./HandoffFolderCopy.testkit";

// Held moves, Hand off anyway and Undo: what the screen says always matches its buttons.
const state = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown]>,
  handlers: {} as Record<string, (input: unknown) => unknown>,
}));
vi.mock("../../state/filesystem", () => ({
  filesystemEnvironment: { browse: (input: unknown) => input },
  useFilesystemReadAccess: () => ({ canReadFiles: true }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { parentPath: "/home/sam", entries: [] },
    isPending: false,
  }),
}));
vi.mock("../../studio/machineHandoff", () => ({
  machineHandoff: new Proxy({}, { get: (_target, name) => name }),
}));
vi.mock("../../studio/projectLink", () => ({
  projectLink: new Proxy({}, { get: (_target, name) => `link:${String(name)}` }),
  linkCopyAsWorkers: async () => ({ status: "linked" }),
}));
vi.mock("./ProjectLinkDialog", () => ({ ProjectLinkDialog: () => null }));
// The credentials list has its own test (CopyCredentialsChecklist.test.tsx).
vi.mock("./CopyCredentialsChecklist", () => ({ CopyCredentialsChecklist: () => null }));
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
  MachineReadinessChecklist: () => null,
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (failure: { error: unknown }) => failure.error,
}));

const KEY = "specwithcode:folder-copy:laptopE:source";
const OPERATION = "00000000-0000-4000-8000-000000000009";
const PROJECT = "00000000-0000-4000-8000-000000000002";
const failedCheck = { repo: ".", ok: false, problems: ["git status differs from the source."] };
const HELD_MESSAGE =
  "The files are in place, but 1 repository differs from the source (the root), so the coordinator stayed on the source. Undo the copy, or retry to move it anyway. 2 files were restored: a.ts, b.ts.";

const copyStatus = (copyState: string, overrides: Record<string, unknown> = {}) => ({
  operationId: OPERATION,
  sourceEnvironmentId: "laptopE",
  sourceProjectId: "source",
  sourceMachine: "Laptop E",
  mode: "copy-and-move",
  targetFolder: "/home/sam/project",
  title: "Project",
  selection: DEFAULT_COPY_SELECTION,
  mirror: false,
  state: copyState,
  failedStep: null,
  error: null,
  progress: null,
  disk: null,
  rows: [],
  totals: { filesToMove: 5, bytesToMove: 50, bytesPresent: 0, decisionsNeeded: 0 },
  checks: [],
  warnings: [],
  unstable: [],
  committed: copyState === "applied",
  projectId: copyState === "applied" ? PROJECT : null,
  createdAt: "2026-10-19T20:00:00.000Z",
  updatedAt: "2026-10-19T20:00:00.000Z",
  ...overrides,
});
const heldMove = () =>
  copyStatus("failed", {
    failedStep: "applied",
    error: { code: "checks_failed", message: HELD_MESSAGE },
    checks: [failedCheck],
  });
const committedAnyway = () => copyStatus("applied", { checks: [failedCheck] });

let root: Root;
let container: HTMLDivElement;
let statuses: Array<Record<string, unknown>>;
const names = () => state.calls.map(([name]) => name);
const pointerNow = () => JSON.parse(localStorage.getItem(KEY) ?? "null");
const labels = () =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].map((node) =>
    node.textContent?.trim(),
  );
const button = (label: string) => {
  const element = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
    ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ].find((node) => node.textContent?.trim() === label);
  if (!element) throw new Error(`Missing button ${label}: ${container.textContent}`);
  return element;
};
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const click = async (label: string) => {
  await act(async () => button(label).click());
  await settle();
};
const problemsText = () =>
  container.querySelector('[data-slot="copy-problems"] [role="alert"]')?.textContent ?? "";
const mount = async () => {
  await act(async () =>
    root.render(
      <HandoffFolderCopy
        project={
          {
            id: "source",
            environmentId: "laptopE",
            title: "Project",
            workspaceRoot: "/Users/me/Projects/project",
          } as never
        }
        coordinatorId={"coordinator" as never}
        sourceLabel="Laptop E"
        method="copy"
        machines={[{ id: "kioskD" as never, label: "Kiosk D", unavailable: null }]}
        savedFolder={() => null}
        canMove
        onBusyChange={() => {}}
        onOpenProject={() => {}}
      />,
    ),
  );
  await settle();
};
const remount = async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  await mount();
};
const reopenMove = (overrides: Record<string, unknown> = {}) =>
  localStorage.setItem(
    KEY,
    JSON.stringify({
      operationId: OPERATION,
      environmentId: "kioskD",
      mode: "copy-and-move",
      targetFolder: "/home/sam/project",
      projectId: PROJECT,
      ...overrides,
    }),
  );
/** A "Copy again" sentence is only ever shown with its button. */
const expectCopyAgainMatchesButton = () => {
  if (container.textContent?.includes("Sync again:")) expect(labels()).toContain("Sync again");
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  state.calls = [];
  statuses = [heldMove()];
  state.handlers = {
    copyScopes: () => ({
      projectRoot: "/Users/me/Projects/project",
      recommendedCopyRoot: "/Users/me/Projects/project",
      scopes: [
        {
          copyRoot: "/Users/me/Projects/project",
          projectRelativePath: ".",
          kind: "project",
          label: "This project folder",
          repositories: [],
          truncated: false,
        },
      ],
    }),
    copySourceStatus: () => ({ state: "scanned", summary: null, error: null }),
    copyStatus: () => statuses.shift() ?? committedAnyway(),
    copyRetry: () => committedAnyway(),
    copySourceCancel: () => ({ state: "cancelled" }),
    copyRelease: () => ({ released: true }),
    copyUndo: ({ input }: any) => ({
      status: input.preview ? heldMove() : copyStatus("undone"),
      items: [],
      edited: 0,
      undone: !input.preview,
      kept: [],
      problems: [],
    }),
    prepare: ({ input }: any) => ({
      publication: "published",
      bundle: {
        digest: "d".repeat(64),
        manifest: { operationId: input.operationId, repositories: [] },
        destination: input.destination,
        sourceEnvironmentId: "laptopE",
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

it("shows the server's held message verbatim beside the differences", async () => {
  reopenMove();
  await mount();
  const held = container.querySelector('[data-slot="copy-held"]');
  expect(held?.querySelector('[data-slot="copy-server-message"]')?.textContent).toBe(HELD_MESSAGE);
  expect(problemsText()).toContain("so the coordinator stayed here");
});

it("shows the destination's error on the undone screen instead of claiming a clean undo", async () => {
  const error =
    "The files here were restored, but Laptop E could not be told, so the copy is still open there. Cancel the copy on Laptop E to give the project back there.";
  reopenMove();
  state.handlers.copyUndo = ({ input }: any) => ({
    status: input.preview
      ? heldMove()
      : copyStatus("undone", { error: { code: "unreachable", message: error } }),
    items: [],
    edited: 0,
    undone: !input.preview,
    kept: [],
    problems: [],
  });
  await mount();
  await click("Undo…");
  await click("Undo the copy");
  expect(container.textContent).toContain(error);
  expect(container.textContent).not.toContain("is back to how it was before the copy");
  // The browser reached Laptop E itself, so the copy is no longer open there.
  expect(container.textContent).toContain("Laptop E has now dropped the copy.");
  expect(pointerNow()).toBeNull();
});

it("says so and keeps the pointer when the source does not drop an undone copy", async () => {
  reopenMove();
  state.handlers.copySourceCancel = () => {
    throw new Error("Laptop E is unreachable.");
  };
  await mount();
  await click("Undo…");
  await click("Undo the copy");
  expect(container.textContent).toContain("is back to how it was before the copy");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Laptop E has not dropped the copy yet: Laptop E is unreachable.",
  );
  expect(container.textContent).not.toContain("Laptop E has now dropped the copy.");
  expect(pointerNow()).toMatchObject({ operationId: OPERATION });
});

it("treats a copy the source no longer knows as dropped", async () => {
  reopenMove();
  state.handlers.copySourceCancel = () => {
    throw { _tag: "FolderCopyError", code: "not_found", message: "Not found." };
  };
  await mount();
  await click("Undo…");
  await click("Undo the copy");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(pointerNow()).toBeNull();
});

it.each([false, true])(
  "recovers incomplete Undo after reopening (committed: %s)",
  async (committed) => {
    const problem = "report: EACCES: cannot list partials";
    const failed = copyStatus("failed", {
      undoIncomplete: true,
      committed,
      projectId: committed ? PROJECT : null,
      failedStep: "applied",
      error: { code: "copy_failed", message: problem },
    });
    const initial = committed ? copyStatus("applied") : heldMove();
    reopenMove({ mode: committed ? "copy-only" : "copy-and-move" });
    statuses = [initial];
    state.handlers.copyUndo = ({ input }: any) => ({
      status: input.preview ? initial : failed,
      items: [],
      edited: 0,
      undone: false,
      kept: [],
      problems: input.preview ? [] : [problem],
    });
    await mount();
    await click("Undo…");
    await click("Undo the copy");
    expect(container.textContent).toContain(problem);
    expect(names()).not.toContain("copySourceCancel");
    expect(names()).not.toContain("copyRelease");
    state.handlers.copyStatus = () => failed;
    await remount();
    if (labels().includes("View")) await click("View");
    expect(labels()).toContain("Undo…");
    expect(labels()).not.toContain("Retry");
    expect(pointerNow()).toMatchObject({ operationId: OPERATION });
    state.handlers.copyUndo = ({ input }: any) => ({
      status: input.preview ? failed : copyStatus("undone", { committed }),
      items: [],
      edited: 0,
      undone: !input.preview,
      kept: [],
      problems: [],
    });
    await click("Undo…");
    await click("Undo the copy");
    expect(pointerNow()).toBeNull();
    expect(container.textContent).toContain("is back to how it was before the copy");
    expect(names()).not.toContain("copyRetry");
  },
);
