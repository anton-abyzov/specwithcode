// @effect-diagnostics nodeBuiltinImport:off - Drives the helper's command line against real files.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { cliArchiveFileName } from "./build-cli-archive.ts";
import {
  appUpdateConfigProblems,
  assetSetProblems,
  feedManifestName,
  feedProblems,
  formatSums,
  isReleaseShAssetName,
  isStableVersion,
  isWindowsLinuxAssetName,
  attachState,
  mergeWindowsFeeds,
  parseFeedManifest,
  planUpload,
  publicLeaks,
  requiredAssetNames,
  STAGED_WIN_ARM64_FEED,
  WINDOWS_LINUX_SUMS,
  windowsCliArchiveName,
} from "./release-windows-linux.ts";

const VERSION = "1.0.63";
const SCRIPT = NodeURL.fileURLToPath(new URL("./release-windows-linux.ts", import.meta.url));

// What release.sh's desktop_assets, linux_assets, installer_assets and release_assets publish.
const RELEASE_SH_ASSETS = [
  `SpecWithCode-${VERSION}-arm64.dmg`,
  `SpecWithCode-${VERSION}-arm64.dmg.blockmap`,
  `SpecWithCode-${VERSION}-arm64.zip`,
  `SpecWithCode-${VERSION}-arm64.zip.blockmap`,
  "SpecWithCode-arm64.dmg",
  "latest-mac.yml",
  `studio-${VERSION}-linux-x64-0123456789ab.tar.gz`,
  `studio-${VERSION}-linux-arm64-0123456789ab.tar.gz`,
  "install.sh",
  `studio-${VERSION}-0123456789ab.tar.gz`,
  `studio-${VERSION}-deployment-helpers-0123456789ab.tar.gz`,
  "deployment-helpers-manifest.json",
  "studio-update.json",
  "SHA256SUMS",
];

const OWN_ASSETS = [
  ...requiredAssetNames("win", VERSION),
  ...requiredAssetNames("linux", VERSION),
  WINDOWS_LINUX_SUMS,
];

const ARM64_ASSETS = [
  ...requiredAssetNames("win", VERSION, "arm64").filter((name) => name !== "latest.yml"),
  ...requiredAssetNames("linux", VERSION, "arm64"),
];

// Every new upload carries both arches (planUpload); a release from before arm64 holds OWN_ASSETS.
const UPLOAD_ASSETS = [...OWN_ASSETS, ...ARM64_ASSETS];

const WIN_FEED = `version: ${VERSION}
files:
  - url: SpecWithCode-${VERSION}-x64.exe
    sha512: AAAA
    size: 4
path: SpecWithCode-${VERSION}-x64.exe
sha512: AAAA
releaseDate: '2026-10-20T10:00:00.000Z'
`;

const LINUX_FEED = `version: ${VERSION}
files:
  - url: SpecWithCode-${VERSION}-x86_64.AppImage
    sha512: BBBB
    size: 4
    blockMapSize: 1234
  - url: SpecWithCode-${VERSION}-amd64.deb
    sha512: CCCC
    size: 4
path: SpecWithCode-${VERSION}-x86_64.AppImage
sha512: BBBB
releaseDate: '2026-10-20T10:00:00.000Z'
`;

describe("asset names", () => {
  it("names electron-updater's latest-channel feeds per platform", () => {
    expect(feedManifestName("win")).toBe("latest.yml");
    expect(feedManifestName("linux")).toBe("latest-linux.yml");
    expect(feedManifestName("win", "arm64")).toBe("latest.yml");
    expect(feedManifestName("linux", "arm64")).toBe("latest-linux-arm64.yml");
  });

  it("names the arm64 builds the way electron-builder and build-cli-archive.ts do", () => {
    expect(requiredAssetNames("win", VERSION, "arm64")).toEqual([
      `SpecWithCode-${VERSION}-arm64.exe`,
      `SpecWithCode-${VERSION}-arm64.exe.blockmap`,
      "latest.yml",
      `studio-${VERSION}-win32-arm64.zip`,
    ]);
    expect(windowsCliArchiveName(VERSION, "arm64")).toBe(
      cliArchiveFileName(VERSION, "win", "arm64"),
    );
    expect(requiredAssetNames("linux", VERSION, "arm64")).toEqual([
      `SpecWithCode-${VERSION}-arm64.AppImage`,
      `SpecWithCode-${VERSION}-arm64.deb`,
      "latest-linux-arm64.yml",
    ]);
    for (const name of ARM64_ASSETS) {
      expect(isWindowsLinuxAssetName(name, VERSION), name).toBe(true);
      expect(isReleaseShAssetName(name), name).toBe(false);
    }
    expect(isWindowsLinuxAssetName(STAGED_WIN_ARM64_FEED, VERSION)).toBe(false);
  });

  it("requires x64 and takes a platform's arm64 build whole or not at all", () => {
    expect(assetSetProblems(OWN_ASSETS, VERSION)).toEqual([]);
    expect(assetSetProblems([...OWN_ASSETS, ...ARM64_ASSETS], VERSION)).toEqual([]);
    const linuxArm64Only = requiredAssetNames("linux", VERSION, "arm64");
    expect(assetSetProblems([...OWN_ASSETS, ...linuxArm64Only], VERSION)).toEqual([]);
    expect(assetSetProblems([...OWN_ASSETS, `SpecWithCode-${VERSION}-arm64.exe`], VERSION)).toEqual(
      [
        `SpecWithCode-${VERSION}-arm64.exe.blockmap is missing, though other win arm64 assets are there`,
        `studio-${VERSION}-win32-arm64.zip is missing, though other win arm64 assets are there`,
      ],
    );
    expect(assetSetProblems([...ARM64_ASSETS, "latest.yml"], VERSION)).toEqual([
      `SpecWithCode-${VERSION}-x64.exe is missing`,
      `SpecWithCode-${VERSION}-x64.exe.blockmap is missing`,
      `studio-${VERSION}-win32-x64.zip is missing`,
      `SpecWithCode-${VERSION}-x86_64.AppImage is missing`,
      `SpecWithCode-${VERSION}-amd64.deb is missing`,
      "latest-linux.yml is missing",
    ]);
  });

  it("never claims a name release.sh publishes, the macOS feed above all", () => {
    for (const name of RELEASE_SH_ASSETS) {
      expect(isWindowsLinuxAssetName(name, VERSION), name).toBe(false);
      expect(isReleaseShAssetName(name), name).toBe(true);
    }
    for (const name of OWN_ASSETS) {
      expect(isWindowsLinuxAssetName(name, VERSION), name).toBe(true);
      expect(isReleaseShAssetName(name), name).toBe(false);
    }
  });

  it("refuses another version's files and other macOS channel feeds", () => {
    expect(isWindowsLinuxAssetName("SpecWithCode-1.0.62-x64.exe", VERSION)).toBe(false);
    expect(isWindowsLinuxAssetName("nightly-mac.yml", VERSION)).toBe(false);
    expect(isReleaseShAssetName("nightly-mac.yml")).toBe(true);
    expect(isWindowsLinuxAssetName("SpecWithCode-1.0.63-x64.zip", VERSION)).toBe(false);
  });

  it("takes only plain X.Y.Z versions", () => {
    expect(isStableVersion("1.0.63")).toBe(true);
    expect(isStableVersion("1.0.63-nightly.20261020.1")).toBe(false);
    expect(isStableVersion("v1.0.63")).toBe(false);
    expect(isStableVersion("01.0.0")).toBe(false);
  });
});

describe("update feeds", () => {
  it("reads electron-builder feeds, extra file keys included", () => {
    const linux = parseFeedManifest(LINUX_FEED);
    expect(linux.version).toBe(VERSION);
    expect(linux.files).toEqual([
      { url: `SpecWithCode-${VERSION}-x86_64.AppImage`, sha512: "BBBB", size: 4 },
      { url: `SpecWithCode-${VERSION}-amd64.deb`, sha512: "CCCC", size: 4 },
    ]);
    expect(parseFeedManifest(WIN_FEED).path).toBe(`SpecWithCode-${VERSION}-x64.exe`);
  });

  it("rejects a feed without files", () => {
    expect(() => parseFeedManifest(`version: ${VERSION}\nfiles:\n`)).toThrow(/no files/);
  });

  it("accepts a feed whose files match the build", () => {
    const files = new Map([[`SpecWithCode-${VERSION}-x64.exe`, { sha512: "AAAA", size: 4 }]]);
    expect(
      feedProblems({
        platform: "win",
        version: VERSION,
        manifest: parseFeedManifest(WIN_FEED),
        files,
      }),
    ).toEqual([]);
  });

  it("reports a wrong version, a changed file and a missing file", () => {
    const files = new Map([
      [`SpecWithCode-${VERSION}-x86_64.AppImage`, { sha512: "XXXX", size: 5 }],
    ]);
    const problems = feedProblems({
      platform: "linux",
      version: VERSION,
      manifest: parseFeedManifest(LINUX_FEED.replace(`version: ${VERSION}`, "version: 1.0.62")),
      files,
    });
    expect(problems.join("\n")).toMatch(/is for 1\.0\.62, not 1\.0\.63/);
    expect(problems.join("\n")).toMatch(/does not match its sha512/);
    expect(problems.join("\n")).toMatch(/amd64\.deb, which the build did not produce/);
  });

  it("refuses a feed that points at a macOS asset", () => {
    const feed = WIN_FEED.replace(
      `url: SpecWithCode-${VERSION}-x64.exe`,
      `url: SpecWithCode-${VERSION}-arm64.zip`,
    );
    const problems = feedProblems({
      platform: "win",
      version: VERSION,
      manifest: parseFeedManifest(feed),
      files: new Map(),
    });
    expect(problems.join("\n")).toMatch(/arm64\.zip, which this workflow does not publish/);
  });
});

describe("Windows feed merge", () => {
  const ARM64_FEED = `version: ${VERSION}
files:
  - url: SpecWithCode-${VERSION}-arm64.exe
    sha512: DDDD
    size: 5
path: SpecWithCode-${VERSION}-arm64.exe
sha512: DDDD
releaseDate: '2026-10-20T10:05:00.000Z'
`;

  it("lists both installers and keeps the x64 one as the default path", () => {
    const merged = parseFeedManifest(mergeWindowsFeeds(WIN_FEED, ARM64_FEED));
    expect(merged.version).toBe(VERSION);
    expect(merged.path).toBe(`SpecWithCode-${VERSION}-x64.exe`);
    expect(merged.files).toEqual([
      { url: `SpecWithCode-${VERSION}-x64.exe`, sha512: "AAAA", size: 4 },
      { url: `SpecWithCode-${VERSION}-arm64.exe`, sha512: "DDDD", size: 5 },
    ]);
    expect(mergeWindowsFeeds(WIN_FEED, ARM64_FEED)).toContain(
      "releaseDate: '2026-10-20T10:00:00.000Z'",
    );
  });

  // electron-updater's Provider.findFile takes the file whose name holds process.arch.
  it("gives each arch an installer whose name holds that arch", () => {
    const merged = parseFeedManifest(mergeWindowsFeeds(WIN_FEED, ARM64_FEED));
    for (const arch of ["x64", "arm64"]) {
      expect(merged.files.find((file) => file.url.includes(arch))?.url).toBe(
        `SpecWithCode-${VERSION}-${arch}.exe`,
      );
    }
  });

  it("refuses feeds of different versions or swapped arches", () => {
    expect(() => mergeWindowsFeeds(WIN_FEED, ARM64_FEED.replaceAll(VERSION, "1.0.62"))).toThrow(
      /arm64 latest\.yml is for 1\.0\.62/,
    );
    expect(() => mergeWindowsFeeds(ARM64_FEED, WIN_FEED)).toThrow(/not a x64 installer/);
  });
});

describe("app-update.yml", () => {
  it("accepts the public feed on the stable channel", () => {
    expect(
      appUpdateConfigProblems(
        "owner: anton-abyzov\nrepo: specwithcode\nprovider: github\nreleaseType: release\nupdaterCacheDirName: x\n",
      ),
    ).toEqual([]);
  });

  it("refuses the private repository, a nightly channel and a generic feed", () => {
    expect(
      appUpdateConfigProblems("owner: anton-abyzov\nrepo: specwithcode-dev\nprovider: github\n"),
    ).toEqual(["feed is anton-abyzov/specwithcode, not anton-abyzov/specwithcode"]);
    expect(
      appUpdateConfigProblems(
        "owner: anton-abyzov\nrepo: specwithcode\nprovider: github\nchannel: nightly\nreleaseType: prerelease\n",
      ),
    ).toHaveLength(2);
    expect(appUpdateConfigProblems("provider: generic\nurl: http://localhost:3000\n")).toHaveLength(
      2,
    );
  });
});

describe("checksums and the public release", () => {
  it("writes sha256sum lines sorted by name", () => {
    expect(
      formatSums([
        { name: "b", sha256: "22" },
        { name: "a", sha256: "11" },
      ]),
    ).toBe("11  a\n22  b\n");
  });

  it("finds private values without echoing them", () => {
    const rules = {
      deny: ["secret-host.internal"],
      replace: [["private-name", "public-name"]] as const,
    };
    const found = publicLeaks(
      "url: secret-host.internal private-name anton-abyzov/specwithcode",
      rules,
    );
    expect(found).toEqual(["the private repository name", "deny rule 1", "replace rule 1"]);
    expect(found.join(" ")).not.toContain("secret-host");
    expect(publicLeaks(WIN_FEED, rules)).toEqual([]);
  });
});

describe("planUpload", () => {
  it("uploads the full set to a release that has only release.sh's assets", () => {
    const plan = planUpload({
      version: VERSION,
      localNames: UPLOAD_ASSETS,
      existingNames: RELEASE_SH_ASSETS,
      replace: false,
    });
    expect(plan.problems).toEqual([]);
    expect(plan.upload).toHaveLength(UPLOAD_ASSETS.length);
  });

  it("refuses to overwrite its own assets unless asked to", () => {
    const again = { version: VERSION, localNames: UPLOAD_ASSETS, existingNames: ["latest.yml"] };
    expect(planUpload({ ...again, replace: false }).problems).toEqual([
      "latest.yml is already on the release; rerun with replace to overwrite this workflow's assets",
    ]);
    expect(planUpload({ ...again, replace: true }).problems).toEqual([]);
  });

  it("never uploads the macOS feed, even with replace", () => {
    const plan = planUpload({
      version: VERSION,
      localNames: [...UPLOAD_ASSETS, "latest-mac.yml"],
      existingNames: [],
      replace: true,
    });
    expect(plan.problems).toEqual(["latest-mac.yml belongs to release.sh"]);
  });

  it("requires both platforms and the checksum file", () => {
    const plan = planUpload({
      version: VERSION,
      localNames: requiredAssetNames("win", VERSION),
      existingNames: [],
      replace: false,
    });
    expect(plan.problems).toContain(`SpecWithCode-${VERSION}-x86_64.AppImage is missing`);
    expect(plan.problems).toContain(`${WINDOWS_LINUX_SUMS} is missing`);
  });

  // A published release from before arm64 stays complete (attachState), but a new upload never
  // leaves arm64 out: a replace with a smaller set would orphan the arm64 assets already there.
  it("requires both arches of both platforms in every upload", () => {
    const plan = planUpload({
      version: VERSION,
      localNames: OWN_ASSETS,
      existingNames: [],
      replace: false,
    });
    expect(plan.problems.sort()).toEqual(
      [...ARM64_ASSETS].sort().map((name) => `${name} is missing`),
    );
    expect(
      planUpload({
        version: VERSION,
        localNames: [...OWN_ASSETS, ...ARM64_ASSETS],
        existingNames: [],
        replace: false,
      }).problems,
    ).toEqual([]);
  });
});

// A published attach as GitHub lists it, built like the workflow does: installers, feeds that
// name the installers' sha512, and the checksum file over everything. `build` tells two builds
// of one version apart.
const sha = (algorithm: "sha256" | "sha512", text: string, encoding: "hex" | "base64") =>
  NodeCrypto.createHash(algorithm).update(text).digest(encoding);

const attach = (build: string) => {
  const files = new Map<string, string>();
  for (const name of OWN_ASSETS) {
    if (!name.endsWith(".yml") && name !== WINDOWS_LINUX_SUMS) files.set(name, `${build} ${name}`);
  }
  const feed = (installer: string) => {
    const content = files.get(installer)!;
    return `version: ${VERSION}\nfiles:\n  - url: ${installer}\n    sha512: ${sha("sha512", content, "base64")}\n    size: ${content.length}\npath: ${installer}\n`;
  };
  files.set("latest.yml", feed(`SpecWithCode-${VERSION}-x64.exe`));
  files.set("latest-linux.yml", feed(`SpecWithCode-${VERSION}-x86_64.AppImage`));
  files.set(
    WINDOWS_LINUX_SUMS,
    formatSums(
      [...files].map(([name, content]) => ({ name, sha256: sha("sha256", content, "hex") })),
    ),
  );
  return files;
};

/** What a replace leaves when it stops after the payload and the new checksum file, before the feeds. */
const interruptedReplace = () => {
  const next = attach("second");
  const old = attach("first");
  next.set("latest.yml", old.get("latest.yml")!);
  next.set("latest-linux.yml", old.get("latest-linux.yml")!);
  return next;
};

const listed = (files: ReadonlyMap<string, string>, state = "uploaded") =>
  [...files].map(([name, content]) => ({
    name,
    digest: `sha256:${sha("sha256", content, "hex")}`,
    state,
  }));

const texts = (files: ReadonlyMap<string, string>) =>
  new Map([...files].filter(([name]) => name.endsWith(".yml") || name === WINDOWS_LINUX_SUMS));

describe("attachState", () => {
  const macOnly = RELEASE_SH_ASSETS.map((name) => ({ name, digest: null, state: "uploaded" }));

  it("accepts a finished attach whose digests match its checksum file", () => {
    const files = attach("first");
    expect(
      attachState({
        version: VERSION,
        assets: [...macOnly, ...listed(files)],
        texts: texts(files),
      }),
    ).toEqual({ state: "complete", problems: [] });
  });

  it.each(["", "\n", "not a checksum\n"])(
    "rejects empty or malformed checksum manifests %j even with missing digests",
    (checksum) => {
      const files = attach("first");
      files.set(WINDOWS_LINUX_SUMS, checksum);
      const assets = listed(files).map((asset) => ({ ...asset, digest: null }));
      const result = attachState({ version: VERSION, assets, texts: texts(files) });
      expect(result.state).toBe("broken");
      expect(result.problems).toContain("latest.yml is not in SHA256SUMS-windows-linux");
      expect(result.problems).toContain(
        `SpecWithCode-${VERSION}-x64.exe is not in SHA256SUMS-windows-linux`,
      );
    },
  );

  it("requires checksum coverage for every payload and feed", () => {
    const files = attach("first");
    const checks = files.get(WINDOWS_LINUX_SUMS)!;
    for (const name of ["latest-linux.yml", `SpecWithCode-${VERSION}-amd64.deb`]) {
      const incomplete = new Map(texts(files));
      incomplete.set(
        WINDOWS_LINUX_SUMS,
        checks
          .split("\n")
          .filter((line) => !line.endsWith(`  ${name}`))
          .join("\n"),
      );
      expect(
        attachState({ version: VERSION, assets: listed(files), texts: incomplete }).problems,
      ).toContain(`${name} is not in ${WINDOWS_LINUX_SUMS}`);
    }
  });

  it("sees a release with none of it as absent", () => {
    expect(attachState({ version: VERSION, assets: macOnly, texts: new Map() }).state).toBe(
      "absent",
    );
  });

  it("refuses a replace stopped before the feeds, though every name is there", () => {
    const files = interruptedReplace();
    const result = attachState({ version: VERSION, assets: listed(files), texts: texts(files) });
    expect(result.state).toBe("broken");
    expect(result.problems.join("\n")).toContain(`latest.yml is sha256:`);
    expect(result.problems.join("\n")).toContain(`${WINDOWS_LINUX_SUMS} says sha256:`);
    expect(result.problems.some((problem) => problem.startsWith("latest-linux.yml is"))).toBe(true);
  });

  it("refuses an attach stopped between the payload and the feeds", () => {
    const files = attach("first");
    files.delete("latest.yml");
    files.delete("latest-linux.yml");
    const result = attachState({ version: VERSION, assets: listed(files), texts: texts(files) });
    expect(result.state).toBe("broken");
    expect(result.problems).toContain("latest.yml is missing");
    expect(result.problems).toContain(
      `${WINDOWS_LINUX_SUMS} lists latest.yml, which the release lacks`,
    );
  });

  it("refuses an upload that is not finished, a wrong feed version and an unreadable feed", () => {
    const files = attach("first");
    const assets = listed(files).map((asset) =>
      asset.name.endsWith(".deb") ? { ...asset, state: "starter" } : asset,
    );
    expect(attachState({ version: VERSION, assets, texts: texts(files) }).problems).toContain(
      `SpecWithCode-${VERSION}-amd64.deb is starter, not uploaded`,
    );
    const stale = new Map(texts(files));
    stale.set(
      "latest.yml",
      files.get("latest.yml")!.replace(`version: ${VERSION}`, "version: 1.0.62"),
    );
    expect(
      attachState({ version: VERSION, assets: listed(files), texts: stale }).problems,
    ).toContain("latest.yml is for 1.0.62, not 1.0.63");
    const unread = new Map(texts(files));
    unread.delete("latest-linux.yml");
    expect(
      attachState({ version: VERSION, assets: listed(files), texts: unread }).problems,
    ).toContain("latest-linux.yml could not be read");
  });
});

/**
 * A `gh` on PATH that serves releases from files: `<root>/<repo>.json` as the release (none: HTTP
 * 404), `<root>/<repo>-assets/<id>` as asset contents, and `releases/latest` as v<VERSION>.
 */
const stubGh = (
  root: string,
  releases: Record<string, ReadonlyMap<string, string> | null>,
  flags: { draft?: boolean; prerelease?: boolean } = {},
) => {
  const bin = NodePath.join(root, "bin");
  NodeFS.mkdirSync(bin, { recursive: true });
  for (const [repo, files] of Object.entries(releases)) {
    if (files === null) continue;
    const dir = NodePath.join(root, `${repo}-assets`);
    NodeFS.mkdirSync(dir, { recursive: true });
    const assets = [...files].map(([name, content], index) => {
      NodeFS.writeFileSync(NodePath.join(dir, String(index + 1)), content);
      return {
        id: index + 1,
        name,
        digest: `sha256:${sha("sha256", content, "hex")}`,
        state: "uploaded",
      };
    });
    NodeFS.writeFileSync(
      NodePath.join(root, `${repo}.json`),
      JSON.stringify({ assets, draft: false, prerelease: false, ...flags }),
    );
  }
  NodeFS.writeFileSync(
    NodePath.join(bin, "gh"),
    `#!/bin/sh
ROOT="$(cygpath -u "$STUB_GH_ROOT" 2>/dev/null || printf '%s' "$STUB_GH_ROOT")"
for last; do :; done
case "$last" in
  */releases/latest) echo v${VERSION}; exit 0 ;;
  .tag_name) echo v${VERSION}; exit 0 ;;
esac
path="$last"
repo="\${path#repos/*/}"; repo="\${repo%%/releases/*}"
case "$path" in
  */releases/assets/*) cat "$ROOT/$repo-assets/\${path##*/}" ;;
  */releases/tags/*) [ -f "$ROOT/$repo.json" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }; cat "$ROOT/$repo.json" ;;
  *) echo "unexpected gh $*" >&2; exit 9 ;;
esac
`,
    { mode: 0o755 },
  );
  // Native Node on Windows cannot exec a POSIX shebang stub. Intercept only gh
  // in the isolated helper process, keeping the real CLI/reader and fixture files.
  NodeFS.writeFileSync(
    NodePath.join(bin, "gh-preload.mjs"),
    `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const original = childProcess.execFileSync;
childProcess.execFileSync = function(command, args, options) {
  if (command !== "gh") return original.apply(this, arguments);
  const route = args.at(-1);
  const match = /^repos\\/[^/]+\\/([^/]+)\\/releases\\/(tags|assets)\\/(.+)$/.exec(route);
  if (!match) throw new Error("unexpected fixture gh route " + route);
  const file = match[2] === "tags" ? join(process.env.STUB_GH_ROOT, match[1] + ".json")
    : join(process.env.STUB_GH_ROOT, match[1] + "-assets", match[3]);
  if (!existsSync(file)) { const error = new Error("fixture release absent"); error.stderr = "gh: Not Found (HTTP 404)"; throw error; }
  return readFileSync(file, options?.encoding);
};
syncBuiltinESMExports();
`,
  );
  return bin;
};

const stubEnv = (root: string, bin: string) => ({
  ...process.env,
  PATH: `${bin}${NodePath.delimiter}${process.env.PATH}`,
  STUB_GH_ROOT: root,
  NODE_OPTIONS:
    `${process.env.NODE_OPTIONS ?? ""} --import=${NodeURL.pathToFileURL(NodePath.join(bin, "gh-preload.mjs")).href}`.trim(),
});

const tempRoot = (prefix: string) => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));

describe("release-state", () => {
  const state = (
    files: ReadonlyMap<string, string> | null,
    flags: { draft?: boolean; prerelease?: boolean } = {},
  ) => {
    const root = tempRoot("release-state fixture-");
    const bin = stubGh(root, { "specwithcode-dev": files }, flags);
    return NodeChildProcess.spawnSync(
      process.execPath,
      [SCRIPT, "release-state", "--version", VERSION, "--repo", "anton-abyzov/specwithcode"],
      { encoding: "utf8", env: stubEnv(root, bin) },
    );
  };

  it("refuses an empty manifest through the real CLI reader", () => {
    const files = attach("first");
    files.set(WINDOWS_LINUX_SUMS, "");
    const result = state(files);
    expect(result.status).toBe(4);
    expect(result.stdout).toContain(`${WINDOWS_LINUX_SUMS} is empty`);
  });

  it.each([{ draft: true }, { prerelease: true }])(
    "refuses non-stable publication metadata %j",
    (flags) => {
      const result = state(attach("first"), flags);
      expect(result.status).toBe(4);
      expect(result.stdout).toContain("not draft or prerelease");
    },
  );

  it("exits 0 for a complete attach, 3 for none and 4 with repair steps for a broken one", () => {
    expect(state(attach("first")).status).toBe(0);
    expect(state(new Map([["SHA256SUMS", "x"]])).status).toBe(3);
    expect(state(null).status).toBe(3);
    const broken = state(interruptedReplace());
    expect(broken.status).toBe(4);
    expect(broken.stdout).toContain(
      "::error::v1.0.63 on anton-abyzov/specwithcode: latest.yml is sha256:",
    );
    expect(broken.stdout).toContain("replace=true");
  });
});

describe("command line", () => {
  const sha512 = (text: string) => NodeCrypto.createHash("sha512").update(text).digest("base64");
  const run = (args: string[]) =>
    NodeChildProcess.execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      stdio: "pipe",
    });

  function windowsBuild() {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "release-windows-linux-"));
    const desktop = NodePath.join(root, "release");
    const cli = NodePath.join(root, "release-cli");
    NodeFS.mkdirSync(desktop);
    NodeFS.mkdirSync(cli);
    const exe = `SpecWithCode-${VERSION}-x64.exe`;
    NodeFS.writeFileSync(NodePath.join(desktop, exe), "exe!");
    NodeFS.writeFileSync(NodePath.join(desktop, `${exe}.blockmap`), "map");
    NodeFS.writeFileSync(NodePath.join(desktop, "builder-debug.yml"), "debug: true\n");
    NodeFS.writeFileSync(
      NodePath.join(desktop, "latest.yml"),
      `version: ${VERSION}\nfiles:\n  - url: ${exe}\n    sha512: ${sha512("exe!")}\n    size: 4\npath: ${exe}\n`,
    );
    NodeFS.writeFileSync(NodePath.join(cli, `studio-${VERSION}-win32-x64.zip`), "zip");
    return { root, desktop, cli };
  }

  it("collects a Windows build and nothing else from its folders", () => {
    const { root, desktop, cli } = windowsBuild();
    const out = NodePath.join(root, "out");
    run([
      "collect",
      "--platform",
      "win",
      "--version",
      VERSION,
      "--from",
      desktop,
      "--from",
      cli,
      "--out",
      out,
    ]);
    expect(NodeFS.readdirSync(out).sort()).toEqual([...requiredAssetNames("win", VERSION)].sort());
  });

  it("refuses a build whose installer no longer matches latest.yml", () => {
    const { root, desktop, cli } = windowsBuild();
    NodeFS.writeFileSync(NodePath.join(desktop, `SpecWithCode-${VERSION}-x64.exe`), "changed");
    expect(() =>
      run([
        "collect",
        "--platform",
        "win",
        "--version",
        VERSION,
        "--from",
        desktop,
        "--from",
        cli,
        "--out",
        NodePath.join(root, "out"),
      ]),
    ).toThrow(/does not match its sha512/);
  });

  it("collects a Windows arm64 build with its feed staged for merge-feeds", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "release-windows-linux-"));
    const desktop = NodePath.join(root, "release");
    NodeFS.mkdirSync(desktop);
    const exe = `SpecWithCode-${VERSION}-arm64.exe`;
    NodeFS.writeFileSync(NodePath.join(desktop, exe), "arm!");
    NodeFS.writeFileSync(NodePath.join(desktop, `${exe}.blockmap`), "map");
    NodeFS.writeFileSync(
      NodePath.join(desktop, "latest.yml"),
      `version: ${VERSION}\nfiles:\n  - url: ${exe}\n    sha512: ${sha512("arm!")}\n    size: 4\npath: ${exe}\n`,
    );
    NodeFS.writeFileSync(NodePath.join(desktop, `studio-${VERSION}-win32-arm64.zip`), "zip");
    const out = NodePath.join(root, "out");
    run([
      "collect",
      "--platform",
      "win",
      "--arch",
      "arm64",
      "--version",
      VERSION,
      "--from",
      desktop,
      "--out",
      out,
    ]);
    expect(NodeFS.readdirSync(out).sort()).toEqual(
      [exe, `${exe}.blockmap`, STAGED_WIN_ARM64_FEED, `studio-${VERSION}-win32-arm64.zip`].sort(),
    );

    // The x64 job's assets land beside it; merge-feeds leaves one latest.yml for both.
    const x64 = windowsBuild();
    run([
      "collect",
      "--platform",
      "win",
      "--version",
      VERSION,
      "--from",
      x64.desktop,
      "--from",
      x64.cli,
      "--out",
      out,
    ]);
    run(["merge-feeds", "--dir", out]);
    expect(NodeFS.existsSync(NodePath.join(out, STAGED_WIN_ARM64_FEED))).toBe(false);
    const feed = parseFeedManifest(NodeFS.readFileSync(NodePath.join(out, "latest.yml"), "utf8"));
    expect(feed.files.map((file) => file.url)).toEqual([`SpecWithCode-${VERSION}-x64.exe`, exe]);
  });

  it("refuses a Linux arm64 build collected as x64", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "release-windows-linux-"));
    const desktop = NodePath.join(root, "release");
    NodeFS.mkdirSync(desktop);
    expect(() =>
      run([
        "collect",
        "--platform",
        "linux",
        "--version",
        VERSION,
        "--from",
        desktop,
        "--out",
        NodePath.join(root, "out"),
      ]),
    ).toThrow(/no latest-linux\.yml/);
  });

  it("writes the checksum file and plans the upload against a release listing", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "release-windows-linux-"));
    const dir = NodePath.join(root, "assets");
    NodeFS.mkdirSync(dir);
    for (const name of UPLOAD_ASSETS.filter((name) => name !== WINDOWS_LINUX_SUMS))
      NodeFS.writeFileSync(NodePath.join(dir, name), name);
    run(["sums", "--dir", dir]);
    const sums = NodeFS.readFileSync(NodePath.join(dir, WINDOWS_LINUX_SUMS), "utf8");
    expect(sums).toContain(`  studio-${VERSION}-win32-x64.zip\n`);
    expect(sums).not.toContain(WINDOWS_LINUX_SUMS);
    NodeFS.writeFileSync(NodePath.join(root, "existing.json"), JSON.stringify(RELEASE_SH_ASSETS));
    const upload = run([
      "plan-upload",
      "--version",
      VERSION,
      "--dir",
      dir,
      "--existing",
      NodePath.join(root, "existing.json"),
    ]);
    expect(upload.trim().split("\n")).toHaveLength(UPLOAD_ASSETS.length);
  });
});

describe("install.ps1", () => {
  const script = NodeFS.readFileSync(new URL("./install.ps1", import.meta.url), "utf8");

  it("downloads the archive build-cli-archive.ts names", () => {
    expect(windowsCliArchiveName(VERSION)).toBe(cliArchiveFileName(VERSION, "win", "x64"));
    expect(script).toContain('$stem = "studio-$version-win32-$arch"');
  });

  it("checks this workflow's checksum file before the macOS release's SHA256SUMS", () => {
    expect(script).toContain(`$sumsFiles = @("${WINDOWS_LINUX_SUMS}", "SHA256SUMS")`);
  });

  it("picks the newest release that already carries the Windows archive", () => {
    expect(script).toContain('-contains "studio-$($_.tag_name.Substring(1))-win32-$wanted.zip"');
    expect(script).toContain("$tag = & $findTag $arch");
  });

  it("falls back to the x64 archive on Windows on ARM when no release has arm64 yet", () => {
    expect(script).toMatch(
      /if \(-not \$tag -and \$arch -eq "arm64"\) \{\n\s+\$tag = & \$findTag "x64"/,
    );
    expect(script).toContain('$arch = "x64"');
  });
});

describe("release-windows-linux.yml", () => {
  const workflow = NodeFS.readFileSync(
    new URL("../.github/workflows/release-windows-linux.yml", import.meta.url),
    "utf8",
  );

  const job = (name: string, next: string) =>
    workflow.slice(workflow.indexOf(`\n  ${name}:\n`), workflow.indexOf(`\n  ${next}:\n`));

  it("runs only on GitHub-hosted runners, each arch on its own hardware", () => {
    const fixed = [...workflow.matchAll(/^\s+runs-on:\s*([^$\s]\S*)$/gm)].map((match) => match[1]);
    const matrix = [...workflow.matchAll(/^\s+runner:\s*(\S+)/gm)].map((match) => match[1]);
    expect(new Set(fixed)).toEqual(new Set(["ubuntu-24.04"]));
    expect(matrix).toEqual(["windows-2025", "windows-11-arm", "ubuntu-22.04", "ubuntu-22.04-arm"]);
    expect(workflow.match(/runs-on: \$\{\{ matrix\.runner \}\}/g)).toHaveLength(2);
  });

  // A release without arm64 would move arm64 installs onto x64 for good, so every leg is required.
  it("requires every arch, and one leg's failure does not cancel the others", () => {
    for (const [name, next] of [
      ["windows", "linux"],
      ["linux", "publish"],
    ] as const) {
      const text = job(name, next);
      expect(text).not.toContain("continue-on-error");
      expect(text).toContain("fail-fast: false");
    }
    expect(workflow).toContain("needs: [plan, windows, linux]");
  });

  it("defaults to a dry run and builds both installers for each arch", () => {
    expect(workflow).toMatch(/dry_run:\n(?:\s+\w+:.*\n)*?\s+default: true/);
    expect(workflow).toContain('--platform win --target nsis --arch "$ARCH"');
    expect(workflow).toContain('--platform linux --target AppImage --arch "$ARCH"');
    expect(workflow.match(/^\s+ARCH: \$\{\{ matrix\.arch \}\}$/gm)).toHaveLength(2);
    expect(job("windows", "linux")).toContain("rust_target: aarch64-pc-windows-msvc");
    expect(job("linux", "publish")).toContain("rust_target: aarch64-unknown-linux-gnu");
  });

  it("builds and smoke-tests the Windows and Linux CLI archives", () => {
    expect(workflow.match(/node apps\/server\/scripts\/cli\.ts build-exe/g)).toHaveLength(2);
    expect(workflow).toContain('build-cli-archive.ts --platform win --arch "$ARCH"');
    expect(workflow).toContain('build-cli-archive.ts --platform linux --arch "$ARCH"');
    expect(workflow).toContain('--archive "release-cli/studio-$VERSION-win32-$ARCH.zip"');
    expect(workflow).toContain('--archive "release-cli/studio-$VERSION-linux-$ARCH.tar.gz"');
  });

  it("merges the Windows feeds before writing the checksums", () => {
    const publish = workflow.slice(workflow.indexOf("\n  publish:\n"));
    const merge = publish.indexOf('node "$TOOL" merge-feeds --dir "$ASSETS"');
    expect(merge).toBeGreaterThan(-1);
    expect(merge).toBeLessThan(publish.indexOf('node "$TOOL" sums --dir "$ASSETS"'));
    expect(workflow).toContain('collect --platform win --arch "$ARCH"');
    expect(workflow).toContain('collect --platform linux --arch "$ARCH"');
  });

  // release.sh owns every studio-*.tar.gz name; install.sh installs its Node bundle.
  it("keeps the Linux CLI archive off the release", () => {
    const name = cliArchiveFileName(VERSION, "linux", "x64");
    expect(isReleaseShAssetName(name)).toBe(true);
    expect(isWindowsLinuxAssetName(name, VERSION)).toBe(false);
    expect(requiredAssetNames("linux", VERSION)).not.toContain(name);
    expect(workflow).toContain(
      "name: cli-linux-${{ matrix.arch }}-${{ needs.plan.outputs.version }}",
    );
  });

  // v1.0.94 waited 8,548 s on a workflow-wide group behind v1.0.93's hour-long publish wait.
  it("serializes only uploads to the same version, and never a dry run", () => {
    expect(workflow).not.toMatch(/^concurrency:/m);
    const publish = workflow.slice(workflow.indexOf("\n  publish:\n"));
    expect(publish).toContain(
      "group: release-windows-linux-${{ needs.plan.outputs.dry_run == 'true' && format('dry-run-{0}', github.run_id) || needs.plan.outputs.version }}",
    );
    expect(publish).toMatch(/concurrency:\n\s+group: .*\n\s+cancel-in-progress: false/);
  });

  it("builds both platforms from the commit Plan resolved", () => {
    expect(workflow.match(/fetch --no-tags --depth=1 origin "\$COMMIT"/g)).toHaveLength(2);
    expect(workflow).toContain('commit="$(resolve "${ref:-refs/tags/v$version}")"');
    expect(workflow).toContain('CSC_IDENTITY_AUTO_DISCOVERY: "false"');
  });

  // Windows signing takes all seven Azure Trusted Signing secrets or none; Plan decides once.
  describe("Windows signing", () => {
    const secrets = [
      "AZURE_TENANT_ID",
      "AZURE_CLIENT_ID",
      "AZURE_CLIENT_SECRET",
      "AZURE_TRUSTED_SIGNING_ENDPOINT",
      "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
      "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME",
      "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
    ];
    const windows = job("windows", "linux");
    const linux = job("linux", "publish");
    const planStep = workflow.slice(
      workflow.indexOf("      - name: Resolve version and commit\n"),
      workflow.indexOf("\n  windows:\n"),
    );
    const decide = planStep.slice(
      planStep.indexOf("          azure=("),
      planStep.indexOf('          {\n            echo "version=$version"'),
    );

    const runDecide = (set: readonly string[]) => {
      const root = tempRoot("signing fixture-");
      const output = NodePath.join(root, "output");
      NodeFS.writeFileSync(output, "");
      const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
      for (const name of set) env[name] = "set";
      const result = NodeChildProcess.spawnSync(
        "bash",
        ["-c", `set -euo pipefail\n${decide}\necho "windows_signing=$windows_signing"`],
        { encoding: "utf8", env },
      );
      return { status: result.status, stdout: result.stdout };
    };

    it("Plan passes every secret's presence, never its value", () => {
      for (const name of secrets) {
        expect(planStep).toContain(`${name}: \${{ secrets.${name} != '' && 'set' || '' }}`);
      }
      expect(workflow).toContain("windows_signing: ${{ steps.plan.outputs.windows_signing }}");
    });

    it("signs with all seven, builds unsigned with none, and fails with some", () => {
      expect(runDecide(secrets)).toMatchObject({ status: 0, stdout: "windows_signing=true\n" });
      const none = runDecide([]);
      expect(none.status).toBe(0);
      expect(none.stdout).toContain("::notice::");
      expect(none.stdout).toContain("windows_signing=false\n");
      const some = runDecide(secrets.slice(0, 3));
      expect(some.status).toBe(1);
      expect(some.stdout).toContain("AZURE_TRUSTED_SIGNING_ENDPOINT");
    });

    it("lets electron-builder sign the installer, and signs the CLI's executables", () => {
      expect(windows).toContain(
        "STUDIO_DESKTOP_SIGNED: ${{ needs.plan.outputs.windows_signing == 'true' && 'true' || 'false' }}",
      );
      for (const step of [
        "Prepare Azure Trusted Signing",
        "Sign the CLI's resource monitor",
        "Check the Windows signatures",
      ]) {
        expect(windows).toMatch(
          new RegExp(
            `- name: ${step}\\n\\s+if: needs\\.plan\\.outputs\\.windows_signing == 'true'`,
          ),
        );
      }
      const build = windows.slice(
        windows.indexOf("      - name: Build installer\n"),
        windows.indexOf("      - name: Smoke test the packaged main process\n"),
      );
      for (const name of secrets) expect(build).toContain(`${name}: \${{ secrets.${name} }}`);
      // The cached monitor is copied before it is signed, never signed in place.
      const sign = windows.indexOf("- name: Sign the CLI's resource monitor");
      expect(windows.indexOf("- name: Stage resource monitor for the CLI archive")).toBeLessThan(
        sign,
      );
      expect(sign).toBeLessThan(windows.indexOf("- name: Build CLI archive"));
      expect(windows.indexOf("- name: Check the Windows signatures")).toBeGreaterThan(
        windows.indexOf("- name: Smoke test CLI archive"),
      );
      expect(linux).not.toContain("AZURE_");
      expect(linux).not.toContain("STUDIO_DESKTOP_SIGNED");
    });

    // The CLI zip also ships node-pty's OpenConsole.exe (signed by Microsoft) and @cursor/sdk's
    // unsigned cursorsandbox.exe and rg.exe; only our two executables there carry our name.
    it("requires our publisher only on our own CLI executables, and leaves PSModulePath alone", () => {
      const windows = job("windows", "linux");
      const check = windows.slice(
        windows.indexOf("      - name: Check the Windows signatures\n"),
        windows.indexOf("      - name: Collect assets\n"),
      );
      expect(check).toContain("-Filter specweave-studio.exe $cli");
      expect(check).toContain("-Filter studio-resource-monitor.exe $cli");
      expect(check).not.toMatch(/-Filter \*\.exe \$cli/);
      expect(windows).not.toContain("PSModulePath");
    });
  });

  // Ubuntu 22.04 has glibc 2.35. v1.0.132, built on 24.04, shipped studio-kde-snap-shot needing
  // GLIBC_2.39 (pidfd_spawnp), which does not load there.
  it("builds Linux on Ubuntu 22.04 and checks the glibc floor", () => {
    const linux = job("linux", "publish");
    expect(linux).toContain("floor=2.35");
    expect(linux.indexOf("- name: Check the glibc floor")).toBeGreaterThan(
      linux.indexOf("- name: Check the packages' update feed"),
    );
    for (const key of [
      "key: resource-monitor-${{ matrix.rust_target }}-glibc2.35-",
      "key: linux-capture-helpers-${{ matrix.rust_target }}-glibc2.35-",
    ]) {
      expect(linux).toContain(key);
    }
  });

  it("restores the native helpers native-cache.yml saves, for both arches", () => {
    const nativeCache = NodeFS.readFileSync(
      new URL("../.github/workflows/native-cache.yml", import.meta.url),
      "utf8",
    );
    const keys = (text: string) =>
      [...text.matchAll(/^\s+key: (.+?)\$\{\{ hashFiles\((.*)\) \}\}$/gm)].map(
        (match) => `${match[1]}|${match[2]}`,
      );
    const restored = new Set(keys(workflow));
    expect(restored.size).toBe(3);
    expect(new Set(keys(nativeCache))).toEqual(restored);
    for (const target of [
      "x86_64-pc-windows-msvc",
      "aarch64-pc-windows-msvc",
      "x86_64-unknown-linux-gnu",
      "aarch64-unknown-linux-gnu",
    ]) {
      expect(nativeCache).toContain(`rust_target: ${target}`);
    }
    expect(nativeCache).toContain("Microsoft.VisualStudio.Component.VC.Runtimes.ARM64.Spectre");
    expect([...nativeCache.matchAll(/^\s+runner:\s*(\S+)/gm)].map((match) => match[1])).toEqual([
      "ubuntu-22.04",
      "ubuntu-22.04-arm",
      "windows-2025",
      "windows-11-arm",
    ]);
  });

  // Every release build downloaded all ~1,350 packages (pnpm "reused 0"). Linux restores
  // setup-vp's store cache. On Windows setup-vp's cache restores a Linux-shaped store (#7975), and
  // a pinned Windows store cache measured no faster than downloading (PR #913), so there is none.
  it("restores the package store on Linux only", () => {
    const windows = workflow.slice(
      workflow.indexOf("\n  windows:\n"),
      workflow.indexOf("\n  linux:\n"),
    );
    const linux = workflow.slice(
      workflow.indexOf("\n  linux:\n"),
      workflow.indexOf("\n  publish:\n"),
    );
    const setupVp = (cache: string) =>
      new RegExp(
        `setup-vp@\\S+ # v[\\d.]+\\n\\s+with:\\n\\s+node-version-file: package.json\\n\\s+cache: ${cache}`,
      );
    expect(windows).toMatch(setupVp("false"));
    expect(windows).not.toContain("pnpm-store");
    expect(linux).toMatch(setupVp("true"));
  });

  // A catch-up run that built while another run attached the same version ends without uploading.
  // Both catch-up checks, run in bash against a stub gh and the real helper: only a complete,
  // consistent attach on both releases skips; none on either builds; anything else fails.
  const block = (job: string, from: string, to: string) => {
    const text = workflow.slice(workflow.indexOf(`\n  ${job}:\n`));
    const start = text.indexOf(from);
    const end = text.indexOf(to, start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return text.slice(start, end);
  };
  const planBlock = `if false; then :\n${block("plan", '          elif [ "$EVENT_NAME" = schedule ]; then\n', "\n          else\n")}\nfi\n`;
  const publishBlock = `${block("publish", '          if [ "$EVENT_NAME" = schedule ]; then\n', "          state() {")}`;

  const runNightly = (
    script: string,
    releases: {
      private: ReadonlyMap<string, string> | null;
      public: ReadonlyMap<string, string> | null;
    },
  ) => {
    const root = tempRoot("nightly fixture-");
    const bin = stubGh(root, {
      "specwithcode-dev": releases.private,
      specwithcode: releases.public,
    });
    const output = NodePath.join(root, "output");
    NodeFS.writeFileSync(output, "");
    const result = NodeChildProcess.spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail\nif command -v cygpath >/dev/null; then export GITHUB_OUTPUT="$(cygpath -u "$GITHUB_OUTPUT")"; export GITHUB_STEP_SUMMARY="$(cygpath -u "$GITHUB_STEP_SUMMARY")"; fi\nEVENT_NAME=schedule\n${script}\necho fell-through`,
      ],
      {
        encoding: "utf8",
        env: {
          ...stubEnv(root, bin),
          VERSION,
          TOOL: SCRIPT,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: NodePath.join(root, "summary"),
          GITHUB_REPOSITORY: "anton-abyzov/specwithcode",
          FEED_REPOSITORY: "anton-abyzov/specwithcode",
        },
      },
    );
    return {
      status: result.status,
      stdout: result.stdout,
      output: NodeFS.readFileSync(output, "utf8"),
    };
  };

  describe.each([
    ["Plan", planBlock, "skip=true\n"],
    ["Read the releases", publishBlock, "already=true\n"],
  ] as const)("catch-up check in %s", (_name, script, flag) => {
    it("skips when both releases hold a complete attach", () => {
      const run = runNightly(script, { private: attach("first"), public: attach("first") });
      expect(run.status).toBe(0);
      expect(run.output).toBe(flag);
      expect(run.stdout).not.toContain("fell-through");
    });

    it("goes on when neither release holds any of it", () => {
      const macOnly = new Map(RELEASE_SH_ASSETS.map((asset) => [asset, asset]));
      const run = runNightly(script, { private: macOnly, public: null });
      expect(run.status).toBe(0);
      expect(run.output).toBe("");
      expect(run.stdout).toContain("fell-through");
    });

    it("fails with repair steps after a replace stopped before the feeds", () => {
      const run = runNightly(script, { private: attach("first"), public: interruptedReplace() });
      expect(run.status).not.toBe(0);
      expect(run.output).toBe("");
      expect(run.stdout).toContain("latest.yml is sha256:");
      expect(run.stdout).toContain("replace=true");
    });

    it("fails when only one release holds the attach", () => {
      const run = runNightly(script, { private: attach("first"), public: null });
      expect(run.status).toBe(1);
      expect(run.output).toBe("");
      expect(run.stdout).toContain("replace=true");
    });
  });

  it("never trusts asset names alone, and verifies an attach another run made", () => {
    expect(workflow).not.toContain("grep -qx 'SHA256SUMS-windows-linux'");
    expect(workflow).not.toContain('"$TOOL" attached');
    const publish = workflow.slice(workflow.indexOf("\n  publish:\n"));
    expect(publish).toContain(
      "- name: Upload to both releases\n        if: needs.plan.outputs.dry_run != 'true' && steps.releases.outputs.already != 'true'",
    );
    const verify = publish.slice(publish.indexOf("- name: Verify both releases"));
    expect(verify).toMatch(
      /^- name: Verify both releases\n        if: needs\.plan\.outputs\.dry_run != 'true'\n/,
    );
    expect(verify).toContain('node "$TOOL" release-state --version "$VERSION" --repo "$repo"');
  });

  it("never names the macOS feed except to check it is unchanged", () => {
    const lines = workflow.split("\n").filter((line) => line.includes("latest-mac.yml"));
    const allowed =
      /^\s*#|select\(\.name == "latest-mac\.yml"|::error::latest-mac\.yml or SHA256SUMS changed/;
    expect(lines.filter((line) => !allowed.test(line))).toEqual([]);
  });
});
