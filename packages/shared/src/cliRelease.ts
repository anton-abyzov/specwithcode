/**
 * Naming shared by the release workflow, the runtime installers, and
 * install scripts for the per-platform CLI archives attached to GitHub
 * Releases. Every consumer derives the same file names from a version and a
 * platform key, so a rename here is a release-breaking change.
 */

const CLI_RELEASE_REPOSITORY = "anton-abyzov/specwithcode";
export const CLI_RELEASE_CHECKSUMS_FILE = "SHA256SUMS";
/** Overrides the download origin for mirrors and air-gapped installs. */
export const CLI_RELEASE_BASE_URL_ENV = "STUDIO_RELEASE_BASE_URL";

/**
 * The archives a release attaches. Kept in step with the build_linux_cli
 * matrix, build_windows_arm64_cli, and the `cli_archive` rows in
 * .github/workflows/release.yml: a key here without a build there produces
 * download URLs that 404, and a build there without a key here is
 * unreachable from every installer.
 */
// No darwin-x64: Node single-executables are unsupported on x64 macOS (the
// SEA docs list macOS as arm64 only) and the binary segfaults on start.
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
 * directory holding the `specweave-studio` executable. A `node-bundle` is what
 * the fleet release ships for Linux (`studio-<v>-linux-<arch>-<commit>.tar.gz`):
 * `bin.mjs`, the web client and `node_modules` at the archive root, run by the
 * host's Node.js.
 */
export type CliArchiveLayout = "single-executable" | "node-bundle";

export interface CliArchiveChoice {
  readonly fileName: string;
  readonly layout: CliArchiveLayout;
}

/**
 * Picks this platform's archive from a release's checksums: the
 * single-executable name when the release has one, otherwise the one
 * commit-suffixed Node bundle. Several bundles for one version and platform
 * are ambiguous and pick nothing.
 */
export function chooseCliArchive(
  checksums: ReadonlyMap<string, string>,
  version: string,
  platformKey: CliArchivePlatformKey,
): CliArchiveChoice | undefined {
  const executable = cliArchiveFileName(version, platformKey);
  if (checksums.has(executable)) return { fileName: executable, layout: "single-executable" };
  const prefix = `studio-${version}-${platformKey}-`;
  const bundles = [...checksums.keys()].filter(
    (name) =>
      name.startsWith(prefix) && /^[0-9a-f]{7,40}\.tar\.gz$/.test(name.slice(prefix.length)),
  );
  return bundles.length === 1 ? { fileName: bundles[0]!, layout: "node-bundle" } : undefined;
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
 * Picks the newest version on a channel from the release index. Tags are
 * `v<version>`; the channel is decided by the same rule the runtime uses, so
 * a preview tag never satisfies a nightly lookup and vice versa. Drafts are
 * skipped because their assets are not downloadable.
 */
export function newestCliReleaseVersion(
  releases: ReadonlyArray<{
    readonly tag_name: string;
    readonly draft?: boolean | undefined;
  }>,
  channel: CliReleaseChannel,
): string | undefined {
  for (const release of releases) {
    if (release.draft) continue;
    const version = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(release.tag_name)?.[1];
    if (version === undefined) continue;
    if (cliReleaseChannelOf(version) === channel) return version;
  }
  return undefined;
}
