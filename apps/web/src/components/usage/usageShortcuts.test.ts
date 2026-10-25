import { DEFAULT_RESOLVED_KEYBINDINGS } from "@specweave-studio/shared/keybindings";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { resolveUsageShortcut } from "./usageShortcuts";

class TestElement extends EventTarget {
  constructor(
    readonly tagName: string,
    readonly isContentEditable = false,
  ) {
    super();
  }

  closest() {
    return null;
  }
}

afterEach(() => vi.unstubAllGlobals());

class LayerElement extends TestElement {
  constructor(private readonly layer: { matches: (selector: string) => boolean } | null) {
    super("BUTTON");
  }

  override closest() {
    return this.layer as never;
  }
}

describe("Usage shortcuts in the Usage sheet", () => {
  const press = (target: EventTarget) =>
    resolveUsageShortcut(
      { key: "t", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target },
      DEFAULT_RESOLVED_KEYBINDINGS,
    );

  it("takes letters inside the sheet but not inside a popup or another dialog", () => {
    vi.stubGlobal("HTMLElement", TestElement);
    vi.stubGlobal("navigator", { platform: "Linux" });
    const usageSheet = { matches: (selector: string) => selector === "[data-usage-sheet]" };
    const otherDialog = { matches: () => false };
    expect(press(new LayerElement(usageSheet))).toBe("usage.tokens");
    expect(press(new LayerElement(otherDialog))).toBeNull();
  });
});

describe("Usage shortcuts while typing", () => {
  it.each([new TestElement("INPUT"), new TestElement("TEXTAREA"), new TestElement("DIV", true)])(
    "leaves letters to the focused $tagName field",
    (target) => {
      vi.stubGlobal("HTMLElement", TestElement);
      vi.stubGlobal("navigator", { platform: "Linux" });
      const event = {
        key: "t",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        target,
      };

      expect(resolveUsageShortcut(event, DEFAULT_RESOLVED_KEYBINDINGS)).toBeNull();
      expect(
        resolveUsageShortcut(
          { ...event, target: new TestElement("BODY") },
          DEFAULT_RESOLVED_KEYBINDINGS,
        ),
      ).toBe("usage.tokens");
    },
  );
});
