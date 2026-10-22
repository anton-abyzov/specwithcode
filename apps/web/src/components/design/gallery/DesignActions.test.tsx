// @vitest-environment jsdom
import type { DesignSummary } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Menu, MenuPopup } from "../../ui/menu";
import {
  DESIGN_MENU_LABELS,
  designMenuEntries,
  DesignMenuItems,
  RenameDesignDialog,
  type DesignMenuEntry,
  type DesignMenuHandlers,
} from "./DesignActions";

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

const summary = (owner: unknown, title = "Pricing page") =>
  ({
    ref: { owner, designId: "d_pricing", path: ".specweave/design/d_pricing/design.json" },
    kind: "design",
    title,
    revision: 3,
    updatedAt: "2026-10-20T15:00:00.000Z",
    pageCount: 1,
    designSystem: null,
    ownerLabel: "Atlas web",
  }) as DesignSummary;

const project = { kind: "project", environmentId: "host", projectId: "atlas-web" };
const playground = { kind: "playground", environmentId: "host" };
const PROJECTS = [
  { id: "atlas-web", title: "Atlas web", projectKey: "logical-project:atlas" },
  { id: "borealis-api", title: "Borealis API", projectKey: "logical-project:borealis" },
] as never as { id: never; title: string; projectKey: string }[];

const labels = (entries: DesignMenuEntry[]) =>
  entries.map((entry) => (entry.kind === "separator" ? "---" : DESIGN_MENU_LABELS[entry.action]));
const disabled = (entries: DesignMenuEntry[]) =>
  entries.flatMap((entry) =>
    entry.kind === "action" && entry.disabled ? [DESIGN_MENU_LABELS[entry.action]] : [],
  );

describe("designMenuEntries", () => {
  it("lists every action for a project design in the gallery", () => {
    const entries = designMenuEntries({
      surface: "gallery",
      ownerKind: "project",
      canWrite: true,
      copyTargets: 1,
      canOpenProject: true,
    });
    expect(labels(entries)).toEqual([
      "Open",
      "Rename…",
      "Duplicate",
      "Copy link",
      "Open project",
      "---",
      "Copy to project…",
      "Copy to Playground",
      "---",
      "Delete…",
    ]);
    expect(disabled(entries)).toEqual([]);
  });

  it("hides Open project and Copy to Playground for a Playground design", () => {
    const entries = designMenuEntries({
      surface: "gallery",
      ownerKind: "playground",
      canWrite: true,
      copyTargets: 2,
      canOpenProject: true,
    });
    expect(labels(entries)).not.toContain("Open project");
    expect(labels(entries)).not.toContain("Copy to Playground");
  });

  it("drops Open in the editor and Open project without a workspace", () => {
    const entries = designMenuEntries({
      surface: "editor",
      ownerKind: "project",
      canWrite: true,
      copyTargets: 1,
      canOpenProject: false,
    });
    expect(labels(entries).slice(0, 3)).toEqual(["Rename…", "Duplicate", "Copy link"]);
    expect(labels(entries)).not.toContain("Open project");
  });

  it("disables every write without canWrite", () => {
    const entries = designMenuEntries({
      surface: "gallery",
      ownerKind: "project",
      canWrite: false,
      copyTargets: 1,
      canOpenProject: true,
    });
    expect(disabled(entries)).toEqual([
      "Rename…",
      "Duplicate",
      "Copy to project…",
      "Copy to Playground",
      "Delete…",
    ]);
  });

  it("disables Copy to project… when there is no other project", () => {
    const entries = designMenuEntries({
      surface: "gallery",
      ownerKind: "project",
      canWrite: true,
      copyTargets: 0,
      canOpenProject: true,
    });
    expect(disabled(entries)).toEqual(["Copy to project…"]);
  });
});

function handlers() {
  return {
    onOpen: vi.fn(),
    onRename: vi.fn(async () => null),
    onDuplicate: vi.fn(),
    onCopy: vi.fn(async () => null),
    onDelete: vi.fn(async () => null),
    onCopyLink: vi.fn(),
    onOpenProject: vi.fn(),
  };
}

describe("DesignMenuItems", () => {
  const renderMenu = (owner: unknown, actions: DesignMenuHandlers) => {
    const rename = vi.fn();
    act(() =>
      root.render(
        <Menu open>
          <MenuPopup>
            <DesignMenuItems
              summary={summary(owner)}
              projects={PROJECTS}
              canWrite
              handlers={actions}
              onRequestRename={rename}
              onRequestDelete={vi.fn()}
            />
          </MenuPopup>
        </Menu>,
      ),
    );
    const item = (action: string) =>
      document.querySelector<HTMLElement>(`[data-slot="menu-item"][data-action="${action}"]`);
    return { item, rename };
  };

  it("runs Duplicate, Open project and Rename… for a project design", async () => {
    const actions = handlers();
    const { item, rename } = renderMenu(project, actions);
    await flush();
    act(() => item("duplicate")!.click());
    expect(actions.onDuplicate).toHaveBeenCalledWith(summary(project));
    act(() => item("open-project")!.click());
    expect(actions.onOpenProject).toHaveBeenCalledWith(summary(project), "logical-project:atlas");
    act(() => item("rename")!.click());
    expect(rename).toHaveBeenCalled();
  });

  it("shows no Open project for a Playground design", async () => {
    const { item } = renderMenu(playground, handlers());
    await flush();
    expect(item("duplicate")).not.toBeNull();
    expect(item("open-project")).toBeNull();
    expect(item("copy-to-playground")).toBeNull();
  });
});

describe("RenameDesignDialog", () => {
  const renderDialog = (onRename: (s: DesignSummary, title: string) => Promise<string | null>) => {
    const onClose = vi.fn();
    act(() =>
      root.render(
        <RenameDesignDialog summary={summary(project)} onRename={onRename} onClose={onClose} />,
      ),
    );
    return onClose;
  };
  const field = () =>
    document.querySelector<HTMLInputElement>("[data-testid=rename-design-dialog] input")!;
  const type = (value: string) =>
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(field(), value);
      field().dispatchEvent(new Event("input", { bubbles: true }));
    });
  const submit = () =>
    act(async () => {
      field().form!.requestSubmit();
    });

  it("saves the typed title and closes", async () => {
    const onRename = vi.fn(async () => null);
    const onClose = renderDialog(onRename);
    await flush();
    expect(field().value).toBe("Pricing page");
    expect(field().maxLength).toBe(180);
    type("Pricing v2");
    await submit();
    await flush();
    expect(onRename).toHaveBeenCalledWith(summary(project), "Pricing v2");
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the dialog open with the server's message on a conflict", async () => {
    const onRename = vi.fn(async () => "The design changed since revision 3.");
    const onClose = renderDialog(onRename);
    await flush();
    type("Pricing v2");
    await submit();
    await flush();
    expect(
      document.querySelector("[data-testid=rename-design-dialog] [role=alert]")?.textContent,
    ).toBe("The design changed since revision 3.");
    expect(onClose).not.toHaveBeenCalled();
  });
});
