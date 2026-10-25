// @vitest-environment jsdom
import type { DesignSystemId, DesignSystemSummary, ProjectId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/studio/design", () => ({ design: {} }));
vi.mock("~/studio/designSystemImport", () => ({ designSystemImport: {} }));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: () => null }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => async () => null }));
vi.mock("~/state/environments", () => ({ usePrimaryEnvironmentId: () => null }));

const {
  ProjectSystemsStrip,
  ProjectSystemsStripView,
  stripCounts,
  stripDistinctions,
  SwatchRow,
  systemFolder,
} = await import("./ProjectSystemsStrip");
const { NEW_SYSTEM_MODES } = await import("../systems/NewDesignSystemDialog");

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

async function press(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    element.click();
  });
  await flush();
}

const summary = (systemId: string, name: string, tokenCount: number, componentCount: number) =>
  ({
    ref: {
      owner: { kind: "project", environmentId: "host" as never, projectId: "harbor" as ProjectId },
      systemId: systemId as DesignSystemId,
      path: `.specweave/design/systems/${systemId}/system.json`,
    },
    name,
    revision: 3,
    updatedAt: "2026-10-22T10:00:00.000Z",
    tokenCount,
    componentCount,
    sources: [],
    ownerLabel: "Harbor",
  }) satisfies DesignSystemSummary;

const SYSTEMS = [summary("s_harbor", "Harbor UI", 84, 23), summary("s_dock", "Dock kit", 1, 1)];

const copyOf = (
  system: DesignSystemSummary,
  owner: NonNullable<DesignSystemSummary["copiedFrom"]>["owner"],
): DesignSystemSummary => ({
  ...system,
  copiedFrom: { owner, id: "ec-uikit", revision: 1, copiedAt: "2026-10-22T10:00:00.000Z" },
});
const FROM_PLAYGROUND = { kind: "playground", environmentId: "host" as never } as const;
const FROM_ATLAS = {
  kind: "project",
  environmentId: "host" as never,
  projectId: "atlas" as ProjectId,
} as const;
const ownerTitle = (owner: { readonly kind: string; readonly projectId?: string }) =>
  owner.kind === "playground" ? "Playground" : owner.projectId === "atlas" ? "Atlas" : undefined;

describe("ProjectSystemsStripView", () => {
  it("shows each system with swatches and counts, and opens it", () => {
    const onOpen = vi.fn<(system: DesignSystemSummary) => void>();
    act(() =>
      root.render(
        <ProjectSystemsStripView
          systems={SYSTEMS}
          canWrite
          onOpen={onOpen}
          onNew={() => undefined}
          renderSwatches={(system) => (
            <SwatchRow colors={system.name === "Harbor UI" ? ["#595ecc", "#0e7490"] : []} />
          )}
        />,
      ),
    );
    const cards = [...container.querySelectorAll<HTMLElement>('[data-testid="strip-system"]')];
    expect(cards.map((card) => card.textContent)).toEqual([
      "Harbor UI84 tokens · 23 components",
      "Dock kit1 token · 1 component",
    ]);
    expect(cards[0]!.querySelectorAll(".rounded-full")).toHaveLength(2);
    act(() => cards[1]!.click());
    expect(onOpen).toHaveBeenCalledWith(SYSTEMS[1]);
  });

  it("tells same-named systems apart by where a copy came from, else by folder", () => {
    const systems = [
      summary("ec-uikit", "ec-uikit", 84, 23),
      copyOf(summary("ec-uikit-2", "ec-uikit", 84, 23), FROM_PLAYGROUND),
      copyOf(summary("ec-uikit-3", "EC-UIKIT ", 84, 23), FROM_ATLAS),
      summary("s_dock", "Dock kit", 1, 1),
    ];
    act(() =>
      root.render(
        <ProjectSystemsStripView
          systems={systems}
          canWrite={false}
          onOpen={() => undefined}
          onNew={() => undefined}
          ownerTitle={ownerTitle}
        />,
      ),
    );
    const cards = [...container.querySelectorAll<HTMLElement>('[data-testid="strip-system"]')];
    expect(
      cards.map(
        (card) =>
          card.querySelector('[data-testid="strip-system-distinction"]')?.textContent ?? null,
      ),
    ).toEqual(["Folder ec-uikit", "Copied from Playground", "Copied from Atlas", null]);
    expect(
      cards[0]!.querySelector('[data-testid="strip-system-distinction"]')!.getAttribute("title"),
    ).toBe(".specweave/design/systems/ec-uikit/system.json");
  });

  it("names a system's folder, never the file every system shares", () => {
    const lines = stripDistinctions(
      [summary("ec-uikit", "ec-uikit", 1, 1), summary("ec-uikit-2", "ec-uikit", 1, 1)],
      ownerTitle,
    );
    expect([...lines.values()]).toEqual(["Folder ec-uikit", "Folder ec-uikit-2"]);
    expect([...lines.values()].some((line) => line.includes("system.json"))).toBe(false);
    const short = { ...summary("kit", "kit", 1, 1) };
    expect(systemFolder({ ...short, ref: { ...short.ref, path: "system.json" } })).toBe("kit");
  });

  it("falls back to the folder when two copies came from the same owner", () => {
    const lines = stripDistinctions(
      [
        copyOf(summary("ec-uikit-2", "ec-uikit", 1, 1), FROM_PLAYGROUND),
        copyOf(summary("ec-uikit-3", "ec-uikit", 1, 1), FROM_PLAYGROUND),
        copyOf(summary("kit", "kit", 1, 1), FROM_ATLAS),
        copyOf(summary("kit-2", "kit", 1, 1), { ...FROM_ATLAS, projectId: "gone" as ProjectId }),
      ],
      ownerTitle,
    );
    expect([...lines.values()]).toEqual([
      "Folder ec-uikit-2",
      "Folder ec-uikit-3",
      "Copied from Atlas",
      "Folder kit-2",
    ]);
  });

  it("says when the list is loading or the project has no system", () => {
    const view = (systems: readonly DesignSystemSummary[] | null) =>
      act(() =>
        root.render(
          <ProjectSystemsStripView
            systems={systems}
            canWrite={false}
            onOpen={() => undefined}
            onNew={() => undefined}
          />,
        ),
      );
    view(null);
    expect(container.textContent).toContain("Loading design systems…");
    view([]);
    expect(container.textContent).toContain("No design system yet.");
    expect(container.querySelector('[data-testid="strip-new-system"]')).toBeNull();
  });

  it("starts a new design system in any of the dialog's ways", async () => {
    const onNew = vi.fn();
    act(() =>
      root.render(
        <ProjectSystemsStripView
          systems={SYSTEMS}
          canWrite
          onOpen={() => undefined}
          onNew={onNew}
        />,
      ),
    );
    await press(container.querySelector<HTMLElement>('[data-testid="strip-new-system"]')!);
    const items = [...document.querySelectorAll<HTMLElement>("[data-mode]")];
    expect(items.map((item) => item.textContent)).toEqual(
      NEW_SYSTEM_MODES.map((entry) => entry.label),
    );
    await press(items[0]!);
    expect(onNew).toHaveBeenCalledWith(NEW_SYSTEM_MODES[0]!.mode);
  });
});

describe("ProjectSystemsStrip", () => {
  it("shows nothing until this machine is connected", () => {
    act(() => root.render(<ProjectSystemsStrip projectId={"harbor" as ProjectId} canWrite />));
    expect(container.innerHTML).toBe("");
  });

  it("counts with singular and plural", () => {
    expect(stripCounts({ tokenCount: 0, componentCount: 2 })).toBe("0 tokens · 2 components");
  });

  it("caps the swatches at six", () => {
    act(() => root.render(<SwatchRow colors={Array.from({ length: 9 }, () => "#000000")} />));
    expect(container.querySelectorAll(".rounded-full")).toHaveLength(6);
  });
});
