import { describe, expect, it } from "vite-plus/test";

import {
  expandBraceShorthand,
  fileReferenceSpans,
  matchesFileNamePattern,
  pathListLines,
  resolveInlineCodeFileLinkMeta,
  resolveInlineCodeFileLinks,
  threadFileFolders,
} from "./markdown-links";
import {
  collectThreadArtifacts,
  settleThreadArtifacts,
  type ThreadArtifact,
} from "./threadArtifacts";

const CWD = "/Users/me/Projects/github/specweave";
const AUDIT = "/Users/me/.specwithcode/audits/2026-10-20";
// The coordinator report of October 20, 2026, as the worker wrote it.
const REPORT =
  "I've routed follow-ups to 15 owner threads; batch A is still running. Findings so far are in `~/.specwithcode/audits/2026-10-20/findings-{B,C,D,E}.md`.";

describe("expandBraceShorthand", () => {
  it("writes out lists, ranges and nested groups as the shell does", () => {
    expect(expandBraceShorthand("findings-{B,C,D,E}.md")).toEqual([
      "findings-B.md",
      "findings-C.md",
      "findings-D.md",
      "findings-E.md",
    ]);
    expect(expandBraceShorthand("findings-{A..C}.md")).toEqual([
      "findings-A.md",
      "findings-B.md",
      "findings-C.md",
    ]);
    expect(expandBraceShorthand("shot-{01..03}.png")).toEqual([
      "shot-01.png",
      "shot-02.png",
      "shot-03.png",
    ]);
    expect(expandBraceShorthand("a/{x,y/{1,2}}.md")).toEqual(["a/x.md", "a/y/1.md", "a/y/2.md"]);
    expect(expandBraceShorthand("icon{,-dark}.svg")).toEqual(["icon.svg", "icon-dark.svg"]);
  });

  it("leaves variables, placeholders and plain text alone", () => {
    expect(expandBraceShorthand("${HOME}/notes.md")).toBeNull();
    expect(expandBraceShorthand("routes/{id}/page.tsx")).toBeNull();
    expect(expandBraceShorthand("notes.md")).toBeNull();
    expect(expandBraceShorthand("a{b")).toBeNull();
  });

  it("refuses shorthand wider than a list of files", () => {
    expect(expandBraceShorthand("log-{1..500}.txt")).toEqual([]);
    expect(expandBraceShorthand("{a,b,c,d}{a,b,c,d}{a,b,c}.md")).toEqual([]);
  });
});

describe("shorthand file links", () => {
  it("links each file of the October 20 report, never the shorthand", () => {
    const meta = resolveInlineCodeFileLinks(fileReferenceSpans(REPORT), CWD).get(
      "~/.specwithcode/audits/2026-10-20/findings-{B,C,D,E}.md",
    );
    expect(meta?.expansions?.map((file) => file.filePath)).toEqual([
      `${AUDIT}/findings-B.md`,
      `${AUDIT}/findings-C.md`,
      `${AUDIT}/findings-D.md`,
      `${AUDIT}/findings-E.md`,
    ]);
    expect(meta?.expansions?.every((file) => !file.filePath.includes("{"))).toBe(true);
    // The written path stays on the link so the host can still find a file
    // really named that way.
    expect(meta?.filePath).toBe(`${AUDIT}/findings-{B,C,D,E}.md`);
  });

  it("resolves a lone span the same way when no message map has it", () => {
    const meta = resolveInlineCodeFileLinkMeta(`${AUDIT}/findings-{A,E}.md`, CWD);
    expect(meta?.expansions?.map((file) => file.basename)).toEqual([
      "findings-A.md",
      "findings-E.md",
    ]);
  });

  it("puts bare shorthand names beside the files the message names", () => {
    const text = `Inventory: \`${AUDIT}/INVENTORY.md\`, per batch \`findings-{A,B}.md\`.`;
    const meta = resolveInlineCodeFileLinks(fileReferenceSpans(text), CWD).get("findings-{A,B}.md");
    expect(meta?.expansions?.map((file) => file.filePath)).toEqual([
      `${AUDIT}/findings-A.md`,
      `${AUDIT}/findings-B.md`,
    ]);
    expect(meta?.expansions?.[0]?.candidates).toEqual([
      `${AUDIT}/findings-A.md`,
      `${CWD}/findings-A.md`,
    ]);
  });

  it("does not link shorthand that names words rather than files", () => {
    expect(resolveInlineCodeFileLinkMeta("{a,b}", CWD)).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("log-{1..500}.txt", CWD)).toBeNull();
  });

  it("settles a basename glob on the host and never links the pattern itself", () => {
    const meta = resolveInlineCodeFileLinkMeta(`${AUDIT}/findings-*.md`, CWD);
    expect(meta?.glob).toEqual({ folder: AUDIT, pattern: "findings-*.md" });
    expect(meta?.expansions).toBeUndefined();
    expect(resolveInlineCodeFileLinkMeta("src/*/index.ts", CWD)).toBeNull();
    expect(matchesFileNamePattern("findings-B.md", "findings-*.md")).toBe(true);
    expect(matchesFileNamePattern("findings-B.mdx", "findings-*.md")).toBe(false);
    expect(matchesFileNamePattern("a+b.md", "a+*.md")).toBe(true);
  });

  it("lists every file of a shorthand line in a fenced path list", () => {
    expect(pathListLines(`${AUDIT}/findings-{B,C}.md\nfindings-{D,E}.md`)).toEqual([
      `${AUDIT}/findings-{B,C}.md`,
      "findings-{D,E}.md",
    ]);
  });

  it("takes folders from the files shorthand names, not the shorthand", () => {
    expect(threadFileFolders(["See `/tmp/{a,b}/report.md`."], CWD)).toEqual(["/tmp/b", "/tmp/a"]);
  });

  it("gives the Artifacts strip the same files as the chat", () => {
    const authored = collectThreadArtifacts([{ id: "m1", text: REPORT }], CWD);
    const artifacts = settleThreadArtifacts(authored, new Map());
    expect(artifacts.map((artifact) => artifact.name)).toEqual([
      "findings-E.md",
      "findings-D.md",
      "findings-C.md",
      "findings-B.md",
    ]);
  });
});

describe("shorthand edge cases from review", () => {
  it("leaves brace shorthand of patterns unlinked", () => {
    expect(resolveInlineCodeFileLinkMeta(`${AUDIT}/shot-{1,2}-*.png`, CWD)).toBeNull();
  });

  it("gives the Artifacts strip a pattern to settle on the host", () => {
    const [artifact] = collectThreadArtifacts(
      [{ id: "m1", text: `All: \`${AUDIT}/findings-*.md\`.` }],
      CWD,
    );
    expect(artifact && "meta" in artifact ? artifact.meta.glob : null).toEqual({
      folder: AUDIT,
      pattern: "findings-*.md",
    });
  });
});

describe("Artifacts strip settles shorthand on the host, as the chat does", () => {
  const meta = (artifact: ThreadArtifact | undefined) =>
    artifact && "meta" in artifact ? artifact.meta : null;

  it("drops an expansion the host does not have", () => {
    const text = `Findings: \`${AUDIT}/findings-{E,F}.md\`.`;
    const [authored] = collectThreadArtifacts([{ id: "m1", text }], CWD);
    const written = meta(authored)!;
    // What `useExistingFileLinks` returns when only findings-E.md exists.
    const [e, f] = written.expansions!;
    const settled = new Map([
      [
        authored!.key,
        {
          ...written,
          expansions: [e!, { ...f!, unresolved: [`${AUDIT}/findings-F.md`] }],
        },
      ],
    ]);
    expect(settleThreadArtifacts([authored!], settled).map((artifact) => artifact.name)).toEqual([
      "findings-E.md",
    ]);
  });

  it("keeps a file really named with braces as that one file", () => {
    const text = `Template: \`${AUDIT}/report-{name}.md\` and \`${AUDIT}/a{1,2}.md\`.`;
    const authored = collectThreadArtifacts([{ id: "m1", text }], CWD);
    const shorthand = authored.find((artifact) => meta(artifact)?.expansions)!;
    const literal = resolveInlineCodeFileLinkMeta(`${AUDIT}/a1.md`, CWD)!;
    // The host has a file named `a{1,2}.md`, so the shorthand settles to it.
    const settled = new Map([
      [shorthand.key, { ...literal, filePath: `${AUDIT}/a{1,2}.md`, basename: "a{1,2}.md" }],
    ]);
    const names = settleThreadArtifacts(authored, settled).map((artifact) => artifact.name);
    expect(names).toContain("a{1,2}.md");
    expect(names).not.toContain("a1.md");
    expect(names).not.toContain("a2.md");
  });

  it("lists a file named on its own and in shorthand once", () => {
    const text = `See \`${AUDIT}/findings-B.md\`, then all of \`${AUDIT}/findings-{B,C}.md\`.`;
    const authored = collectThreadArtifacts([{ id: "m1", text }], CWD);
    const names = settleThreadArtifacts(authored, new Map()).map((artifact) => artifact.name);
    expect(names.toSorted()).toEqual(["findings-B.md", "findings-C.md"]);
  });
});

describe("single-character glob", () => {
  it("reads `?` as one character, settled on the host like `*`", () => {
    expect(resolveInlineCodeFileLinkMeta(`${AUDIT}/findings-?.md`, CWD)?.glob).toEqual({
      folder: AUDIT,
      pattern: "findings-?.md",
    });
    expect(matchesFileNamePattern("findings-A.md", "findings-?.md")).toBe(true);
    expect(matchesFileNamePattern("findings-AB.md", "findings-?.md")).toBe(false);
    expect(matchesFileNamePattern("findings-A.md", "findings-*.md")).toBe(true);
    expect(matchesFileNamePattern("findings-(1).md", "findings-(?).md")).toBe(true);
  });
});
