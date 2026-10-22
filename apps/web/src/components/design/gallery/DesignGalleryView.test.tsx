// @vitest-environment jsdom
import type { DesignDocument, DesignSummary } from "@specweave-studio/contracts";
import { newDesignDocument } from "@specweave-studio/shared/designOps";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DesignGalleryView, type DesignGalleryViewProps } from "./DesignGalleryView";
import { DesignThumbnail } from "./DesignThumbnail";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const NOW = Date.parse("2026-10-20T15:00:00Z");
const summary = (id: string, title: string, owner: unknown, ownerLabel: string, minutes: number) =>
  ({
    ref: { owner, designId: id, path: `.specweave/design/${id}/design.json` },
    kind: "design",
    title,
    revision: 1,
    updatedAt: new Date(NOW - minutes * 60_000).toISOString(),
    pageCount: 1,
    designSystem: null,
    ownerLabel,
  }) as DesignSummary;

const designs = [
  summary(
    "d1",
    "Pricing page",
    { kind: "project", environmentId: "h", projectId: "web" },
    "Web app",
    5,
  ),
  summary("d2", "Moodboard", { kind: "playground", environmentId: "h" }, "Playground", 1),
];

function render(overrides: Partial<DesignGalleryViewProps> = {}) {
  const props: DesignGalleryViewProps = {
    designs,
    error: null,
    problems: [],
    projects: [{ id: "web" as never, title: "Web app" }],
    now: NOW,
    canWrite: true,
    canOperate: true,
    renderThumbnail: () => <span data-testid="thumb" />,
    onCreate: vi.fn(),
    onOpen: vi.fn(),
    onCopy: vi.fn(async () => null),
    onDelete: vi.fn(async () => null),
    onCopyLink: vi.fn(),
    onRename: vi.fn(async () => null),
    onDuplicate: vi.fn(),
    ...overrides,
  };
  act(() => root.render(<DesignGalleryView {...props} />));
  return props;
}

const cards = () =>
  [...container.querySelectorAll('[data-testid="design-card"] h3')].map((node) =>
    node.textContent?.replace(/^Design: /, ""),
  );
const click = (element: Element | null) =>
  act(() => (element as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true })));

describe("DesignGalleryView", () => {
  it("shows cards with owner and edited time, newest first", () => {
    render();
    expect(cards()).toEqual(["Moodboard", "Pricing page"]);
    const owners = [...container.querySelectorAll('[data-testid="design-owner"]')].map(
      (node) => node.textContent,
    );
    expect(owners).toEqual(["Playground", "Web app"]);
    expect(container.querySelector('[data-testid="design-edited"]')?.textContent).toBe(
      "Edited 1 min ago",
    );
    expect(container.innerHTML).not.toMatch(/lucide-lock/);
  });

  it("filters by tab", () => {
    render();
    click(container.querySelector('[data-tab="playground"]'));
    expect(cards()).toEqual(["Moodboard"]);
    click(container.querySelector('[data-tab="projects"]'));
    expect(cards()).toEqual(["Pricing page"]);
  });

  it("follows a controlled filter and reports tab and project changes", () => {
    const onFilterChange = vi.fn();
    render({
      designs: [
        ...designs,
        summary(
          "d3",
          "API docs",
          { kind: "project", environmentId: "h", projectId: "api" },
          "API",
          9,
        ),
      ],
      projects: [
        { id: "web" as never, title: "Web app" },
        { id: "api" as never, title: "API" },
      ],
      filter: { tab: "projects", projectId: "web" as never },
      onFilterChange,
    });
    expect(cards()).toEqual(["Pricing page"]);
    expect(container.querySelector('[data-tab="projects"]')?.getAttribute("aria-selected")).toBe(
      "true",
    );
    click(container.querySelector('[data-tab="playground"]'));
    expect(onFilterChange).toHaveBeenCalledWith({ tab: "playground", projectId: null });
    // Controlled: the URL, not the click, changes what shows.
    expect(cards()).toEqual(["Pricing page"]);
  });

  it("offers only the kinds that work", () => {
    const props = render();
    const kinds = [...container.querySelectorAll('[data-testid="design-create"]')].map(
      (node) => (node as HTMLElement).dataset.kind,
    );
    expect(kinds).toEqual(["slides", "design", "design-from-code", "design-system"]);
    click(container.querySelector('[data-kind="slides"][data-testid="design-create"]'));
    expect(props.onCreate).toHaveBeenCalledWith("slides");
    click(container.querySelector('[data-kind="design-from-code"][data-testid="design-create"]'));
    expect(props.onCreate).toHaveBeenCalledWith("design-from-code");
    click(container.querySelector('[data-kind="design-system"][data-testid="design-create"]'));
    expect(props.onCreate).toHaveBeenCalledWith("design-system");
  });

  it("disables Design from code, and only it, without the operate scope", () => {
    const props = render({ canOperate: false });
    const tile = (kind: string) =>
      container.querySelector<HTMLButtonElement>(
        `[data-testid="design-create"][data-kind="${kind}"]`,
      );
    expect(tile("design-from-code")?.disabled).toBe(true);
    expect(tile("design-from-code")?.textContent).toContain("This window may not start threads");
    expect(tile("design")?.disabled).toBe(false);
    click(tile("design-from-code"));
    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it("opens a design from its card and switches to the list view", () => {
    const props = render();
    click(container.querySelector('[aria-label="Open Pricing page"]'));
    expect(props.onOpen).toHaveBeenCalledWith(designs[0]);
    click(container.querySelector('[aria-label="List view"]'));
    expect(container.querySelectorAll('[data-testid="design-row"]')).toHaveLength(2);
  });

  it("says what to do when there is nothing", () => {
    render({ designs: [] });
    expect(container.querySelector('[data-testid="design-empty"]')?.textContent).toMatch(
      /No designs yet/,
    );
  });
});

describe("DesignThumbnail", () => {
  it("renders the first frame in an opaque-origin iframe", () => {
    const size = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(320);
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(240);
    const document: DesignDocument = newDesignDocument({
      id: "d_card",
      kind: "design",
      title: "Card",
      createdBy: { kind: "user" },
      now: new Date(NOW).toISOString(),
    });
    act(() => root.render(<DesignThumbnail document={document} />));
    const slot = container.querySelector('[data-slot="design-thumbnail"]');
    expect(slot?.getAttribute("data-state")).toBe("ready");
    const frame = container.querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("");
    const srcdoc = frame?.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain("data-node=");
    // The policy sits first in <head>, before any style or image could load.
    expect(srcdoc).toContain(
      `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:">`,
    );
    expect(frame?.style.width).toBe("1440px");
    size.mockRestore();
    height.mockRestore();
  });
});
