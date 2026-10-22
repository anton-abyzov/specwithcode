// @vitest-environment jsdom
import type { DesignSystemId, DesignSystemSummary } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PROJECTS, SYSTEMS } from "./fixtureData";
import { DesignSystemPickerView, type CopyOutcome } from "./DesignSystemPicker";

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

async function openPicker() {
  const trigger = container.querySelector<HTMLElement>('[data-slot="select-trigger"]')!;
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    trigger.click();
  });
  await flush();
}

const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];

describe("DesignSystemPickerView", () => {
  it("lists the owner's systems and offers other owners' systems as copies", async () => {
    act(() =>
      root.render(
        <DesignSystemPickerView
          owner={{ kind: "playground" }}
          systems={SYSTEMS}
          projects={PROJECTS}
          value={null}
          onChange={() => undefined}
          onCopy={async () => ({ ok: false, message: "unused" })}
        />,
      ),
    );
    await openPicker();
    const labels = options().map((option) => option.textContent);
    expect(labels).toEqual([
      "None",
      "Moodboard palette",
      "Figma kit",
      "WeaveAtlas web · Copy into Playground",
      "App themeAtlas web · Copy into Playground",
      "BrandBorealis API · Copy into Playground",
    ]);
    expect(document.body.textContent).toContain("Other projects");
  });

  it("copies another project's system into the owner, then selects the copy", async () => {
    const onChange = vi.fn<(value: DesignSystemId | null) => void>();
    const onCopy = vi.fn(async (_system: DesignSystemSummary): Promise<CopyOutcome> => ({
      ok: true,
      systemId: "weave-2" as DesignSystemId,
      name: "Weave",
    }));
    act(() =>
      root.render(
        <DesignSystemPickerView
          owner={{ kind: "project", projectId: "borealis-api" as never }}
          systems={SYSTEMS}
          projects={PROJECTS}
          value={null}
          onChange={onChange}
          onCopy={onCopy}
        />,
      ),
    );
    await openPicker();
    const weave = options().find((option) => option.textContent?.startsWith("Weave"))!;
    expect(weave.textContent).toContain("Copy into Borealis API");
    await act(async () => weave.click());
    await flush();
    expect(onCopy).toHaveBeenCalledOnce();
    expect(onCopy.mock.calls[0]![0].ref.systemId).toBe("weave");
    expect(onChange).toHaveBeenCalledWith("weave-2");
  });

  it("shows why a copy failed and keeps the selection", async () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <DesignSystemPickerView
          owner={{ kind: "playground" }}
          systems={SYSTEMS}
          projects={PROJECTS}
          value={null}
          onChange={onChange}
          onCopy={async () => ({ ok: false, message: "The design system was not copied." })}
        />,
      ),
    );
    await openPicker();
    await act(async () =>
      options()
        .find((o) => o.textContent?.startsWith("Brand"))!
        .click(),
    );
    await flush();
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "The design system was not copied.",
    );
  });
});
