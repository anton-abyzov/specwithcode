import { describe, expect, it } from "vite-plus/test";
import type { RepositoryIdentity } from "@specweave-studio/contracts";
import {
  alternateFolder,
  defaultDestinationFolder,
  existingCopyOn,
  type CopyCandidate,
} from "./existingCopy.ts";

const repo = (rootPath: string, key = "github.com/acme/app"): RepositoryIdentity =>
  ({
    canonicalKey: key,
    locator: { source: "git-remote", remoteName: "origin", remoteUrl: `git@${key}.git` },
    rootPath,
  }) as RepositoryIdentity;

const copy = (
  id: string,
  workspaceRoot: string,
  identity: RepositoryIdentity | null,
  logical?: string,
): CopyCandidate => ({
  id,
  workspaceRoot,
  repositoryIdentity: identity,
  workspaceSettings: logical ? { logicalProject: { id: logical } } : null,
});

describe("existingCopyOn", () => {
  const source = copy("s", "/Users/a/app", repo("/Users/a/app"), "logical-app");

  it("never matches a record whose repository root is unknown", () => {
    // A stale record of a subfolder (no root recorded) is not the source's root checkout.
    const stale = copy("stale", "/home/b/app/packages/web", {
      ...repo("/home/b/app"),
      rootPath: undefined,
    } as RepositoryIdentity);
    expect(existingCopyOn({ source, candidates: [stale] })).toEqual({ kind: "none" });
  });

  it("takes the linked copy before any same-repository checkout", () => {
    const linked = copy("l", "/home/b/elsewhere", null, "logical-app");
    const same = copy("r", "/home/b/app", repo("/home/b/app"));
    expect(existingCopyOn({ source, candidates: [same, linked] })).toEqual({
      kind: "linked",
      copy: linked,
    });
    expect(existingCopyOn({ source, candidates: [same], linkedId: "r" })).toEqual({
      kind: "linked",
      copy: same,
    });
  });

  it("uses one checkout of the same repository at the same place, else asks", () => {
    const one = copy("r1", "/home/b/app", repo("/home/b/app", "GitHub.com/Acme/App"));
    expect(existingCopyOn({ source, candidates: [one] })).toEqual({
      kind: "same-repository",
      copy: one,
    });
    const two = copy("r2", "/home/b/app-2", repo("/home/b/app-2"));
    expect(existingCopyOn({ source, candidates: [one, two] })).toEqual({
      kind: "several",
      copies: [one, two],
    });
  });

  it("never matches another place in the repository, another repository or a folder name", () => {
    const inside = copy("sub", "/home/b/mono/app", repo("/home/b/mono"));
    const other = copy("o", "/home/b/app", repo("/home/b/app", "github.com/acme/other"));
    const plain = copy("p", "/home/b/app", null);
    expect(existingCopyOn({ source, candidates: [inside, other, plain] })).toEqual({
      kind: "none",
    });
  });

  it("does not guess when the source's place in its repository is unknown", () => {
    const unknown = copy("s", "/Users/a/app", {
      ...repo("/Users/a/app"),
      rootPath: undefined,
    } as unknown as RepositoryIdentity);
    const there = copy("r", "/home/b/app", repo("/home/b/app"));
    expect(existingCopyOn({ source: unknown, candidates: [there] })).toEqual({ kind: "none" });
  });
});

describe("defaultDestinationFolder", () => {
  it("puts the folder in the destination's projects folder when it has one", () => {
    expect(defaultDestinationFolder("/Users/a/Projects/github/specweave", "/home/b/Projects")).toBe(
      "/home/b/Projects/specweave",
    );
    expect(defaultDestinationFolder("/Users/a/app/", "C:\\Users\\b\\Projects\\")).toBe(
      "C:\\Users\\b\\Projects\\app",
    );
  });

  it.each([
    ["/Users/x/a/b", "~/a/b"],
    ["/home/x/a", "~/a"],
    ["C:\\Users\\x\\a", "~/a"],
    ["/opt/a", "~/a"],
    ["/Users/x/a/", "~/a"],
    ["~/work/app", "~/work/app"],
  ])("without one, mirrors %s to %s", (source, expected) => {
    expect(defaultDestinationFolder(source)).toBe(expected);
  });

  it("suggests the next free name for an occupied folder", () => {
    expect(alternateFolder("~/a")).toBe("~/a-2");
    expect(alternateFolder("~/a-2")).toBe("~/a-3");
  });
});
