import { describe, expect, it } from "vite-plus/test";

import { imageMimeType, NO_PREVIEW, previewPlan } from "./previewPlan";

const plan = (path: string, bytes = 1_000, unavailable?: string) =>
  previewPlan({ path, bytes, ...(unavailable === undefined ? {} : { unavailable }) });

describe("FilePreview type detection", () => {
  it("renders markdown, shows text, JSON, CSS and HTML as source", () => {
    expect(plan("README.md").kind).toBe("markdown");
    expect(plan("docs/voice.markdown").kind).toBe("markdown");
    for (const path of ["notes.txt", "tokens.json", "tokens.css", "card.html", "theme.ts"])
      expect(plan(path).kind).toBe("source");
  });

  it("shows images through an image type the extension decides, SVG included", () => {
    expect(plan("assets/Logos/mark.svg")).toEqual({ kind: "image", mimeType: "image/svg+xml" });
    expect(plan("hero.JPG")).toEqual({ kind: "image", mimeType: "image/jpeg" });
    expect(imageMimeType("mark.html")).toBeNull();
  });

  it("renders fonts as a specimen", () => {
    for (const path of ["fonts/Inter.woff2", "fonts/Inter.woff", "a.ttf", "b.otf"])
      expect(plan(path).kind).toBe("font");
  });

  it("explains PDFs and unknown types, and offers Download", () => {
    expect(plan("brand.pdf")).toEqual({ kind: "notice", message: NO_PREVIEW, download: true });
    expect(plan("archive.zip")).toEqual({ kind: "notice", message: NO_PREVIEW, download: true });
  });

  it("says why an over-large or unreadable file is not shown", () => {
    expect(plan("big.json", 600 * 1024)).toEqual({
      kind: "notice",
      message: "This file is too large to preview (over 512 KB).",
      download: true,
    });
    expect(plan("poster.png", 11 * 1024 * 1024).kind).toBe("notice");
    expect(plan("src/theme.css", 100, "excluded as a secret")).toEqual({
      kind: "notice",
      message: "This file can't be read from the repository: excluded as a secret",
      download: false,
    });
  });
});
