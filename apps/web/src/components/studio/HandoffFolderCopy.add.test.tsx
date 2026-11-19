// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { CopyFixture, onChoices } from "./HandoffFolderCopy.testkit";
import { readPendingCopy } from "./handoffFolderCopyPending";

// "Add to another machine…" with a copy or a move to another machine left unfinished: the
// real copy flow neither opens that one nor changes its pointer.
const state = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown]>,
  handlers: {} as Record<string, (input: unknown) => unknown>,
  uuid: 0,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, onClick, className }: any) => (
    <a
      className={className}
      href={to
        .replace("$environmentId", params.environmentId)
        .replace("$threadId", params.threadId)}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
    >
      {children}
    </a>
  ),
}));
vi.mock("../../state/filesystem", () => ({
  filesystemEnvironment: { browse: (input: unknown) => input },
  useFilesystemReadAccess: () => ({ canReadFiles: true }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (input: { environmentId: string } | null) => ({
    data: input ? { parentPath: "/home/sam", entries: [] } : null,
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
vi.mock("../../lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/utils")>()),
  randomUUID: () => `00000000-0000-4000-8000-00000000000${++state.uuid}`,
}));

let root: Root;
let container: HTMLDivElement;
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const KEY = "specwithcode:folder-copy:m4:source";
const unfinished = {
  operationId: "00000000-0000-4000-8000-000000000009",
  environmentId: "m1",
  mode: "copy-and-move",
  targetFolder: "/work/atlas",
  projectId: null,
};
const polls = () =>
  state.calls.filter(([name]) => name === "copyStatus" || name === "moveCoordinator");

it("opens Add as a new copy and leaves the unfinished move to another machine as it is", async () => {
  onChoices.mockClear();
  localStorage.setItem(KEY, JSON.stringify(unfinished));
  await act(async () => root.render(<CopyFixture fresh machineRequested m1Available />));
  await settle();
  // Nothing of the saved move is asked for or continued.
  expect(polls()).toEqual([]);
  expect(readPendingCopy(KEY)).toMatchObject(unfinished);
  for (const [choices] of onChoices.mock.calls)
    expect(choices).not.toMatchObject({ mode: "copy-and-move" });
  expect(container.textContent).not.toContain("/work/atlas");
});

it("still opens that unfinished move when the dialog is not Add", async () => {
  onChoices.mockClear();
  localStorage.setItem(KEY, JSON.stringify(unfinished));
  await act(async () => root.render(<CopyFixture machineRequested m1Available />));
  await settle();
  expect(polls().length).toBeGreaterThan(0);
  expect(onChoices.mock.calls.some(([choices]) => choices.mode === "copy-and-move")).toBe(true);
});
