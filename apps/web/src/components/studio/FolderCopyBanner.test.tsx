// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import {
  registerCopyOpener,
  resetCopyActivityForTests,
  setCopyActivity,
} from "../../studio/folderCopyActivity";
import { FolderCopyBanner } from "./FolderCopyBanner";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetCopyActivityForTests();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("shows a running copy's progress and opens its dialog, and hides once it is done", async () => {
  let opened = 0;
  registerCopyOpener("m4:source", () => (opened += 1));
  await act(async () => root.render(<FolderCopyBanner environmentId="m4" projectId="source" />));
  expect(container.innerHTML).toBe("");
  await act(async () =>
    setCopyActivity("m4:source", {
      machine: "ministorm",
      label: "Copying files",
      fraction: 0.5,
      waiting: false,
    }),
  );
  expect(container.textContent).toContain("Copy to ministorm: copying files, 50%");
  expect(container.textContent).toContain("You can keep working");
  expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("50");
  await act(async () => container.querySelector("button")!.click());
  expect(opened).toBe(1);
  await act(async () => setCopyActivity("m4:source", null));
  expect(container.innerHTML).toBe("");
});
