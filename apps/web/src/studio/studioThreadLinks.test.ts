import { describe, expect, it } from "vite-plus/test";

import {
  formatStudioThreadHref,
  formatStudioThreadLink,
  parseStudioThreadHref,
  resolveStudioThreadHref,
  resolveStudioThreadLink,
} from "./studioThreadLinks";

// The shape a delegated worker's ID has on a real host: `%3A` is part of the ID.
const DELEGATED = "thread:delegated-task:command%3Amcp%3Aa1b2%3Adelegate-task%3Areview-landing";

describe("parseStudioThreadHref", () => {
  it("offers the ID decoded once, then the segment as written", () => {
    expect(parseStudioThreadHref("studio://thread/thread%3Amcp%3Aa%3Ab%3A0")).toEqual([
      "thread:mcp:a:b:0",
      "thread%3Amcp%3Aa%3Ab%3A0",
    ]);
    expect(parseStudioThreadHref("studio://thread/plain")).toEqual(["plain"]);
    expect(parseStudioThreadHref("studio://thread/Fix%20the%20login")).toEqual([
      "Fix the login",
      "Fix%20the%20login",
    ]);
  });
  it("round-trips the canonical href to the stored ID", () => {
    expect(parseStudioThreadHref(formatStudioThreadHref(DELEGATED))?.[0]).toBe(DELEGATED);
  });
  it.each([
    "https://example.com",
    "studio-context://v1/thread/a",
    "studio://thread/",
    "studio://thread/a/b",
    "studio://thread/../a",
    "studio://thread/a?x=1",
    "studio://thread/a#run",
    "studio://thread/a\\b",
    "studio://thread/%2e%2e%2f",
    "studio://thread/a%0Ab%0A",
  ])("rejects %s or keeps only a safe raw segment", (href) => {
    const candidates = parseStudioThreadHref(href) ?? [];
    for (const candidate of candidates) {
      expect(candidate).not.toMatch(/[/\\\u0000-\u001f\u007f]/);
      expect(candidate === "." || candidate === "..").toBe(false);
    }
    if (!href.startsWith("studio://thread/") || /[/?#\\]/.test(href.slice(16)))
      expect(parseStudioThreadHref(href)).toBeNull();
  });
  it("never decodes a control character or a path into an ID", () => {
    expect(parseStudioThreadHref("studio://thread/a%0Ab")).toEqual(["a%0Ab"]);
    expect(parseStudioThreadHref("studio://thread/worker%2F1")).toEqual(["worker%2F1"]);
    expect(parseStudioThreadHref("studio://thread/%2e%2e")).toEqual(["%2e%2e"]);
  });
});

describe("formatStudioThreadLink", () => {
  it("strips what would break the Markdown label", () => {
    expect(formatStudioThreadLink(DELEGATED, "Fix [the]\nlogin")).toBe(
      `[Fix the login](studio://thread/${encodeURIComponent(DELEGATED)})`,
    );
    expect(formatStudioThreadLink("t", "  ")).toBe("[thread](studio://thread/t)");
  });
});

describe("resolveStudioThreadLink", () => {
  const thread = (id: string, title: string, overrides: Record<string, unknown> = {}) => ({
    id: id as never,
    environmentId: "host" as never,
    title,
    deletedAt: null as string | null,
    ...overrides,
  });
  const threads = [
    thread(DELEGATED, "Review the landing page"),
    thread("worker", "Fix the login"),
    thread("twin-1", "Twin"),
    thread("twin-2", "Twin"),
    thread("gone", "Gone", { deletedAt: "2026-10-11T00:00:00Z" }),
    thread("remote", "Remote", { environmentId: "laptop" }),
  ];
  const resolve = (href: string, label = "x") =>
    resolveStudioThreadHref(threads, href, label, "host");
  it("opens a raw ID whose %3A is part of the ID, as an agent pastes it", () => {
    expect(resolve(`studio://thread/${DELEGATED}`)).toMatchObject({
      kind: "thread",
      id: DELEGATED,
    });
  });
  it("opens the canonical, encoded-once ID (%253A)", () => {
    const href = formatStudioThreadHref(DELEGATED);
    expect(href).toContain("%253A");
    expect(resolve(href)).toMatchObject({ kind: "thread", id: DELEGATED });
  });
  it("falls back to a title only one thread has, the target's then the label's", () => {
    expect(resolve("studio://thread/Fix%20the%20login")).toMatchObject({ id: "worker" });
    expect(resolve("studio://thread/nope", "Fix the login")).toMatchObject({ id: "worker" });
    expect(resolve("studio://thread/Twin", "Twin")).toEqual({ kind: "missing" });
  });
  it("keeps opening a renamed thread by its ID", () => {
    const renamed = threads.map((t) => (t.id === DELEGATED ? { ...t, title: "Renamed" } : t));
    expect(
      resolveStudioThreadHref(
        renamed,
        formatStudioThreadHref(DELEGATED),
        "Review the landing page",
        "host",
      ),
    ).toMatchObject({ kind: "thread", id: DELEGATED });
  });
  it("says when the thread was deleted or is not on this machine", () => {
    expect(resolve("studio://thread/gone", "Gone")).toEqual({ kind: "deleted" });
    expect(resolve("studio://thread/missing")).toEqual({ kind: "missing" });
    expect(resolve("studio://thread/remote", "Remote")).toEqual({ kind: "missing" });
  });
  it("finds another project's thread when no environment filter applies", () => {
    expect(resolveStudioThreadLink(threads, ["remote"], "Remote")).toMatchObject({ id: "remote" });
  });
  it("never opens a live thread by title when the ID names a deleted one", () => {
    const retried = [
      ...threads,
      thread("first-try", "Retry me", { deletedAt: "2026-10-11T00:00:00Z" }),
      thread("second-try", "Retry me"),
    ];
    expect(
      resolveStudioThreadHref(retried, "studio://thread/first-try", "Retry me", "host"),
    ).toEqual({ kind: "deleted" });
  });
  it("keeps a link to a known thread outside the subset with that thread, not a title match", () => {
    // One project's workers, and the environment's other threads a link may name.
    const workers = [thread("worker", "Fix the login")];
    const environment = [...threads, thread("other-project", "Fix the login")];
    expect(
      resolveStudioThreadLink(workers, ["other-project"], "Fix the login", null, environment),
    ).toEqual({ kind: "elsewhere" });
    expect(resolveStudioThreadLink(workers, ["gone"], "Fix the login", null, environment)).toEqual({
      kind: "deleted",
    });
    expect(
      resolveStudioThreadLink(workers, ["nope"], "Fix the login", null, environment),
    ).toMatchObject({ kind: "thread", id: "worker" });
  });
});
