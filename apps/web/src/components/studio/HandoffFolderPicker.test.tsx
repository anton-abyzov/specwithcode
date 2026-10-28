// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { HandoffFolderPicker } from "./HandoffFolderPicker";

const state = vi.hoisted(() => ({
  browsed: [] as Array<{ environmentId: string; input: { partialPath: string } }>,
  listing: null as null | {
    parentPath: string;
    entries: Array<{ name: string; fullPath: string }>;
  },
  create: vi.fn(),
}));
vi.mock("../../state/filesystem", () => ({
  filesystemEnvironment: { browse: (input: unknown) => input },
  useFilesystemReadAccess: (machine: string | null) => ({
    canReadFiles: machine !== null,
    error: null,
  }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: { input: { partialPath: string } } | null) => {
    if (query) state.browsed.push(query as never);
    return {
      data: query && !query.input.partialPath.startsWith("~/mirror") ? state.listing : null,
      isPending: false,
      error: null,
    };
  },
}));
vi.mock("../../state/projects", () => ({ projectEnvironment: { create: "create" } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.create }));
vi.mock("../../lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/utils")>()),
  randomUUID: () => "00000000-0000-4000-8000-000000000009",
}));

const machine = (id: string, unavailable: string | null = null) => ({
  id: id as EnvironmentId,
  label: id.toUpperCase(),
  online: unavailable === null,
  unavailable,
  workersAllowed: false,
  hasProjectFolder: false,
  lastOnlineAt: null,
});
let root: Root;
let container: HTMLDivElement;
const field = () => container.querySelector<HTMLInputElement>('input[aria-label="Folder on M3"]');
const button = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label,
  )!;
const render = (props: Partial<Parameters<typeof HandoffFolderPicker>[0]>) =>
  act(async () =>
    root.render(
      <HandoffFolderPicker
        title="Project"
        machines={[machine("m2", "Connect first"), machine("m1"), machine("m3")]}
        machine={"m3" as EnvironmentId}
        onSaved={() => {}}
        {...props}
      />,
    ),
  );

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.browsed.length = 0;
  state.listing = null;
  state.create.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("shows the folder on the machine chosen in the list, with no machine menu or disclosure", async () => {
  await render({});
  expect(field()?.value).toBe("~/Projects/");
  expect(container.querySelector("select")).toBeNull();
  expect(container.querySelector("details")).toBeNull();
  expect(button("Browse…")).toBeDefined();
  // Only the chosen machine is read.
  expect(state.browsed.every((query) => query.environmentId === "m3")).toBe(true);
});

it("reads nothing and shows nothing without a machine", async () => {
  await render({ machine: null });
  expect(container.textContent).toBe("");
  expect(state.browsed).toHaveLength(0);
});

it("lists folders only after Browse… and fills the field from a pick", async () => {
  state.listing = {
    parentPath: "/home/me/Projects/",
    entries: [{ name: "product", fullPath: "/home/me/Projects/product" }],
  };
  await render({});
  expect(container.querySelector('[aria-label="Remote folders"]')).toBeNull();
  await act(async () => button("Browse…").click());
  expect(container.querySelector('[aria-label="Remote folders"]')).not.toBeNull();
  await act(async () => button("product").click());
  expect(field()?.value).toBe("/home/me/Projects/product");
});

it("saves an existing registration without creating a project", async () => {
  const onSaved = vi.fn();
  state.listing = {
    parentPath: "/home/me/Projects/",
    entries: [{ name: "product", fullPath: "/home/me/Projects/product" }],
  };
  await render({
    onSaved,
    existingFolders: [
      {
        environmentId: "m3" as EnvironmentId,
        id: "known" as never,
        workspaceRoot: "/home/me/Projects/product/",
      },
    ],
  });
  await act(async () => button("Browse…").click());
  await act(async () => button("product").click());
  await act(async () => button("Use this folder").click());
  expect(onSaved).toHaveBeenCalledExactlyOnceWith("m3", "known", "/home/me/Projects/product/");
  expect(state.create).not.toHaveBeenCalled();
});

it("refuses a relative path and an unavailable machine", async () => {
  const onSaved = vi.fn();
  await render({ onSaved });
  await act(async () => button("Use this folder").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("full absolute path");
  expect(onSaved).not.toHaveBeenCalled();
  await render({ machine: "m2" as EnvironmentId });
  expect(button("Use this folder").disabled).toBe(true);
});
