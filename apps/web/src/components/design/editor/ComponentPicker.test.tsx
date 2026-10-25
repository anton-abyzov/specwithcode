// @vitest-environment jsdom
import type { DesignSystem, DesignSystemComponent } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ComponentList, ComponentPicker, matchComponents } from "./ComponentPicker";

const provenance = { source: "agent", location: "app", extractor: "edit" } as const;
const component = (
  id: string,
  name: string,
  extra: Partial<DesignSystemComponent> = {},
): DesignSystemComponent => ({ id, name, framework: "html", provenance, ...extra });

const matchday = {
  schema: "swc.design-system/1",
  id: "s_matchday",
  name: "Matchday",
  revision: 1,
  createdAt: "2026-10-24T00:00:00.000Z",
  updatedAt: "2026-10-24T00:00:00.000Z",
  modes: [
    { id: "light", name: "Light" },
    { id: "dark", name: "Dark" },
  ],
  tokens: [
    {
      name: "brand",
      type: "color",
      values: {
        light: { raw: "#0a7d32", resolved: null, provenance },
        dark: { raw: "#34c46a", resolved: null, provenance },
      },
    },
  ],
  components: [
    component("html:Score-pill", "Score pill", {
      previewHtml: '<span style="background:var(--brand)">2-1</span>',
    }),
    component("html:Fixture-card", "Fixture card", { group: "Cards" }),
    component("html:Team-badge", "Team badge", { group: "Badges" }),
  ],
  sources: [],
  copiedFrom: null,
} as unknown as DesignSystem;

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

const options = () => [...container.querySelectorAll("[data-testid=component-option]")];

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("matchComponents", () => {
  it("matches the name or the group and counts what it leaves out", () => {
    const many = Array.from({ length: 70 }, (_, i) => component(`c${i}`, `Item ${i}`));
    expect(matchComponents(many, "")).toMatchObject({ more: 10 });
    expect(matchComponents(many, "").shown).toHaveLength(60);
    expect(matchComponents(matchday.components, "PILL").shown.map((c) => c.id)).toEqual([
      "html:Score-pill",
    ]);
    expect(matchComponents(matchday.components, "badges").shown.map((c) => c.id)).toEqual([
      "html:Team-badge",
    ]);
    expect(matchComponents(matchday.components, "zzz")).toEqual({ shown: [], more: 0 });
  });
});

describe("ComponentList", () => {
  it("lists the system's components, narrows by search and inserts the one clicked", () => {
    const onInsert = vi.fn();
    act(() => root.render(<ComponentList system={matchday} mode="light" onInsert={onInsert} />));
    expect(options()).toHaveLength(3);
    // The preview carries the tokens; a component without preview HTML says so.
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("--brand:#0a7d32");
    expect(container.textContent).toContain("No preview");

    const search = container.querySelector<HTMLInputElement>(
      "input[aria-label='Search components']",
    )!;
    type(search, "pill");
    expect(options()).toHaveLength(1);
    act(() => (options()[0] as HTMLButtonElement).click());
    expect(onInsert).toHaveBeenCalledWith(matchday.components[0]);

    type(search, "nothing");
    expect(options()).toHaveLength(0);
    expect(container.textContent).toContain("No components match “nothing”.");
  });

  it("previews in the design's mode", () => {
    act(() => root.render(<ComponentList system={matchday} mode="dark" onInsert={vi.fn()} />));
    expect(container.querySelector("iframe")!.getAttribute("srcdoc")).toContain("--brand:#34c46a");
  });

  it("explains a missing system and an empty one", () => {
    act(() => root.render(<ComponentList system={null} mode="light" onInsert={vi.fn()} />));
    expect(container.textContent).toBe(
      "Choose a design system in the header to insert its components.",
    );
    act(() =>
      root.render(
        <ComponentList system={{ ...matchday, components: [] }} mode="light" onInsert={vi.fn()} />,
      ),
    );
    expect(container.textContent).toBe(
      "Matchday has no components yet. Add them on its design system page.",
    );
  });
});

describe("ComponentPicker", () => {
  it("renders the toolbar button", () => {
    const html = renderToStaticMarkup(
      <ComponentPicker system={matchday} mode="light" onInsert={vi.fn()} />,
    );
    expect(html).toContain('aria-label="Insert component"');
    expect(html).toContain('data-testid="insert-component"');
  });

  it("opens the list, inserts, and closes", async () => {
    const onInsert = vi.fn();
    act(() => root.render(<ComponentPicker system={matchday} mode="light" onInsert={onInsert} />));
    const trigger = container.querySelector<HTMLButtonElement>("[data-testid=insert-component]")!;
    await act(async () => trigger.click());
    const listed = () => [...document.querySelectorAll("[data-testid=component-option]")];
    expect(listed()).toHaveLength(3);
    await act(async () => (listed()[1] as HTMLButtonElement).click());
    expect(onInsert).toHaveBeenCalledWith(matchday.components[1]);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
