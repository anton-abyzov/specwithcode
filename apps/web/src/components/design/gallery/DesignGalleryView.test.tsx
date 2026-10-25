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
    localStorage.setItem("design.gallery.grouping", JSON.stringify("recent"));
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

  it("scopes by owner chip and filters from a card's owner badge", () => {
    render();
    const chips = [...container.querySelectorAll('[data-testid="design-scope"]')].map((node) =>
      node.textContent?.trim(),
    );
    expect(chips).toEqual(["All2", "Playground1", "Web app1"]);
    click(container.querySelector('[data-scope="playground"]'));
    expect(cards()).toEqual(["Moodboard"]);
    click(container.querySelector('[data-scope="all"]'));
    // Two owners: one section each, and the sections drop the owner badge.
    expect(
      [...container.querySelectorAll('[data-testid="design-section"]')].map(
        (node) => (node as HTMLElement).dataset.owner,
      ),
    ).toEqual(["web", "playground"]);
    expect(container.querySelector('[data-testid="design-owner"]')).toBeNull();
    click(container.querySelector('[data-testid="design-grouping"]'));
  });

  it("lists by recency with owner badges when Recent is chosen", () => {
    localStorage.setItem("design.gallery.grouping", JSON.stringify("recent"));
    const onScopeChange = vi.fn();
    render({ onScopeChange });
    expect(cards()).toEqual(["Moodboard", "Pricing page"]);
    const badge = [...container.querySelectorAll('[data-testid="design-owner"]')][1]!;
    expect(badge.textContent).toBe("Web app");
    click(badge);
    expect(onScopeChange).toHaveBeenCalledWith({ kind: "project", projectId: "web" });
    expect(cards()).toEqual(["Pricing page"]);
  });

  it("follows a controlled scope, names it in search and in the creation entry", () => {
    const onScopeChange = vi.fn();
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
      scope: { kind: "project", projectId: "web" as never },
      onScopeChange,
    });
    expect(cards()).toEqual(["Pricing page"]);
    expect(container.querySelector('[data-scope="web"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(container.querySelector("input[type='search']")?.getAttribute("placeholder")).toBe(
      "Search Web app designs",
    );
    expect(
      container.querySelector('[data-testid="design-create"][data-kind="design"]')?.textContent,
    ).toBe("New design in Web app");
    click(container.querySelector('[data-scope="playground"]'));
    expect(onScopeChange).toHaveBeenCalledWith({ kind: "playground" });
    // Controlled: the URL, not the click, changes what shows.
    expect(cards()).toEqual(["Pricing page"]);
  });

  it("folds the creation tiles into one row once the scope has designs", () => {
    render();
    expect(container.querySelector("#design-make-new")).toBeNull();
    render({ designs: [] });
    expect(container.querySelector("#design-make-new")).not.toBeNull();
  });

  it("offers only the kinds that work", () => {
    const props = render();
    const kinds = [...container.querySelectorAll('[data-testid="design-create"]')].map(
      (node) => (node as HTMLElement).dataset.kind,
    );
    // With designs in scope the row is compact and leads with the plain design.
    expect(kinds).toEqual(["design", "slides", "design-from-code", "design-system"]);
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

  it("shows a project board only its own problems, with the missing folder and a way to it", () => {
    const onOpenProjectPage = vi.fn();
    const problems = [
      { ownerLabel: "Gone app", detail: "The folder /Users/me/gone is missing." },
      { ownerLabel: "Web app", detail: "d9: The file is not valid JSON." },
    ];
    const projects = [
      { id: "web" as never, title: "Web app", projectKey: "key-web" },
      {
        id: "gone" as never,
        title: "Gone app",
        projectKey: "key-gone",
        unavailable: "Folder missing",
        missingFolder: "/Users/me/gone",
      },
    ];
    render({ problems, projects, scope: { kind: "project", projectId: "web" as never } });
    const rows = () =>
      [...container.querySelectorAll('[data-testid="design-problem"]')].map((n) => n.textContent);
    expect(rows()).toEqual(["Web app: d9: The file is not valid JSON."]);

    render({ problems, projects, onOpenProjectPage });
    expect(rows()).toEqual([
      "Gone app: its folder /Users/me/gone is missing. Open Gone app",
      "Web app: d9: The file is not valid JSON.",
    ]);
    click(container.querySelector('[data-testid="design-problem"] button'));
    expect(onOpenProjectPage).toHaveBeenCalledWith("key-gone");
  });

  it("turns creation off on an archived or folder-less board and says why", () => {
    const onOpenProjectPage = vi.fn();
    render({
      projects: [
        {
          id: "old" as never,
          title: "Old site",
          projectKey: "key-old",
          unavailable: "Archived project, not available here",
        },
      ],
      scope: { kind: "project", projectId: "old" as never },
      onOpenProjectPage,
    });
    const buttons = [...container.querySelectorAll('[data-testid="design-create"]')];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(container.querySelector('[data-testid="design-creation-off"]')?.textContent).toContain(
      "Old site is archived, so new designs are off.",
    );
    expect(container.querySelector('[data-testid="design-scope-note"]')?.textContent).toBe(
      "Archived project",
    );

    render({
      problems: [{ ownerLabel: "Gone app", detail: "The folder /Users/me/gone is missing." }],
      projects: [
        {
          id: "gone" as never,
          title: "Gone app",
          projectKey: "key-gone",
          unavailable: "Folder missing",
          missingFolder: "/Users/me/gone",
        },
      ],
      scope: { kind: "project", projectId: "gone" as never },
      onOpenProjectPage,
    });
    expect(container.querySelector('[data-testid="design-creation-off"]')?.textContent).toBe(
      "Gone app: its folder /Users/me/gone is missing. New designs are off until it is back. Open Gone app",
    );
    // Said once: the board's own problem row is the line above.
    expect(container.querySelector('[data-testid="design-problem"]')).toBeNull();
  });

  it("offers a way back to the project and describes the scoped design tile", () => {
    const onOpenProjectPage = vi.fn();
    render({
      designs: [],
      projects: [{ id: "web" as never, title: "Web app", projectKey: "key-web" }],
      scope: { kind: "project", projectId: "web" as never },
      onOpenProjectPage,
    });
    click(container.querySelector('[data-testid="design-open-project"]'));
    expect(onOpenProjectPage).toHaveBeenCalledWith("key-web");
    expect(
      container.querySelector('[data-testid="design-create"][data-kind="design"]')?.textContent,
    ).toContain("A blank canvas saved in Web app");
  });

  it("says a finished move in the page, with its action and Dismiss", () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    render({
      notice: {
        title: "Moved to Web app",
        description: "Its files are now in the project's .specweave/design folder.",
        actionLabel: "Open",
        onAction,
        onDismiss,
      },
    });
    const notice = container.querySelector('[data-testid="design-notice"]');
    expect(notice?.textContent).toContain("Moved to Web app");
    const [open, dismiss] = [...notice!.querySelectorAll("button")];
    click(open!);
    click(dismiss!);
    expect(onAction).toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalled();
  });
});
