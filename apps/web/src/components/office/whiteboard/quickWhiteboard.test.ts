import { DEFAULT_RESOLVED_KEYBINDINGS } from "@specweave-studio/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import { resolveShortcutCommand, shortcutLabelForCommand } from "../../../keybindings";
import { reduceCommandPaletteUiState } from "../../CommandPalette.logic";
import { artifactMatchesType, artifactSubfolder } from "../../../studio/projectArtifacts";
import { parseProjectWorkspaceSearch } from "../../../studio/projectPaneThreads";
import { isWhiteboardEditorKey } from "./bridge";
import {
  asksForWhiteboard,
  openWhiteboardDestination,
  whiteboardSearchTerms,
  whiteboardsInLibrary,
} from "./quickWhiteboard";
import { limitGroupItems, whiteboardBoardItems } from "./whiteboardPalette";

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

describe("?open=<path>", () => {
  it("keeps a project-relative whiteboard path and refuses any way out of the project", () => {
    const open = (value: unknown) => parseProjectWorkspaceSearch({ open: value }).open;
    expect(open(".specweave/artifacts/team/q4/checkout flow #2.excalidraw")).toBe(
      ".specweave/artifacts/team/q4/checkout flow #2.excalidraw",
    );
    for (const bad of [
      "/etc/x.excalidraw",
      "C:/Users/x.excalidraw",
      "..\\x.excalidraw",
      ".specweave/../x.excalidraw",
      "a//b.excalidraw",
      "notes.md",
      "",
      ["a.excalidraw"],
      "a\u0000.excalidraw",
    ]) {
      expect(open(bad)).toBeUndefined();
    }
  });

  it("drops a pending new-board request when it asks to open one", () => {
    const destination = openWhiteboardDestination("p1", ".specweave/artifacts/a.excalidraw");
    expect(destination.search({ new: "whiteboard", pane: "library" })).toEqual({
      pane: "library",
      open: ".specweave/artifacts/a.excalidraw",
    });
  });
});

describe("the project's whiteboards", () => {
  const library = {
    outputs: [
      { path: ".specweave/reports/r.md", byteLength: 1, modifiedAt: "2026-11-27T10:00:00Z" },
      {
        path: ".specweave/artifacts/old.excalidraw",
        byteLength: 1,
        modifiedAt: "2026-11-01T10:00:00Z",
      },
      {
        path: ".specweave/artifacts/team/q4/checkout-architecture.excalidraw",
        byteLength: 1,
        modifiedAt: "2026-11-26T16:00:00Z",
      },
      { path: "docs/flow.excalidraw", byteLength: 1, modifiedAt: "2026-11-20T10:00:00Z" },
    ].map((output) => ({ ...output, increment: null })),
  } as never;

  it("are the snapshot's .excalidraw files, newest first, with their folder", () => {
    expect(whiteboardsInLibrary(library).map((board) => [board.name, board.folder])).toEqual([
      ["checkout-architecture.excalidraw", "team/q4"],
      ["flow.excalidraw", "docs"],
      ["old.excalidraw", null],
    ]);
    // Older servers send no outputs.
    expect(whiteboardsInLibrary({} as never)).toEqual([]);
    expect(whiteboardsInLibrary(null)).toEqual([]);
  });

  it("are found by words of their name and folder", () => {
    const [board] = whiteboardsInLibrary(library);
    const terms = whiteboardSearchTerms(board!).join(" ");
    for (const word of ["checkout architecture", "team q4", "whiteboard", "excalidraw"]) {
      expect(terms).toContain(word);
    }
  });

  it("become palette rows that open the board, named without the extension", async () => {
    const opened: string[] = [];
    const items = whiteboardBoardItems({
      projectKey: "p1",
      projectName: "Atlas web",
      boards: whiteboardsInLibrary(library),
      icon: null,
      openBoard: async (path) => {
        opened.push(path);
      },
    });
    expect(items.map((item) => [item.title, item.description])).toEqual([
      ["checkout-architecture", "team/q4 · Atlas web"],
      ["flow", "docs · Atlas web"],
      ["old", "Atlas web"],
    ]);
    await items[0]!.run();
    expect(opened).toEqual([".specweave/artifacts/team/q4/checkout-architecture.excalidraw"]);
    expect(
      limitGroupItems([{ value: "w", label: "W", items }], "w", 2)[0]!.items.map(
        (item) => item.title,
      ),
    ).toEqual(["checkout-architecture", "flow"]);
  });

  it("have their own Type filter in the Library", () => {
    const board = { kind: "whiteboard" } as never;
    expect(artifactMatchesType("whiteboards", board)).toBe(true);
    expect(artifactMatchesType("documents", board)).toBe(false);
  });

  it("open the palette on the Whiteboards picker", () => {
    expect(
      reduceCommandPaletteUiState(
        { open: false, mode: "command", openIntent: null },
        { _tag: "OpenWhiteboards" },
      ),
    ).toEqual({ open: true, mode: "command", openIntent: { kind: "whiteboards" } });
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
