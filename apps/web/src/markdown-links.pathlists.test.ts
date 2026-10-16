import { describe, expect, it } from "vite-plus/test";

import {
  fencedPathListLines,
  fileReferenceSpans,
  pathListLines,
  resolveInlineCodeFileLinks,
  threadFileFolders,
} from "./markdown-links";

const CWD = "/Users/me/Projects/app";
const CWS = "/Users/me/Downloads/specwithcode-browser-cws";

describe("pathListLines", () => {
  it("reads a fence of absolute paths and bare file names as a file list", () => {
    expect(pathListLines(`${CWS}/icon-128.png\n${CWS}/specwithcode-browser-1.0.0.zip\n`)).toEqual([
      `${CWS}/icon-128.png`,
      `${CWS}/specwithcode-browser-1.0.0.zip`,
    ]);
    expect(pathListLines("screenshot-1-overview.png\nscreenshot-2-pair.png\n\n")).toEqual([
      "screenshot-1-overview.png",
      "screenshot-2-pair.png",
    ]);
  });

  it("keeps commands, placeholders and highlighted code as code", () => {
    expect(pathListLines("(leave empty)\n")).toBeNull();
    expect(pathListLines("pnpm test\n")).toBeNull();
    expect(pathListLines(`${CWS}/icon-128.png\n`, "ts")).toBeNull();
    expect(pathListLines("\n\n")).toBeNull();
  });
});

describe("fileReferenceSpans", () => {
  it("adds the lines of fenced path lists after inline code", () => {
    const text = [
      "Icon `icon-128.png`:",
      "```",
      `${CWS}/screenshot-1-overview.png`,
      "```",
      "Run:",
      "```sh",
      "ls screenshots/",
      "```",
    ].join("\n");
    expect(fencedPathListLines(text)).toEqual([`${CWS}/screenshot-1-overview.png`]);
    expect(fileReferenceSpans(text)).toEqual(["icon-128.png", `${CWS}/screenshot-1-overview.png`]);
  });
});

describe("threadFileFolders", () => {
  it("lists folders outside the workspace, the latest message first", () => {
    const folders = threadFileFolders(
      [
        "Assets are in `~/Downloads/specwithcode-browser-cws/`.",
        `Saved \`/tmp/shots/a.png\` and \`${CWD}/src/app.ts\`.`,
      ],
      CWD,
    );
    expect(folders).toEqual(["/tmp/shots", CWS]);
  });
});

describe("resolveInlineCodeFileLinks with thread folders", () => {
  it("tries a bare name in the thread's folders before the workspace", () => {
    const links = resolveInlineCodeFileLinks(["promo-small-440x280.png"], CWD, CWD, [CWS]);
    const meta = links.get("promo-small-440x280.png")!;
    expect(meta.filePath).toBe(`${CWS}/promo-small-440x280.png`);
    expect(meta.candidates).toEqual([
      `${CWS}/promo-small-440x280.png`,
      `${CWD}/promo-small-440x280.png`,
    ]);
    expect(meta.search?.roots).toEqual([CWS, CWD]);
  });
});
