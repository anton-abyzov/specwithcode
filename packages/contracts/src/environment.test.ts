import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor, repositoryRelativePathOf } from "./environment.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;

describe("ExecutionEnvironmentDescriptor", () => {
  it("decodes old, recognized and future manual installation descriptors", () => {
    expect(decodeDescriptor(descriptor).capabilities.serverInstallation).toBeUndefined();
    for (const installation of [{ kind: "npx" }, { kind: "npm-global", prefix: "/opt/node" }]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toEqual(installation);
    }
    for (const installation of [{ kind: "future-manager" }, { kind: "npm-global" }]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toBeUndefined();
    }
  });
  it("requires an advertised required-worktree bootstrap capability", () => {
    expect(decodeDescriptor(descriptor).capabilities.requiredWorktreeBootstrap).toBeUndefined();
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, requiredWorktreeBootstrap: true },
      }).capabilities.requiredWorktreeBootstrap,
    ).toBe(true);
  });

  it("decodes a descriptor with and without linkedMembersSync", () => {
    expect(decodeDescriptor(descriptor).capabilities.linkedMembersSync).toBeUndefined();
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, linkedMembersSync: true },
      }).capabilities.linkedMembersSync,
    ).toBe(true);
  });

  it("treats a missing pull-request capability as unsupported under version skew", () => {
    expect(decodeDescriptor(descriptor).capabilities.pullRequests).toBeUndefined();
  });

  it("preserves an advertised pull-request capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, pullRequests: true },
      }).capabilities.pullRequests,
    ).toBe(true);
  });

  it("treats a missing attachment upload capability as unsupported", () => {
    expect(decodeDescriptor(descriptor).capabilities.attachmentUploads).toBeUndefined();
  });

  it("preserves an advertised attachment upload capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, attachmentUploads: true },
      }).capabilities.attachmentUploads,
    ).toBe(true);
  });

  it("preserves the server's generic attachment upload limit", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          fileAttachments: { maxUploadBytes: 50 * 1024 * 1024 },
        },
      }).capabilities.fileAttachments,
    ).toEqual({ maxUploadBytes: 50 * 1024 * 1024 });
  });

  it("treats missing server-resolved command context as unsupported", () => {
    expect(decodeDescriptor(descriptor).capabilities.serverResolvedCommandContext).toBeUndefined();
  });

  it("preserves advertised server-resolved command context", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          serverResolvedCommandContext: true,
        },
      }).capabilities.serverResolvedCommandContext,
    ).toBe(true);
  });
});

it("exposes an optional authoritative managed-worktree root", () => {
  expect(decodeDescriptor(descriptor).defaultWorktreesDirectory).toBeUndefined();
  expect(
    decodeDescriptor({
      ...descriptor,
      defaultWorktreesDirectory: "/private/app/worktrees",
      capabilities: { worktreeLocationMode: true },
    }).defaultWorktreesDirectory,
  ).toBe("/private/app/worktrees");
});

describe("repositoryRelativePathOf", () => {
  it("places a folder inside its repository", () => {
    expect(repositoryRelativePathOf("/Users/a/mono", "/Users/a/mono")).toBe("");
    expect(repositoryRelativePathOf("/Users/a/mono/apps/web/", "/Users/a/mono")).toBe("apps/web");
    expect(repositoryRelativePathOf("C:\\src\\mono\\apps", "C:\\src\\mono")).toBe("apps");
  });

  it("matches a root git reports with the home link resolved", () => {
    const root = "/srv/work/github/specweave-umb/repositories/anton-abyzov/specweave";
    expect(
      repositoryRelativePathOf(
        "/home/anton/Projects/github/specweave-umb/repositories/anton-abyzov/specweave",
        root,
      ),
    ).toBe("");
    expect(
      repositoryRelativePathOf(
        "/home/anton/Projects/github/specweave-umb/repositories/anton-abyzov/specweave/docs",
        root,
      ),
    ).toBe("docs");
  });

  it("matches a repository right below the linked folder", () => {
    // /home/anton links to /srv/work, so git reports /srv/work/app for /home/anton/app.
    expect(repositoryRelativePathOf("/home/anton/app", "/srv/work/app")).toBe("");
    expect(repositoryRelativePathOf("/home/anton/app/docs", "/srv/work/app")).toBe("docs");
  });

  it("places a folder that repeats the repository's names", () => {
    expect(repositoryRelativePathOf("/home/u/a/lib/packages/a/lib", "/srv/a/lib")).toBe(
      "packages/a/lib",
    );
  });

  it("knows nothing without a root or with an unrelated folder", () => {
    expect(repositoryRelativePathOf("/Users/a/mono", undefined)).toBeNull();
    expect(repositoryRelativePathOf("/Users/a/other", "/srv/work/mono")).toBeNull();
  });
});
