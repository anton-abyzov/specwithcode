import { describe, expect, it } from "vite-plus/test";

import {
  htmlLocalReferencePaths,
  localReferencePath,
  rewriteHtmlLocalReferences,
} from "./HtmlLocalReferences.ts";

const page = "/Users/me/Movies/live/cue-sheet.html";

describe("localReferencePath", () => {
  it("resolves absolute, sibling, encoded and file URL references", () => {
    expect(localReferencePath("/Users/me/shot.png", page)).toBe("/Users/me/shot.png");
    expect(localReferencePath("shot.png", page)).toBe("/Users/me/Movies/live/shot.png");
    expect(localReferencePath("./img/a%20b.png?v=2#x", page)).toBe(
      "/Users/me/Movies/live/img/a b.png",
    );
    expect(localReferencePath("../thumb.jpg", page)).toBe("/Users/me/Movies/thumb.jpg");
    expect(localReferencePath("file:///Users/me/shot.png", page)).toBe("/Users/me/shot.png");
  });

  it("leaves remote, inline and fragment references alone", () => {
    for (const value of [
      "https://example.com/a.png",
      "data:image/png;base64,AAAA",
      "//cdn.example.com/a.png",
      "#top",
      "",
      "javascript:alert(1)",
    ]) {
      expect(localReferencePath(value, page)).toBeNull();
    }
  });
});

describe("rewriteHtmlLocalReferences", () => {
  const html = [
    `<img src="/Users/me/shot.png" alt="a">`,
    `<img SRC='shot.png'>`,
    `<video poster="poster.jpg" src="https://example.com/v.mp4"></video>`,
    `<img srcset="shot.png 1x, /Users/me/big.png 2x">`,
    `<a href="/Users/me/shot.png">link stays</a>`,
    `<img src="missing.png">`,
  ].join("\n");

  it("lists each local path once, in order", () => {
    expect(htmlLocalReferencePaths(html, page)).toEqual([
      "/Users/me/shot.png",
      "/Users/me/Movies/live/shot.png",
      "/Users/me/Movies/live/poster.jpg",
      "/Users/me/big.png",
      "/Users/me/Movies/live/missing.png",
    ]);
  });

  it("swaps only references that have a signed URL and keeps quoting safe", () => {
    const urls = new Map([
      ["/Users/me/shot.png", "/api/assets/t1.s/shot.png"],
      ["/Users/me/Movies/live/shot.png", "/api/assets/t2.s/it's.png"],
      ["/Users/me/Movies/live/poster.jpg", "/api/assets/t3.s/poster.jpg"],
      ["/Users/me/big.png", "/api/assets/t4.s/big.png"],
    ]);
    const out = rewriteHtmlLocalReferences(html, page, urls);
    expect(out).toContain(`<img src="/api/assets/t1.s/shot.png" alt="a">`);
    expect(out).toContain(`<img SRC='/api/assets/t2.s/it%27s.png'>`);
    expect(out).toContain(`poster="/api/assets/t3.s/poster.jpg" src="https://example.com/v.mp4"`);
    expect(out).toContain(`srcset="/api/assets/t2.s/it%27s.png 1x, /api/assets/t4.s/big.png 2x"`);
    expect(out).toContain(`<a href="/Users/me/shot.png">link stays</a>`);
    expect(out).toContain(`<img src="missing.png">`);
  });

  it("returns the document unchanged when nothing was signed", () => {
    expect(rewriteHtmlLocalReferences(html, page, new Map())).toBe(html);
  });
});
