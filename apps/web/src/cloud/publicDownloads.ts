/**
 * Public download counts for the owner's usage numbers: installers from the
 * GitHub releases of the app, and installs of the npm packages. Both are read
 * from public APIs without a credential, and nothing about this app or its
 * user is sent.
 */

const RELEASES_URL = "https://api.github.com/repos/anton-abyzov/specwithcode/releases";
const NPM_DOWNLOADS_URL = "https://api.npmjs.org/downloads/point";
/** The npm packages counted. */
export const PUBLIC_NPM_PACKAGES = ["specweave", "vskill"] as const;
const RELEASES_PER_PAGE = 100;
/** GitHub allows 60 requests an hour without a credential; one read uses at most this many. */
const RELEASE_PAGES_MAX = 5;
/** Counts change slowly, and a re-read spends the hourly allowance. */
const KEEP_FOR_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface InstallerDownloads {
  readonly mac: number;
  readonly windows: number;
  readonly linux: number;
  /** Releases the counts were added up from. */
  readonly releases: number;
  /** False when there are more releases than one read covers. */
  readonly complete: boolean;
}

export interface NpmDownloads {
  readonly name: string;
  readonly week: number;
  readonly month: number;
}

export interface PublicDownloads {
  /** Null when GitHub could not be read. */
  readonly installers: InstallerDownloads | null;
  /** Null when npm could not be read. */
  readonly npm: ReadonlyArray<NpmDownloads> | null;
}

type InstallerPlatform = "mac" | "windows" | "linux";

/**
 * What a release file is, by its name. Only files a person installs from are
 * counted: update archives, update feeds, signatures and server builds are not.
 */
export function installerPlatform(assetName: string): InstallerPlatform | null {
  const name = assetName.toLowerCase();
  if (name.endsWith(".dmg")) return "mac";
  if (name.endsWith(".exe")) return "windows";
  if (name.endsWith(".appimage") || name.endsWith(".deb")) return "linux";
  return null;
}

const wholeCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** Adds up installer downloads over the releases GitHub returned. */
export function countInstallerDownloads(
  releases: ReadonlyArray<unknown>,
): Pick<InstallerDownloads, InstallerPlatform> {
  const counts = { mac: 0, windows: 0, linux: 0 };
  for (const release of releases) {
    const assets = (release as { readonly assets?: unknown } | null)?.assets;
    if (!Array.isArray(assets)) continue;
    for (const asset of assets as ReadonlyArray<{ name?: unknown; download_count?: unknown }>) {
      const platform = typeof asset?.name === "string" ? installerPlatform(asset.name) : null;
      if (platform !== null) counts[platform] += wholeCount(asset.download_count);
    }
  }
  return counts;
}

type Fetch = typeof globalThis.fetch;

async function readJson(fetchFn: Fetch, url: string): Promise<unknown> {
  const response = await fetchFn(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function readInstallers(fetchFn: Fetch): Promise<InstallerDownloads> {
  const releases: Array<unknown> = [];
  let complete = false;
  for (let page = 1; page <= RELEASE_PAGES_MAX; page += 1) {
    const listed = await readJson(
      fetchFn,
      `${RELEASES_URL}?per_page=${RELEASES_PER_PAGE}&page=${page}`,
    );
    if (!Array.isArray(listed)) throw new Error("not a release list");
    releases.push(...listed);
    if (listed.length < RELEASES_PER_PAGE) {
      complete = true;
      break;
    }
  }
  return { ...countInstallerDownloads(releases), releases: releases.length, complete };
}

async function readNpm(fetchFn: Fetch): Promise<ReadonlyArray<NpmDownloads>> {
  const names = PUBLIC_NPM_PACKAGES.join(",");
  const [week, month] = (await Promise.all([
    readJson(fetchFn, `${NPM_DOWNLOADS_URL}/last-week/${names}`),
    readJson(fetchFn, `${NPM_DOWNLOADS_URL}/last-month/${names}`),
  ])) as ReadonlyArray<Record<string, { readonly downloads?: unknown } | null> | null>;
  return PUBLIC_NPM_PACKAGES.map((name) => ({
    name,
    week: wholeCount(week?.[name]?.downloads),
    month: wholeCount(month?.[name]?.downloads),
  }));
}

/** One read of both sources. It never rejects: a source that failed is null. */
export async function fetchPublicDownloads(
  fetchFn: Fetch = globalThis.fetch,
): Promise<PublicDownloads> {
  const [installers, npm] = await Promise.all([
    readInstallers(fetchFn).catch(() => null),
    readNpm(fetchFn).catch(() => null),
  ]);
  return { installers, npm };
}

let kept: { readonly at: number; readonly read: Promise<PublicDownloads> } | null = null;

/**
 * The counts, read at most once every ten minutes for this window. A read
 * with a failed source is not kept, so the next call asks again.
 */
export function readPublicDownloads(now: number = Date.now()): Promise<PublicDownloads> {
  if (kept !== null && now - kept.at < KEEP_FOR_MS) return kept.read;
  const read = fetchPublicDownloads();
  const entry = { at: now, read };
  kept = entry;
  void read.then((downloads) => {
    if ((downloads.installers === null || downloads.npm === null) && kept === entry) kept = null;
  });
  return read;
}
