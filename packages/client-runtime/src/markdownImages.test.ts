import { describe, expect, it } from "vite-plus/test";

import {
  classifyMarkdownImageSource,
  firstUnembeddedMedia,
  markdownImageSourceFragment,
} from "./markdownImages.js";

describe("classifyMarkdownImageSource", () => {
  it.each([
    "https://example.com/image.png",
    "HTTP://example.com/image.png",
    "data:image/png;base64,AAAA",
    "blob:https://app.studio.invalid/image-id",
    "//cdn.example.com/image.png",
  ])("keeps %s directly loadable", (uri) => {
    expect(classifyMarkdownImageSource(uri, "/workspace/project")).toEqual({
      _tag: "Direct",
      uri,
    });
  });

  it.each([
    ["images/result.png", "/workspace/project", "/workspace/project/images/result.png"],
    ["./images/result.png", "/workspace/project", "/workspace/project/./images/result.png"],
    [
      "images/result.png",
      "C:\\Users\\dara\\project",
      "C:\\Users\\dara\\project\\images\\result.png",
    ],
    [
      "images\\result.png",
      "C:\\Users\\dara\\project",
      "C:\\Users\\dara\\project\\images\\result.png",
    ],
    ["/workspace/project/image.png", null, "/workspace/project/image.png"],
    ["/C:/Users/dara/project/image.png", null, "C:/Users/dara/project/image.png"],
    ["C:/Users/dara/project/image.png", null, "C:/Users/dara/project/image.png"],
    ["\\\\server\\share\\image.png", null, "\\\\server\\share\\image.png"],
    ["file:///workspace/project/image%20one.png", null, "/workspace/project/image one.png"],
    ["file:///C:/Users/dara/project/image.png", null, "C:/Users/dara/project/image.png"],
    ["file://localhost/C:/Users/dara/project/image.png", null, "C:/Users/dara/project/image.png"],
    ["file://server/share/image.png", null, "\\\\server\\share\\image.png"],
  ])("maps %s to a workspace file", (source, workspaceRoot, path) => {
    expect(classifyMarkdownImageSource(source, workspaceRoot)).toEqual({
      _tag: "WorkspaceFile",
      path,
    });
  });

  it.each([
    null,
    "",
    "#image",
    "?image=1",
    "image.png",
    "~/image.png",
    "javascript:alert(1)",
    "ftp://example.com/image.png",
    "content://media/image/1",
    "custom:image.png",
    "file://%",
  ])("blocks unsupported or unresolved source %s", (source) => {
    expect(classifyMarkdownImageSource(source)).toEqual({ _tag: "Blocked" });
  });
});

describe("markdownImageSourceFragment", () => {
  it.each([
    ["<icons.svg?version=2#logo>", "#logo"],
    ["icons.svg?version=2", ""],
  ])("extracts %s as %s", (source, fragment) => {
    expect(markdownImageSourceFragment(source)).toBe(fragment);
  });
});

describe("firstUnembeddedMedia", () => {
  it("picks the first image or video named by absolute path in a chip or a link", () => {
    expect(
      firstUnembeddedMedia(
        "Done. Report: `/tmp/run/report.md`, screenshot `/tmp/run/after shot.png` and `/tmp/run/b.png`.",
      ),
    ).toEqual({ path: "/tmp/run/after shot.png", kind: "image" });
    expect(
      firstUnembeddedMedia("See [the recording](/tmp/run/demo.mp4) and `/tmp/a.png`."),
    ).toEqual({ path: "/tmp/run/demo.mp4", kind: "video" });
    expect(firstUnembeddedMedia("Saved to [shot](</tmp/my run/shot.webp>).")).toEqual({
      path: "/tmp/my run/shot.webp",
      kind: "image",
    });
    expect(firstUnembeddedMedia("Saved ``C:\\Users\\me\\shot.PNG``.")).toEqual({
      path: "C:\\Users\\me\\shot.PNG",
      kind: "image",
    });
    expect(firstUnembeddedMedia("Open file:///tmp/a.png or `file:///tmp/run/a%20b.jpg`")).toEqual({
      path: "/tmp/run/a b.jpg",
      kind: "image",
    });
  });

  it("yields to media the author embedded, wherever it sits", () => {
    expect(firstUnembeddedMedia("`/tmp/a.png`\n\n![after](/tmp/b.png)")).toBeNull();
    expect(firstUnembeddedMedia("![after](https://example.com/b.png) and `/tmp/a.png`")).toBeNull();
    expect(firstUnembeddedMedia('`/tmp/a.png`\n\n<img src="/tmp/b.png" width="200">')).toBeNull();
    expect(firstUnembeddedMedia('`/tmp/a.png`\n\n<video src="/tmp/b.mp4"></video>')).toBeNull();
    // Image syntax quoted as code is not an embed.
    expect(firstUnembeddedMedia("Write `![x](/tmp/b.png)` to embed `/tmp/a.png`.")).toEqual({
      path: "/tmp/a.png",
      kind: "image",
    });
  });

  it("ignores what is not a result on the thread's host", () => {
    expect(firstUnembeddedMedia("No paths here.")).toBeNull();
    expect(firstUnembeddedMedia("Edited `/src/app.ts` and `/tmp/report.pdf`.")).toBeNull();
    // Relative and home paths have no certain host location; web images are not paths.
    expect(firstUnembeddedMedia("See `shots/a.png`, `~/a.png` and `./a.png`.")).toBeNull();
    expect(firstUnembeddedMedia("See [logo](https://example.com/logo.png).")).toBeNull();
    // Unquoted prose is not a chip.
    expect(firstUnembeddedMedia("Saved to /tmp/a.png today.")).toBeNull();
    // A path in a log or a script is not a result.
    expect(
      firstUnembeddedMedia("```sh\nopen `/tmp/a.png`\ncp /tmp/a.png /tmp/b.png\n```\nDone."),
    ).toBeNull();
    expect(firstUnembeddedMedia("~~~\n`/tmp/a.png`\n~~~\nThen `/tmp/c.gif`.")).toEqual({
      path: "/tmp/c.gif",
      kind: "image",
    });
    // An unclosed fence while a reply streams hides the rest.
    expect(firstUnembeddedMedia("Start\n```\n`/tmp/a.png`")).toBeNull();
  });
});
