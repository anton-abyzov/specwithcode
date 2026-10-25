// @vitest-environment jsdom
import type { ProjectId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ConnectToProjectDialog, type ConnectToProjectDialogProps } from "./ConnectToProjectDialog";
import type { GalleryProject } from "./DesignActions";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

const PROJECTS: GalleryProject[] = [
  { id: "atlas-web" as ProjectId, title: "Atlas web" },
  { id: "borealis-api" as ProjectId, title: "Borealis API" },
];

function renderDialog(props: Partial<ConnectToProjectDialogProps> = {}) {
  const onMove = vi.fn<ConnectToProjectDialogProps["onMove"]>(async () => null);
  const onClose = vi.fn();
  act(() =>
    root.render(
      <ConnectToProjectDialog
        title="Pricing page"
        projects={PROJECTS}
        initialProjectId={"borealis-api" as ProjectId}
        thread={{ title: "Design: Pricing page" }}
        hasDesignSystem={false}
        onMove={onMove}
        onClose={onClose}
        {...props}
      />,
    ),
  );
  return { onMove: props.onMove ?? onMove, onClose };
}

const dialog = () => document.querySelector<HTMLElement>("[data-testid=connect-design-dialog]")!;
const moveButton = () =>
  document.querySelector<HTMLButtonElement>("[data-testid=connect-design-move]")!;
const threadBox = () => document.querySelector<HTMLElement>("[data-testid=connect-design-thread]");
const press = (button: HTMLElement) => act(async () => button.click());

describe("ConnectToProjectDialog", () => {
  it("says where the files go and that links keep working", async () => {
    renderDialog({ hasDesignSystem: true });
    await flush();
    const text = dialog().textContent ?? "";
    expect(text).toContain("“Pricing page” moves out of your Playground");
    expect(text).toContain(".specweave/design folder, so the design travels with the repository");
    expect(text).toContain("Existing links keep working.");
    expect(text).toContain("Its design system is copied in too");
    expect(document.querySelector("[data-testid=connect-design-project]")?.textContent).toContain(
      "Borealis API",
    );
  });

  it("moves into the chosen project with its thread, which is checked by default", async () => {
    const { onMove, onClose } = renderDialog();
    await flush();
    expect(threadBox()?.getAttribute("aria-checked")).toBe("true");
    await press(moveButton());
    await flush();
    expect(onMove).toHaveBeenCalledWith("borealis-api", true);
    // The caller closes the dialog once the design moved.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("leaves the thread when the box is cleared, and offers no box without a movable thread", async () => {
    const { onMove } = renderDialog();
    await flush();
    await press(threadBox()!);
    expect(threadBox()?.getAttribute("aria-checked")).toBe("false");
    await press(moveButton());
    await flush();
    expect(onMove).toHaveBeenCalledWith("borealis-api", false);

    act(() => root.unmount());
    root = createRoot(container);
    renderDialog({ thread: null });
    await flush();
    expect(threadBox()).toBeNull();
    expect(dialog().textContent).not.toContain("Also move its thread");
  });

  it("shows Moving… while it works, then a plain error with Retry", async () => {
    let settle: (problem: string | null) => void = () => undefined;
    const onMove = vi.fn(
      () => new Promise<string | null>((resolve) => (settle = resolve)),
    ) as ConnectToProjectDialogProps["onMove"];
    renderDialog({ onMove });
    await flush();
    await press(moveButton());
    expect(moveButton().textContent).toBe("Moving…");
    expect(moveButton().disabled).toBe(true);
    await act(async () => settle("The project folder is read-only."));
    await flush();
    expect(dialog().querySelector("[role=alert]")?.textContent).toBe(
      "The project folder is read-only.",
    );
    expect(moveButton().textContent).toBe("Retry");
    await press(moveButton());
    expect(onMove).toHaveBeenCalledTimes(2);
  });

  it("waits for a choice when no project is preselected, and says when none can take it", async () => {
    renderDialog({ initialProjectId: null });
    await flush();
    expect(moveButton().disabled).toBe(true);
    expect(document.querySelector("[data-testid=connect-design-project]")?.textContent).toContain(
      "Choose a project",
    );

    act(() => root.unmount());
    root = createRoot(container);
    renderDialog({ projects: [] });
    await flush();
    expect(document.querySelector("[data-testid=connect-design-empty]")).not.toBeNull();
    expect(moveButton().disabled).toBe(true);
  });
});
