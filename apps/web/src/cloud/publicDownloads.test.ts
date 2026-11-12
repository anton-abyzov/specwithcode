import { describe, expect, it } from "vite-plus/test";

import {
  countInstallerDownloads,
  fetchPublicDownloads,
  installerPlatform,
} from "./publicDownloads";

const asset = (name: string, download_count: number) => ({ name, download_count });

const release = (version: string) => ({
  tag_name: `v${version}`,
  assets: [
    asset(`SpecWithCode-${version}-arm64.dmg`, 10),
    asset("SpecWithCode-arm64.dmg", 5),
    asset(`SpecWithCode-${version}-x64.exe`, 7),
    asset(`SpecWithCode-${version}-arm64.exe`, 1),
    asset(`SpecWithCode-${version}-x86_64.AppImage`, 3),
    asset(`SpecWithCode-${version}-amd64.deb`, 2),
    // Not installs: updates, update feeds, signatures, server builds.
    asset(`SpecWithCode-${version}-arm64.zip`, 1000),
    asset(`SpecWithCode-${version}-arm64.dmg.blockmap`, 1000),
    asset(`SpecWithCode-${version}-x64.exe.blockmap`, 1000),
    asset(`SpecWithCode-${version}-amd64.deb.asc`, 1000),
    asset("latest-mac.yml", 1000),
    asset(`studio-${version}-linux-x64-abc.tar.gz`, 1000),
    asset("install.sh", 1000),
  ],
});

const fakeFetch = (routes: (url: string) => unknown) => {
  const seen: Array<string> = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    const body = routes(url);
    if (body instanceof Response) return body;
    return Response.json(body);
  }) as typeof globalThis.fetch;
  return { seen, fetchFn };
};

const npm = (url: string) =>
  url.includes("last-week")
    ? { specweave: { downloads: 40 }, vskill: { downloads: 4 } }
    : { specweave: { downloads: 160 }, vskill: null };

describe("public download counts", () => {
  it("knows an installer by its file name", () => {
    expect(installerPlatform("SpecWithCode-1.0.1-arm64.dmg")).toBe("mac");
    expect(installerPlatform("SpecWithCode-1.0.1-x64.EXE")).toBe("windows");
    expect(installerPlatform("SpecWithCode-1.0.1-x86_64.AppImage")).toBe("linux");
    expect(installerPlatform("SpecWithCode-1.0.1-arm64.deb")).toBe("linux");
    expect(installerPlatform("SpecWithCode-1.0.1-arm64.zip")).toBeNull();
    expect(installerPlatform("SpecWithCode-1.0.1-arm64.dmg.blockmap")).toBeNull();
    expect(installerPlatform("latest.yml")).toBeNull();
  });

  it("adds up installers only, over every release, and survives odd entries", () => {
    expect(
      countInstallerDownloads([
        release("1.0.1"),
        release("1.0.2"),
        null,
        { assets: "nope" },
        { assets: [{ name: "x.dmg", download_count: "12" }, { name: 5 }, null] },
      ]),
    ).toEqual({ mac: 30, windows: 16, linux: 10 });
  });

  it("reads every page of releases and both npm periods", async () => {
    const full = Array.from({ length: 100 }, () => release("1.0.1"));
    const { seen, fetchFn } = fakeFetch((url) =>
      url.includes("api.npmjs.org") ? npm(url) : url.endsWith("page=1") ? full : [release("1.0.0")],
    );
    expect(await fetchPublicDownloads(fetchFn)).toEqual({
      installers: { mac: 1515, windows: 808, linux: 505, releases: 101, complete: true },
      npm: [
        { name: "specweave", week: 40, month: 160 },
        // A package npm has no count for reads as zero.
        { name: "vskill", week: 4, month: 0 },
      ],
    });
    expect(seen.filter((url) => url.includes("api.github.com"))).toEqual([
      "https://api.github.com/repos/anton-abyzov/specwithcode/releases?per_page=100&page=1",
      "https://api.github.com/repos/anton-abyzov/specwithcode/releases?per_page=100&page=2",
    ]);
  });

  it("stops after five pages and says the count is not complete", async () => {
    const full = Array.from({ length: 100 }, () => release("1.0.1"));
    const { seen, fetchFn } = fakeFetch((url) => (url.includes("api.npmjs.org") ? npm(url) : full));
    const read = await fetchPublicDownloads(fetchFn);
    expect(read.installers).toMatchObject({ releases: 500, complete: false });
    expect(seen.filter((url) => url.includes("api.github.com"))).toHaveLength(5);
  });

  it("leaves out a source that failed and keeps the other", async () => {
    const limited = fakeFetch((url) =>
      url.includes("api.npmjs.org") ? npm(url) : new Response("rate limited", { status: 403 }),
    );
    expect(await fetchPublicDownloads(limited.fetchFn)).toMatchObject({
      installers: null,
      npm: [{ name: "specweave" }, { name: "vskill" }],
    });
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    expect(await fetchPublicDownloads(offline)).toEqual({ installers: null, npm: null });
  });
});
