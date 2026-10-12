import { describe, expect, it } from "vite-plus/test";

import {
  describeFeedError,
  fetchReleases,
  isPlainAssetName,
  macUpdateManifestName,
  openReleaseAsset,
  parseGitHubReleases,
  parseUpdateManifest,
  selectMacZip,
  selectNewestRelease,
  versionFromTag,
  type GitHubRelease,
} from "./githubReleaseFeed.ts";

const release = (
  tagName: string,
  options: { draft?: boolean; prerelease?: boolean; assets?: string[] } = {},
): GitHubRelease => ({
  tagName,
  draft: options.draft ?? false,
  prerelease: options.prerelease ?? false,
  body: null,
  publishedAt: null,
  assets: (options.assets ?? ["latest-mac.yml"]).map((name, index) => ({
    id: index + 1,
    name,
    size: 1,
  })),
});

const MANIFEST = `version: 0.2.1
files:
  - url: SpecWeave-Studio-0.2.1-arm64.zip
    sha512: abc==
    size: 120
  - url: SpecWeave-Studio-0.2.1-x64.zip
    sha512: def==
    size: 130
  - url: SpecWeave-Studio-0.2.1-arm64.dmg
    sha512: ghi==
    size: 140
path: SpecWeave-Studio-0.2.1-arm64.zip
sha512: abc==
releaseDate: '2026-10-10T05:00:00.000Z'
`;

describe("githubReleaseFeed", () => {
  it("names each channel's Mac manifest the way electron-builder does", () => {
    expect(macUpdateManifestName("latest")).toBe("latest-mac.yml");
    expect(macUpdateManifestName("nightly")).toBe("nightly-mac.yml");
  });

  it("reads versions from tags and skips anything else", () => {
    expect(versionFromTag("v0.2.1")).toBe("0.2.1");
    expect(versionFromTag("0.2.1-nightly.20261010.1")).toBe("0.2.1-nightly.20261010.1");
    expect(versionFromTag("nightly")).toBeNull();
    expect(versionFromTag("v1.0")).toBeNull();
  });

  it("parses releases and drops malformed entries and assets", () => {
    const parsed = parseGitHubReleases([
      {
        tag_name: "v0.2.1",
        draft: false,
        prerelease: true,
        body: "notes",
        published_at: "2026-10-10T00:00:00Z",
        assets: [
          { id: 7, name: "latest-mac.yml", size: 400 },
          { id: "x", name: 1 },
        ],
      },
      { name: "no tag" },
      "junk",
    ]);
    expect(parsed).toEqual([
      {
        tagName: "v0.2.1",
        draft: false,
        prerelease: true,
        body: "notes",
        publishedAt: "2026-10-10T00:00:00Z",
        assets: [{ id: 7, name: "latest-mac.yml", size: 400 }],
      },
    ]);
    expect(parseGitHubReleases({ message: "Not Found" })).toEqual([]);
  });

  it("takes the newest plain version even when GitHub flags it as a prerelease", () => {
    const selected = selectNewestRelease({
      releases: [
        release("v0.1.9"),
        release("v0.2.0", { prerelease: true }),
        release("v0.3.0", { draft: true }),
        release("v0.2.5-nightly.20261010.1"),
        release("v0.2.4", { assets: ["notes.txt"] }),
      ],
      currentVersion: "0.1.4",
      allowPrerelease: false,
      manifestName: "latest-mac.yml",
    });
    expect(selected?.version).toBe("0.2.0");
    expect(selected?.manifestAsset.name).toBe("latest-mac.yml");
  });

  it("accepts suffixed versions only when prereleases are allowed", () => {
    const releases = [release("v0.2.0"), release("v0.2.5-nightly.20261010.1")];
    expect(
      selectNewestRelease({
        releases,
        currentVersion: "0.1.4",
        allowPrerelease: true,
        manifestName: "latest-mac.yml",
      })?.version,
    ).toBe("0.2.5-nightly.20261010.1");
  });

  it("offers nothing at or below the running version", () => {
    expect(
      selectNewestRelease({
        releases: [release("v0.2.0"), release("v0.1.4")],
        currentVersion: "0.2.0",
        allowPrerelease: true,
        manifestName: "latest-mac.yml",
      }),
    ).toBeNull();
  });

  it("parses electron-builder manifests and picks the zip for this Mac", () => {
    const manifest = parseUpdateManifest(MANIFEST);
    expect(manifest?.version).toBe("0.2.1");
    expect(manifest?.releaseDate).toBe("2026-10-10T05:00:00.000Z");
    expect(manifest?.files).toHaveLength(3);
    expect(selectMacZip(manifest!, "arm64")).toEqual({
      url: "SpecWeave-Studio-0.2.1-arm64.zip",
      sha512: "abc==",
      size: 120,
    });
    expect(selectMacZip(manifest!, "x64")?.url).toBe("SpecWeave-Studio-0.2.1-x64.zip");
  });

  it("rejects manifests it cannot read", () => {
    expect(parseUpdateManifest("version: not-a-version\n")).toBeNull();
    expect(parseUpdateManifest("files:\n  weird line\nversion: 0.2.1\n")).toBeNull();
  });

  it("refuses path-like asset names", () => {
    expect(isPlainAssetName("SpecWeave-Studio-0.2.1-arm64.zip")).toBe(true);
    expect(isPlainAssetName("../evil.zip")).toBe(false);
    expect(isPlainAssetName("dir/evil.zip")).toBe(false);
    expect(isPlainAssetName(".hidden")).toBe(false);
  });

  it("explains private-repo errors in terms of the gh login", () => {
    expect(describeFeedError(404, false)).toContain("gh auth login");
    expect(describeFeedError(401, true)).toContain("gh auth login");
    expect(describeFeedError(403, true)).toContain("rate limiting");
  });

  it("sends the token to the releases API", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const releases = await fetchReleases(
      { owner: "acme", repo: "studio", token: "secret-token" },
      async (url, init) => {
        calls.push({ url, headers: init?.headers as Record<string, string> });
        return new Response(JSON.stringify([{ tag_name: "v0.2.1", assets: [] }]), { status: 200 });
      },
    );
    expect(releases.map((entry) => entry.tagName)).toEqual(["v0.2.1"]);
    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/studio/releases?per_page=30");
    expect(calls[0]?.headers.Authorization).toBe("Bearer secret-token");
  });

  it("turns a private-repo 404 into the sign-in message", async () => {
    await expect(
      fetchReleases(
        { owner: "acme", repo: "studio", token: null },
        async () => new Response("{}", { status: 404 }),
      ),
    ).rejects.toThrow("gh auth login");
  });

  it("never forwards the token along a download redirect to another host", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const response = await openReleaseAsset(
      { owner: "acme", repo: "studio", token: "secret-token" },
      9,
      async (url, init) => {
        calls.push({ url, headers: init?.headers as Record<string, string> });
        if (calls.length === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://objects.example.com/blob?sig=1" },
          });
        }
        return new Response("payload", { status: 200 });
      },
    );
    expect(await response.text()).toBe("payload");
    expect(calls[0]?.headers.Authorization).toBe("Bearer secret-token");
    expect(calls[1]?.url).toBe("https://objects.example.com/blob?sig=1");
    expect(calls[1]?.headers.Authorization).toBeUndefined();
  });
});
