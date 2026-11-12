// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  applyPlatform,
  currentPlatform,
  defaultButtonLast,
  defaultButtonPlacement,
  deviceWord,
  fileManagerName,
  hasMainModifier,
  keyLabel,
  platformOf,
  shortcutLabel,
  systemDialogLabel,
} from "./platformConventions";

afterEach(() => {
  delete document.documentElement.dataset.platform;
});

describe("platformOf", () => {
  it("names the three desktop systems", () => {
    expect(platformOf("MacIntel")).toBe("macos");
    expect(platformOf("Win32")).toBe("windows");
    expect(platformOf("Linux x86_64")).toBe("linux");
    expect(platformOf("")).toBe("linux");
  });

  it("puts phones with the system their conventions come from", () => {
    expect(platformOf("iPhone")).toBe("macos");
    expect(platformOf("Linux armv8l", "Mozilla/5.0 (Linux; Android 16)")).toBe("linux");
  });
});

describe("the document's platform", () => {
  it("is what the document was marked with", () => {
    applyPlatform(document.documentElement, "windows");
    expect(document.documentElement.getAttribute("data-platform")).toBe("windows");
    expect(currentPlatform()).toBe("windows");
  });

  it("falls back to the browser's own when the mark is missing or unknown", () => {
    document.documentElement.dataset.platform = "beos";
    expect(["macos", "windows", "linux"]).toContain(currentPlatform());
  });
});

describe("conventions", () => {
  it("prints keys as symbols on macOS and as words elsewhere", () => {
    expect(keyLabel("enter", "macos")).toBe("↵");
    expect(keyLabel("tab", "macos")).toBe("⇥");
    expect(keyLabel("enter", "windows")).toBe("Enter");
    expect(keyLabel("tab", "linux")).toBe("Tab");
    expect(shortcutLabel("o", "macos")).toBe("⌘O");
    expect(shortcutLabel("o", "windows")).toBe("Ctrl+O");
    expect(shortcutLabel("l", "linux")).toBe("Ctrl+L");
  });

  it("reads the main modifier per system", () => {
    expect(hasMainModifier({ metaKey: true, ctrlKey: false }, "macos")).toBe(true);
    expect(hasMainModifier({ metaKey: false, ctrlKey: true }, "macos")).toBe(false);
    expect(hasMainModifier({ metaKey: false, ctrlKey: true }, "linux")).toBe(true);
    expect(hasMainModifier({ metaKey: true, ctrlKey: true }, "windows")).toBe(false);
  });

  it("orders buttons, names the file manager, the dialog button and the device", () => {
    expect(defaultButtonLast("macos")).toBe(true);
    expect(defaultButtonLast("linux")).toBe(true);
    expect(defaultButtonLast("windows")).toBe(false);
    expect(defaultButtonPlacement("macos")).toBe("last");
    expect(defaultButtonPlacement("linux")).toBe("last");
    expect(defaultButtonPlacement("windows")).toBe("first");
    expect(fileManagerName("macos")).toBe("Finder");
    expect(fileManagerName("windows")).toBe("File Explorer");
    expect(fileManagerName("linux")).toBe("Files");
    expect(systemDialogLabel("macos")).toBe("Choose…");
    expect(systemDialogLabel("windows")).toBe("Browse…");
    expect(systemDialogLabel("linux")).toBe("Browse…");
    expect(deviceWord("macos")).toBe("Mac");
    expect(deviceWord("windows")).toBe("PC");
    expect(deviceWord("linux")).toBe("computer");
  });
});
