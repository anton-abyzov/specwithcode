// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ColorTable } from "./ColorTable";
import { NameValueTable } from "./NameValueTable";
import { ShadowTable } from "./ShadowTable";
import type { SystemEditIntent } from "./systemEditIntents";
import { TEST_SYSTEM, testToken } from "./testSystem";
import { SystemUsageContext, UsageNotes } from "./tokenRows";
import { TypographyTable } from "./TypographyTable";

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
const render = (element: ReactElement) => act(() => root.render(element));
const $ = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T & Element>(selector);
const byLabel = <T extends HTMLElement = HTMLElement>(label: string) =>
  document.querySelector<T>(`[aria-label="${label}"]`);

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const press = (element: Element, key: string) =>
  act(() => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });

async function open(trigger: HTMLElement) {
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    trigger.click();
  });
  await flush();
}

function editor(canEdit = true) {
  const onEdit = vi.fn(async (_intent: SystemEditIntent) => true);
  const onGoTo = vi.fn<(name: string) => void>();
  return { system: TEST_SYSTEM, canEdit, onEdit, onGoTo };
}

const tokensOf = (group: string) => TEST_SYSTEM.tokens.filter((token) => token.group === group);
const colorTokens = TEST_SYSTEM.tokens.filter((token) => token.type === "color");
const row = (name: string) => $(`[data-token-row="${name}"]`)!;

describe("ColorTable", () => {
  it("shows a swatch, hex and alpha per mode, and marks inherited values", () => {
    render(<ColorTable {...editor(false)} tokens={colorTokens} onAdd={() => undefined} />);
    expect(document.querySelectorAll('[data-testid="token-row"]')).toHaveLength(9);
    const scrim = row("color-scrim");
    expect(scrim.querySelector('[data-mode="light"]')!.textContent).toBe("#0F141E52%");
    const inherited = scrim.querySelector<HTMLElement>('[data-mode="dark"]')!;
    expect(inherited.dataset.inherited).toBe("true");
    expect(inherited.title).toBe("Inherits Light");
    expect(inherited.textContent).toBe("Inherits Light");
    expect(row("color-brand").querySelector('[data-mode="dark"]')!.textContent).toBe("#7D84FF");
    // Read-only: no edit triggers and no Remove.
    expect(byLabel("Edit color-brand, Light")).toBeNull();
    expect(byLabel("Remove color-brand")).toBeNull();
  });

  it("shows a text color's contrast on the page ground in each mode", () => {
    render(<ColorTable {...editor(false)} tokens={colorTokens} onAdd={() => undefined} />);
    for (const mode of ["light", "dark"]) {
      const badge = row("color-ink").querySelector<HTMLElement>(
        `[data-mode="${mode}"] [data-testid="contrast-badge"]`,
      )!;
      expect(badge.dataset.passes).toBe("true");
      expect(badge.textContent).toMatch(/^\d+(\.\d)?:1 contrast, passes for body text$/);
    }
    expect(row("color-brand").querySelector('[data-testid="contrast-badge"]')).toBeNull();
  });

  it("checks an inherited text color in the mode it is shown in", () => {
    const faint = testToken("color-text-faint", "color", "color", "#22263b");
    const system = { ...TEST_SYSTEM, tokens: [...TEST_SYSTEM.tokens, faint] };
    render(
      <ColorTable {...editor(false)} system={system} tokens={[faint]} onAdd={() => undefined} />,
    );
    const dark = row("color-text-faint").querySelector<HTMLElement>('[data-mode="dark"]')!;
    expect(dark.dataset.inherited).toBe("true");
    const badge = dark.querySelector<HTMLElement>('[data-testid="contrast-badge"]')!;
    expect(badge.dataset.passes).toBe("false");
  });

  it("follows an alias to its target", () => {
    const props = editor();
    render(<ColorTable {...props} tokens={colorTokens} onAdd={() => undefined} />);
    act(() => byLabel("Go to color-brand")!.click());
    expect(props.onGoTo).toHaveBeenCalledWith("color-brand");
  });

  it("saves a new value for one mode and rejects what is not a color", async () => {
    const props = editor();
    render(<ColorTable {...props} tokens={colorTokens} onAdd={() => undefined} />);
    await open(byLabel("Edit color-brand, Light")!);
    const field = byLabel<HTMLInputElement>("Color value")!;
    typeInto(field, "nope");
    expect($('[data-testid="color-field"] [role="alert"]')!.textContent).toContain("Not a color");
    typeInto(field, "#123456");
    expect($('[data-testid="color-field"] [role="alert"]')).toBeNull();
    press(field, "Enter");
    await flush();
    expect(props.onEdit).toHaveBeenCalledWith({
      kind: "set-value",
      name: "color-brand",
      modeId: "light",
      raw: "#123456",
    });
  });

  it("lets a later mode inherit the first mode again", async () => {
    const props = editor();
    render(<ColorTable {...props} tokens={colorTokens} onAdd={() => undefined} />);
    await open(byLabel("Edit color-brand, Dark")!);
    const inherit = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Use Light's value",
    )!;
    act(() => inherit.click());
    expect(props.onEdit).toHaveBeenCalledWith({
      kind: "set-value",
      name: "color-brand",
      modeId: "dark",
      raw: null,
    });
  });

  it("opens the add dialog for a group from its header", () => {
    const onAdd = vi.fn<(group: string) => void>();
    render(<ColorTable {...editor()} tokens={colorTokens} onAdd={onAdd} />);
    const add = [...document.querySelectorAll<HTMLElement>('[title="Add color"]')];
    expect(add.length).toBeGreaterThan(1);
    act(() => add[0]!.click());
    expect(onAdd).toHaveBeenCalledOnce();
  });
});

describe("token rows", () => {
  it("renames in place with the name rules", () => {
    const props = editor();
    render(<NameValueTable {...props} tokens={tokensOf("spacing")} check="length" />);
    act(() => row("space-1").querySelector<HTMLButtonElement>('[title="Rename space-1"]')!.click());
    const input = byLabel<HTMLInputElement>("New name for space-1")!;
    typeInto(input, "");
    expect(row("space-1").querySelector('[role="alert"]')!.textContent).toBe(
      "A token needs a name.",
    );
    typeInto(input, "space 1");
    expect(row("space-1").querySelector('[role="alert"]')!.textContent).toBe(
      "“space 1” is not a token name — letters, digits, . _ and - only.",
    );
    typeInto(input, "space-2");
    expect(row("space-1").querySelector('[role="alert"]')!.textContent).toBe(
      "“space-2” already exists.",
    );
    typeInto(input, "space-xs");
    press(input, "Enter");
    expect(props.onEdit).toHaveBeenCalledWith({ kind: "rename", from: "space-1", to: "space-xs" });
  });

  it("warns that designs keep the old name when the system is in use", () => {
    const props = editor();
    render(
      <SystemUsageContext.Provider value={12}>
        <NameValueTable {...props} tokens={tokensOf("spacing")} check="length" />
      </SystemUsageContext.Provider>,
    );
    act(() => row("space-1").querySelector<HTMLButtonElement>('[title="Rename space-1"]')!.click());
    expect(document.querySelector('[data-testid="rename-warning"]')!.textContent).toBe(
      "12 designs use this system. Any that name space-1 keep the old name and lose its value.",
    );
  });

  it("removes a token from its row", () => {
    const props = editor();
    render(<NameValueTable {...props} tokens={tokensOf("spacing")} check="length" />);
    act(() => byLabel("Remove space-2")!.click());
    expect(props.onEdit).toHaveBeenCalledWith({ kind: "remove", name: "space-2" });
  });
});

describe("NameValueTable", () => {
  it("checks lengths and saves on Enter", () => {
    const props = editor();
    render(<NameValueTable {...props} tokens={tokensOf("spacing")} check="length" />);
    const input = byLabel<HTMLInputElement>("Value of space-2")!;
    typeInto(input, "wide");
    expect(row("space-2").querySelector('[role="alert"]')!.textContent).toBe(
      "Not a length — try 8px or 0.5rem.",
    );
    press(input, "Enter");
    expect(props.onEdit).not.toHaveBeenCalled();
    typeInto(input, "0.75rem");
    press(input, "Enter");
    expect(props.onEdit).toHaveBeenCalledWith({
      kind: "set-value",
      name: "space-2",
      modeId: "light",
      raw: "0.75rem",
    });
  });

  it("edits a length as a number with its unit after it, and draws its size", () => {
    const props = editor();
    render(
      <NameValueTable {...props} tokens={tokensOf("spacing")} check="length" preview="spacing" />,
    );
    const input = byLabel<HTMLInputElement>("Value of space-2")!;
    expect(input.value).toBe("8");
    expect(row("space-2").textContent).toContain("px");
    expect(
      row("space-2").querySelector<HTMLElement>('[data-testid="spacing-preview"]')!.style.width,
    ).toBe("8px");
    typeInto(input, "12");
    press(input, "Enter");
    expect(props.onEdit).toHaveBeenCalledWith({
      kind: "set-value",
      name: "space-2",
      modeId: "light",
      raw: "12px",
    });
  });

  it("gives a bare 0 a unit and never saves a field that was only passed through", () => {
    const zero = testToken("space-0", "dimension", "spacing", "0");
    const upper = testToken("space-big", "dimension", "spacing", "16PX");
    const props = editor();
    render(
      <NameValueTable
        {...props}
        system={{ ...TEST_SYSTEM, tokens: [zero, upper] }}
        tokens={[zero, upper]}
        check="length"
      />,
    );
    const big = byLabel<HTMLInputElement>("Value of space-big")!;
    expect(big.value).toBe("16");
    act(() => big.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(props.onEdit).not.toHaveBeenCalled();
    const input = byLabel<HTMLInputElement>("Value of space-0")!;
    expect(input.getAttribute("aria-describedby")).toBeTruthy();
    act(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(props.onEdit).not.toHaveBeenCalled();
    typeInto(input, "4");
    press(input, "Enter");
    expect(props.onEdit).toHaveBeenCalledWith({
      kind: "set-value",
      name: "space-0",
      modeId: "light",
      raw: "4px",
    });
  });

  it("draws a corner at each radius", () => {
    render(
      <NameValueTable
        {...editor(false)}
        tokens={tokensOf("radius")}
        check="length"
        preview="radius"
      />,
    );
    const corner = row("radius-md").querySelector<HTMLElement>('[data-testid="radius-preview"]')!;
    expect(corner.style.borderTopLeftRadius).toBe("8px");
  });

  it("shows values as text when read-only", () => {
    render(<NameValueTable {...editor(false)} tokens={tokensOf("duration")} check="plain" />);
    expect(byLabel("Value of duration-micro")).toBeNull();
    expect(row("duration-micro").textContent).toContain("120ms");
  });
});

describe("TypographyTable", () => {
  it("previews each style with the pangram and names its font and size", () => {
    render(
      <TypographyTable
        {...editor(false)}
        tokens={TEST_SYSTEM.tokens.filter((token) => token.group === "type")}
        onAdd={() => undefined}
      />,
    );
    expect($('[data-testid="typography-table"]')!.textContent).toContain(
      "The quick brown fox jumps over the lazy dog",
    );
    const chips = [...document.querySelectorAll('[data-testid="type-chip"]')].map(
      (chip) => chip.textContent,
    );
    expect(chips).toContain("Inter Variable · 11/1.35 · Semibold · 0.06em");
  });

  it("opens the Text popover from the chip for editors", async () => {
    render(
      <TypographyTable
        {...editor()}
        tokens={TEST_SYSTEM.tokens.filter((token) => token.group === "type")}
        onAdd={() => undefined}
      />,
    );
    const chip = byLabel("Edit text style of type-body")!;
    expect(chip.textContent).toBe("Inter Variable · 15");
    await open(chip);
    expect($('[data-testid="text-popover"]')!.textContent).toContain("Text");
  });
});

describe("ShadowTable", () => {
  it("draws each mode's shadow on a surface card over the ground", () => {
    render(<ShadowTable {...editor(false)} tokens={tokensOf("shadow")} />);
    const stages = [...document.querySelectorAll<HTMLElement>('[data-testid="shadow-stage"]')];
    expect(stages).toHaveLength(2);
    expect(stages[0]!.style.backgroundColor).toBe("rgb(250, 250, 250)");
    expect(stages[1]!.style.backgroundColor).toBe("rgb(18, 22, 28)");
    const card = stages[0]!.querySelector<HTMLElement>("[style*='box-shadow']")!;
    expect(card.style.boxShadow).toContain("rgba(15, 23, 42, 0.08)");
  });
});

describe("UsageNotes", () => {
  it("closes when its note vanishes for a viewer, so it never reopens on its own", () => {
    const setOpen = vi.fn<(open: boolean) => void>();
    const state = { open: true, setOpen, draft: "Brand fills only.", setDraft: vi.fn() };
    render(
      <UsageNotes
        name="color-brand"
        note=""
        canEdit={false}
        onSave={() => undefined}
        state={state}
      />,
    );
    expect(setOpen).toHaveBeenCalledWith(false);
  });
});
