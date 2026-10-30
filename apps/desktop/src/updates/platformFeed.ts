import { compareSemverVersions } from "@specweave-studio/shared/semver";

import {
  fetchReleases,
  type GitHubFeed,
  type GitHubRelease,
  type ReleaseFeedCache,
  versionFromTag,
} from "./githubReleaseFeed.ts";
import type { ElectronUpdaterFeedUrl } from "../electron/ElectronUpdater.ts";

/**
 * Windows and Linux apps are attached to a release after release.sh has published it (it dispatches
 * release-windows-linux.yml, which also runs a daily catch-up), so GitHub's Latest release often
 * has no latest.yml or latest-linux.yml yet. electron-updater's github provider reads only the
 * Latest release, so every check then fails ("Cannot find latest-linux.yml") and the app stays
 * where it is until a release that has its feed is Latest again. This finds the newest release that
 * does carry this platform's manifest and points the updater at that release instead.
 */

/** electron-builder's manifest for a channel on Windows or Linux; null on macOS. */
export function platformManifestName(
  platform: string,
  arch: string,
  channel: string,
): string | null {
  const base = channel.trim() === "" ? "latest" : channel;
  if (platform === "win32") return `${base}.yml`;
  if (platform === "linux")
    return arch === "arm64" ? `${base}-linux-arm64.yml` : `${base}-linux.yml`;
  return null;
}

/**
 * The release to read when the newest stable release lacks `manifestName`: the newest stable one
 * that has it. Null when the newest has it (the github provider reads it already) or none does.
 */
export function selectFeedRelease(
  releases: ReadonlyArray<GitHubRelease>,
  manifestName: string,
): { readonly tagName: string; readonly version: string } | null {
  let newest: {
    readonly tagName: string;
    readonly version: string;
    readonly hasFeed: boolean;
  } | null = null;
  let newestWithFeed: { readonly tagName: string; readonly version: string } | null = null;
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const version = versionFromTag(release.tagName);
    if (version === null || version.includes("-")) continue;
    const hasFeed = release.assets.some((asset) => asset.name === manifestName);
    if (newest === null || compareSemverVersions(version, newest.version) > 0) {
      newest = { tagName: release.tagName, version, hasFeed };
    }
    if (
      hasFeed &&
      (newestWithFeed === null || compareSemverVersions(version, newestWithFeed.version) > 0)
    ) {
      newestWithFeed = { tagName: release.tagName, version };
    }
  }
  if (newest === null || newest.hasFeed) return null;
  return newestWithFeed;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The feed for the next check. The release list is read without the sign-in: a repository that
 * answers anonymously serves its downloads anonymously too, which the generic provider needs. Any
 * failure (offline, rate limited, a private repository) keeps the github provider as before.
 */
export async function resolveUpdateFeed(input: {
  readonly owner: string;
  readonly repo: string;
  readonly token: string | null;
  readonly platform: string;
  readonly arch: string;
  readonly channel: string;
  readonly fetchImpl?: FetchLike;
  readonly cache?: ReleaseFeedCache;
}): Promise<{ readonly feed: ElectronUpdaterFeedUrl; readonly fallbackTag: string | null }> {
  const { owner, repo, token } = input;
  const github = {
    feed: {
      provider: "github",
      owner,
      repo,
      ...(token ? { private: true, token } : {}),
    } as ElectronUpdaterFeedUrl,
    fallbackTag: null,
  };
  // Nightly reads prereleases through the github provider; only the stable channel falls back.
  if (input.channel !== "latest") return github;
  const manifestName = platformManifestName(input.platform, input.arch, input.channel);
  if (manifestName === null) return github;
  const anonymous: GitHubFeed = { owner, repo, token: null };
  const releases = await fetchReleases(
    anonymous,
    input.fetchImpl,
    input.cache ? { cache: input.cache } : {},
  ).catch(() => null);
  const selected = releases === null ? null : selectFeedRelease(releases, manifestName);
  if (selected === null) return github;
  return {
    feed: {
      provider: "generic",
      url: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/download/${encodeURIComponent(selected.tagName)}`,
      // GitHub's asset storage answers multi-range requests with 501; the github provider turns
      // them off too, so differential downloads use one range per request.
      useMultipleRangeRequest: false,
    } as ElectronUpdaterFeedUrl,
    fallbackTag: selected.tagName,
  };
}
