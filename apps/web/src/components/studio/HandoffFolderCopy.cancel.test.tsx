// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { HandoffFolderCopy } from "./HandoffFolderCopy";
import { readPendingCopy } from "./handoffFolderCopyPending";
import { DEFAULT_COPY_SELECTION } from "../../studio/folderCopy";

// Cancel while measuring: a source that missed the cancel is told again, never resumed.
const state = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown]>,
  handlers: {} as Record<string, (input: unknown) => unknown>,
  uuid: 0,
}));
vi.mock("../../state/filesystem", () => ({
  filesystemEnvironment: { browse: (input: unknown) => input },
  useFilesystemReadAccess: () => ({ canReadFiles: true }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (input: { environmentId: string } | null) => ({
    data: input ? { parentPath: "/home/anton", entries: [] } : null,
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
vi.mock("../../lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/utils")>()),
  randomUUID: () => `00000000-0000-4000-8000-00000000000${++state.uuid}`,
}));

const KEY = "specwithcode:folder-copy:m4:source";
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
  secretFiles: [],
  linksOutside: 0,
  warnings: [],
};
const project = {
  id: "source",
  environmentId: "m4",
  title: "Project",
  workspaceRoot: "/Users/me/Projects/project",
};
const scanning = () => ({
  state: "scanning",
  summary: null,
  progress: { files: 10, bytes: 10 },
  error: null,
});
const scanned = () => ({ state: "scanned", summary, progress: null, error: null });
const notFound = () => {
  throw Object.assign(new Error("gone"), { _tag: "FolderCopyError", code: "not_found" });
};

let root: Root;
let container: HTMLDivElement;
const names = () => state.calls.map(([name]) => name);
const pointerNow = () => JSON.parse(localStorage.getItem(KEY) ?? "null");
const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? "";
const stage = () =>
  container.querySelector('[data-slot="handoff-folder-copy"]')?.getAttribute("data-stage");
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const waitPoll = () => act(async () => new Promise((resolve) => setTimeout(resolve, 1100)));
const button = (label: string) => {
  const element = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!element) throw new Error(`Missing button ${label}: ${container.textContent}`);
  return element;
};
const click = async (label: string) => {
  await act(async () => button(label).click());
  await settle();
};
const mount = async () => {
  await act(async () =>
    root.render(
      <HandoffFolderCopy
        project={project as never}
        coordinatorId={"coordinator" as never}
        sourceLabel="M4"
        method="copy"
        machines={[{ id: "m3" as never, label: "M3", unavailable: null }]}
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
  state.calls = [];
  root = createRoot(container);
  await mount();
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  state.calls = [];
  state.uuid = 0;
  state.handlers = {
    copyScopes: () => ({
      projectRoot: project.workspaceRoot,
      recommendedCopyRoot: project.workspaceRoot,
      scopes: [
        {
          copyRoot: project.workspaceRoot,
          projectRelativePath: ".",
          kind: "project",
          label: "This project folder",
          repositories: [],
          truncated: false,
        },
      ],
    }),
    copyCapabilities: () => ({ scopeVersion: 1 }),
    copyOffer: ({ input }: any) => ({
      operationId: input.operationId,
      sourceEnvironmentId: "m4",
      sourceProjectId: "source",
      sourceUrl: "https://m4.example.ts.net",
      sourceMachine: "M4",
      token: "grant",
      title: "Project",
      mode: input.mode,
      status: scanning(),
    }),
    copySourceStatus: scanning,
    copySourceCancel: () => {
      throw new Error("M4 did not answer.");
    },
    copyRelease: () => ({ released: true }),
    copyStart: () => {
      throw new Error("copyStart must not run for a cancelled copy.");
    },
    copyStatus: notFound,
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

/** One-click copy, then Stop copy while M4 is still measuring and misses the cancel. */
const cancelWhileMeasuring = async () => {
  await mount();
  await click("Copy to M3");
  expect(pointerNow()).toMatchObject({ auto: true });
  await click("Stop copy");
  expect(alertText()).toContain(
    "M4 has not dropped the copy yet: M4 did not answer. Reopen this window to tell it again, or cancel the copy on M4.",
  );
  expect(stage()).toBe("setup");
};

it("keeps a cancelled pointer that never resumes the measure or plan", async () => {
  await cancelWhileMeasuring();
  const saved = pointerNow();
  expect(saved).toMatchObject({ cancelled: true });
  expect(saved).not.toHaveProperty("auto");
  expect(readPendingCopy(KEY)).toMatchObject({ cancelled: true });

  // Reopen while M4 is still unreachable: only the cancel is retried.
  await remount();
  expect(names().filter((name) => name !== "copyScopes")).toEqual(["copySourceCancel"]);
  expect(alertText()).toContain("M4 has not dropped the copy yet: M4 did not answer.");
  expect(stage()).toBe("setup");
  expect(pointerNow()).toMatchObject({ operationId: saved.operationId, cancelled: true });

  // Reopen once M4 answers, with the folder measured meanwhile: the cancel lands, nothing starts.
  state.handlers.copySourceCancel = () => ({ state: "cancelled" });
  state.handlers.copySourceStatus = scanned;
  await remount();
  await waitPoll();
  await waitPoll();
  const cancelCall = state.calls.find(([name]) => name === "copySourceCancel")!;
  expect(cancelCall[1]).toMatchObject({
    environmentId: "m4",
    input: { operationId: saved.operationId },
  });
  for (const name of ["copyOffer", "copySourceStatus", "copyStart", "copyStatus"])
    expect(names()).not.toContain(name);
  expect(pointerNow()).toBeNull();
  expect(alertText()).toBe("");
  expect(stage()).toBe("setup");
  expect(button("Copy to M3").disabled).toBe(false);
});

it("treats a cancelled copy the source no longer knows as dropped on reopen", async () => {
  await cancelWhileMeasuring();
  state.handlers.copySourceCancel = notFound;
  await remount();
  expect(names()).not.toContain("copyStart");
  expect(names()).not.toContain("copyOffer");
  expect(pointerNow()).toBeNull();
  expect(alertText()).toBe("");
});

it("reads a cancelled pointer with the person's choices", () => {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      operationId: "op",
      environmentId: "m3",
      mode: "copy-only",
      targetFolder: "/home/anton/project",
      projectId: null,
      selection: DEFAULT_COPY_SELECTION,
      cancelled: true,
    }),
  );
  expect(readPendingCopy(KEY)).toMatchObject({ cancelled: true });
  localStorage.setItem(KEY, JSON.stringify({ ...pointerNow(), cancelled: "yes" }));
  expect(readPendingCopy(KEY)).not.toHaveProperty("cancelled");
});

const moveRadio = () =>
  [...container.querySelectorAll<HTMLElement>('[data-slot="toggle"]')].find(
    (node) => node.textContent === "Move and continue there",
  )!;
const checkbox = (selector: string) =>
  container.querySelector<HTMLElement>(`${selector} [data-slot="checkbox"]`)!;
const folderValue = () =>
  container.querySelector<HTMLInputElement>('input[aria-label="Folder on M3"]')!.value;

it("stops measuring to change the setup, the same way Stop copy does", async () => {
  state.handlers.copySourceCancel = () => ({ state: "cancelled" });
  await mount();
  await click("Copy to M3");
  expect(stage()).toBe("scanning");
  await click("Change (stops this copy)");
  expect(names()).toContain("copySourceCancel");
  expect(names()).not.toContain("copyStart");
  expect(pointerNow()).toBeNull();
  expect(stage()).toBe("setup");
  expect(alertText()).toBe("");
  expect(container.querySelector('[data-slot="copy-cancelled"]')?.textContent).toBe(
    "Copy cancelled. Nothing on M3 changed.",
  );
  expect(folderValue()).toBe("/home/anton/Projects/project");
  expect(button("Copy to M3").disabled).toBe(false);
});

it("keeps machine, folder, mode and chosen classes after Stop copy while choosing", async () => {
  state.handlers.copySourceCancel = () => ({ state: "cancelled" });
  const offer = state.handlers.copyOffer!;
  state.handlers.copyOffer = (input) => ({ ...(offer(input) as object), status: scanned() });
  await mount();
  await act(async () => moveRadio().click());
  await act(async () => checkbox('[data-slot="copy-choose-first"]').click());
  await click("Move to M3");
  expect(stage()).toBe("select");
  await act(async () => checkbox('[data-class="untracked"]').click());
  // A move says Stop move.
  await click("Stop move");
  expect(names()).toContain("copyRelease");
  expect(pointerNow()).toBeNull();
  expect(stage()).toBe("setup");
  expect(moveRadio().getAttribute("aria-pressed")).toBe("true");
  expect(folderValue()).toBe("/home/anton/Projects/project");
  await click("Move to M3");
  expect(stage()).toBe("select");
  expect(checkbox('[data-class="untracked"]').getAttribute("aria-checked")).toBe("false");
  expect(pointerNow()).toMatchObject({ mode: "copy-and-move" });
});
