// @effect-diagnostics nodeBuiltinImport:off - Host path rules for both platforms.
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  htmlLocalReferencePaths,
  localReferencePath,
  rewriteHtmlLocalReferences,
} from "./HtmlLocalReferences.ts";

const page = "/Users/me/Movies/live/cue-sheet.html";
const posix = NodePath.posix;
const windowsPage = "C:\\Users\\me\\live\\cue-sheet.html";

describe("localReferencePath", () => {
  it("resolves absolute, sibling, encoded and file URL references", () => {
    expect(localReferencePath("/Users/me/shot.png", page, posix)).toBe("/Users/me/shot.png");
    expect(localReferencePath("shot.png", page, posix)).toBe("/Users/me/Movies/live/shot.png");
    expect(localReferencePath("./img/a%20b.png?v=2#x", page, posix)).toBe(
      "/Users/me/Movies/live/img/a b.png",
    );
    expect(localReferencePath("../thumb.jpg", page, posix)).toBe("/Users/me/Movies/thumb.jpg");
    expect(localReferencePath("file:///Users/me/shot.png", page, posix)).toBe("/Users/me/shot.png");
  });

  it("reads Windows drive paths and file URLs as host files on a Windows host", () => {
    const win = NodePath.win32;
    expect(localReferencePath("C:\\Users\\me\\shot.png", windowsPage, win)).toBe(
      "C:\\Users\\me\\shot.png",
    );
    expect(localReferencePath("C:/Users/me/shot.png", windowsPage, win)).toBe(
      "C:\\Users\\me\\shot.png",
    );
    expect(localReferencePath("file:///C:/Users/me/a%20b.png?v=1#x", windowsPage, win)).toBe(
      "C:\\Users\\me\\a b.png",
    );
    expect(localReferencePath("shot.png", windowsPage, win)).toBe("C:\\Users\\me\\live\\shot.png");
    expect(localReferencePath("img/a%20b.png", windowsPage, win)).toBe(
      "C:\\Users\\me\\live\\img\\a b.png",
    );
    // On a Mac or Linux host a drive letter is still a scheme, never a file.
    expect(localReferencePath("C:/Users/me/shot.png", page, posix)).toBeNull();
  });

  it("swaps Windows references on a Windows host", () => {
    const win = NodePath.win32;
    const html = `<img src="C:\\Users\\me\\shot.png"><img src='file:///C:/Users/me/shot.png'>`;
    expect(htmlLocalReferencePaths(html, windowsPage, win)).toEqual(["C:\\Users\\me\\shot.png"]);
    const urls = new Map([["C:\\Users\\me\\shot.png", "/api/assets/t1.s/shot.png"]]);
    expect(rewriteHtmlLocalReferences(html, windowsPage, urls, win)).toBe(
      `<img src="/api/assets/t1.s/shot.png"><img src='/api/assets/t1.s/shot.png'>`,
    );
  });

  it("leaves remote, inline and fragment references alone", () => {
    for (const value of [
      "https://example.com/a.png",
      "data:image/png;base64,AAAA",
      "//cdn.example.com/a.png",
      "#top",
      "",
      "javascript:alert(1)",
      "file://fileserver/share/a.png",
      "file:///tmp/a%00.png",
      "/tmp/a%00.png",
    ]) {
      expect(localReferencePath(value, page, posix)).toBeNull();
      expect(localReferencePath(value, windowsPage, NodePath.win32)).toBeNull();
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
    expect(htmlLocalReferencePaths(html, page, posix)).toEqual([
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
    const out = rewriteHtmlLocalReferences(html, page, urls, posix);
    expect(out).toContain(`<img src="/api/assets/t1.s/shot.png" alt="a">`);
    expect(out).toContain(`<img SRC='/api/assets/t2.s/it%27s.png'>`);
    expect(out).toContain(`poster="/api/assets/t3.s/poster.jpg" src="https://example.com/v.mp4"`);
    expect(out).toContain(`srcset="/api/assets/t2.s/it%27s.png 1x, /api/assets/t4.s/big.png 2x"`);
    expect(out).toContain(`<a href="/Users/me/shot.png">link stays</a>`);
    expect(out).toContain(`<img src="missing.png">`);
  });

  it("returns the document unchanged when nothing was signed", () => {
    expect(rewriteHtmlLocalReferences(html, page, new Map(), posix)).toBe(html);
  });
});
