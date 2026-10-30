/**
 * Naming shared by the release workflow, the runtime installers, and
 * install scripts for the per-platform CLI archives attached to GitHub
 * Releases. Every consumer derives the same file names from a version and a
 * platform key, so a rename here is a release-breaking change.
 */

const CLI_RELEASE_REPOSITORY = "anton-abyzov/specwithcode";
/**
 * scripts/release/release.sh publishes SHA256SUMS: the macOS app, the macOS
 * Node bundle and the Linux Node bundles. .github/workflows/release-windows-linux.yml
 * attaches the Windows CLI zips and the Windows and Linux desktop apps to the
 * same release afterwards, listed in SHA256SUMS-windows-linux; releases from
 * before that workflow have no such file.
 */
export const CLI_RELEASE_CHECKSUMS_FILE = "SHA256SUMS";
export const CLI_RELEASE_WINDOWS_LINUX_CHECKSUMS_FILE = "SHA256SUMS-windows-linux";
/** Overrides the download origin for mirrors and air-gapped installs. */
export const CLI_RELEASE_BASE_URL_ENV = "STUDIO_RELEASE_BASE_URL";

/**
 * The platforms a release has a CLI archive for. scripts/release/release.sh
 * builds the Node bundles: `studio-<v>-<commit>.tar.gz` for macOS arm64 (no
 * platform in its name) and `studio-<v>-linux-<arch>-<commit>.tar.gz` for
 * Linux. .github/workflows/release-windows-linux.yml builds the
 * single-executable `studio-<v>-win32-<arch>.zip` archives. A key here without
 * an archive there produces lookups that find nothing, and an archive there
 * without a key here is unreachable from every installer.
 */
// No darwin-x64: there is no Intel macOS build (scripts/install.sh refuses it
// too), and Node single-executables are unsupported on x64 macOS.
export const CLI_ARCHIVE_PLATFORM_KEYS = [
  "darwin-arm64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
] as const;
export type CliArchivePlatformKey = (typeof CLI_ARCHIVE_PLATFORM_KEYS)[number];

export function cliArchivePlatformKey(
  platform: NodeJS.Platform,
  arch: string,
): CliArchivePlatformKey | undefined {
  const key = `${platform}-${arch}`;
  return CLI_ARCHIVE_PLATFORM_KEYS.find((candidate) => candidate === key);
}

/**
 * The tar to extract a release archive with. Windows ships bsdtar in
 * System32, which reads both formats; a Git-for-Windows GNU tar earlier on
 * PATH cannot open the zip, so the system copy is named by absolute path.
 */
export function cliArchiveTarCommand(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (platform !== "win32") return "tar";
  const systemRoot = env["SystemRoot"] ?? env["windir"] ?? "C:\\Windows";
  return `${systemRoot}\\System32\\tar.exe`;
}

export function cliArchiveFileName(version: string, platformKey: CliArchivePlatformKey): string {
  return `studio-${version}-${platformKey}.${platformKey.startsWith("win32") ? "zip" : "tar.gz"}`;
}

/**
 * How a release archive is laid out. A `single-executable` archive wraps one
 * directory holding the `specweave-studio` executable (the Windows zips). A
 * `node-bundle` is what release.sh ships for macOS and Linux: `bin.mjs`, the
 * web client and `node_modules` at the archive root, run by the host's Node.js.
 */
export type CliArchiveLayout = "single-executable" | "node-bundle";

export interface CliArchiveChoice {
  readonly fileName: string;
  readonly layout: CliArchiveLayout;
}

const isCommitSuffix = (rest: string) => /^[0-9a-f]{7,40}\.tar\.gz$/.test(rest);

/** This platform's own archive, without the Windows on ARM fallback. */
function chooseOwnCliArchive(
  checksums: ReadonlyMap<string, string>,
  version: string,
  platformKey: CliArchivePlatformKey,
): CliArchiveChoice | undefined {
  const executable = cliArchiveFileName(version, platformKey);
  if (checksums.has(executable)) return { fileName: executable, layout: "single-executable" };
  const prefix = `studio-${version}-${platformKey}-`;
  // The macOS bundle has no platform in its name: studio-<v>-<commit>.tar.gz.
  const bare = `studio-${version}-`;
  const bundles = [...checksums.keys()].filter(
    (name) =>
      (name.startsWith(prefix) && isCommitSuffix(name.slice(prefix.length))) ||
      (platformKey === "darwin-arm64" &&
        name.startsWith(bare) &&
        isCommitSuffix(name.slice(bare.length))),
  );
  return bundles.length === 1 ? { fileName: bundles[0]!, layout: "node-bundle" } : undefined;
}

/**
 * Picks this platform's archive from a release's checksums: the
 * single-executable name when the release has one, otherwise the one
 * commit-suffixed Node bundle. Several bundles for one version and platform
 * are ambiguous and pick nothing. Windows on ARM takes the x64 zip, which it
 * runs emulated, only when the release has no arm64 zip (as scripts/install.ps1
 * does for releases from before the arm64 build).
 */
export function chooseCliArchive(
  checksums: ReadonlyMap<string, string>,
  version: string,
  platformKey: CliArchivePlatformKey,
): CliArchiveChoice | undefined {
  return (
    chooseOwnCliArchive(checksums, version, platformKey) ??
    (platformKey === "win32-arm64"
      ? chooseOwnCliArchive(checksums, version, "win32-x64")
      : undefined)
  );
}

/**
 * Whether SHA256SUMS alone settles the choice: it lists this platform's own
 * archive. Otherwise SHA256SUMS-windows-linux is read too, for the Windows
 * zips (and an arm64 zip that beats the x64 fallback).
 */
export function cliChecksumsHaveOwnArchive(
  checksums: ReadonlyMap<string, string>,
  version: string,
  platformKey: CliArchivePlatformKey,
): boolean {
  return chooseOwnCliArchive(checksums, version, platformKey) !== undefined;
}

/**
 * Joins the release's checksum files. A file listed in both with different
 * digests is dropped, so it is never accepted on either digest.
 */
export function mergeChecksums(
  ...files: ReadonlyArray<ReadonlyMap<string, string>>
): ReadonlyMap<string, string> {
  const merged = new Map<string, string>();
  const conflicting = new Set<string>();
  for (const file of files) {
    for (const [name, digest] of file) {
      const seen = merged.get(name);
      if (seen !== undefined && seen !== digest) conflicting.add(name);
      else merged.set(name, digest);
    }
  }
  for (const name of conflicting) merged.delete(name);
  return merged;
}

const CLI_RELEASE_DEFAULT_BASE_URL = `https://github.com/${CLI_RELEASE_REPOSITORY}/releases/download`;

/** Directory that `releases/download/<tag>/<asset>` lives under. */
export function cliReleaseDownloadBaseUrl(
  version: string,
  baseUrl: string | undefined = CLI_RELEASE_DEFAULT_BASE_URL,
): string {
  return `${(baseUrl?.trim() || CLI_RELEASE_DEFAULT_BASE_URL).replace(/\/+$/, "")}/v${version}`;
}

/**
 * Parses the `sha256sum` style checksum file attached to each release.
 * Lines are `<hex>  <file>`; a leading `*` marks binary mode and is ignored.
 */
export function parseChecksums(text: string): ReadonlyMap<string, string> {
  const checksums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      checksums.set(match[2], match[1].toLowerCase());
    }
  }
  return checksums;
}

export type CliReleaseChannel = "stable" | "nightly" | "preview";
export const CLI_RELEASE_CHANNELS: ReadonlyArray<CliReleaseChannel> = [
  "stable",
  "nightly",
  "preview",
];

/** The release train a version was published on, derived from its prerelease tag. */
export function cliReleaseChannelOf(version: string): CliReleaseChannel {
  const channel = /^[^-+]+-(nightly|preview)\.\d{8}\.\d+$/.exec(version)?.[1];
  return channel === "nightly" || channel === "preview" ? channel : "stable";
}

/**
 * One page of GitHub's list-releases endpoint, newest first. Callers walk pages
 * until a channel match turns up; a busy nightly train can push the newest
 * preview or stable release past any single page.
 */
export function cliReleaseIndexPageUrl(page: number): string {
  return `https://api.github.com/repos/${CLI_RELEASE_REPOSITORY}/releases?per_page=100&page=${page}`;
}

/**
 * Whether a release's asset list holds this platform's archive, by the same
 * rule chooseCliArchive applies to its checksums.
 */
export function cliReleaseAssetsHaveArchive(
  assetNames: ReadonlyArray<string>,
  version: string,
  platformKey: CliArchivePlatformKey,
): boolean {
  const names = new Map(assetNames.map((name) => [name, ""] as const));
  return chooseCliArchive(names, version, platformKey) !== undefined;
}

/**
 * Picks the newest version on a channel from the release index. Tags are
 * `v<version>`; the channel is decided by the same rule the runtime uses, so
 * a preview tag never satisfies a nightly lookup and vice versa. Drafts are
 * skipped because their assets are not downloadable. With a platform key, a
 * release whose asset list lacks that platform's archive is skipped too (as
 * scripts/install.ps1 does): the Windows zips are attached by a later
 * workflow, and some releases never got them. A release listed without its
 * assets is not judged.
 */
export function newestCliReleaseVersion(
  releases: ReadonlyArray<{
    readonly tag_name: string;
    readonly draft?: boolean | undefined;
    readonly assets?: ReadonlyArray<{ readonly name: string }> | undefined;
  }>,
  channel: CliReleaseChannel,
  platformKey?: CliArchivePlatformKey,
): string | undefined {
  for (const release of releases) {
    if (release.draft) continue;
    const version = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(release.tag_name)?.[1];
    if (version === undefined) continue;
    if (cliReleaseChannelOf(version) !== channel) continue;
    if (
      platformKey !== undefined &&
      release.assets !== undefined &&
      !cliReleaseAssetsHaveArchive(
        release.assets.map((asset) => asset.name),
        version,
        platformKey,
      )
    ) {
      continue;
    }
    return version;
  }
  return undefined;
}
