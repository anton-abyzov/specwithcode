import { DEFAULT_RESOLVED_KEYBINDINGS } from "@specweave-studio/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import { resolveShortcutCommand, shortcutLabelForCommand } from "../../../keybindings";
import { artifactSubfolder } from "../../../studio/projectArtifacts";
import { parseProjectWorkspaceSearch } from "../../../studio/projectPaneThreads";
import { isWhiteboardEditorKey } from "./bridge";
import { asksForWhiteboard } from "./quickWhiteboard";

const press = (overrides: Record<string, unknown>) => ({
  key: "w",
  code: "KeyW",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides,
});
const command = (event: ReturnType<typeof press>, platform: string) =>
  resolveShortcutCommand(event as never, DEFAULT_RESOLVED_KEYBINDINGS, {
    platform,
    context: { terminalFocus: false },
  });

describe("whiteboard.new shortcut", () => {
  it("is Cmd+Option+W on a Mac and Ctrl+Alt+W on Windows and Linux", () => {
    expect(command(press({ metaKey: true, altKey: true, key: "∑" }), "MacIntel")).toBe(
      "whiteboard.new",
    );
    for (const platform of ["Win32", "Linux x86_64"]) {
      expect(command(press({ ctrlKey: true, altKey: true }), platform)).toBe("whiteboard.new");
      // Cmd+Shift+W and Ctrl+Shift+W stay the browser's (close the window).
      expect(command(press({ ctrlKey: true, shiftKey: true }), platform)).not.toBe(
        "whiteboard.new",
      );
    }
    expect(command(press({ ctrlKey: true, altKey: true }), "MacIntel")).toBeNull();
  });

  it("leaves AltGr typing alone where Ctrl+Alt+W types a character", () => {
    const altGr = press({
      ctrlKey: true,
      altKey: true,
      key: "|",
      getModifierState: (modifier: string) => modifier === "AltGraph",
    });
    expect(command(altGr, "Win32")).toBeNull();
  });

  it("is off while a terminal has focus", () => {
    expect(
      resolveShortcutCommand(
        press({ ctrlKey: true, altKey: true }) as never,
        DEFAULT_RESOLVED_KEYBINDINGS,
        { platform: "Linux x86_64", context: { terminalFocus: true } },
      ),
    ).not.toBe("whiteboard.new");
  });

  it("has a label for the palette and Settings", () => {
    expect(shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "whiteboard.new", "Win32")).toBe(
      "Ctrl+Alt+W",
    );
  });
});

describe("New whiteboard in the palette", () => {
  it("lists every project's entry only when the query asks for a whiteboard", () => {
    for (const query of ["whiteboard", "new white", "excalidraw", "> draw", "New diagram"])
      expect(asksForWhiteboard(query)).toBe(true);
    for (const query of ["", "d", "board", "settings", "atlas web", "add project"])
      expect(asksForWhiteboard(query)).toBe(false);
  });
});

describe("?new=whiteboard", () => {
  it("is kept on a project page, and nothing else is", () => {
    expect(parseProjectWorkspaceSearch({ new: "whiteboard" })).toEqual({ new: "whiteboard" });
    expect(parseProjectWorkspaceSearch({ new: "sheet" })).toEqual({});
    expect(parseProjectWorkspaceSearch({ new: ["whiteboard"] })).toEqual({});
  });
});

describe("keys handed to the editor from outside its frame", () => {
  it("are undo, redo and select all, with Cmd on a Mac or Ctrl elsewhere", () => {
    for (const mod of [{ metaKey: true }, { ctrlKey: true }]) {
      expect(isWhiteboardEditorKey(press({ ...mod, key: "z" }))).toBe(true);
      expect(isWhiteboardEditorKey(press({ ...mod, key: "Z", shiftKey: true }))).toBe(true);
      expect(isWhiteboardEditorKey(press({ ...mod, key: "y" }))).toBe(true);
      expect(isWhiteboardEditorKey(press({ ...mod, key: "a" }))).toBe(true);
      expect(isWhiteboardEditorKey(press({ ...mod, key: "w" }))).toBe(false);
      expect(isWhiteboardEditorKey(press({ ...mod, altKey: true, key: "z" }))).toBe(false);
    }
    expect(isWhiteboardEditorKey(press({ key: "z" }))).toBe(false);
  });
});

describe("artifactSubfolder", () => {
  it("names the folder below the artifacts folder", () => {
    expect(artifactSubfolder({ path: ".specweave/artifacts/team/q4/flow.excalidraw" })).toBe(
      "team/q4",
    );
    expect(artifactSubfolder({ path: ".specweave/artifacts/flow.excalidraw" })).toBeNull();
    expect(artifactSubfolder({ path: ".specweave/reports/run/flow.excalidraw" })).toBeNull();
    expect(artifactSubfolder({ path: null })).toBeNull();
  });
});
