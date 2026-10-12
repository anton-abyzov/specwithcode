// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
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
function Harness() {
  const dialog = useProjectDeletionConfirmation();
  useEffect(() => {
    request = dialog.confirmDeletion;
  }, [dialog.confirmDeletion]);
  return dialog.deletionDialog;
}
beforeEach(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
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
    const input = container.querySelector("input")!;
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
});
