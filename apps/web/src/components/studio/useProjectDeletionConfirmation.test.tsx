// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
const state = vi.hoisted(() => ({
  worktreesRead: vi.fn(),
  worktreesRemove: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("../../state/projects", () => ({
  projectEnvironment: { worktreesRead: "worktreesRead", worktreesRemove: "worktreesRemove" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "worktreesRead" | "worktreesRemove") => state[command],
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ children, open }: React.PropsWithChildren<{ open: boolean }>) =>
    open ? children : null,
  DialogPopup: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogPanel: ({ children }: React.PropsWithChildren) => <section>{children}</section>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <footer>{children}</footer>,
}));
vi.mock("../ui/button", () => ({
  Button: ({
    variant: _variant,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => <button {...props} />,
}));
vi.mock("../ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));
import { useProjectDeletionConfirmation } from "./useProjectDeletionConfirmation";
let root: Root, container: HTMLDivElement;
let request: ReturnType<typeof useProjectDeletionConfirmation>["confirmDeletion"];
let removeConfirmed: ReturnType<typeof useProjectDeletionConfirmation>["removeConfirmedWorktrees"];
function Harness() {
  const dialog = useProjectDeletionConfirmation();
  useEffect(() => {
    request = dialog.confirmDeletion;
    removeConfirmed = dialog.removeConfirmedWorktrees;
  }, [dialog.confirmDeletion, dialog.removeConfirmedWorktrees]);
  return dialog.deletionDialog;
}
beforeEach(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  for (const fn of Object.values(state)) fn.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
function button(text: string) {
  return [...container.querySelectorAll("button")].find((b) => b.textContent === text)!;
}
async function type(value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Confirm project deletion"]',
    )!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
describe("Shared destructive project confirmation", () => {
  it("requires exact typed text and returns that receipt", async () => {
    let result!: Promise<string | null>;
    await act(async () => {
      result = request({ title: "Atlas", workspaceRoot: "/work/atlas", environmentLabel: "Local" });
    });
    expect(button("Delete project and threads").disabled).toBe(true);
    await type("atlas");
    expect(button("Delete project and threads").disabled).toBe(true);
    await type(" Atlas");
    expect(button("Delete project and threads").disabled).toBe(true);
    await type("Atlas");
    expect(button("Delete project and threads").disabled).toBe(false);
    await act(async () => button("Delete project and threads").click());
    await expect(result).resolves.toBe("Atlas");
  });
  it("cancels without a receipt and refuses to replace an outstanding request", async () => {
    let result!: Promise<string | null>;
    await act(async () => {
      result = request({ title: "Atlas", workspaceRoot: "/work/atlas" });
    });
    await expect(request({ title: "Other", workspaceRoot: "/other" })).resolves.toBeNull();
    await act(async () => button("Cancel").click());
    await expect(result).resolves.toBeNull();
  });
  it("cancels a pending deletion when its UI unmounts", async () => {
    let result!: Promise<string | null>;
    await act(async () => {
      result = request({ title: "Atlas", workspaceRoot: "/work/atlas" });
    });
    await act(async () => root.render(null));
    await expect(result).resolves.toBeNull();
  });
  it("removes the worktrees ticked in the dialog, with uncommitted files only when ticked", async () => {
    const target = {
      title: "Atlas",
      workspaceRoot: "/work/atlas",
      id: "atlas" as ProjectId,
      environmentId: "local" as EnvironmentId,
    };
    const worktree = (path: string, status: string) => ({
      path,
      branch: "b",
      threadCount: 1,
      sizeBytes: 2_000_000_000,
      localCommits: status === "removable" ? 3 : 0,
      status,
      detail: null,
    });
    state.worktreesRead.mockResolvedValue({
      _tag: "Success",
      value: {
        projectId: "atlas",
        worktrees: [worktree("/wt/clean", "removable"), worktree("/wt/dirty", "local_changes")],
      },
    });
    state.worktreesRemove.mockResolvedValue({
      _tag: "Success",
      value: {
        projectId: "atlas",
        removed: ["/wt/clean"],
        kept: [{ path: "/wt/dirty", reason: "A terminal uses this worktree." }],
      },
    });
    let result!: Promise<string | null>;
    await act(async () => {
      result = request(target);
    });
    expect(state.worktreesRead).toHaveBeenCalledWith({
      environmentId: "local",
      input: { projectId: "atlas" },
    });
    expect(container.textContent).toContain(
      "1 worktree has commits that exist only on this machine; they stay on the branch.",
    );
    await act(async () =>
      (
        container.querySelector(
          '[aria-label="Also delete worktrees with uncommitted files"]',
        ) as HTMLElement
      ).click(),
    );
    await type("Atlas");
    await act(async () => button("Delete project and threads").click());
    await expect(result).resolves.toBe("Atlas");
    expect(state.worktreesRemove).not.toHaveBeenCalled();
    await act(async () => removeConfirmed(target));
    expect(state.worktreesRemove).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: {
        projectId: "atlas",
        paths: ["/wt/clean", "/wt/dirty"],
        discardLocalChanges: ["/wt/dirty"],
      },
    });
    expect(state.toast).toHaveBeenCalledWith({
      type: "warning",
      title: "Removed 1 worktree, freed 2.0 GB",
      description: "Kept 1 worktree: /wt/dirty (A terminal uses this worktree.)",
    });
    // A receipt is used once.
    await act(async () => removeConfirmed(target));
    expect(state.worktreesRemove).toHaveBeenCalledOnce();
  });
});
