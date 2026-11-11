#!/usr/bin/env node
/**
 * The decisions .github/workflows/release-npm.yml makes around npm-package.mjs: which release
 * asset is the runtime archive, whether the release has it yet, what the built tarball must
 * hold, whether this version may go to npm, and whether npm lists it afterwards.
 *
 *   node npm-release.mjs fetch --repo <owner/name> --version <X.Y.Z> --dir <new dir>
 *   node npm-release.mjs check-tarball --tarball <specwithcode-X.Y.Z.tgz> --version <X.Y.Z>
 *   node npm-release.mjs plan --version <X.Y.Z> [--dry-run]
 *   node npm-release.mjs await-listed --version <X.Y.Z> [--accepted]
 *
 * `fetch` waits (up to an hour) for a published release to hold its runtime archive and a
 * SHA256SUMS that lists it, then downloads both. `fetch`, `check-tarball` and `plan` append
 * their results to $GITHUB_OUTPUT when it is set. `await-listed` waits for npm to list the
 * version and writes the outcome to $GITHUB_STEP_SUMMARY; `--accepted` says this run's
 * `npm publish` succeeded.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { NPM_BINS, NPM_PACKAGE_NAME } from "./npm-package.mjs";

export const REGISTRY = "https://registry.npmjs.org";
export const VERSIONS_PAGE = `https://www.npmjs.com/package/${NPM_PACKAGE_NAME}?activeTab=versions`;
// This many reads in a row without an answer, at the end of the wait, mean npm is unreachable.
const UNANSWERED_POLLS = 5;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SUMS_LINE = /^([0-9a-fA-F]{64}) [ *](.+)$/;

/** The three numbers of an X.Y.Z version. Suffixed versions have no npm release here. */
export function parseStableVersion(value) {
  const match = STABLE_VERSION.exec(value ?? "");
  if (!match) throw new Error(`'${value}' is not an X.Y.Z release version`);
  return match.slice(1).map(BigInt);
}

/** Negative, zero or positive as `a` is older than, equal to or newer than `b`. */
export function compareVersions(a, b) {
  const left = parseStableVersion(a);
  const right = parseStableVersion(b);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

/**
 * The runtime archive among a release's asset names: `studio-<version>-<sha12>.tar.gz`. The
 * per-platform CLI archives (`-linux-x64-`, `-win32-x64.zip`) and `-deployment-helpers-` carry
 * a word where the commit goes and never match. Null while the release has none.
 */
export function runtimeArchiveName(names, version) {
  parseStableVersion(version);
  const pattern = new RegExp(`^studio-${version.replaceAll(".", "\\.")}-[0-9a-f]{12}\\.tar\\.gz$`);
  const found = names.filter((name) => pattern.test(name));
  if (found.length > 1) {
    throw new Error(`v${version} has ${found.length} runtime archives: ${found.join(", ")}`);
  }
  return found[0] ?? null;
}

/** The digest SHA256SUMS gives `name`, or null when it does not list it. */
export function sumsDigest(text, name) {
  const digests = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = SUMS_LINE.exec(line);
    if (match && match[2] === name) digests.add(match[1].toLowerCase());
  }
  if (digests.size > 1) throw new Error(`SHA256SUMS lists ${name} with ${digests.size} digests`);
  return [...digests][0] ?? null;
}

/**
 * Whether a release can be packaged yet. `release` is the GitHub release (null when the tag has
 * no published release) and `readSums` returns its SHA256SUMS text, or null when the download
 * failed; it is only called once the release holds both files. A draft is never read:
 * release.sh may still replace its assets.
 */
export function runtimeArchiveState({ version, release, readSums }) {
  if (release === null) return { ready: false, reason: "is not a published release yet" };
  if (release.draft) return { ready: false, reason: "is still a draft" };
  const uploaded = (release.assets ?? []).filter((asset) => asset.state === "uploaded");
  const name = runtimeArchiveName(
    uploaded.map((asset) => asset.name),
    version,
  );
  if (name === null) {
    return { ready: false, reason: `has no studio-${version}-<sha12>.tar.gz runtime archive yet` };
  }
  if (!uploaded.some((asset) => asset.name === "SHA256SUMS")) {
    return { ready: false, reason: "has no SHA256SUMS yet" };
  }
  const sums = readSums();
  if (sums === null)
    return { ready: false, reason: "has a SHA256SUMS that could not be downloaded" };
  const sha256 = sumsDigest(sums, name);
  if (sha256 === null) return { ready: false, reason: `has a SHA256SUMS without ${name}` };
  // GitHub's own digest of the uploaded file: a release caught between replacing the archive
  // and replacing SHA256SUMS is waited for here rather than failed at the checksum step.
  const digest = uploaded.find((asset) => asset.name === name)?.digest;
  if (digest && digest.toLowerCase() !== `sha256:${sha256}`) {
    return { ready: false, reason: `has a SHA256SUMS that does not match the uploaded ${name}` };
  }
  return { ready: true, name, sha256 };
}

/** Polls `read` until the release is ready, and fails with what it lacks after `timeoutMs`. */
export async function waitForRuntimeArchive({
  version,
  read,
  sleep,
  log = () => {},
  timeoutMs = 60 * 60_000,
  intervalMs = 60_000,
}) {
  let waited = 0;
  for (;;) {
    const state = read();
    if (state.ready) return state;
    const minutes = Math.round(waited / 60_000);
    if (waited >= timeoutMs) {
      throw new Error(
        `v${version} ${state.reason} after ${minutes} minutes; attach it, then run Release npm again with version=${version}.`,
      );
    }
    log(`v${version} ${state.reason}; waited ${minutes} of ${Math.round(timeoutMs / 60_000)} min.`);
    await sleep(intervalMs);
    waited += intervalMs;
  }
}

/** What is wrong with a built tarball, given its package.json and its entry names. */
export function tarballProblems({ manifest, entries, version }) {
  const problems = [];
  if (manifest.name !== NPM_PACKAGE_NAME) problems.push(`name is ${manifest.name}`);
  if (manifest.version !== version) problems.push(`version is ${manifest.version}, not ${version}`);
  const bins = manifest.bin ?? {};
  for (const bin of NPM_BINS) {
    if (typeof bins[bin] !== "string") problems.push(`no ${bin} command`);
    else if (!entries.includes(`package/${bins[bin]}`)) problems.push(`${bin} has no ${bins[bin]}`);
  }
  const extra = Object.keys(bins).filter((bin) => !NPM_BINS.includes(bin));
  if (extra.length > 0) problems.push(`unexpected commands: ${extra.join(", ")}`);
  if (manifest.dependencies || manifest.scripts) {
    problems.push("package.json has dependencies or scripts; the tarball must be self-contained");
  }
  if (!entries.some((entry) => entry.startsWith("package/node_modules/"))) {
    problems.push("no bundled node_modules");
  }
  return problems;
}

/**
 * What to do with `version`, given npm's view of the package (`versions` and the `latest`
 * dist-tag). A version already there is skipped. A version older than `latest` is refused:
 * `npm publish` would move `latest` back to it. A dry run of one only rehearses, under another
 * tag.
 */
export function publishPlan({ version, versions, latest, dryRun = false }) {
  parseStableVersion(version);
  if (versions.includes(version)) {
    return { publish: false, latest, note: `${version} is already on npm; nothing to publish.` };
  }
  if (latest !== undefined && compareVersions(version, latest) < 0) {
    const refusal = `${version} is older than npm latest ${latest}; publishing it would move latest back.`;
    if (!dryRun) throw new Error(`Refusing to publish: ${refusal}`);
    return { publish: true, refused: true, latest, note: `A real run would refuse: ${refusal}` };
  }
  return { publish: true, latest, note: `${version} follows npm latest ${latest ?? "(none)"}.` };
}

/** npm's current versions and `latest` for the package, read past the registry's cache. */
export async function readRegistry({ fetchImpl = fetch, attempts = 3, sleep = wait } = {}) {
  let failure;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(
        `${REGISTRY}/${NPM_PACKAGE_NAME}?_release_npm=${Date.now()}`,
        {
          headers: { accept: "application/vnd.npm.install-v1+json" },
          cache: "no-store",
          signal: AbortSignal.timeout(30_000),
        },
      );
      // The package exists, so anything but its document (a 404 included) is a failed read.
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const document = await response.json();
      if (document.name !== NPM_PACKAGE_NAME || typeof document.versions !== "object") {
        throw new Error("unexpected registry document");
      }
      return { versions: Object.keys(document.versions), latest: document["dist-tags"]?.latest };
    } catch (error) {
      failure = error;
      if (attempt < attempts) await sleep(5_000);
    }
  }
  throw new Error(`Cannot read ${NPM_PACKAGE_NAME} from npm: ${failure.message}`);
}

/**
 * One look at npm for `version`, through `run` (`npm view <args>`): `seen` is the version npm
 * lists, or null when npm answers that it has none (E404). The `latest` read must succeed too,
 * so a version only counts as not listed while the package itself is readable. Any other
 * failure of either read throws.
 */
export function viewVersion({ version, run }) {
  const failure = (error) =>
    new Error(
      `${error.stderr ?? ""}`.split("\n").filter(Boolean).slice(0, 2).join("; ") || error.message,
    );
  let seen = null;
  try {
    seen = run([`${NPM_PACKAGE_NAME}@${version}`, "version"]).trim() || null;
  } catch (error) {
    if (!/\bE404\b/.test(`${error.stderr ?? ""}`)) throw failure(error);
  }
  let latest;
  try {
    latest = run([NPM_PACKAGE_NAME, "dist-tags.latest"]).trim();
  } catch (error) {
    throw failure(error);
  }
  if (!latest) throw new Error("npm named no latest version");
  return { seen, latest };
}

function atLeast(latest, version) {
  return STABLE_VERSION.test(latest ?? "") && compareVersions(latest, version) >= 0;
}

/**
 * Waits until npm lists `version` with `latest` at or past it, polling `view` (see viewVersion).
 *
 * npm accepts an upload, then reviews it before the registry shows it: until the review is done
 * every read answers 404. So a version this run published (`accepted`) is waited for an hour,
 * and one still hidden after that returns `{ listed: false }`: npm has it, which is all this run
 * can prove. A version this run did not publish gets ten minutes and must be listed.
 *
 * Everything else throws: npm not answering, a version that is not listed and was not published
 * here, and a listed version that `latest` stays behind (it gets ten minutes from the moment it
 * is first listed).
 *
 * The limits are on the clock (`now`), so the time the reads themselves take counts. The
 * verdict always rests on a read npm answered: when the limit falls on a failed read, polling
 * goes on until npm answers or has failed UNANSWERED_POLLS times in a row.
 */
export async function waitForListedVersion({
  version,
  accepted,
  view,
  sleep,
  now = Date.now,
  log = () => {},
  acceptedMs = 60 * 60_000,
  otherMs = 10 * 60_000,
  latestMs = 10 * 60_000,
  intervalMs = 30_000,
}) {
  const id = `${NPM_PACKAGE_NAME}@${version}`;
  const minutesOf = (ms) => Math.floor(ms / 60_000);
  const started = now();
  let limit = accepted ? acceptedMs : otherMs;
  let waited = 0;
  let answer = null;
  let unanswered = 0;
  let failure = "";
  let everListed = false;
  for (;;) {
    try {
      answer = view();
      unanswered = 0;
    } catch (error) {
      unanswered += 1;
      failure = error.message;
    }
    waited = now() - started;
    const listed = unanswered === 0 && answer.seen === version;
    if (listed && atLeast(answer.latest, version)) return { listed: true, latest: answer.latest };
    if (listed && !everListed) {
      everListed = true;
      limit = Math.max(limit, waited + latestMs);
    }
    if (unanswered >= UNANSWERED_POLLS && waited >= limit) {
      throw new Error(
        `npm did not answer for ${id} after ${minutesOf(waited)} minutes: ${failure}`,
      );
    }
    if (unanswered === 0 && waited >= limit) break;
    const progress = `waited ${minutesOf(waited)} of ${minutesOf(limit)} min.`;
    if (unanswered > 0) log(`npm did not answer (${failure}); ${progress}`);
    else if (listed) log(`${id} is listed but latest is ${answer.latest}; ${progress}`);
    else if (accepted) log(`npm accepted ${id} and does not list it yet; ${progress}`);
    else log(`${id} is not listed yet; ${progress}`);
    // The last read of the wait lands on the limit, not up to an interval past it.
    await sleep(waited < limit ? Math.min(intervalMs, limit - waited) : intervalMs);
  }
  const minutes = minutesOf(waited);
  if (answer.seen === version) {
    throw new Error(
      `${id} is on npm but latest is ${answer.latest}. Move it by hand: npm dist-tag add ${id} latest`,
    );
  }
  if (answer.seen !== null) throw new Error(`npm answered ${answer.seen} for ${id}`);
  if (!accepted) {
    throw new Error(
      `${id} is not on npm after ${minutes} minutes, and this run did not publish it.`,
    );
  }
  return { listed: false, minutes };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** The published release for a tag, or null (GitHub answers 404 for a missing or draft one). */
function readRelease(repo, version) {
  try {
    return JSON.parse(gh(["api", `repos/${repo}/releases/tags/v${version}`]));
  } catch (error) {
    const detail = `${error.stderr ?? ""}`.trim();
    if (!detail.includes("HTTP 404"))
      console.log(`GitHub did not answer: ${detail || error.message}`);
    return null;
  }
}

function output(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  console.log(lines.join("\n"));
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

async function fetchCommand({ repo, version, dir }) {
  parseStableVersion(version);
  if (fs.existsSync(dir)) throw new Error(`${dir} already exists`);
  fs.mkdirSync(dir, { recursive: true });
  const tag = `v${version}`;
  const download = (name) =>
    gh(["release", "download", tag, "-R", repo, "-p", name, "-D", dir, "--clobber"]);
  const downloadOrNull = (name) => {
    try {
      download(name);
      return true;
    } catch (error) {
      console.log(`Could not download ${name}: ${`${error.stderr ?? ""}`.trim() || error.message}`);
      return null;
    }
  };
  const state = await waitForRuntimeArchive({
    version,
    sleep: wait,
    log: console.log,
    read: () =>
      runtimeArchiveState({
        version,
        release: readRelease(repo, version),
        readSums: () =>
          downloadOrNull("SHA256SUMS") && fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8"),
      }),
  });
  // One retry: the checksum step, not this download, decides whether the bytes are right.
  if (!downloadOrNull(state.name)) download(state.name);
  output({ archive: state.name, sha256: state.sha256 });
}

function checkTarballCommand({ tarball, version }) {
  parseStableVersion(version);
  if (!fs.existsSync(tarball)) throw new Error(`${tarball} was not built`);
  const tar = (args) =>
    execFileSync("tar", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const entries = tar(["-tzf", tarball]).split("\n").filter(Boolean);
  const manifest = JSON.parse(tar(["-xzOf", tarball, "package/package.json"]));
  const problems = tarballProblems({ manifest, entries, version });
  if (problems.length > 0) throw new Error(`${path.basename(tarball)}: ${problems.join("; ")}`);
  const sha256 = createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
  console.log(
    `${manifest.name}@${manifest.version}: ${entries.length} entries, commands ${NPM_BINS.join(" and ")}`,
  );
  output({ tarball_sha256: sha256 });
}

async function planCommand({ version, dryRun }) {
  const registry = await readRegistry();
  const plan = publishPlan({ version, ...registry, dryRun });
  console.log(plan.refused ? `::warning::${plan.note}` : plan.note);
  output({ publish: plan.publish, latest: plan.latest ?? "" });
}

/** The log line and the step-summary line for the outcome of waitForListedVersion. */
export function listedReport({ version, result }) {
  const id = `${NPM_PACKAGE_NAME}@${version}`;
  if (result.listed) {
    return {
      log: `${id} is on npm; latest is ${result.latest}.`,
      summary: `- npm: [${id}](https://www.npmjs.com/package/${NPM_PACKAGE_NAME}/v/${version}), latest is ${result.latest}`,
    };
  }
  return {
    log: `::warning title=npm is still validating ${id}::npm accepted ${id}, but its review still hides the version after ${result.minutes} minutes. It is listed at ${VERSIONS_PAGE} once the review completes.`,
    summary: `- npm: ${id} was published and accepted, but npm's review still hides it after ${result.minutes} minutes. It appears under [Versions](${VERSIONS_PAGE}) once the review completes; until then \`npm i -g ${NPM_PACKAGE_NAME}\` installs the previous version.`,
  };
}

async function awaitListedCommand({ version, accepted }) {
  parseStableVersion(version);
  // A read that hangs is a read npm did not answer.
  const npmView = (args) =>
    execFileSync("npm", ["view", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
  const result = await waitForListedVersion({
    version,
    accepted,
    view: () => viewVersion({ version, run: npmView }),
    sleep: wait,
    log: console.log,
  });
  const report = listedReport({ version, result });
  console.log(report.log);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report.summary}\n`);
  }
}

async function main(argv) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      repo: { type: "string" },
      version: { type: "string" },
      dir: { type: "string" },
      tarball: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      accepted: { type: "boolean", default: false },
    },
  });
  if (command === "fetch" && values.repo && values.version && values.dir) {
    await fetchCommand({
      repo: values.repo,
      version: values.version,
      dir: path.resolve(values.dir),
    });
  } else if (command === "check-tarball" && values.tarball && values.version) {
    checkTarballCommand({ tarball: values.tarball, version: values.version });
  } else if (command === "plan" && values.version) {
    await planCommand({ version: values.version, dryRun: values["dry-run"] });
  } else if (command === "await-listed" && values.version) {
    await awaitListedCommand({ version: values.version, accepted: values.accepted });
  } else {
    console.error(
      "usage: npm-release.mjs fetch --repo <owner/name> --version <X.Y.Z> --dir <new dir>\n" +
        "       npm-release.mjs check-tarball --tarball <tgz> --version <X.Y.Z>\n" +
        "       npm-release.mjs plan --version <X.Y.Z> [--dry-run]\n" +
        "       npm-release.mjs await-listed --version <X.Y.Z> [--accepted]",
    );
    process.exitCode = 2;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
