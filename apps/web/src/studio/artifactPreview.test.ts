// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";

import {
  ArtifactPreviewCache,
  ArtifactPreviewSlots,
  artifactPreviewFormat,
  artifactPreviewKey,
  markdownPreviewLines,
  plainPreviewLines,
} from "./artifactPreview";
import { documentPreview, inertPageMarkup } from "./artifactPreviewRaster";
import type { ProjectArtifact } from "./projectArtifacts";

const artifact = (over: Partial<ProjectArtifact>): ProjectArtifact => ({
  id: "x",
  kind: "document",
  source: "output",
  title: "x",
  updatedAt: 1,
  path: "reports/a.md",
  root: null,
  url: null,
  byteLength: 10,
  thread: null,
  increment: null,
  design: null,
  pullRequestState: null,
  pullRequestNumber: null,
  pullRequestRepository: null,
  missing: false,
  pinned: false,
  ...over,
});

describe("artifactPreviewFormat", () => {
  it("names what a file previews as", () => {
    expect(artifactPreviewFormat(artifact({}))).toBe("markdown");
    expect(artifactPreviewFormat(artifact({ path: "a.txt" }))).toBe("text");
    expect(artifactPreviewFormat(artifact({ kind: "page", path: "a.html" }))).toBe("html");
    expect(artifactPreviewFormat(artifact({ kind: "data", path: "a.json" }))).toBe("text");
    expect(artifactPreviewFormat(artifact({ kind: "image", path: "a.png" }))).toBe("image");
  });

  it("reads nothing for what has no file, is gone, is too big or is outside the project", () => {
    expect(artifactPreviewFormat(artifact({ kind: "pullRequest", path: null }))).toBeNull();
    expect(artifactPreviewFormat(artifact({ missing: true }))).toBeNull();
    expect(artifactPreviewFormat(artifact({ byteLength: 513 * 1024 }))).toBeNull();
    expect(artifactPreviewFormat(artifact({ path: "/tmp/a.md" }))).toBeNull();
    expect(artifactPreviewFormat(artifact({ path: "C:\\a.md" }))).toBeNull();
    expect(artifactPreviewFormat(artifact({ path: "a.pdf" }))).toBeNull();
    expect(
      artifactPreviewFormat(artifact({ kind: "image", path: "a.png", byteLength: 25 * 1048576 })),
    ).toBeNull();
  });
});

describe("preview lines", () => {
  it("strips markdown down to headings and plain text", () => {
    expect(
      markdownPreviewLines("---\nid: 1\n---\n# Title\n\n- **Bold** [link](https://x)\n```\ncode"),
    ).toEqual([{ text: "Title", heading: 1 }, { text: "Bold link" }, { text: "code" }]);
  });

  it("caps lines and their width", () => {
    const lines = plainPreviewLines(`${"x".repeat(400)}\n${"y\n".repeat(50)}`);
    expect(lines).toHaveLength(14);
    expect(lines[0]?.text).toHaveLength(120);
  });
});

it("has nothing to show for a file with no text", async () => {
  expect(await documentPreview("---\nid: 1\n---\n<!-- note -->\n", "markdown")).toEqual({
    type: "none",
  });
  expect(await documentPreview("  \n", "text")).toEqual({ type: "none" });
});

describe("inertPageMarkup", () => {
  it("leaves nothing that runs or loads", () => {
    const page = inertPageMarkup(
      `<html><head><link rel="stylesheet" href="https://x/a.css"><base href="https://x"><meta http-equiv="refresh" content="0;url=https://x"></head>
       <body onload="bad()"><script>bad()</script><iframe src="https://x"></iframe><object data="https://x"></object>
       <a href="#" onclick="bad()" OnMouseOver="bad()">Link</a></body></html>`,
    )!;
    expect(page.markup).not.toMatch(/<script|<iframe|<object|<link|<base|<meta|\bon[a-z]+=|bad\(/i);
    expect(page.markup).toContain("Link");
    expect(page.text).toContain("Link");
  });

  it("is well-formed XHTML even from broken markup", () => {
    const page = inertPageMarkup("<p>one<br>two<img src=x><div>unclosed")!;
    const parsed = new DOMParser().parseFromString(page.markup, "application/xhtml+xml");
    expect(parsed.querySelector("parsererror")).toBeNull();
  });
});

it("gives a changed file a new key", () => {
  const before = artifactPreviewKey(artifact({ updatedAt: 1 }), "s");
  expect(artifactPreviewKey(artifact({ updatedAt: 2 }), "s")).not.toBe(before);
  expect(artifactPreviewKey(artifact({ byteLength: 11 }), "s")).not.toBe(before);
  expect(artifactPreviewKey(artifact({ root: "/wt" }), "s")).not.toBe(before);
  expect(artifactPreviewKey(artifact({}), "other")).not.toBe(before);
});

describe("ArtifactPreviewCache", () => {
  const image = (bytes: number) => ({ type: "image", src: "x".repeat(bytes) }) as const;

  it("drops the least recently used past its byte limit", () => {
    const cache = new ArtifactPreviewCache(300);
    cache.set("a", image(100));
    cache.set("b", image(100));
    cache.set("c", image(100));
    cache.touch("a");
    cache.set("d", image(100));
    expect(cache.peek("a")).toBeDefined();
    expect(cache.peek("b")).toBeUndefined();
    expect(cache.stats()).toEqual({ entries: 3, bytes: 300 });
  });

  it("keeps a preview larger than the limit until the next one", () => {
    const cache = new ArtifactPreviewCache(50);
    cache.set("a", image(100));
    expect(cache.peek("a")).toBeDefined();
    cache.set("b", image(10));
    expect(cache.peek("a")).toBeUndefined();
  });

  it("counts a replaced entry once and tells only its own listeners", () => {
    const cache = new ArtifactPreviewCache(1000);
    const own = vi.fn();
    const other = vi.fn();
    const stop = cache.subscribe("a", own);
    cache.subscribe("b", other);
    cache.set("a", image(100));
    cache.set("a", image(200));
    expect(cache.stats().bytes).toBe(200);
    expect(own).toHaveBeenCalledTimes(2);
    expect(other).not.toHaveBeenCalled();
    stop();
    cache.set("a", image(10));
    expect(own).toHaveBeenCalledTimes(2);
  });
});

describe("ArtifactPreviewSlots", () => {
  it("runs at most its limit, newest waiting first, and forgets a cancelled wait", () => {
    const slots = new ArtifactPreviewSlots(1);
    const order: string[] = [];
    const first = slots.acquire(() => order.push("first"));
    const second = slots.acquire(() => order.push("second"));
    const third = slots.acquire(() => order.push("third"));
    const fourth = slots.acquire(() => order.push("fourth"));
    expect(order).toEqual(["first"]);
    third();
    first();
    first();
    expect(order).toEqual(["first", "fourth"]);
    fourth();
    expect(order).toEqual(["first", "fourth", "second"]);
    second();
  });
});
