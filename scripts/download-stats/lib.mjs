// Pure helpers for the daily download snapshot of the public release repository.
// No I/O here: snapshot.mjs and today.mjs do the fetching, git and file work.

export const DEFAULT_REPO = "anton-abyzov/specwithcode";
export const DATA_BRANCH = "download-stats";

// Every platform bucket, in report order.
export const PLATFORMS = [
  "mac-dmg",
  "mac-zip",
  "windows-exe",
  "linux-deb",
  "linux-appimage",
  "install-script",
  "server-archive",
  "update-metadata",
  "signature",
  "other",
];

// Buckets that count as a fresh install and as an update download.
export const NEW_INSTALL_PLATFORMS = [
  "mac-dmg",
  "windows-exe",
  "linux-deb",
  "linux-appimage",
  "install-script",
];
export const UPDATE_PLATFORMS = ["mac-zip", "update-metadata"];

// Summary rows added after the per-platform rows.
export const SUMMARY_ROWS = ["new-installs", "updates", "all"];

/**
 * Maps a release asset name to its platform bucket. Order matters: update metadata
 * (blockmaps, checksums) and server archives are matched before the installer
 * extensions, so `x.dmg.blockmap` and `studio-1.0.0-win32-arm64.zip` land in the
 * right bucket.
 * @param {string} name
 * @returns {string}
 */
export function classifyAsset(name) {
  const n = String(name ?? "");
  const lower = n.toLowerCase();
  if (
    lower.endsWith(".blockmap") ||
    /^latest[^/]*\.yml$/.test(lower) ||
    lower === "studio-update.json" ||
    lower === "deployment-helpers-manifest.json" ||
    lower.startsWith("sha256sums")
  ) {
    // A detached signature of a checksum file is a signature, not metadata.
    if (lower.endsWith(".asc") || lower.endsWith(".sig")) return "signature";
    return "update-metadata";
  }
  if (lower.endsWith(".asc") || lower.endsWith(".sig")) return "signature";
  if (lower === "install.sh" || lower === "install.ps1") return "install-script";
  if (lower.startsWith("studio-") && (lower.endsWith(".tar.gz") || lower.endsWith(".zip"))) {
    return "server-archive";
  }
  if (lower.endsWith(".dmg")) return "mac-dmg";
  if (lower.endsWith("-mac.zip") || lower.endsWith("-arm64.zip") || lower.endsWith("-x64.zip")) {
    return "mac-zip";
  }
  if (lower.endsWith(".exe")) return "windows-exe";
  if (lower.endsWith(".deb")) return "linux-deb";
  if (lower.endsWith(".appimage")) return "linux-appimage";
  return "other";
}

/** UTC calendar date (YYYY-MM-DD) of a Date. */
export function utcDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Turns the GitHub REST releases list into the snapshot shape. Drafts are left out;
 * releases and assets are sorted so the file diff stays small between days.
 * @param {Array<any>} apiReleases
 * @param {{ repo: string, takenAt: string }} meta
 */
export function buildSnapshot(apiReleases, { repo, takenAt }) {
  const releases = (apiReleases ?? [])
    .filter((r) => r && !r.draft)
    .map((r) => ({
      tag: String(r.tag_name),
      publishedAt: r.published_at ?? null,
      assets: (r.assets ?? [])
        .map((a) => ({ name: String(a.name), downloadCount: Number(a.download_count) || 0 }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => {
      const pa = a.publishedAt ?? "";
      const pb = b.publishedAt ?? "";
      if (pa !== pb) return pa < pb ? 1 : -1;
      return a.tag.localeCompare(b.tag);
    });
  return { takenAt, repo, releases };
}

function assetKey(tag, name) {
  return `${tag}\u0000${name}`;
}

function emptyTotals() {
  return Object.fromEntries(PLATFORMS.map((p) => [p, 0]));
}

function withSummary(byPlatform) {
  const sum = (list) => list.reduce((acc, p) => acc + (byPlatform[p] ?? 0), 0);
  return {
    ...byPlatform,
    "new-installs": sum(NEW_INSTALL_PLATFORMS),
    updates: sum(UPDATE_PLATFORMS),
    all: sum(PLATFORMS),
  };
}

/**
 * Cumulative download counts per platform bucket, plus new-installs, updates and all.
 * @param {{ releases: Array<{ tag: string, assets: Array<{ name: string, downloadCount: number }> }> }} snapshot
 */
export function totalsByPlatform(snapshot) {
  const totals = emptyTotals();
  for (const release of snapshot?.releases ?? []) {
    for (const asset of release.assets ?? []) {
      totals[classifyAsset(asset.name)] += Number(asset.downloadCount) || 0;
    }
  }
  return withSummary(totals);
}

/**
 * Downloads between two snapshots per platform bucket. Each asset counts
 * (today - previous) for the same tag and asset name; an asset new since the
 * previous snapshot counts fully. A count that went down (asset replaced and its
 * counter reset) counts as 0, never negative. Without a previous snapshot every
 * asset counts fully.
 */
export function deltaByPlatform(current, previous) {
  const before = new Map();
  for (const release of previous?.releases ?? []) {
    for (const asset of release.assets ?? []) {
      before.set(assetKey(release.tag, asset.name), Number(asset.downloadCount) || 0);
    }
  }
  const delta = emptyTotals();
  for (const release of current?.releases ?? []) {
    for (const asset of release.assets ?? []) {
      const now = Number(asset.downloadCount) || 0;
      const prior = before.get(assetKey(release.tag, asset.name)) ?? 0;
      delta[classifyAsset(asset.name)] += Math.max(0, now - prior);
    }
  }
  return withSummary(delta);
}

/** Snapshot file names (snapshots/YYYY-MM-DD.json) sorted by date. */
export function sortSnapshotNames(names) {
  return names
    .map((n) => String(n).split("/").pop())
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))
    .sort();
}

/**
 * daily.csv rows for every dated snapshot, oldest first. Each date has one row per
 * platform bucket and summary row; delta is against the previous dated snapshot
 * (empty on the first date, where there is nothing to compare).
 * @param {Array<{ date: string, snapshot: any }>} dated
 */
export function buildDailyCsv(dated) {
  const ordered = [...dated].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const lines = ["date,platform,total,delta"];
  let previous = null;
  for (const { date, snapshot } of ordered) {
    const totals = totalsByPlatform(snapshot);
    const delta = previous ? deltaByPlatform(snapshot, previous) : null;
    for (const platform of [...PLATFORMS, ...SUMMARY_ROWS]) {
      lines.push(`${date},${platform},${totals[platform]},${delta ? delta[platform] : ""}`);
    }
    previous = snapshot;
  }
  return lines.join("\n") + "\n";
}

/** The latest.json summary: newest snapshot totals and the change since the one before. */
export function buildLatestSummary({ date, snapshot, previousDate, previous }) {
  const releases = snapshot?.releases ?? [];
  return {
    date,
    takenAt: snapshot?.takenAt ?? null,
    repo: snapshot?.repo ?? null,
    previousDate: previousDate ?? null,
    releaseCount: releases.length,
    latestTag: releases[0]?.tag ?? null,
    totals: totalsByPlatform(snapshot),
    delta: previous ? deltaByPlatform(snapshot, previous) : null,
  };
}

/** Plain-text table for today.mjs. */
export function formatReport({ title, fromLabel, toLabel, delta, totals }) {
  const rows = [...PLATFORMS, ...SUMMARY_ROWS];
  const width = Math.max(...rows.map((r) => r.length));
  const out = [`${title} (${fromLabel} -> ${toLabel})`];
  for (const platform of rows) {
    if (platform === SUMMARY_ROWS[0]) out.push("-".repeat(width + 22));
    const d = String(delta[platform] ?? 0).padStart(8);
    const t = String(totals[platform] ?? 0).padStart(10);
    out.push(`${platform.padEnd(width)}  ${d}  total ${t}`);
  }
  return out.join("\n");
}

/** Parses the `Link` header of a paginated GitHub response for the next page URL. */
export function nextPageUrl(linkHeader) {
  if (!linkHeader) return null;
  for (const part of String(linkHeader).split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

/** Reads every page of a repository's releases from the GitHub REST API. */
export async function fetchAllReleases(repo, { token, fetchImpl = globalThis.fetch } = {}) {
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "download-stats-snapshot",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  let url = `https://api.github.com/repos/${repo}/releases?per_page=100`;
  const all = [];
  for (let page = 0; url && page < 100; page += 1) {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      throw new Error(`GitHub releases request failed: ${res.status} ${res.statusText}`);
    }
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error("GitHub releases response was not a list");
    all.push(...body);
    url = nextPageUrl(res.headers.get("link"));
  }
  return all;
}
