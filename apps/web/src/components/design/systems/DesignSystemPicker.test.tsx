// @vitest-environment jsdom
import type { DesignSystemId, DesignSystemSummary } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PROJECTS, SYSTEMS } from "./fixtureData";
import { DesignSystemPickerView, type CopyOptions, type CopyOutcome } from "./DesignSystemPicker";
import { copyIn } from "./reviewModel";

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

  it("selects the owner's existing copy instead of copying again", async () => {
    const weave = SYSTEMS.find((system) => system.ref.systemId === "weave")!;
    const copy = {
      ...weave,
      ref: {
        ...weave.ref,
        owner: { kind: "project", environmentId: "host", projectId: "borealis-api" },
        systemId: "weave-copy",
      },
      ownerLabel: "Borealis API",
      copiedFrom: { owner: weave.ref.owner, id: "weave", revision: 3, copiedAt: "" },
    } as DesignSystemSummary;
    const onChange = vi.fn<(value: DesignSystemId | null) => void>();
    const onCopy = vi.fn(async (): Promise<CopyOutcome> => ({ ok: false, message: "unused" }));
    act(() =>
      root.render(
        <DesignSystemPickerView
          owner={{ kind: "project", projectId: "borealis-api" as never }}
          systems={[...SYSTEMS, copy]}
          projects={PROJECTS}
          value={null}
          onChange={onChange}
          onCopy={onCopy}
        />,
      ),
    );
    await openPicker();
    const offered = options().find((option) => option.textContent?.startsWith("WeaveAtlas"))!;
    expect(offered.textContent).toContain("Use the copy in Borealis API");
    await act(async () => offered.click());
    await flush();
    expect(onCopy).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith("weave-copy");
    expect(options().some((option) => option.textContent?.includes("fresh copy"))).toBe(false);
  });

  it("says a copy predates the source's latest change and offers a fresh one", async () => {
    const onChange = vi.fn<(value: DesignSystemId | null) => void>();
    const onCopy = vi.fn(
      async (_system: DesignSystemSummary, _options?: CopyOptions): Promise<CopyOutcome> => ({
        ok: true,
        systemId: "weave-3" as DesignSystemId,
        name: "Weave 2",
      }),
    );
    const render = () =>
      act(() =>
        root.render(
          <DesignSystemPickerView
            owner={{ kind: "project", projectId: "borealis-api" as never }}
            // Weave is at revision 3; Borealis copied revision 1.
            systems={[...SYSTEMS, weaveCopy("weave-copy", 1)]}
            projects={PROJECTS}
            value={null}
            onChange={onChange}
            onCopy={onCopy}
          />,
        ),
      );
    render();
    await openPicker();
    const stale = options().find((option) => option.textContent?.startsWith("WeaveAtlas"))!;
    expect(stale.textContent).toBe(
      "WeaveAtlas web · Use the copy in Borealis API, copied before the latest change",
    );
    await act(async () => stale.click());
    await flush();
    expect(onCopy).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith("weave-copy");

    await openPicker();
    const fresh = document.querySelector<HTMLElement>(
      '[data-testid="design-system-picker-fresh"]',
    )!;
    expect(fresh.textContent).toBe("WeaveAtlas web · Make a fresh copy in Borealis API");
    await act(async () => fresh.click());
    await flush();
    expect(onCopy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ ref: expect.objectContaining({ systemId: "weave" }) }),
      { fresh: true },
    );
    expect(onChange).toHaveBeenLastCalledWith("weave-3");
  });

  it("matches a copy's source by machine too, as the server does", async () => {
    const elsewhere = weaveCopy("weave-copy", 3, "other-mac");
    act(() =>
      root.render(
        <DesignSystemPickerView
          owner={{ kind: "project", projectId: "borealis-api" as never }}
          systems={[...SYSTEMS, elsewhere]}
          projects={PROJECTS}
          value={null}
          onChange={() => undefined}
          onCopy={async () => ({ ok: false, message: "unused" })}
        />,
      ),
    );
    await openPicker();
    // A copy of the same project on another machine is not this machine's source.
    expect(
      options().find((option) => option.textContent?.startsWith("WeaveAtlas"))!.textContent,
    ).toBe("WeaveAtlas web · Copy into Borealis API");
  });

  it("uses the newest copy when the owner holds several", () => {
    const weave = SYSTEMS.find((system) => system.ref.systemId === "weave")!;
    const older = weaveCopy("weave-copy", 1);
    const newer = weaveCopy("weave-copy-2", 3);
    expect(copyIn([older, newer], weave)?.ref.systemId).toBe("weave-copy-2");
    expect(copyIn([newer, older], weave)?.ref.systemId).toBe("weave-copy-2");
  });
});

/** Borealis API's copy of Atlas web's Weave, made from `revision` of it on `environmentId`. */
function weaveCopy(systemId: string, revision: number, environmentId = "host") {
  const weave = SYSTEMS.find((system) => system.ref.systemId === "weave")!;
  return {
    ...weave,
    name: "Weave",
    ref: {
      ...weave.ref,
      owner: { kind: "project", environmentId: "host", projectId: "borealis-api" },
      systemId,
    },
    ownerLabel: "Borealis API",
    copiedFrom: {
      owner: { ...weave.ref.owner, environmentId },
      id: "weave",
      revision,
      copiedAt: `2026-10-2${revision}T10:00:00.000Z`,
    },
  } as DesignSystemSummary;
}
