import { compareSemverVersions, parseSemver } from "@specweave-studio/shared/semver";

/**
 * Reads Studio releases straight from the GitHub REST API. The desktop's own
 * updater uses this on macOS while builds are unsigned (Squirrel.Mac refuses
 * unsigned updates), so it must work for a private repository: every request
 * carries the token of the `gh` login on this computer when one exists.
 */

export const GITHUB_API_URL = "https://api.github.com";
export const MAC_UPDATE_MANIFEST = "latest-mac.yml";

/** electron-builder names each channel's Mac manifest `<channel>-mac.yml`. */
export function macUpdateManifestName(channel: string): string {
  return channel === "latest" || channel.trim() === "" ? MAC_UPDATE_MANIFEST : `${channel}-mac.yml`;
}

export interface GitHubFeed {
  readonly owner: string;
  readonly repo: string;
  readonly token: string | null;
  readonly apiUrl?: string;
}

export interface GitHubReleaseAsset {
  readonly id: number;
  readonly name: string;
  readonly size: number;
}

export interface GitHubRelease {
  readonly tagName: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly body: string | null;
  readonly publishedAt: string | null;
  readonly assets: ReadonlyArray<GitHubReleaseAsset>;
}

export interface SelectedRelease {
  readonly release: GitHubRelease;
  readonly version: string;
  readonly manifestAsset: GitHubReleaseAsset;
}

export interface UpdateManifestFile {
  readonly url: string;
  readonly sha512: string;
  readonly size: number | null;
}

/** The parts of electron-builder's `latest-mac.yml` an install needs. */
export interface UpdateManifest {
  readonly version: string;
  readonly files: ReadonlyArray<UpdateManifestFile>;
  readonly releaseDate: string | null;
}

export class GitHubFeedError extends Error {
  readonly status: number | null;
  /** Epoch ms before which the feed will not ask GitHub again (rate limits). */
  readonly retryAt: number | null;
  constructor(message: string, status: number | null = null, retryAt: number | null = null) {
    super(message);
    this.name = "GitHubFeedError";
    this.status = status;
    this.retryAt = retryAt;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseGitHubReleases(json: unknown): ReadonlyArray<GitHubRelease> {
  if (!Array.isArray(json)) return [];
  const releases: GitHubRelease[] = [];
  for (const entry of json) {
    const record = asRecord(entry);
    if (record === null || typeof record.tag_name !== "string") continue;
    const assets: GitHubReleaseAsset[] = [];
    if (Array.isArray(record.assets)) {
      for (const rawAsset of record.assets) {
        const asset = asRecord(rawAsset);
        if (asset === null) continue;
        if (typeof asset.id !== "number" || typeof asset.name !== "string") continue;
        assets.push({
          id: asset.id,
          name: asset.name,
          size: typeof asset.size === "number" ? asset.size : 0,
        });
      }
    }
    releases.push({
      tagName: record.tag_name,
      draft: record.draft === true,
      prerelease: record.prerelease === true,
      body: typeof record.body === "string" ? record.body : null,
      publishedAt: typeof record.published_at === "string" ? record.published_at : null,
      assets,
    });
  }
  return releases;
}

/** `v0.2.1` and `0.2.1` both name version 0.2.1; anything else is skipped. */
export function versionFromTag(tagName: string): string | null {
  const candidate = tagName.trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(candidate)) return null;
  return parseSemver(candidate) === null ? null : candidate;
}

/**
 * The newest release above `currentVersion` that carries `manifestName`.
 * Drafts never count. The version decides the track, not GitHub's
 * prerelease flag: the 0.2.x alpha releases were published as prereleases,
 * yet a plain `0.2.1` is a stable release, and from 1.0.0 plain versions are
 * published as Latest (scripts/studio-projects/release-flags.mjs). Suffixed
 * versions need `allowPrerelease`.
 */
export function selectNewestRelease(input: {
  readonly releases: ReadonlyArray<GitHubRelease>;
  readonly currentVersion: string;
  readonly allowPrerelease: boolean;
  readonly manifestName: string;
}): SelectedRelease | null {
  let best: SelectedRelease | null = null;
  for (const release of input.releases) {
    if (release.draft) continue;
    const version = versionFromTag(release.tagName);
    if (version === null) continue;
    if (!input.allowPrerelease && version.includes("-")) continue;
    if (compareSemverVersions(version, input.currentVersion) <= 0) continue;
    const manifestAsset = release.assets.find((asset) => asset.name === input.manifestName);
    if (manifestAsset === undefined) continue;
    if (best === null || compareSemverVersions(version, best.version) > 0) {
      best = { release, version, manifestAsset };
    }
  }
  return best;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Parses the flat YAML electron-builder writes for update manifests:
 * `version`, a `files` list of `url`/`sha512`/`size` maps, and scalar keys.
 * It is not a general YAML parser and rejects anything it cannot read.
 */
export function parseUpdateManifest(text: string): UpdateManifest | null {
  let version: string | null = null;
  let releaseDate: string | null = null;
  const files: Array<{ url?: string; sha512?: string; size?: number }> = [];
  let inFiles = false;
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim() === "" || rawLine.trimStart().startsWith("#")) continue;
    const topLevel = /^([A-Za-z][\w]*):\s*(.*)$/.exec(rawLine);
    if (topLevel) {
      const [, key, value = ""] = topLevel;
      inFiles = key === "files" && value.trim() === "";
      if (key === "version") version = unquote(value);
      if (key === "releaseDate") releaseDate = unquote(value);
      continue;
    }
    if (!inFiles) continue;
    const item = /^\s+-\s+([A-Za-z][\w]*):\s*(.*)$/.exec(rawLine);
    const field = item ?? /^\s+([A-Za-z][\w]*):\s*(.*)$/.exec(rawLine);
    if (field === null) return null;
    if (item) files.push({});
    const current = files.at(-1);
    if (current === undefined) return null;
    const [, key, rawValue = ""] = field;
    const value = unquote(rawValue);
    if (key === "url") current.url = value;
    else if (key === "sha512") current.sha512 = value;
    else if (key === "size") {
      const size = Number.parseInt(value, 10);
      if (Number.isFinite(size)) current.size = size;
    }
  }
  if (version === null || parseSemver(version) === null) return null;
  const complete: UpdateManifestFile[] = [];
  for (const file of files) {
    if (!file.url || !file.sha512) continue;
    complete.push({ url: file.url, sha512: file.sha512, size: file.size ?? null });
  }
  return { version, files: complete, releaseDate };
}

/**
 * The zip for this Mac's architecture. electron-builder names arm64 zips
 * `...-arm64.zip` and Intel zips without a suffix or with `-x64`.
 */
export function selectMacZip(manifest: UpdateManifest, arch: string): UpdateManifestFile | null {
  const zips = manifest.files.filter((file) => file.url.toLowerCase().endsWith(".zip"));
  if (arch === "arm64") {
    return zips.find((file) => /arm64/i.test(file.url)) ?? null;
  }
  return (
    zips.find((file) => /x64/i.test(file.url)) ??
    zips.find((file) => !/arm64|universal/i.test(file.url)) ??
    null
  );
}

/** Asset names come from a manifest we downloaded; refuse anything path-like. */
export function isPlainAssetName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name) && !name.includes("..");
}

export function describeFeedError(status: number, hasToken: boolean): string {
  if ((status === 404 || status === 401) && !hasToken) {
    return "SpecWithCode's releases are private. Sign in with `gh auth login` on this computer so updates can be read.";
  }
  if (status === 401) {
    return "GitHub refused the saved sign-in. Run `gh auth login` again on this computer.";
  }
  if (status === 404) {
    return "This GitHub account cannot read SpecWithCode's releases.";
  }
  if (status === 403 || status === 429) {
    return "GitHub is rate limiting update checks. SpecWithCode will try again later.";
  }
  return `GitHub answered ${status} while looking for updates.`;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function apiHeaders(feed: GitHubFeed, accept: string): Record<string, string> {
  return {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "SpecWeave-Studio-Updater",
    ...(feed.token ? { Authorization: `Bearer ${feed.token}` } : {}),
  };
}

/**
 * What the releases request remembers between checks: the last answer and its
 * ETag, so an unchanged release list costs a 304 that GitHub does not count
 * against the rate limit, and when GitHub said to come back after a limit.
 */
export interface ReleaseFeedCache {
  readonly answers: Map<
    string,
    { readonly etag: string; readonly releases: ReadonlyArray<GitHubRelease> }
  >;
  readonly blockedUntil: Map<string, number>;
  readonly consecutiveLimits: Map<string, number>;
}

export function createReleaseFeedCache(): ReleaseFeedCache {
  return { answers: new Map(), blockedUntil: new Map(), consecutiveLimits: new Map() };
}

const defaultReleaseFeedCache = createReleaseFeedCache();

const MIN_RATE_LIMIT_BACKOFF_MS = 60_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 60 * 60_000;

/** A 429, or a 403 GitHub marks as a rate limit (no requests left, or Retry-After). */
export function isRateLimitResponse(status: number, headers: Headers): boolean {
  if (status === 429) return true;
  return (
    status === 403 &&
    (headers.get("x-ratelimit-remaining") === "0" || headers.get("retry-after") !== null)
  );
}

/**
 * How long to wait after a rate limit: Retry-After first, then the reset time
 * GitHub reports, otherwise one minute doubling with each limit in a row.
 * Always at least a minute and at most an hour.
 */
export function rateLimitDelayMs(headers: Headers, now: number, consecutive: number): number {
  const clamp = (ms: number) =>
    Math.min(MAX_RATE_LIMIT_BACKOFF_MS, Math.max(MIN_RATE_LIMIT_BACKOFF_MS, ms));
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter.trim());
    if (Number.isFinite(seconds) && retryAfter.trim() !== "") return clamp(seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return clamp(date - now);
  }
  const reset = Number(headers.get("x-ratelimit-reset") ?? "");
  if (Number.isFinite(reset) && reset > 0) return clamp(reset * 1000 - now);
  return clamp(MIN_RATE_LIMIT_BACKOFF_MS * 2 ** Math.max(0, consecutive - 1));
}

/**
 * One key per repository and sign-in: the releases list and asset downloads
 * share GitHub's limit, so a limit hit by either holds back both.
 */
function feedCacheKey(feed: GitHubFeed): string {
  const base = feed.apiUrl ?? GITHUB_API_URL;
  return `${base}/repos/${feed.owner}/${feed.repo}#${feed.token ? "token" : "anonymous"}`;
}

function throwIfBlocked(
  feed: GitHubFeed,
  cache: ReleaseFeedCache,
  key: string,
  now: () => number,
): void {
  const blockedUntil = cache.blockedUntil.get(key);
  if (blockedUntil !== undefined && now() < blockedUntil) {
    throw new GitHubFeedError(describeFeedError(429, feed.token !== null), 429, blockedUntil);
  }
}

function recordRateLimit(
  feed: GitHubFeed,
  cache: ReleaseFeedCache,
  key: string,
  now: () => number,
  response: Response,
): GitHubFeedError {
  const consecutive = (cache.consecutiveLimits.get(key) ?? 0) + 1;
  cache.consecutiveLimits.set(key, consecutive);
  const retryAt = now() + rateLimitDelayMs(response.headers, now(), consecutive);
  cache.blockedUntil.set(key, retryAt);
  return new GitHubFeedError(
    describeFeedError(response.status, feed.token !== null),
    response.status,
    retryAt,
  );
}

export async function fetchReleases(
  feed: GitHubFeed,
  fetchImpl: FetchLike = fetch,
  options: { readonly cache?: ReleaseFeedCache; readonly now?: () => number } = {},
): Promise<ReadonlyArray<GitHubRelease>> {
  const cache = options.cache ?? defaultReleaseFeedCache;
  const now = options.now ?? Date.now;
  const base = feed.apiUrl ?? GITHUB_API_URL;
  const url = `${base}/repos/${encodeURIComponent(feed.owner)}/${encodeURIComponent(feed.repo)}/releases?per_page=30`;
  const key = feedCacheKey(feed);
  throwIfBlocked(feed, cache, key, now);
  const cached = cache.answers.get(key);
  const response = await fetchImpl(url, {
    headers: {
      ...apiHeaders(feed, "application/vnd.github+json"),
      ...(cached ? { "If-None-Match": cached.etag } : {}),
    },
  });
  if (response.status === 304 && cached) {
    cache.blockedUntil.delete(key);
    cache.consecutiveLimits.delete(key);
    return cached.releases;
  }
  if (isRateLimitResponse(response.status, response.headers)) {
    throw recordRateLimit(feed, cache, key, now, response);
  }
  if (!response.ok) {
    throw new GitHubFeedError(
      describeFeedError(response.status, feed.token !== null),
      response.status,
    );
  }
  cache.blockedUntil.delete(key);
  cache.consecutiveLimits.delete(key);
  const releases = parseGitHubReleases(await response.json());
  const etag = response.headers.get("etag");
  if (etag) cache.answers.set(key, { etag, releases });
  else cache.answers.delete(key);
  return releases;
}

/**
 * Opens a release asset. GitHub redirects asset downloads to a storage host;
 * the token goes only to the API host, never along the redirect.
 */
export async function openReleaseAsset(
  feed: GitHubFeed,
  assetId: number,
  fetchImpl: FetchLike = fetch,
  options: { readonly cache?: ReleaseFeedCache; readonly now?: () => number } = {},
): Promise<Response> {
  const cache = options.cache ?? defaultReleaseFeedCache;
  const now = options.now ?? Date.now;
  const key = feedCacheKey(feed);
  throwIfBlocked(feed, cache, key, now);
  const base = feed.apiUrl ?? GITHUB_API_URL;
  const url = `${base}/repos/${encodeURIComponent(feed.owner)}/${encodeURIComponent(feed.repo)}/releases/assets/${assetId}`;
  const first = await fetchImpl(url, {
    headers: apiHeaders(feed, "application/octet-stream"),
    redirect: "manual",
  });
  if (isRateLimitResponse(first.status, first.headers)) {
    throw recordRateLimit(feed, cache, key, now, first);
  }
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get("location");
    if (!location) throw new GitHubFeedError("GitHub sent a download redirect without a target.");
    const target = new URL(location, url);
    const sameHost = target.host === new URL(url).host;
    const second = await fetchImpl(target.toString(), {
      headers: sameHost
        ? apiHeaders(feed, "application/octet-stream")
        : { Accept: "application/octet-stream", "User-Agent": "SpecWeave-Studio-Updater" },
    });
    if (!second.ok) {
      throw new GitHubFeedError(`Downloading the update failed (${second.status}).`, second.status);
    }
    return second;
  }
  if (!first.ok) {
    throw new GitHubFeedError(describeFeedError(first.status, feed.token !== null), first.status);
  }
  return first;
}
