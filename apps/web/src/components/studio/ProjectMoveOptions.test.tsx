// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { FolderField } from "./ProjectMoveOptions";

let container: HTMLDivElement;
let root: Root;
let widths: { scroll: number; client: number };
const saved = {
  scroll: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth"),
  client: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth"),
};
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  widths = { scroll: 100, client: 100 };
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get: () => widths.scroll,
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => widths.client,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (saved.scroll) Object.defineProperty(HTMLElement.prototype, "scrollWidth", saved.scroll);
  if (saved.client) Object.defineProperty(HTMLElement.prototype, "clientWidth", saved.client);
});

const long = "/Users/me/Projects/github/specweave-umb/repositories/anton-abyzov/specweave";
const field = () => container.querySelector<HTMLInputElement>('input[aria-label="Folder on M3"]')!;
const box = () => container.querySelector('[data-slot="folder-box"]')!;

it("shows the end of a long path with an ellipsis, and the whole path as its tooltip", async () => {
  widths = { scroll: 600, client: 240 };
  await act(async () => root.render(<FolderField machineLabel="M3" value={long} />));
  expect(field().title).toBe(long);
  expect(field().scrollLeft).toBe(600);
  expect(box().hasAttribute("data-clipped")).toBe(true);
  expect(container.querySelector('[data-slot="folder-ellipsis"]')?.textContent).toBe("…");
});

it("drops the ellipsis while the path is edited and when it fits", async () => {
  widths = { scroll: 600, client: 240 };
  await act(async () => root.render(<FolderField machineLabel="M3" value={long} />));
  await act(async () => field().focus());
  expect(box().hasAttribute("data-clipped")).toBe(false);
  await act(async () => field().blur());
  expect(box().hasAttribute("data-clipped")).toBe(true);
  widths = { scroll: 120, client: 240 };
  await act(async () => root.render(<FolderField machineLabel="M3" value="/Users/me/app" />));
  expect(box().hasAttribute("data-clipped")).toBe(false);
  expect(field().title).toBe("/Users/me/app");
});

it("has no tooltip for an empty field", async () => {
  await act(async () => root.render(<FolderField machineLabel="M3" value="" />));
  expect(field().hasAttribute("title")).toBe(false);
});
