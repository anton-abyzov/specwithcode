import { describe, expect, it } from "vite-plus/test";

import {
  chooseCliArchive,
  cliArchiveFileName,
  cliChecksumsHaveOwnArchive,
  cliArchivePlatformKey,
  cliArchiveTarCommand,
  cliReleaseDownloadBaseUrl,
  cliReleaseAssetsHaveArchive,
  cliReleaseChannelOf,
  cliReleaseIndexPageUrl,
  mergeChecksums,
  newestCliReleaseVersion,
  parseChecksums,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it("names archives by version and platform, zip only on Windows", () => {
    expect(cliArchiveFileName("1.2.3-preview.20260911.4", "linux-x64")).toBe(
      "studio-1.2.3-preview.20260911.4-linux-x64.tar.gz",
    );
    expect(cliArchiveFileName("1.2.3", "win32-x64")).toBe("studio-1.2.3-win32-x64.zip");
  });

  it("only maps platforms and architectures that have a release archive", () => {
    expect(cliArchivePlatformKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(cliArchivePlatformKey("linux", "x64")).toBe("linux-x64");
    expect(cliArchivePlatformKey("win32", "x64")).toBe("win32-x64");
    // Node single-executables are unsupported on x64 macOS.
    expect(cliArchivePlatformKey("darwin", "x64")).toBeUndefined();
    expect(cliArchivePlatformKey("linux", "arm64")).toBe("linux-arm64");
    expect(cliArchivePlatformKey("win32", "arm64")).toBe("win32-arm64");
    expect(cliArchivePlatformKey("freebsd", "x64")).toBeUndefined();
    expect(cliArchivePlatformKey("linux", "ia32")).toBeUndefined();
  });

  it("resolves download URLs under the tagged release, honoring a mirror", () => {
    expect(cliReleaseDownloadBaseUrl("1.2.3")).toBe(
      "https://github.com/anton-abyzov/specwithcode/releases/download/v1.2.3",
    );
    expect(cliReleaseDownloadBaseUrl("1.2.3", "https://mirror.example/studio/")).toBe(
      "https://mirror.example/studio/v1.2.3",
    );
  });

  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  studio-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *studio-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("studio-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("studio-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("derives the release channel from the version alone", () => {
    expect(cliReleaseChannelOf("1.2.3")).toBe("stable");
    expect(cliReleaseChannelOf("1.2.3-nightly.20260911.4")).toBe("nightly");
    expect(cliReleaseChannelOf("1.2.3-preview.20260911.4")).toBe("preview");
    // A prerelease that is not one of our trains is not silently a nightly.
    expect(cliReleaseChannelOf("1.2.3-rc.1")).toBe("stable");
  });

  it("picks the newest non-draft release on the requested channel", () => {
    const releases = [
      { tag_name: "v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "v1.2.4-preview.20260912.8" },
      { tag_name: "v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "v1.2.3" },
      { tag_name: "v1.2.3-nightly.20260911.2" },
    ];
    expect(newestCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3");
    expect(newestCliReleaseVersion([{ tag_name: "v1.2.3" }], "preview")).toBeUndefined();
  });

  it("pages through the release index at the largest page GitHub allows", () => {
    expect(cliReleaseIndexPageUrl(1)).toBe(
      "https://api.github.com/repos/anton-abyzov/specwithcode/releases?per_page=100&page=1",
    );
    expect(cliReleaseIndexPageUrl(3)).toContain("page=3");
  });

  it("prefers the single executable and falls back to the one commit-suffixed Node bundle", () => {
    const sum = "a".repeat(64);
    const of = (...names: string[]) => new Map(names.map((name) => [name, sum]));
    expect(
      chooseCliArchive(
        of("studio-1.0.43-linux-x64.tar.gz", "studio-1.0.43-linux-x64-043e9db88a6e.tar.gz"),
        "1.0.43",
        "linux-x64",
      ),
    ).toEqual({ fileName: "studio-1.0.43-linux-x64.tar.gz", layout: "single-executable" });
    expect(
      chooseCliArchive(
        of(
          "studio-1.0.43-043e9db88a6e.tar.gz",
          "studio-1.0.43-linux-arm64-043e9db88a6e.tar.gz",
          "studio-1.0.43-linux-x64-043e9db88a6e.tar.gz",
          "studio-1.0.43-deployment-helpers-043e9db88a6e.tar.gz",
        ),
        "1.0.43",
        "linux-x64",
      ),
    ).toEqual({ fileName: "studio-1.0.43-linux-x64-043e9db88a6e.tar.gz", layout: "node-bundle" });
    // Not another version's bundle, and never a guess between two.
    expect(
      chooseCliArchive(of("studio-1.0.4-linux-x64-043e9db88a6e.tar.gz"), "1.0.43", "linux-x64"),
    ).toBeUndefined();
    expect(
      chooseCliArchive(
        of(
          "studio-1.0.43-linux-x64-aaaaaaaaaaaa.tar.gz",
          "studio-1.0.43-linux-x64-bbbbbbbbbbbb.tar.gz",
        ),
        "1.0.43",
        "linux-x64",
      ),
    ).toBeUndefined();
  });

  // The asset names v1.0.132 really published, split the way its two checksum files list them.
  const release132 = {
    sums: [
      "SpecWithCode-1.0.132-arm64.dmg",
      "SpecWithCode-1.0.132-arm64.zip",
      "latest-mac.yml",
      "studio-1.0.132-linux-x64-ca452067cd93.tar.gz",
      "studio-1.0.132-linux-arm64-ca452067cd93.tar.gz",
      "install.sh",
      "studio-1.0.132-ca452067cd93.tar.gz",
      "studio-1.0.132-deployment-helpers-ca452067cd93.tar.gz",
      "studio-update.json",
    ],
    windowsLinux: [
      "SpecWithCode-1.0.132-amd64.deb",
      "SpecWithCode-1.0.132-arm64.exe",
      "SpecWithCode-1.0.132-x64.exe",
      "latest.yml",
      "studio-1.0.132-win32-arm64.zip",
      "studio-1.0.132-win32-x64.zip",
    ],
  };
  const listed = (names: ReadonlyArray<string>, digit = "a") =>
    new Map(names.map((name) => [name, digit.repeat(64)]));

  it("finds the Windows zips only in SHA256SUMS-windows-linux and the rest in SHA256SUMS", () => {
    const sums = listed(release132.sums);
    for (const key of ["win32-x64", "win32-arm64"] as const) {
      expect(cliChecksumsHaveOwnArchive(sums, "1.0.132", key)).toBe(false);
      expect(chooseCliArchive(sums, "1.0.132", key)).toBeUndefined();
    }
    const both = mergeChecksums(sums, listed(release132.windowsLinux));
    expect(chooseCliArchive(both, "1.0.132", "win32-x64")).toEqual({
      fileName: "studio-1.0.132-win32-x64.zip",
      layout: "single-executable",
    });
    expect(chooseCliArchive(both, "1.0.132", "win32-arm64")).toEqual({
      fileName: "studio-1.0.132-win32-arm64.zip",
      layout: "single-executable",
    });
    for (const key of ["linux-x64", "linux-arm64", "darwin-arm64"] as const) {
      expect(cliChecksumsHaveOwnArchive(sums, "1.0.132", key)).toBe(true);
    }
  });

  it("picks the macOS Node bundle, which has no platform in its name", () => {
    expect(chooseCliArchive(listed(release132.sums), "1.0.132", "darwin-arm64")).toEqual({
      fileName: "studio-1.0.132-ca452067cd93.tar.gz",
      layout: "node-bundle",
    });
    // Linux never takes the macOS bundle, and the deployment helpers are never a runtime.
    expect(
      chooseCliArchive(
        listed([
          "studio-1.0.132-ca452067cd93.tar.gz",
          "studio-1.0.132-deployment-helpers-ca452067cd93.tar.gz",
        ]),
        "1.0.132",
        "linux-x64",
      ),
    ).toBeUndefined();
    expect(
      chooseCliArchive(
        listed(["studio-1.0.132-deployment-helpers-ca452067cd93.tar.gz"]),
        "1.0.132",
        "darwin-arm64",
      ),
    ).toBeUndefined();
  });

  it("gives Windows on ARM the x64 zip only when the release has no arm64 zip", () => {
    const x64Only = listed(["studio-1.0.100-win32-x64.zip"]);
    expect(chooseCliArchive(x64Only, "1.0.100", "win32-arm64")).toEqual({
      fileName: "studio-1.0.100-win32-x64.zip",
      layout: "single-executable",
    });
    // The fallback does not settle the choice: the other file may still hold the arm64 zip.
    expect(cliChecksumsHaveOwnArchive(x64Only, "1.0.100", "win32-arm64")).toBe(false);
    // x64 never falls back to arm64.
    expect(
      chooseCliArchive(listed(["studio-1.0.100-win32-arm64.zip"]), "1.0.100", "win32-x64"),
    ).toBeUndefined();
  });

  it("never accepts a file the two checksum files list with different digests", () => {
    const merged = mergeChecksums(
      listed(["studio-1.0.132-win32-x64.zip", "same.txt"], "a"),
      listed(["studio-1.0.132-win32-x64.zip"], "b"),
      listed(["same.txt", "studio-1.0.132-win32-arm64.zip"], "a"),
    );
    expect(merged.has("studio-1.0.132-win32-x64.zip")).toBe(false);
    expect(merged.get("same.txt")).toBe("a".repeat(64));
    expect(merged.get("studio-1.0.132-win32-arm64.zip")).toBe("a".repeat(64));
    expect(chooseCliArchive(merged, "1.0.132", "win32-x64")).toBeUndefined();
  });

  it("skips releases whose assets lack this platform's archive, as install.ps1 does", () => {
    const assets = (...names: string[]) => names.map((name) => ({ name }));
    // 1.0.133 before release-windows-linux.yml attached its zips; 1.0.132 complete.
    const releases = [
      {
        tag_name: "v1.0.133",
        assets: assets("SHA256SUMS", "studio-1.0.133-0123456789ab.tar.gz"),
      },
      {
        tag_name: "v1.0.132",
        assets: assets(
          "SHA256SUMS",
          "SHA256SUMS-windows-linux",
          "studio-1.0.132-ca452067cd93.tar.gz",
          "studio-1.0.132-linux-x64-ca452067cd93.tar.gz",
          "studio-1.0.132-win32-x64.zip",
        ),
      },
    ];
    expect(newestCliReleaseVersion(releases, "stable", "darwin-arm64")).toBe("1.0.133");
    expect(newestCliReleaseVersion(releases, "stable", "win32-x64")).toBe("1.0.132");
    // Windows on ARM takes the x64 zip when the release has no arm64 one.
    expect(newestCliReleaseVersion(releases, "stable", "win32-arm64")).toBe("1.0.132");
    expect(newestCliReleaseVersion(releases, "stable", "linux-arm64")).toBeUndefined();
    // Without a platform key, or without an asset list, nothing is filtered.
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.0.133");
    expect(newestCliReleaseVersion([{ tag_name: "v1.0.133" }], "stable", "win32-x64")).toBe(
      "1.0.133",
    );
    expect(
      cliReleaseAssetsHaveArchive(["studio-1.0.132-win32-arm64.zip"], "1.0.132", "win32-arm64"),
    ).toBe(true);
    expect(cliReleaseAssetsHaveArchive(["SHA256SUMS"], "1.0.132", "win32-x64")).toBe(false);
  });
});
