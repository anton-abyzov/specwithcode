// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@specweave-studio/contracts";
import { AddFolderAction, AddFolderPanel, useAddFolder } from "./AddFolderPanel";

const HOME = "/Users/test";
const TREE: Record<string, Array<{ name: string; kind?: "folder" | "git" }>> = {
  [HOME]: [{ name: ".config" }, { name: "Projects", kind: "folder" }],
  [`${HOME}/Projects`]: [
    { name: "acme", kind: "git" },
    { name: "notes", kind: "folder" },
  ],
  [`${HOME}/Projects/notes`]: [],
};
const state = vi.hoisted(() => ({ requests: [] as string[], allowed: true, pending: false }));
vi.mock("../../state/filesystem", () => ({
  useFilesystemReadAccess: () => ({
    canReadFiles: state.allowed,
    isPending: false,
    error: state.allowed ? null : "No filesystem permission",
  }),
  filesystemEnvironment: { browse: (input: any) => input },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (input: any) => {
    if (!input) return { data: null, error: null, isPending: false, refresh: () => {} };
    const asked: string = input.input.partialPath;
    const parentPath = asked.replace(/^~/, HOME).replace(/\/$/, "") || "/";
    if (state.requests.at(-1) !== parentPath) state.requests.push(parentPath);
    const entries = state.pending ? undefined : TREE[parentPath];
    if (state.pending) return { data: null, error: null, isPending: true, refresh: () => {} };
    return {
      isPending: false,
      refresh: () => {},
      error:
        entries === undefined
          ? { message: `The folder '${parentPath}' does not exist on this machine.` }
          : null,
      data:
        entries === undefined
          ? null
          : {
              parentPath,
              homePath: HOME,
              entries: entries.map((entry) => ({
                ...entry,
                fullPath: `${parentPath}/${entry.name}`,
              })),
            },
    };
  },
}));

let container: HTMLDivElement;
let root: Root;
let finishAdd: ((reason: string | null) => void) | null = null;
const onMissing = vi.fn();
const add = vi.fn(
  (_path: string) =>
    new Promise<string | null>((resolve) => {
      finishAdd = resolve;
    }),
);

function Harness({ start, platform = "MacIntel" }: { start: string; platform?: string }) {
  const [value, setValue] = useState(start);
  const folder = useAddFolder({
    environmentId: EnvironmentId.make("mac"),
    active: true,
    value,
    onValueChange: setValue,
    platform,
    cwd: null,
    machineLabel: "Work Mac",
    projects: [],
    allowed: true,
    add,
    dropRefusal: null,
    onMissing,
  });
  return (
    <>
      <input
        aria-label="Folder path"
        {...folder.bar.aria}
        value={value}
        onChange={(event) => folder.bar.change(event.target.value, { element: event.target })}
        onKeyDown={(event) => void folder.bar.onKeyDown(event)}
      />
      <AddFolderPanel folder={folder} places={[]} />
      <AddFolderAction folder={folder} />
    </>
  );
}
const bar = () => container.querySelector<HTMLInputElement>('input[aria-label="Folder path"]')!;
const primary = () =>
  container.querySelector<HTMLButtonElement>('[data-slot="add-folder-primary"]')!;
const status = () => container.querySelector('[data-slot="add-folder-status"]')!.textContent;
const row = (name: string) =>
  [...container.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
    option.textContent?.startsWith(name),
  )!;
async function key(name: string) {
  await act(async () => {
    bar().dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });
}
async function render(start: string, platform?: string) {
  await act(async () => root.render(<Harness start={start} {...(platform ? { platform } : {})} />));
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(state, { allowed: true, pending: false });
  state.requests.length = 0;
  TREE[`${HOME}/Projects`] = [
    { name: "acme", kind: "git" },
    { name: "notes", kind: "folder" },
  ];
  add.mockClear();
  onMissing.mockClear();
  finishAdd = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("Enter adds a typed folder that has no folders inside", async () => {
  await render(`${HOME}/Projects/notes/`);
  expect(status()).toBe("No folders inside. notes itself becomes the project on Work Mac.");
  expect(primary().textContent).toContain("Add notes");
  await key("Enter");
  expect(add).toHaveBeenCalledWith(`${HOME}/Projects/notes`);
});

it("the pointer on a row changes nothing that Enter does", async () => {
  await render(`${HOME}/Projects/`);
  await act(async () => {
    row("acme").dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
  expect(row("acme").getAttribute("aria-selected")).toBe("false");
  await key("Enter");
  expect(add).toHaveBeenCalledWith(`${HOME}/Projects`);
});

it("arrows put the folder into the bar, and Enter adds that folder", async () => {
  await render(`${HOME}/Projects/`);
  await key("ArrowDown");
  expect(bar().value).toBe(`${HOME}/Projects/acme`);
  expect(row("acme").getAttribute("aria-selected")).toBe("true");
  expect(row("notes")).toBeDefined();
  expect(status()).toBe("acme is a Git repository on Work Mac. It becomes the project.");
  await key("ArrowDown");
  await key("Enter");
  expect(add).toHaveBeenCalledWith(`${HOME}/Projects/notes`);
});

it("ties the bar to the list and to the highlighted row", async () => {
  await render(`${HOME}/Projects/`);
  const list = container.querySelector('[role="listbox"]')!;
  expect(bar().getAttribute("aria-controls")).toBe(list.id);
  expect(bar().hasAttribute("aria-activedescendant")).toBe(false);
  await key("ArrowDown");
  expect(bar().getAttribute("aria-activedescendant")).toBe(row("acme").id);
});

it("Enter adds the folder in the bar when the list changes under a highlighted row", async () => {
  await render(`${HOME}/Projects/`);
  await key("ArrowDown");
  await key("ArrowDown");
  expect(bar().value).toBe(`${HOME}/Projects/notes`);
  // A folder appears ahead of the highlighted one and the list is read again.
  TREE[`${HOME}/Projects`] = [
    { name: "acme", kind: "git" },
    { name: "brand-new", kind: "folder" },
    { name: "notes", kind: "folder" },
  ];
  await render(`${HOME}/Projects/notes`);
  expect(row("notes").getAttribute("aria-selected")).toBe("true");
  expect(row("brand-new").getAttribute("aria-selected")).toBe("false");
  await key("Enter");
  expect(add).toHaveBeenCalledWith(`${HOME}/Projects/notes`);
});

it("still adds a typed folder when the connection may not list folders", async () => {
  state.allowed = false;
  await render(`${HOME}/Projects/notes`);
  expect(status()).toBe("No filesystem permission. Enter still adds notes on Work Mac.");
  expect(primary().disabled).toBe(false);
  await key("Enter");
  expect(add).toHaveBeenCalledWith(`${HOME}/Projects/notes`);
  expect(state.requests).toEqual([]);
});

it("adds the typed folder while the machine is still answering", async () => {
  state.pending = true;
  await render(`${HOME}/Projects/notes`);
  expect(status()).toBe("Checking notes on Work Mac…");
  await key("Enter");
  expect(add).toHaveBeenCalledWith(`${HOME}/Projects/notes`);
});

it("announces the status once it settles, and a failed add at once", async () => {
  vi.useFakeTimers();
  try {
    await render(`${HOME}/Projects/`);
    const announcement = () =>
      container.querySelector('[data-slot="add-folder-announcement"]')!.textContent;
    const first = announcement();
    await key("ArrowDown");
    // Nothing is read out mid-keystroke, and the visible line is not a live region.
    expect(announcement()).toBe(first);
    expect(container.querySelector('[data-slot="add-folder-status"]')!.hasAttribute("role")).toBe(
      false,
    );
    await act(async () => vi.advanceTimersByTime(800));
    expect(announcement()).toBe("acme is a Git repository on Work Mac. It becomes the project.");
  } finally {
    vi.useRealTimers();
  }
});

it("Tab opens the highlighted folder", async () => {
  await render(`${HOME}/Projects/`);
  await key("ArrowDown");
  await key("ArrowDown");
  await key("Tab");
  expect(bar().value).toBe(`${HOME}/Projects/notes/`);
  expect(add).not.toHaveBeenCalled();
});

it("shows Adding at once, ignores a second Enter, and keeps a failure on screen", async () => {
  await render(`${HOME}/Projects/notes/`);
  await key("Enter");
  expect(primary().textContent).toBe("Adding…");
  expect(primary().disabled).toBe(true);
  await key("Enter");
  expect(add).toHaveBeenCalledTimes(1);
  await act(async () => finishAdd!("The folder cannot be written to."));
  expect(status()).toBe("The folder cannot be written to.");
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(primary().disabled).toBe(false);
});

it("names creating a folder that is not there", async () => {
  await render(`${HOME}/Projects/fresh`);
  expect(primary().textContent).toContain("Create and add");
  expect(onMissing).not.toHaveBeenCalled();
});

it("reports a folder the machine no longer has, so a remembered one can be dropped", async () => {
  await render(`${HOME}/gone/`);
  expect(onMissing).toHaveBeenCalledTimes(1);
  expect(onMissing).toHaveBeenCalledWith(expect.stringContaining(`${HOME}/gone`));
});

it("refuses a path of the wrong kind before asking the machine", async () => {
  await render("C:\\Users\\test");
  expect(status()).toContain("Work Mac is not a Windows machine");
  expect(primary().disabled).toBe(true);
  expect(state.requests).toEqual([]);
  await key("Enter");
  expect(add).not.toHaveBeenCalled();
});
