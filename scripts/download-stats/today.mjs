#!/usr/bin/env node
// Prints downloads by platform since the previous snapshot.
//
//   node scripts/download-stats/today.mjs            newest snapshot vs the one before it
//   node scripts/download-stats/today.mjs --live     live GitHub API vs the newest snapshot
//   options: --json, --no-fetch, --ref <git ref>, --remote <name>, --repo owner/name
//
// Snapshots are read from the download-stats data branch with git (fetched from the
// remote first unless --no-fetch), so run it inside a checkout of this repository.

import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  DATA_BRANCH,
  buildSnapshot,
  deltaByPlatform,
  fetchAllReleases,
  formatReport,
  sortSnapshotNames,
  totalsByPlatform,
} from "./lib.mjs";

export function parseArgs(argv) {
  const opts = { live: false, json: false, fetch: true, remote: "origin", ref: null, repo: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1;
      return v;
    };
    if (arg === "--live") opts.live = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--no-fetch") opts.fetch = false;
    else if (arg === "--remote") opts.remote = value();
    else if (arg === "--ref") opts.ref = value();
    else if (arg === "--repo") opts.repo = value();
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  opts.ref ??= `${opts.remote}/${DATA_BRANCH}`;
  return opts;
}

function git(args) {
  return NodeChildProcess.execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readSnapshotAt(ref, date) {
  return JSON.parse(git(["show", `${ref}:snapshots/${date}.json`]));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      "Usage: today.mjs [--live] [--json] [--no-fetch] [--ref <ref>] [--remote <name>] [--repo owner/name]",
    );
    return;
  }
  if (opts.fetch) {
    try {
      git([
        "fetch",
        "--quiet",
        opts.remote,
        `+refs/heads/${DATA_BRANCH}:refs/remotes/${opts.remote}/${DATA_BRANCH}`,
      ]);
    } catch (error) {
      throw new Error(
        `Could not fetch ${opts.remote}/${DATA_BRANCH} (has the Download stats workflow run yet?): ${String(error.stderr ?? error.message).trim()}`,
        { cause: error },
      );
    }
  }
  let names;
  try {
    names = sortSnapshotNames(
      git(["ls-tree", "--name-only", `${opts.ref}:snapshots`])
        .split("\n")
        .filter(Boolean),
    );
  } catch (error) {
    throw new Error(`No snapshots found at ${opts.ref}:snapshots`, { cause: error });
  }
  if (names.length === 0) throw new Error(`No snapshots found at ${opts.ref}:snapshots`);
  const dates = names.map((n) => n.slice(0, 10));
  const newestDate = dates[dates.length - 1];
  const newest = readSnapshotAt(opts.ref, newestDate);

  let current;
  let previous;
  let fromLabel;
  let toLabel;
  if (opts.live) {
    const repo = opts.repo ?? newest.repo;
    const releases = await fetchAllReleases(repo, { token: process.env.GITHUB_TOKEN });
    current = buildSnapshot(releases, { repo, takenAt: new Date().toISOString() });
    previous = newest;
    fromLabel = newest.takenAt ?? newestDate;
    toLabel = `live ${current.takenAt}`;
  } else {
    current = newest;
    const previousDate = dates.length > 1 ? dates[dates.length - 2] : null;
    previous = previousDate ? readSnapshotAt(opts.ref, previousDate) : null;
    fromLabel = previousDate ?? "start";
    toLabel = newestDate;
  }

  const delta = deltaByPlatform(current, previous);
  const totals = totalsByPlatform(current);
  if (opts.json) {
    console.log(
      JSON.stringify({ from: fromLabel, to: toLabel, live: opts.live, delta, totals }, null, 2),
    );
    return;
  }
  console.log(
    formatReport({ title: "Downloads today by platform", fromLabel, toLabel, delta, totals }),
  );
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(`download-stats today failed: ${error.message}`);
    process.exit(1);
  });
}
