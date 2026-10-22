// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DesignSystemsSettingsView, figmaDesktopLabel } from "./DesignSystemsSettingsView";
import { FIGMA_CONNECTED, FIGMA_OFF, PROJECTS } from "./fixtureData";
import type { FigmaStatusView } from "./NewDesignSystemDialog";

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

const view = (status: FigmaStatusView["status"], error: string | null = null): FigmaStatusView => ({
  status,
  error,
  checking: false,
  onCheck: vi.fn(),
});

describe("Figma desktop status in Settings (AC-09)", () => {
  it("names each state plainly", () => {
    expect(figmaDesktopLabel(view(FIGMA_CONNECTED))).toBe("Figma desktop: connected, 1 tool");
    expect(figmaDesktopLabel(view(FIGMA_OFF))).toBe("Figma desktop: off");
    expect(figmaDesktopLabel(view(null))).toBe("Figma desktop: checking…");
    expect(figmaDesktopLabel(view(null, "No connection"))).toBe("Figma desktop: could not check");
  });

  it("shows the row with a check-again button", async () => {
    const figma = view(FIGMA_CONNECTED);
    act(() =>
      root.render(
        <DesignSystemsSettingsView
          systems={[]}
          systemsError={null}
          problems={[]}
          proposals={[]}
          projects={PROJECTS}
          now={0}
          canWrite
          rescans={{}}
          threadTitleFor={() => null}
          onRescan={() => undefined}
          onOpenProposal={() => undefined}
          onNew={() => undefined}
          figma={figma}
        />,
      ),
    );
    const row = container.querySelector<HTMLElement>('[data-testid="figma-desktop"]')!;
    expect(row.textContent).toContain("Figma desktop: connected");
    const check = [...row.querySelectorAll("button")].find((b) => b.textContent === "Check again")!;
    await act(async () => check.click());
    expect(figma.onCheck).toHaveBeenCalledOnce();
  });
});
