// @vitest-environment jsdom
/** "Start from scratch" in New design system (1046 AC-08). */
import type { DesignSystemCreateInput } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { FIGMA_OFF, PROJECTS, SCAN_RESULT } from "./fixtureData";
import { NewDesignSystemDialog, offeredModes } from "./NewDesignSystemDialog";

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
const $ = <T extends Element = HTMLElement>(selector: string) =>
  document.body.querySelector<T>(selector);

async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function render(
  onCreate?: (input: DesignSystemCreateInput) => Promise<string | null>,
  defaultProjectId?: string,
) {
  act(() =>
    root.render(
      <NewDesignSystemDialog
        mode="scratch"
        onModeChange={() => undefined}
        onOpenChange={() => undefined}
        projects={PROJECTS}
        {...(defaultProjectId === undefined ? {} : { defaultProjectId: defaultProjectId as never })}
        figma={{ status: FIGMA_OFF, error: null, checking: false, onCheck: () => undefined }}
        onScan={async () => ({ ok: true, result: SCAN_RESULT })}
        onPropose={async () => null}
        {...(onCreate === undefined ? {} : { onCreate })}
      />,
    ),
  );
}

describe("Start from scratch", () => {
  it("is offered only where the server can create systems", () => {
    expect(offeredModes(false).map((entry) => entry.mode)).not.toContain("scratch");
    expect(offeredModes(true)[0]).toEqual({ mode: "scratch", label: "Start from scratch" });
  });

  it("creates an empty system with Light and Dark modes in the chosen owner", async () => {
    const onCreate = vi.fn(async (_input: DesignSystemCreateInput) => null);
    render(onCreate, "borealis-api");
    await flush();
    expect($('[data-testid="new-design-system-dialog"]')!.textContent).toContain(
      "New design system: start from scratch",
    );
    await act(async () => $<HTMLButtonElement>('[data-testid="scratch-create"]')!.click());
    expect($('[role="alert"]')!.textContent).toBe("A design system needs a name.");
    expect(onCreate).not.toHaveBeenCalled();

    await type($<HTMLInputElement>('input[placeholder="e.g. Acme brand"]')!, "  Acme brand ");
    await type(
      $<HTMLTextAreaElement>('[data-testid="scratch-panel"] textarea')!,
      "For the web app",
    );
    await act(async () => $<HTMLButtonElement>('[data-testid="scratch-create"]')!.click());
    await flush();
    expect(onCreate).toHaveBeenCalledWith({
      owner: { kind: "project", projectId: "borealis-api" },
      name: "Acme brand",
      description: "For the web app",
      modes: [
        { id: "light", name: "Light" },
        { id: "dark", name: "Dark" },
      ],
    });
  });

  it("shows why it failed and keeps the form", async () => {
    const onCreate = vi.fn(async () => "There is no room on this disk.");
    render(onCreate);
    await type($<HTMLInputElement>('input[placeholder="e.g. Acme brand"]')!, "Acme");
    await act(async () => $<HTMLButtonElement>('[data-testid="scratch-create"]')!.click());
    await flush();
    expect($('[role="alert"]')!.textContent).toBe("There is no room on this disk.");
    expect($<HTMLInputElement>('input[placeholder="e.g. Acme brand"]')!.value).toBe("Acme");
  });

  it("says so when the server cannot create systems", async () => {
    render(undefined);
    await flush();
    expect($('[data-testid="scratch-panel"]')).toBeNull();
    expect($('[data-testid="new-design-system-dialog"]')!.textContent).toContain(
      "too old to start a design system from scratch",
    );
  });
});
