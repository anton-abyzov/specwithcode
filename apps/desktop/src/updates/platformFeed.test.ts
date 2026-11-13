import { describe, expect, it } from "vite-plus/test";

import { createReleaseFeedCache, type GitHubRelease } from "./githubReleaseFeed.ts";
import {
  platformManifestName,
  resolveUpdateFeed,
  selectFeedRelease,
  selectInsidersFeedRelease,
} from "./platformFeed.ts";

const release = (
  tagName: string,
  assets: string[],
  options: { draft?: boolean; prerelease?: boolean } = {},
): GitHubRelease => ({
  tagName,
  draft: options.draft ?? false,
  prerelease: options.prerelease ?? false,
  body: null,
  publishedAt: null,
  assets: assets.map((name, index) => ({ id: index + 1, name, size: 1 })),
});

const apiRelease = (tag: string, assets: string[], prerelease = false) => ({
  tag_name: tag,
  draft: false,
  prerelease,
  assets: assets.map((name, index) => ({ id: index + 1, name, size: 1 })),
});

const answering = (status: number, body: unknown) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
};

describe("platformManifestName", () => {
  it("names electron-builder's Windows and Linux manifests and nothing on macOS", () => {
    expect(platformManifestName("linux", "x64", "latest")).toBe("latest-linux.yml");
    expect(platformManifestName("linux", "arm64", "latest")).toBe("latest-linux-arm64.yml");
    expect(platformManifestName("win32", "x64", "latest")).toBe("latest.yml");
    expect(platformManifestName("darwin", "arm64", "latest")).toBeNull();
  });
});

describe("selectFeedRelease", () => {
  it("leaves the github provider alone when the newest release has the feed", () => {
    const releases = [
      release("v1.0.116", ["latest-mac.yml", "latest-linux.yml"]),
      release("v1.0.107", ["latest-mac.yml", "latest-linux.yml"]),
    ];
    expect(selectFeedRelease(releases, "latest-linux.yml")).toBeNull();
  });

  it("picks the newest release with the feed when the newest has none", () => {
    const releases = [
      release("v1.0.116", ["latest-mac.yml"]),
      release("v1.0.92", ["latest-mac.yml", "latest-linux.yml"]),
      release("v1.0.107", ["latest-mac.yml", "latest-linux.yml"]),
    ];
    expect(selectFeedRelease(releases, "latest-linux.yml")).toEqual({
      tagName: "v1.0.107",
      version: "1.0.107",
    });
  });

  it("skips drafts and prereleases on both sides", () => {
    const releases = [
      release("v1.0.120", ["latest-linux.yml"], { draft: true }),
      release("v1.0.119-nightly.1", ["latest-linux.yml"]),
      release("v1.0.118", ["latest-linux.yml"], { prerelease: true }),
      release("v1.0.116", ["latest-mac.yml"]),
      release("v1.0.107", ["latest-linux.yml"]),
    ];
    expect(selectFeedRelease(releases, "latest-linux.yml")?.tagName).toBe("v1.0.107");
  });

  it("returns null when no release has the feed", () => {
    expect(selectFeedRelease([release("v1.0.116", ["latest-mac.yml"])], "latest.yml")).toBeNull();
  });
});

describe("resolveUpdateFeed", () => {
  const base = {
    owner: "anton-abyzov",
    repo: "specwithcode",
    platform: "linux",
    arch: "x64",
    isDebPackage: false,
  };

  it("points the generic provider at the newest release with this platform's feed", async () => {
    const { calls, fetchImpl } = answering(200, [
      apiRelease("v1.0.116", ["latest-mac.yml"]),
      apiRelease("v1.0.107", ["latest-linux.yml"]),
    ]);
    const result = await resolveUpdateFeed({
      ...base,
      token: "gho_secret",
      channel: "latest",
      fetchImpl,
      cache: createReleaseFeedCache(),
    });
    expect(result).toEqual({
      feed: {
        provider: "generic",
        url: "https://github.com/anton-abyzov/specwithcode/releases/download/v1.0.107",
        useMultipleRangeRequest: false,
      },
      fallbackTag: "v1.0.107",
    });
    // The list is read anonymously: the sign-in never goes to this request.
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("keeps the github provider, with the sign-in, when the newest release has the feed", async () => {
    const { fetchImpl } = answering(200, [apiRelease("v1.0.116", ["latest-linux.yml"])]);
    const result = await resolveUpdateFeed({
      ...base,
      token: "gho_secret",
      channel: "latest",
      fetchImpl,
      cache: createReleaseFeedCache(),
    });
    expect(result).toEqual({
      feed: {
        provider: "github",
        owner: "anton-abyzov",
        repo: "specwithcode",
        private: true,
        token: "gho_secret",
      },
      fallbackTag: null,
    });
  });

  it("leaves the sign-in out of a .deb install's feed, on every channel", async () => {
    const { fetchImpl } = answering(200, [apiRelease("v1.0.116", ["latest-linux.yml"])]);
    const stable = await resolveUpdateFeed({
      ...base,
      token: "gho_secret",
      channel: "latest",
      isDebPackage: true,
      fetchImpl,
      cache: createReleaseFeedCache(),
    });
    expect(stable).toEqual({
      feed: { provider: "github", owner: "anton-abyzov", repo: "specwithcode" },
      fallbackTag: null,
    });
    const insiders = await resolveUpdateFeed({
      ...base,
      token: "gho_secret",
      channel: "nightly",
      isDebPackage: true,
      fetchImpl,
      cache: createReleaseFeedCache(),
    });
    expect(insiders.feed).not.toHaveProperty("token");
    expect(insiders.fallbackTag).toBe("v1.0.116");
  });

  it("points Insiders at the newest build, prerelease or not, and Stable past it", async () => {
    const { fetchImpl } = answering(200, [
      apiRelease("v1.1.3", ["latest-linux.yml"], true),
      apiRelease("v1.1.0", ["latest-linux.yml"]),
    ]);
    const insiders = await resolveUpdateFeed({
      ...base,
      token: null,
      channel: "nightly",
      fetchImpl,
      cache: createReleaseFeedCache(),
    });
    expect(insiders).toEqual({
      feed: {
        provider: "generic",
        url: "https://github.com/anton-abyzov/specwithcode/releases/download/v1.1.3",
        useMultipleRangeRequest: false,
      },
      fallbackTag: "v1.1.3",
    });
    const stable = await resolveUpdateFeed({
      ...base,
      token: null,
      channel: "latest",
      fetchImpl,
      cache: createReleaseFeedCache(),
    });
    expect(stable.feed).toEqual({
      provider: "github",
      owner: "anton-abyzov",
      repo: "specwithcode",
    });
  });

  it("keeps the github provider when the list cannot be read anonymously", async () => {
    const { fetchImpl } = answering(404, { message: "Not Found" });
    const result = await resolveUpdateFeed({
      ...base,
      token: null,
      channel: "latest",
      fetchImpl,
      cache: createReleaseFeedCache(),
    });
    expect(result.feed).toEqual({
      provider: "github",
      owner: "anton-abyzov",
      repo: "specwithcode",
    });
    expect(result.fallbackTag).toBeNull();
  });

  it("never asks on macOS, where the swap updater lists releases itself", async () => {
    const { calls, fetchImpl } = answering(200, []);
    for (const channel of ["latest", "nightly"]) {
      await resolveUpdateFeed({ ...base, platform: "darwin", token: null, channel, fetchImpl });
    }
    expect(calls).toHaveLength(0);
  });
});

describe("selectInsidersFeedRelease", () => {
  it("takes the newest plain release with the feed, prerelease or not, never a draft", () => {
    const releases = [
      release("v1.1.4", ["latest-linux.yml"], { draft: true }),
      release("v1.1.3", ["latest-mac.yml"], { prerelease: true }),
      release("v1.1.2", ["latest-linux.yml"], { prerelease: true }),
      release("v1.1.0", ["latest-linux.yml"]),
      release("v1.1.9-nightly.1", ["latest-linux.yml"], { prerelease: true }),
    ];
    expect(selectInsidersFeedRelease(releases, "latest-linux.yml")).toEqual({
      tagName: "v1.1.2",
      version: "1.1.2",
    });
    expect(selectInsidersFeedRelease(releases, "latest.yml")).toBeNull();
  });
});
