// @effect-diagnostics nodeBuiltinImport:off - Drives the helper's command line against real files.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { cliArchiveFileName } from "./build-cli-archive.ts";
import {
  appUpdateConfigProblems,
  feedManifestName,
  feedProblems,
  formatSums,
  isReleaseShAssetName,
  isStableVersion,
  isWindowsLinuxAssetName,
  parseFeedManifest,
  planUpload,
  publicLeaks,
  requiredAssetNames,
  WINDOWS_LINUX_SUMS,
  windowsCliArchiveName,
} from "./release-windows-linux.ts";

const VERSION = "1.0.63";
const SCRIPT = fileURLToPath(new URL("./release-windows-linux.ts", import.meta.url));

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
      localNames: OWN_ASSETS,
      existingNames: RELEASE_SH_ASSETS,
      replace: false,
    });
    expect(plan.problems).toEqual([]);
    expect(plan.upload).toHaveLength(OWN_ASSETS.length);
  });

  it("refuses to overwrite its own assets unless asked to", () => {
    const again = { version: VERSION, localNames: OWN_ASSETS, existingNames: ["latest.yml"] };
    expect(planUpload({ ...again, replace: false }).problems).toEqual([
      "latest.yml is already on the release; rerun with replace to overwrite this workflow's assets",
    ]);
    expect(planUpload({ ...again, replace: true }).problems).toEqual([]);
  });

  it("never uploads the macOS feed, even with replace", () => {
    const plan = planUpload({
      version: VERSION,
      localNames: [...OWN_ASSETS, "latest-mac.yml"],
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

  it("writes the checksum file and plans the upload against a release listing", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "release-windows-linux-"));
    const dir = NodePath.join(root, "assets");
    NodeFS.mkdirSync(dir);
    for (const name of OWN_ASSETS.filter((name) => name !== WINDOWS_LINUX_SUMS))
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
    expect(upload.trim().split("\n")).toHaveLength(OWN_ASSETS.length);
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
    expect(script).toContain('-contains "studio-$($_.tag_name.Substring(1))-win32-$arch.zip"');
  });
});

describe("release-windows-linux.yml", () => {
  const workflow = NodeFS.readFileSync(
    new URL("../.github/workflows/release-windows-linux.yml", import.meta.url),
    "utf8",
  );

  it("runs only on GitHub-hosted runners", () => {
    const runners = [...workflow.matchAll(/^\s+runs-on:\s*(\S+)/gm)].map((match) => match[1]);
    expect(new Set(runners)).toEqual(new Set(["ubuntu-24.04", "windows-2025"]));
  });

  it("defaults to a dry run and builds both installers", () => {
    expect(workflow).toMatch(/dry_run:\n(?:\s+\w+:.*\n)*?\s+default: true/);
    expect(workflow).toContain("--platform win --target nsis --arch x64");
    expect(workflow).toContain("--platform linux --target AppImage --arch x64");
  });

  it("builds and smoke-tests the Windows and Linux CLI archives", () => {
    expect(workflow.match(/node apps\/server\/scripts\/cli\.ts build-exe/g)).toHaveLength(2);
    expect(workflow).toContain("build-cli-archive.ts --platform win --arch x64");
    expect(workflow).toContain("build-cli-archive.ts --platform linux --arch x64");
    expect(workflow).toContain('--archive "release-cli/studio-$VERSION-win32-x64.zip"');
    expect(workflow).toContain('--archive "release-cli/studio-$VERSION-linux-x64.tar.gz"');
  });

  // release.sh owns every studio-*.tar.gz name; install.sh installs its Node bundle.
  it("keeps the Linux CLI archive off the release", () => {
    const name = cliArchiveFileName(VERSION, "linux", "x64");
    expect(isReleaseShAssetName(name)).toBe(true);
    expect(isWindowsLinuxAssetName(name, VERSION)).toBe(false);
    expect(requiredAssetNames("linux", VERSION)).not.toContain(name);
    expect(workflow).toContain("name: cli-linux-x64-${{ needs.plan.outputs.version }}");
  });

  it("never names the macOS feed except to check it is unchanged", () => {
    const lines = workflow.split("\n").filter((line) => line.includes("latest-mac.yml"));
    const allowed =
      /^\s*#|select\(\.name == "latest-mac\.yml"|::error::latest-mac\.yml or SHA256SUMS changed/;
    expect(lines.filter((line) => !allowed.test(line))).toEqual([]);
  });
});
