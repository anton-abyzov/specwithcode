#!/usr/bin/env node
// Takes today's download snapshot of the public release repository.
//
//   node scripts/download-stats/snapshot.mjs --out <data dir> [--repo owner/name] [--date YYYY-MM-DD] [--dry-run]
//
// Writes <out>/snapshots/<UTC date>.json, then regenerates <out>/daily.csv and
// <out>/latest.json from every snapshot in <out>/snapshots. Running twice on one day
// overwrites that day's snapshot. The workflow points --out at a checkout of the
// download-stats data branch and commits the result; this script never touches git.
// --dry-run prints the summary and writes nothing unless --out is given.
// GITHUB_TOKEN (optional for a public repository) raises the API rate limit.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  DEFAULT_REPO,
  buildDailyCsv,
  buildLatestSummary,
  buildSnapshot,
  fetchAllReleases,
  formatReport,
  sortSnapshotNames,
  utcDate,
} from "./lib.mjs";

export function parseArgs(argv) {
  const opts = { out: null, repo: DEFAULT_REPO, date: null, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1;
      return v;
    };
    if (arg === "--out") opts.out = value();
    else if (arg === "--repo") opts.repo = value();
    else if (arg === "--date") opts.date = value();
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (opts.date && !/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
    throw new Error("--date must be YYYY-MM-DD");
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new Error("--repo must be owner/name");
  if (!opts.out && !opts.dryRun && !opts.help) throw new Error("--out <dir> is required");
  return opts;
}

function readSnapshots(dir) {
  const snapshotsDir = NodePath.join(dir, "snapshots");
  if (!NodeFS.existsSync(snapshotsDir)) return [];
  return sortSnapshotNames(NodeFS.readdirSync(snapshotsDir)).map((file) => ({
    date: file.slice(0, 10),
    snapshot: JSON.parse(NodeFS.readFileSync(NodePath.join(snapshotsDir, file), "utf8")),
  }));
}

function writeFileAtomic(path, content) {
  const tmp = `${path}.tmp-${process.pid}`;
  NodeFS.writeFileSync(tmp, content);
  NodeFS.renameSync(tmp, path);
}

/**
 * Writes the snapshot and regenerated aggregates into `out`. Returns the latest.json
 * summary. Exported for tests and for callers that already hold the releases.
 */
export function writeSnapshot(out, date, snapshot) {
  NodeFS.mkdirSync(NodePath.join(out, "snapshots"), { recursive: true });
  writeFileAtomic(
    NodePath.join(out, "snapshots", `${date}.json`),
    JSON.stringify(snapshot, null, 2) + "\n",
  );
  const dated = readSnapshots(out);
  writeFileAtomic(NodePath.join(out, "daily.csv"), buildDailyCsv(dated));
  const newest = dated[dated.length - 1];
  const before = dated[dated.length - 2] ?? null;
  // latest.json always describes the newest snapshot, even when --date backfills an older day.
  const summary = buildLatestSummary({
    date: newest.date,
    snapshot: newest.snapshot,
    previousDate: before?.date ?? null,
    previous: before?.snapshot ?? null,
  });
  writeFileAtomic(NodePath.join(out, "latest.json"), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      "Usage: snapshot.mjs --out <dir> [--repo owner/name] [--date YYYY-MM-DD] [--dry-run] [--json]",
    );
    return;
  }
  const now = new Date();
  const date = opts.date ?? utcDate(now);
  const releases = await fetchAllReleases(opts.repo, { token: process.env.GITHUB_TOKEN });
  const snapshot = buildSnapshot(releases, { repo: opts.repo, takenAt: now.toISOString() });

  let summary;
  if (opts.out) {
    const out = NodePath.resolve(opts.out);
    summary = writeSnapshot(out, date, snapshot);
    if (!opts.json) console.log(`Wrote ${NodePath.join(out, "snapshots", `${date}.json`)}`);
  } else {
    // Dry run without an output folder: nothing on disk, compare with nothing.
    summary = buildLatestSummary({ date, snapshot, previousDate: null, previous: null });
  }

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(`${summary.releaseCount} releases of ${opts.repo}, newest ${summary.latestTag}`);
  console.log(
    formatReport({
      title: "Downloads by platform",
      fromLabel: summary.previousDate ?? "start",
      toLabel: summary.date,
      delta: summary.delta ?? summary.totals,
      totals: summary.totals,
    }),
  );
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(`download-stats snapshot failed: ${error.message}`);
    process.exit(1);
  });
}
