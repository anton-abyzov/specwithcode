// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";

import {
  WorkspaceMissingRecovery,
  type WorkspaceMissingRecoveryActions,
} from "./WorkspaceMissingRecovery";

const recovery = (threadId: string): WorkspaceMissingRecoveryActions => ({
  threadId,
  failureItemId: "item:1",
  code: "workspace_missing",
  branch: "fix/design",
  projectFolder: "/repos/specweave",
  onRecreate: async () => ({ ok: true, message: "Folder restored. Send your message again." }),
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));

it("starts fresh on another thread with the same failure", async () => {
  act(() => root.render(<WorkspaceMissingRecovery recovery={recovery("thread-a")} />));
  const recreate = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.startsWith("Recreate folder"),
  )!;
  await act(async () => recreate.click());
  expect(container.textContent).toContain("Folder restored.");
  expect(container.textContent).not.toContain("Recreate folder");

  act(() => root.render(<WorkspaceMissingRecovery recovery={recovery("thread-b")} />));
  expect(container.textContent).not.toContain("Folder restored.");
  expect(container.textContent).toContain("Recreate folder from fix/design");
});
