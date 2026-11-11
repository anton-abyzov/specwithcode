// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@specweave-studio/contracts";
import { NewProjectFolderPicker, parentFolderOf } from "./NewProjectFolderPicker";
import { useProjectFolderChoice } from "../../hooks/useProjectFolderChoice";

const HOME = "/Users/test";
const TREE: Record<string, Array<{ name: string; kind?: "folder" | "git" }>> = {
  [HOME]: [{ name: ".config" }, { name: "Projects", kind: "folder" }],
  [`${HOME}/Projects`]: [
    { name: "acme", kind: "git" },
    { name: "notes", kind: "folder" },
    { name: "site", kind: "folder" },
  ],
  [`${HOME}/Projects/acme`]: [{ name: ".git" }, { name: "src", kind: "folder" }],
  [`${HOME}/Projects/notes`]: [],
};
const state = vi.hoisted(() => ({
  allowed: true,
  pending: false,
  error: null as string | null,
  requests: [] as any[],
  created: [] as any[],
  createFailure: null as string | null,
  unreadable: null as string | null,
}));
vi.mock("../../state/filesystem", () => ({
  useFilesystemReadAccess: () => ({
    canReadFiles: state.allowed,
    error: state.allowed ? null : "No filesystem permission",
  }),
  filesystemEnvironment: {
    browse: (input: any) => {
      state.requests.push(input);
      return input;
    },
    createDirectory: "create-directory",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async (value: any) => {
    state.created.push(value);
    if (state.createFailure) {
      return { _tag: "Failure", cause: { message: state.createFailure } };
    }
    const path = `${value.input.parentPath}/${value.input.name}`;
    TREE[path] = [];
    return { _tag: "Success", value: { path } };
  },
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (result: any) => result.cause,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (input: any) => {
    const asked: string | null = input ? input.input.partialPath : null;
    const parentPath =
      asked === null ? null : asked === "~/" ? HOME : asked.replace(/\/$/, "") || "/";
    const known = parentPath !== null && TREE[parentPath] !== undefined;
    return {
      isPending: state.pending,
      error:
        state.error ??
        (asked !== null && !known
          ? `The folder '${parentPath}' does not exist on this machine.`
          : null),
      refresh: () => {},
      data:
        parentPath !== null && known
          ? {
              parentPath,
              homePath: HOME,
              ...(state.unreadable === parentPath ? { unreadable: true } : {}),
              entries: TREE[parentPath]!.map((entry) => ({
                ...entry,
                fullPath: `${parentPath}/${entry.name}`,
              })),
            }
          : null,
    };
  },
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(state, {
    allowed: true,
    pending: false,
    error: null,
    requests: [],
    created: [],
    createFailure: null,
  });
  delete TREE[`${HOME}/Projects/clients`];
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const button = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent === name || b.getAttribute("aria-label") === name,
  )!;
const row = (name: string) =>
  [...container.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
    option.textContent!.startsWith(name),
  )!;
const rows = () =>
  [...container.querySelectorAll('[role="option"]')].map((option) => option.textContent);
const crumbs = () =>
  [...container.querySelectorAll("nav ol button")].map((crumb) => crumb.textContent);
const outcome = () =>
  container.querySelector('[data-slot="project-location-outcome"]')!.textContent;
const list = () => container.querySelector<HTMLElement>('[role="listbox"]')!;
const key = (target: HTMLElement, name: string) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });
const type = (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const machine = EnvironmentId.make("m1");
const render = (props: Partial<Parameters<typeof NewProjectFolderPicker>[0]> = {}) =>
  act(async () =>
    root.render(
      <NewProjectFolderPicker
        environmentId={machine}
        selectedPath={null}
        disabled={false}
        onSelect={vi.fn()}
        {...props}
      />,
    ),
  );

it("starts at home with nothing chosen, and chooses the folder a person opens", async () => {
  const onSelect = vi.fn();
  await render({ onSelect });
  expect(state.requests.at(-1).environmentId).toBe("m1");
  expect(onSelect.mock.calls.every(([path]) => path === null)).toBe(true);
  expect(crumbs()).toEqual(["Home"]);
  await act(async () => row("Projects").click());
  expect(onSelect).toHaveBeenLastCalledWith(`${HOME}/Projects`);
  expect(crumbs()).toEqual(["Home", "Projects"]);
});

it.each(["pending", "error", "denied"])("does not choose a stale folder while %s", async (mode) => {
  state.pending = mode === "pending";
  state.error = mode === "error" ? "Offline" : null;
  state.allowed = mode !== "denied";
  const onSelect = vi.fn();
  await render({ onSelect, defaultPath: `${HOME}/Projects` });
  expect(onSelect.mock.calls.every(([path]) => path === null)).toBe(true);
  expect(container.querySelector('[role="option"]')).toBeNull();
});

it("opens at the default folder and says exactly which folder is made", async () => {
  const onSelect = vi.fn();
  await render({ onSelect, defaultPath: `${HOME}/Projects`, projectName: "Fable Test" });
  expect(onSelect).toHaveBeenLastCalledWith(`${HOME}/Projects`);
  expect(outcome()).toBe("Creates ~/Projects/fable-test.");
  expect(container.textContent).not.toContain("Up one folder");
  expect(container.textContent).not.toContain("Use this folder");
});

it("says when the folder shown is used as the project instead", async () => {
  await render({ defaultPath: `${HOME}/Projects`, projectName: "Fable Test", machineLabel: "m1" });
  await act(async () => row("acme").click());
  expect(outcome()).toBe(
    "Uses ~/Projects/acme as the project on m1. It is already a Git repository.",
  );
});

it("marks repositories and existing projects, and hides dot folders until asked", async () => {
  await render({
    defaultPath: `${HOME}/Projects`,
    projects: [{ workspaceRoot: `${HOME}/Projects/site`, title: "Website" }],
  });
  expect(rows()).toEqual(["acmeGit repository", "notes", "siteProject: Website"]);
  await act(async () => button("Home").click());
  expect(rows()).toEqual(["Projects"]);
  await act(async () => button("Show hidden folders").click());
  expect(rows()).toEqual([".config", "Projects"]);
});

it("moves with the keyboard: arrows, open, parent and typed letters", async () => {
  const onSelect = vi.fn();
  await render({ onSelect, defaultPath: `${HOME}/Projects` });
  expect(row("acme").getAttribute("aria-selected")).toBe("true");
  await key(list(), "s");
  expect(row("site").getAttribute("aria-selected")).toBe("true");
  await key(list(), "ArrowUp");
  expect(row("notes").getAttribute("aria-selected")).toBe("true");
  await key(list(), "ArrowRight");
  expect(onSelect).toHaveBeenLastCalledWith(`${HOME}/Projects/notes`);
  expect(container.textContent).toContain("No folders inside.");
  await key(list(), "ArrowLeft");
  expect(onSelect).toHaveBeenLastCalledWith(`${HOME}/Projects`);
  await key(list(), "/");
  const path = container.querySelector<HTMLInputElement>('input[aria-label="Folder path"]')!;
  expect(path.value).toBe(`${HOME}/Projects`);
  await type(path, HOME);
  await key(path, "Enter");
  expect(onSelect).toHaveBeenLastCalledWith(HOME);
});

it("turns the breadcrumb into the address bar on a click in its empty part", async () => {
  const onSelect = vi.fn();
  await render({ onSelect, defaultPath: `${HOME}/Projects` });
  await act(async () =>
    container.querySelector<HTMLElement>('nav[aria-label^="Current folder"]')!.click(),
  );
  const path = () => container.querySelector<HTMLInputElement>('input[aria-label="Folder path"]')!;
  expect(path().value).toBe(`${HOME}/Projects`);
  // Typing completes from the folder being shown.
  await type(path(), `${HOME}/Projects/no`);
  expect(path().value).toBe(`${HOME}/Projects/notes`);
  await key(path(), "Enter");
  expect(onSelect).toHaveBeenLastCalledWith(`${HOME}/Projects/notes`);
});

it("takes a pasted path anywhere in the browser", async () => {
  const onSelect = vi.fn();
  await render({ onSelect, defaultPath: `${HOME}/Projects` });
  await act(async () => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.assign(event, { clipboardData: { getData: () => `"${HOME}/Projects/acme"\n` } });
    list().dispatchEvent(event);
  });
  const path = () => container.querySelector<HTMLInputElement>('input[aria-label="Folder path"]')!;
  expect(path().value).toBe(`${HOME}/Projects/acme`);
  await key(path(), "Enter");
  expect(onSelect).toHaveBeenLastCalledWith(`${HOME}/Projects/acme`);
});

it("jumps to a place", async () => {
  const onSelect = vi.fn();
  await render({
    onSelect,
    places: [
      { kind: "projects", label: "Projects", path: `${HOME}/Projects` },
      { kind: "home", label: "Home", path: "~/" },
    ],
  });
  await act(async () =>
    container.querySelector<HTMLElement>('[aria-label="Places"] button')!.click(),
  );
  expect(onSelect).toHaveBeenLastCalledWith(`${HOME}/Projects`);
});

it("makes a new folder on the machine and opens it", async () => {
  const onSelect = vi.fn();
  await render({ onSelect, defaultPath: `${HOME}/Projects`, canCreateFolder: true });
  await act(async () => button("New folder").click());
  const name = () => container.querySelector<HTMLInputElement>('[aria-label="New folder name"]')!;
  const submit = () =>
    act(async () =>
      name().form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
  for (const [bad, message] of [
    ["", "Enter a folder name."],
    ["a/b", "A folder name cannot contain a slash."],
    ["..", '".." is not a folder name.'],
    ["acme", '"acme" is already here.'],
  ]) {
    await type(name(), bad!);
    await submit();
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(message);
  }
  expect(state.created).toEqual([]);
  await type(name(), "clients");
  await submit();
  expect(state.created).toEqual([
    { environmentId: "m1", input: { parentPath: `${HOME}/Projects`, name: "clients" } },
  ]);
  expect(onSelect).toHaveBeenLastCalledWith(`${HOME}/Projects/clients`);
  expect(crumbs()).toEqual(["Home", "Projects", "clients"]);
});

it("shows the machine's own refusal and keeps the name for another try", async () => {
  state.createFailure = "This machine does not allow making '/x'.";
  await render({ defaultPath: `${HOME}/Projects`, canCreateFolder: true, machineLabel: "m1" });
  await act(async () => button("New folder").click());
  const name = container.querySelector<HTMLInputElement>('[aria-label="New folder name"]')!;
  await type(name, "clients");
  await act(async () =>
    name.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(container.querySelector('[role="alert"]')!.textContent).toBe(
    "This machine does not allow making '/x'.",
  );
  expect(name.value).toBe("clients");
});

it("does not offer New folder on a machine that cannot make one", async () => {
  await render({ defaultPath: `${HOME}/Projects` });
  expect(button("New folder")).toBeUndefined();
});

it("blocks folder controls while creating", async () => {
  await render({ defaultPath: `${HOME}/Projects`, disabled: true, canCreateFolder: true });
  expect(row("acme").hasAttribute("disabled")).toBe(true);
  expect(button("New folder").hasAttribute("disabled")).toBe(true);
  expect(button("Home").hasAttribute("disabled")).toBe(true);
});

it("chooses a folder with the system dialog when it is offered", async () => {
  const onSelect = vi.fn();
  const onPickNatively = vi.fn(async () => `${HOME}/Projects/notes`);
  await render({ onSelect, nativePickerLabel: "Choose in Finder…", onPickNatively });
  await act(async () => button("Choose in Finder…").click());
  expect(onPickNatively).toHaveBeenCalledWith(HOME);
  expect(onSelect).toHaveBeenLastCalledWith(`${HOME}/Projects/notes`);
});

it("names the machine it browses", async () => {
  await render({ defaultPath: `${HOME}/Projects`, machineLabel: "linux-mini" });
  expect(container.textContent).toContain("Project location on linux-mini");
  expect(list().getAttribute("aria-label")).toBe("Folders on linux-mini");
});

it("offers a default folder that does not exist yet instead of a browse error", async () => {
  const onSelect = vi.fn();
  await render({ onSelect, defaultPath: `${HOME}/Code`, machineLabel: "m1", projectName: "x" });
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("does not exist yet");
  expect(onSelect).toHaveBeenLastCalledWith(`${HOME}/Code`);
});

it("names a folder the machine may not read and never offers it as the choice", async () => {
  state.unreadable = `${HOME}/Projects`;
  const onSelect = vi.fn();
  try {
    await render({
      onSelect,
      selectedPath: `${HOME}/Projects`,
      machineLabel: "m1",
      projectName: "x",
    });
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(
      `m1 does not allow reading ${HOME}/Projects.`,
    );
    expect(container.textContent).not.toContain("No folders inside");
    expect(onSelect.mock.calls.every(([path]) => path === null)).toBe(true);
    expect(button(`Open ${HOME}`)).toBeDefined();
  } finally {
    state.unreadable = null;
  }
});

it("keeps the name field and messages outside the list of folders", async () => {
  await render({ selectedPath: `${HOME}/Projects`, canCreateFolder: true });
  await act(async () => button("New folder").click());
  const field = container.querySelector('[aria-label="New folder name"]')!;
  expect(field.closest('[role="listbox"]')).toBeNull();
});

it("shows a browse error in its own words with the machine it came from", async () => {
  const onSelect = vi.fn();
  await render({ onSelect, selectedPath: `${HOME}/gone/deeper`, machineLabel: "m1" });
  expect(container.querySelector('[role="alert"]')!.textContent).toBe(
    `The folder '${HOME}/gone/deeper' does not exist on m1.`,
  );
  expect(onSelect.mock.calls.every(([path]) => path === null)).toBe(true);
  expect(button(`Open ${HOME}/gone`)).toBeDefined();
});

function Choice({ id, remember = false }: { id: string; remember?: boolean }) {
  const choice = useProjectFolderChoice(EnvironmentId.make(id), false, {
    remember,
    defaultPath: `${HOME}/Projects`,
  });
  return (
    <>
      <output>{choice.path ?? "none"}</output>
      <button onClick={choice.reset}>reset</button>
      {choice.picker}
    </>
  );
}
const chosen = () => container.querySelector("output")!.textContent;

it("keeps each machine's folder when switching machines and back", async () => {
  await act(async () => root.render(<Choice id="m1" />));
  await act(async () => row("notes").click());
  expect(chosen()).toBe(`${HOME}/Projects/notes`);
  await act(async () => root.render(<Choice id="m2" />));
  expect(chosen()).toBe(`${HOME}/Projects`);
  await act(async () => root.render(<Choice id="m1" />));
  expect(chosen()).toBe(`${HOME}/Projects/notes`);
});

it("starts over from the default folder for a new creation flow", async () => {
  await act(async () => root.render(<Choice id="m1" />));
  await act(async () => row("notes").click());
  await act(async () => button("reset").click());
  expect(chosen()).toBe(`${HOME}/Projects`);
});

it("offers the last chosen folder again when asked to remember", async () => {
  await act(async () => root.render(<Choice id="m1" remember />));
  await act(async () => row("notes").click());
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<Choice id="m1" remember />));
  expect(chosen()).toBe(`${HOME}/Projects/notes`);
  expect(crumbs()).toEqual(["Home", "Projects", "notes"]);
});

it("finds the parent of a folder without ../ paths", () => {
  expect(parentFolderOf("/Users/test/Projects/")).toBe("/Users/test");
  expect(parentFolderOf("/Users")).toBe("/");
  expect(parentFolderOf("/")).toBeNull();
  expect(parentFolderOf("C:\\Users")).toBe("C:\\");
});
