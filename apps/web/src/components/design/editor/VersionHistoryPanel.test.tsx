// @vitest-environment jsdom
import type { DesignHistoryEntry, ThreadId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DesignVersions } from "./backend";
import { AUTOSAVES_SHOWN, VersionHistoryPanel, historyRows } from "./VersionHistoryPanel";

const user = { kind: "user" } as const;
const agent = { kind: "agent", threadId: "t_1" as ThreadId } as const;
const revision = (n: number, actor: DesignHistoryEntry["actor"] = user): DesignHistoryEntry => ({
  kind: "revision",
  revision: n,
  name: null,
  savedAt: `2026-10-24T12:${String(n).padStart(2, "0")}:00.000Z`,
  actor,
});
const version = (n: number, name: string): DesignHistoryEntry => ({
  kind: "version",
  revision: n,
  name,
  savedAt: `2026-10-24T12:${String(n).padStart(2, "0")}:30.000Z`,
  actor: user,
});

describe("historyRows", () => {
  it("lists named versions and autosaves newest first, once per revision", () => {
    const rows = historyRows(
      [revision(1), revision(2, agent), version(2, "Before review"), revision(3)],
      3,
    );
    expect(rows.map((row) => [row.title, row.revision])).toEqual([
      ["Autosave", 3],
      ["Before review", 2],
      ["Autosave", 1],
    ]);
    expect(rows[0]!.current).toBe(true);
    expect(rows[1]!.kind).toBe("version");
  });

  it("keeps every named version but only the recent autosaves", () => {
    const entries = [
      version(0, "First"),
      ...Array.from({ length: AUTOSAVES_SHOWN + 10 }, (_, i) => revision(i + 1)),
    ];
    const rows = historyRows(entries, AUTOSAVES_SHOWN + 10);
    expect(rows.filter((row) => row.kind === "revision")).toHaveLength(AUTOSAVES_SHOWN);
    expect(rows.at(-1)!.title).toBe("First");
  });
});

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
});

const byText = (text: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === text,
  );

async function mount(versions: DesignVersions, onRestore = vi.fn(async () => undefined)) {
  await act(async () => {
    root.render(
      <VersionHistoryPanel
        versions={versions}
        revision={3}
        readOnly={false}
        onRestore={onRestore}
        onClose={() => undefined}
      />,
    );
  });
  return onRestore;
}

describe("VersionHistoryPanel", () => {
  it("saves a named version", async () => {
    const saved = [revision(3), version(3, "Hand-off")];
    const versions: DesignVersions = {
      list: vi.fn(async () => [revision(3)]),
      save: vi.fn(async () => saved),
      restore: vi.fn(),
    };
    await mount(versions);
    expect(container.textContent).toContain("Version history");
    await act(async () => byText("Save version")?.click());
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Version name"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Hand-off");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector("form")!.requestSubmit();
    });
    expect(versions.save).toHaveBeenCalledExactlyOnceWith("Hand-off");
    expect(container.textContent).toContain("Hand-off");
  });

  it("asks before Restore replaces the current content", async () => {
    const versions: DesignVersions = {
      list: vi.fn(async () => [revision(3), version(1, "Approved")]),
      save: vi.fn(),
      restore: vi.fn(),
    };
    const onRestore = await mount(versions);
    const restoreButton = byText("Restore");
    expect(restoreButton).toBeDefined();
    await act(async () => restoreButton!.click());
    expect(onRestore).not.toHaveBeenCalled();
    const dialog = document.body.querySelector('[data-testid="design-restore-dialog"]');
    expect(dialog?.textContent).toContain("Restore “Approved”?");
    await act(async () =>
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="design-restore-confirm"]')!
        .click(),
    );
    expect(onRestore).toHaveBeenCalledExactlyOnceWith(1);
  });
});
