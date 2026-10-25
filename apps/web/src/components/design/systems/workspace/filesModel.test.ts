import { describe, expect, it } from "vite-plus/test";

import {
  buildTree,
  fileCaption,
  fileGroup,
  folderCaption,
  formatSize,
  groupTopLevel,
  isHiddenPath,
  kindLabel,
  shownIn,
  typeLabel,
  whereLabel,
  type BrowserFile,
} from "./filesModel";

const stored = (path: string, bytes = 100): BrowserFile => ({
  path,
  origin: "stored",
  bytes,
  mimeType: "application/octet-stream",
});

const FILES: BrowserFile[] = [
  stored("README.md", 2_400),
  stored("docs/voice.md"),
  stored("docs/.draft.md"),
  stored("fonts/Inter.woff2", 98_000),
  stored("assets/Logos/mark.svg", 3_100),
  stored("assets/Logos/wordmark.png", 91_000),
  stored("assets/Logos/print/mark.pdf"),
  stored("assets/hero.jpg", 1_400_000),
  stored(".secret/notes.txt"),
  { path: "src/styles/tokens.css", origin: "source", bytes: 4_000, mimeType: "text/css" },
  { path: "tokens.css", origin: "generated", bytes: 900, mimeType: "text/css", text: "" },
  { path: "tokens.json", origin: "generated", bytes: 1_900, mimeType: "application/json" },
];

describe("sizes and type labels", () => {
  it("reads bytes, rounded kilobytes and megabytes with one decimal", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1_023)).toBe("1023 B");
    expect(formatSize(93_184)).toBe("91 KB");
    expect(formatSize(1_536)).toBe("2 KB");
    expect(formatSize(3_565_158)).toBe("3.4 MB");
    expect(formatSize(1024 * 1024 * 1024)).toBe("1024 MB");
  });

  it('labels a type as "<EXT> · <size>"', () => {
    expect(typeLabel("assets/Logos/photo.JPG", 93_184)).toBe("JPG · 91 KB");
    expect(typeLabel("fonts/Inter.woff2", 512)).toBe("WOFF2 · 512 B");
    expect(typeLabel("LICENSE", 2_048)).toBe("File · 2 KB");
  });
});

describe("kinds, groups and where each file shows", () => {
  it("classifies by extension, and keeps sources in their own group", () => {
    expect(fileGroup(stored("index.html"))).toBe("Pages");
    expect(fileGroup(stored("Button.tsx"))).toBe("Components");
    expect(fileGroup(stored("tokens.css"))).toBe("Stylesheets");
    expect(fileGroup(stored("bundle.js"))).toBe("Scripts");
    expect(fileGroup(stored("logo.SVG"))).toBe("Images");
    expect(fileGroup(stored("Inter.otf"))).toBe("Fonts");
    expect(fileGroup(stored("guide.pdf"))).toBe("Documents");
    expect(fileGroup(stored("theme.json"))).toBe("Data");
    expect(fileGroup(stored("archive.zip"))).toBe("Other");
    expect(fileGroup({ path: "src/theme.css", origin: "source" })).toBe("Sources");
    expect(kindLabel("README.md")).toBe("Markdown");
    expect(kindLabel("brand.pdf")).toBe("PDF document");
    expect(kindLabel("mark.png")).toBe("Image");
    expect(kindLabel("x.bin")).toBe("File");
  });

  it("captions README and docs as Overview, fonts as Typography, assets as Assets", () => {
    expect(shownIn(stored("README.md"))?.id).toBe("readme");
    expect(whereLabel(stored("README.md"))).toBe("Shown in Overview");
    expect(whereLabel(stored("docs/voice.md"))).toBe("Shown in Overview");
    expect(whereLabel(stored("fonts/Inter.woff2"))).toBe("Shown in Typography");
    expect(whereLabel(stored("assets/Logos/mark.svg"))).toBe("Shown in Assets");
    expect(whereLabel(stored("notes/todo.txt"))).toBeNull();
    expect(whereLabel({ path: "tokens.css", origin: "generated" })).toBe(
      "Generated from this design system",
    );
    expect(whereLabel({ path: "src/theme.css", origin: "source" })).toBe(
      "Read from the repository",
    );
    expect(fileCaption(stored("fonts/Inter.woff2"))).toBe("Font · Shown in Typography");
    expect(fileCaption(stored("notes/todo.txt"))).toBe("Document");
  });
});

describe("tree", () => {
  it("hides dot paths", () => {
    expect(isHiddenPath(".env")).toBe(true);
    expect(isHiddenPath("docs/.draft.md")).toBe(true);
    expect(isHiddenPath(".secret/notes.txt")).toBe(true);
    expect(isHiddenPath("docs/voice.md")).toBe(false);
  });

  it("nests folders with counts of every file inside, folders before files", () => {
    const root = buildTree(FILES);
    expect(root.children.map((node) => node.name)).toEqual([
      "assets",
      "docs",
      "fonts",
      "README.md",
      "tokens.css",
      "tokens.json",
    ]);
    const assets = root.children[0]!;
    expect(assets.kind).toBe("folder");
    if (assets.kind !== "folder") return;
    expect(folderCaption(assets)).toBe("Folder · 4 files");
    const logos = assets.children[0]!;
    expect(logos.kind === "folder" && folderCaption(logos)).toBe("Folder · 3 files");
    const docs = root.children[1]!;
    expect(docs.kind === "folder" && folderCaption(docs)).toBe("Folder · 1 file");
  });

  it("lists the top level in the fixed group order, only non-empty groups", () => {
    const groups = groupTopLevel(FILES);
    expect(groups.map((entry) => entry.group)).toEqual([
      "Folders",
      "Stylesheets",
      "Documents",
      "Data",
      "Sources",
    ]);
    expect(groups[0]!.entries.map((node) => node.name)).toEqual(["assets", "docs", "fonts"]);
    expect(groups.find((entry) => entry.group === "Sources")!.entries[0]!.name).toBe(
      "src/styles/tokens.css",
    );
  });
});
