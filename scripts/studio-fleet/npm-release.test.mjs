import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareVersions,
  listedReport,
  parseStableVersion,
  publishPlan,
  readRegistry,
  runtimeArchiveName,
  runtimeArchiveState,
  sumsDigest,
  tarballProblems,
  VERSIONS_PAGE,
  viewVersion,
  waitForListedVersion,
  waitForRuntimeArchive,
} from "./npm-release.mjs";

const RUNTIME = "studio-1.0.233-c43425ec8f25.tar.gz";
const DIGEST = "af9b13f7b83ee2a7ea089ec4a5a7ebcd36a38c2059f8e09d805f5e4706307015";
// The studio-* assets of v1.0.233, with the other names a release carries.
const ASSET_NAMES = [
  "SHA256SUMS",
  "SHA256SUMS-windows-linux",
  "SpecWithCode-1.0.233-arm64.dmg",
  RUNTIME,
  "studio-1.0.233-deployment-helpers-c43425ec8f25.tar.gz",
  "studio-1.0.233-linux-arm64-c43425ec8f25.tar.gz",
  "studio-1.0.233-linux-x64-c43425ec8f25.tar.gz",
  "studio-1.0.233-win32-arm64.zip",
  "studio-1.0.233-win32-x64.zip",
  "studio-update.json",
];
const SUMS = [
  `e79ab23315ec8c62f5b5a041194bb3a3e543dd25fe996e35cf8d324e8a78b144  studio-1.0.233-linux-x64-c43425ec8f25.tar.gz`,
  `${DIGEST}  ${RUNTIME}`,
  `89a6fdbdfd9654d3932befc81440c6d93ea8b86641f39a1f65f527eb9da51d82  studio-1.0.233-deployment-helpers-c43425ec8f25.tar.gz`,
  // release.sh lists the runtime archive a second time after appending studio-update.json.
  `${DIGEST}  ${RUNTIME}`,
  "",
].join("\n");

function release(names = ASSET_NAMES, overrides = {}) {
  return {
    draft: false,
    assets: names.map((name) => ({
      name,
      state: "uploaded",
      digest: name === RUNTIME ? `sha256:${DIGEST}` : `sha256:${"1".repeat(64)}`,
    })),
    ...overrides,
  };
}

test("only X.Y.Z versions are accepted and they compare by number", () => {
  assert.deepEqual(parseStableVersion("1.0.233"), [1n, 0n, 233n]);
  for (const bad of ["v1.0.233", "1.0", "1.0.233-rc.1", "1.0.233+build", "01.0.1", "", undefined]) {
    assert.throws(() => parseStableVersion(bad), /not an X\.Y\.Z release version/);
  }
  assert.equal(compareVersions("1.0.233", "1.0.47"), 1);
  assert.equal(compareVersions("1.0.47", "1.0.233"), -1);
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("2.0.0", "2.0.0"), 0);
});

test("the runtime archive is the one asset named by version and commit alone", () => {
  assert.equal(runtimeArchiveName(ASSET_NAMES, "1.0.233"), RUNTIME);
  assert.equal(
    runtimeArchiveName(
      ASSET_NAMES.filter((name) => name !== RUNTIME),
      "1.0.233",
    ),
    null,
  );
  // Another version's archive, and a version that only shares a prefix, are not this release's.
  assert.equal(runtimeArchiveName(ASSET_NAMES, "1.0.23"), null);
  assert.equal(runtimeArchiveName(["studio-1x0x233-c43425ec8f25.tar.gz"], "1.0.233"), null);
  assert.throws(
    () => runtimeArchiveName([RUNTIME, "studio-1.0.233-0123456789ab.tar.gz"], "1.0.233"),
    /2 runtime archives/,
  );
});

test("SHA256SUMS gives one digest for a name it may list twice", () => {
  assert.equal(sumsDigest(SUMS, RUNTIME), DIGEST);
  assert.equal(sumsDigest(SUMS.replaceAll("\n", "\r\n"), RUNTIME), DIGEST);
  assert.equal(sumsDigest(`${DIGEST.toUpperCase()} *${RUNTIME}\n`, RUNTIME), DIGEST);
  assert.equal(sumsDigest(SUMS, "studio-1.0.233-win32-x64.zip"), null);
  assert.throws(
    () => sumsDigest(`${SUMS}${"0".repeat(64)}  ${RUNTIME}\n`, RUNTIME),
    /with 2 digests/,
  );
});

test("a release is ready once it is published with the archive SHA256SUMS lists", () => {
  const ready = runtimeArchiveState({
    version: "1.0.233",
    release: release(),
    readSums: () => SUMS,
  });
  assert.deepEqual(ready, { ready: true, name: RUNTIME, sha256: DIGEST });
});

test("a release that is not complete yet says what it lacks", () => {
  const reason = (input) => {
    const state = runtimeArchiveState({ version: "1.0.233", readSums: () => SUMS, ...input });
    assert.equal(state.ready, false);
    return state.reason;
  };
  const unread = () => assert.fail("SHA256SUMS is not read before the release holds both files");
  assert.match(reason({ release: null, readSums: unread }), /not a published release/);
  assert.match(
    reason({ release: release(ASSET_NAMES, { draft: true }), readSums: unread }),
    /draft/,
  );
  assert.match(
    reason({ release: release(ASSET_NAMES.filter((name) => name !== RUNTIME)), readSums: unread }),
    /no studio-1\.0\.233-<sha12>\.tar\.gz runtime archive/,
  );
  // An asset GitHub is still receiving is not there yet.
  const uploading = release();
  uploading.assets.find((asset) => asset.name === RUNTIME).state = "starter";
  assert.match(reason({ release: uploading, readSums: unread }), /no studio-1\.0\.233-<sha12>/);
  assert.match(
    reason({
      release: release(ASSET_NAMES.filter((name) => name !== "SHA256SUMS")),
      readSums: unread,
    }),
    /no SHA256SUMS/,
  );
  assert.match(reason({ release: release(), readSums: () => null }), /could not be downloaded/);
  assert.match(
    reason({ release: release(), readSums: () => `${"0".repeat(64)}  install.sh\n` }),
    /SHA256SUMS without studio-1\.0\.233-c43425ec8f25\.tar\.gz/,
  );
  assert.match(
    reason({ release: release(), readSums: () => `${"0".repeat(64)}  ${RUNTIME}\n` }),
    /does not match the uploaded/,
  );
});

test("the wait polls each minute and returns as soon as the archive is attached", async () => {
  const states = [
    { ready: false, reason: "has no SHA256SUMS yet" },
    { ready: false, reason: "has no SHA256SUMS yet" },
    { ready: true, name: RUNTIME, sha256: DIGEST },
  ];
  const sleeps = [];
  const lines = [];
  const state = await waitForRuntimeArchive({
    version: "1.0.233",
    read: () => states.shift(),
    sleep: async (ms) => void sleeps.push(ms),
    log: (line) => lines.push(line),
  });
  assert.deepEqual(state, { ready: true, name: RUNTIME, sha256: DIGEST });
  assert.deepEqual(sleeps, [60_000, 60_000]);
  assert.deepEqual(lines, [
    "v1.0.233 has no SHA256SUMS yet; waited 0 of 60 min.",
    "v1.0.233 has no SHA256SUMS yet; waited 1 of 60 min.",
  ]);
});

test("the wait gives up after an hour with what the release still lacks", async () => {
  let reads = 0;
  let slept = 0;
  await assert.rejects(
    waitForRuntimeArchive({
      version: "1.0.233",
      read: () => {
        reads += 1;
        return { ready: false, reason: "has no SHA256SUMS yet" };
      },
      sleep: async (ms) => void (slept += ms),
    }),
    /v1\.0\.233 has no SHA256SUMS yet after 60 minutes; .*version=1\.0\.233/,
  );
  assert.equal(slept, 60 * 60_000);
  assert.equal(reads, 61);
});

test("a built tarball must be this version with both commands and its own node_modules", () => {
  const manifest = {
    name: "specwithcode",
    version: "1.0.233",
    bin: { specwithcode: "bin.mjs", "specweave-studio": "bin.mjs" },
  };
  const entries = ["package/package.json", "package/bin.mjs", "package/node_modules/zod/index.js"];
  assert.deepEqual(tarballProblems({ manifest, entries, version: "1.0.233" }), []);
  assert.deepEqual(tarballProblems({ manifest, entries, version: "1.0.234" }), [
    "version is 1.0.233, not 1.0.234",
  ]);
  assert.deepEqual(
    tarballProblems({
      manifest: {
        name: "specweave-studio",
        version: "1.0.233",
        bin: { specwithcode: "cli.mjs", studio: "bin.mjs" },
        dependencies: { zod: "^4" },
      },
      entries: ["package/package.json", "package/bin.mjs"],
      version: "1.0.233",
    }),
    [
      "name is specweave-studio",
      "specwithcode has no cli.mjs",
      "no specweave-studio command",
      "unexpected commands: studio",
      "package.json has dependencies or scripts; the tarball must be self-contained",
      "no bundled node_modules",
    ],
  );
});

test("a version already on npm is skipped and a newer one is published", () => {
  const npm = { versions: ["1.0.43", "1.0.47"], latest: "1.0.47" };
  assert.equal(publishPlan({ version: "1.0.47", ...npm }).publish, false);
  assert.match(publishPlan({ version: "1.0.47", ...npm }).note, /already on npm/);
  assert.equal(publishPlan({ version: "1.0.233", ...npm }).publish, true);
  assert.equal(publishPlan({ version: "1.0.233", versions: [], latest: undefined }).publish, true);
  assert.throws(() => publishPlan({ version: "1.0.233-rc.1", ...npm }), /not an X\.Y\.Z/);
});

test("a stable version older than npm latest is never published", () => {
  const npm = { versions: ["1.0.47", "1.0.233"], latest: "1.0.233" };
  assert.throws(
    () => publishPlan({ version: "1.0.232", ...npm }),
    /Refusing to publish: 1\.0\.232 is older than npm latest 1\.0\.233/,
  );
  // An older version that is already there is a skip, not a refusal: nothing would be published.
  assert.equal(publishPlan({ version: "1.0.47", ...npm }).publish, false);
  const rehearsal = publishPlan({ version: "1.0.232", ...npm, dryRun: true });
  assert.equal(rehearsal.refused, true);
  assert.match(rehearsal.note, /A real run would refuse/);
  // A latest the guard cannot compare stops the run rather than letting the publish through.
  assert.throws(
    () => publishPlan({ version: "1.0.234", versions: [], latest: "2.0.0-rc.1" }),
    /not an X\.Y\.Z/,
  );
});

test("the registry read bypasses the cache, retries, and fails closed", async () => {
  const urls = [];
  const document = {
    name: "specwithcode",
    "dist-tags": { latest: "1.0.47" },
    versions: { "1.0.43": {}, "1.0.47": {} },
  };
  const replies = [
    { ok: false, status: 503 },
    { ok: true, status: 200, json: async () => document },
  ];
  const registry = await readRegistry({
    fetchImpl: async (url) => {
      urls.push(url);
      return replies.shift();
    },
    sleep: async () => {},
  });
  assert.deepEqual(registry, { versions: ["1.0.43", "1.0.47"], latest: "1.0.47" });
  assert.equal(urls.length, 2);
  assert.match(urls[0], /^https:\/\/registry\.npmjs\.org\/specwithcode\?_release_npm=\d+$/);

  // A 404 for a package that exists, or another package's document, is a failed read.
  await assert.rejects(
    readRegistry({ fetchImpl: async () => ({ ok: false, status: 404 }), sleep: async () => {} }),
    /Cannot read specwithcode from npm: HTTP 404/,
  );
  await assert.rejects(
    readRegistry({
      fetchImpl: async () => ({ ok: true, json: async () => ({ name: "other", versions: {} }) }),
      sleep: async () => {},
    }),
    /unexpected registry document/,
  );
});

// What `npm view` exits with: npm 11.19.1's stderr for a version it does not list, and for a
// registry it cannot reach.
function npmError(stderr) {
  return Object.assign(new Error("Command failed: npm view"), { stderr });
}
const NOT_LISTED = "npm error code E404\nnpm error 404 No match found for version 1.0.233\n";
const UNREACHABLE = "npm error code ECONNREFUSED\nnpm error syscall connect\n";

test("one look at npm tells a version it does not list from a registry that fails", () => {
  const calls = [];
  const listed = viewVersion({
    version: "1.0.233",
    run: (args) => {
      calls.push(args);
      return args[1] === "version" ? "1.0.233\n" : "1.0.233\n";
    },
  });
  assert.deepEqual(listed, { seen: "1.0.233", latest: "1.0.233" });
  assert.deepEqual(calls, [
    ["specwithcode@1.0.233", "version"],
    ["specwithcode", "dist-tags.latest"],
  ]);

  const hidden = viewVersion({
    version: "1.0.233",
    run: (args) => {
      if (args[1] === "version") throw npmError(NOT_LISTED);
      return "1.0.47\n";
    },
  });
  assert.deepEqual(hidden, { seen: null, latest: "1.0.47" });

  assert.throws(
    () =>
      viewVersion({
        version: "1.0.233",
        run: () => {
          throw npmError(UNREACHABLE);
        },
      }),
    /npm error code ECONNREFUSED; npm error syscall connect/,
  );
  // A 404 for the version only means "not listed" while the package itself can be read.
  assert.throws(
    () =>
      viewVersion({
        version: "1.0.233",
        run: () => {
          throw npmError("npm error code E404\nnpm error 404 Not Found - GET specwithcode\n");
        },
      }),
    /npm error code E404; npm error 404 Not Found/,
  );
  assert.throws(
    () => viewVersion({ version: "1.0.233", run: (args) => (args[1] === "version" ? "" : "") }),
    /no latest version/,
  );
});

/**
 * Runs the wait against a scripted registry on a scripted clock; the last answer repeats. Each
 * read takes `readMs` of that clock, and sleeping is the only other thing that moves it.
 */
async function listedWait({ answers, accepted, readMs = 0, ...options }) {
  const lines = [];
  let clock = 0;
  let polls = 0;
  const outcome = waitForListedVersion({
    version: "1.0.233",
    accepted,
    view: () => {
      const answer = answers[Math.min(polls, answers.length - 1)];
      polls += 1;
      clock += readMs;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    log: (line) => lines.push(line),
    ...options,
  });
  return { outcome, lines, minutes: () => clock / 60_000, polls: () => polls };
}
const HIDDEN = { seen: null, latest: "1.0.47" };
const LISTED = { seen: "1.0.233", latest: "1.0.233" };
const DOWN = new Error("npm error code ECONNREFUSED");

test("a version npm lists with latest at or past it passes at once", async () => {
  const run = await listedWait({ answers: [LISTED], accepted: true });
  assert.deepEqual(await run.outcome, { listed: true, latest: "1.0.233" });
  assert.equal(run.minutes(), 0);
  // Skipped as already on npm, with a newer latest: still listed.
  const older = await listedWait({
    answers: [{ seen: "1.0.233", latest: "1.0.240" }],
    accepted: false,
  });
  assert.deepEqual(await older.outcome, { listed: true, latest: "1.0.240" });
});

test("a version npm accepted is waited for while its review hides it", async () => {
  // Twenty minutes of 404, as 1.0.233 gave, then the listing.
  const run = await listedWait({ answers: [...Array(40).fill(HIDDEN), LISTED], accepted: true });
  assert.deepEqual(await run.outcome, { listed: true, latest: "1.0.233" });
  assert.equal(run.minutes(), 20);
  assert.equal(
    run.lines[0],
    "npm accepted specwithcode@1.0.233 and does not list it yet; waited 0 of 60 min.",
  );
});

test("a version npm accepted and still hides after an hour ends without failing", async () => {
  const run = await listedWait({ answers: [HIDDEN], accepted: true });
  assert.deepEqual(await run.outcome, { listed: false, minutes: 60 });
  assert.equal(run.minutes(), 60);
  assert.equal(run.polls(), 121);
  assert.match(
    VERSIONS_PAGE,
    /^https:\/\/www\.npmjs\.com\/package\/specwithcode\?activeTab=versions$/,
  );
});

test("the hour is an hour on the clock however long the reads take", async () => {
  // Seven seconds a read, as two `npm view` calls took: by counting sleeps alone the wait ran
  // 74 minutes.
  const run = await listedWait({ answers: [HIDDEN], accepted: true, readMs: 7_000 });
  assert.deepEqual(await run.outcome, { listed: false, minutes: 60 });
  // The last read starts on the hour, so the wait ends one read past it.
  assert.equal(run.minutes() * 60_000, 60 * 60_000 + 7_000);
  assert.ok(run.polls() < 121);
});

test("a version this run did not publish must be listed within ten minutes", async () => {
  const run = await listedWait({ answers: [HIDDEN], accepted: false });
  await assert.rejects(
    run.outcome,
    /specwithcode@1\.0\.233 is not on npm after 10 minutes, and this run did not publish it/,
  );
  assert.equal(run.minutes(), 10);
  assert.equal(run.lines[0], "specwithcode@1.0.233 is not listed yet; waited 0 of 10 min.");
});

test("a registry that stops answering fails even for an accepted version", async () => {
  const never = await listedWait({ answers: [DOWN], accepted: true });
  await assert.rejects(
    never.outcome,
    /npm did not answer for specwithcode@1\.0\.233 after 60 minutes: npm error code ECONNREFUSED/,
  );
  assert.equal(never.minutes(), 60);
  // Hidden for most of the hour, then five reads in a row without an answer up to its end.
  const late = await listedWait({ answers: [...Array(116).fill(HIDDEN), DOWN], accepted: true });
  await assert.rejects(late.outcome, /npm did not answer .* after 60 minutes/);
  // Down from the last read of the hour on: four more reads are tried before giving up.
  const atTheEnd = await listedWait({
    answers: [...Array(120).fill(HIDDEN), DOWN],
    accepted: true,
  });
  await assert.rejects(atTheEnd.outcome, /npm did not answer .* after 62 minutes/);
  assert.equal(atTheEnd.polls(), 125);
  // The same for a version this run did not publish.
  const other = await listedWait({ answers: [DOWN], accepted: false });
  await assert.rejects(other.outcome, /npm did not answer .* after 10 minutes/);
});

test("the verdict rests on a read npm answered, not on a stale one", async () => {
  // One failed read on the hour: the next read answers, and that answer decides.
  const blip = await listedWait({
    answers: [...Array(120).fill(HIDDEN), DOWN, HIDDEN],
    accepted: true,
  });
  assert.deepEqual(await blip.outcome, { listed: false, minutes: 60 });
  assert.equal(blip.minutes(), 60.5);
  assert.match(
    blip.lines.at(-1),
    /^npm did not answer \(npm error code ECONNREFUSED\); waited 60 of 60/,
  );
  // Four failed reads, then the version is listed after all: that is a pass, not a warning.
  const recovered = await listedWait({
    answers: [...Array(120).fill(HIDDEN), DOWN, DOWN, DOWN, DOWN, LISTED],
    accepted: true,
  });
  assert.deepEqual(await recovered.outcome, { listed: true, latest: "1.0.233" });
  // Failed and hidden reads in turn never add up to an outage, and end on an answered read.
  const turns = Array.from({ length: 130 }, (_, index) => (index % 2 === 0 ? DOWN : HIDDEN));
  const alternating = await listedWait({ answers: turns, accepted: true });
  assert.deepEqual(await alternating.outcome, { listed: false, minutes: 60 });
  assert.equal(alternating.polls() % 2, 0);
  // Without --accepted the same answered read is a failure.
  const unpublished = await listedWait({
    answers: [...Array(20).fill(HIDDEN), DOWN, HIDDEN],
    accepted: false,
  });
  await assert.rejects(unpublished.outcome, /is not on npm after 10 minutes/);
});

test("a listed version that latest stays behind fails after ten more minutes", async () => {
  const behind = { seen: "1.0.233", latest: "1.0.47" };
  const stuck = await listedWait({ answers: [behind], accepted: true });
  await assert.rejects(
    stuck.outcome,
    /specwithcode@1\.0\.233 is on npm but latest is 1\.0\.47\. Move it by hand: npm dist-tag add specwithcode@1\.0\.233 latest/,
  );
  // Accepted keeps its hour; the ten minutes only ever extend the wait.
  assert.equal(stuck.minutes(), 60);
  // Listed in the last minute of the hour: latest still gets its ten minutes to follow.
  const late = await listedWait({
    answers: [...Array(119).fill(HIDDEN), ...Array(10).fill(behind), LISTED],
    accepted: true,
  });
  assert.deepEqual(await late.outcome, { listed: true, latest: "1.0.233" });
  assert.equal(late.minutes(), 64.5);
  assert.match(late.lines.at(-1), /is listed but latest is 1\.0\.47; waited 64 of 69 min\.$/);
  // ...and fails when it never does, ten minutes after it was first listed.
  const lateStuck = await listedWait({
    answers: [...Array(119).fill(HIDDEN), behind],
    accepted: true,
  });
  await assert.rejects(lateStuck.outcome, /is on npm but latest is 1\.0\.47/);
  assert.equal(lateStuck.minutes(), 69.5);
  // A latest the check cannot compare is behind, not an exception.
  const odd = await listedWait({
    answers: [{ seen: "1.0.233", latest: "2.0.0-rc.1" }],
    accepted: false,
  });
  await assert.rejects(odd.outcome, /is on npm but latest is 2\.0\.0-rc\.1/);
  assert.equal(odd.minutes(), 10);
});

test("the outcome is reported as a link when listed and as a warning while npm validates", () => {
  const listed = listedReport({ version: "1.0.233", result: { listed: true, latest: "1.0.233" } });
  assert.equal(listed.log, "specwithcode@1.0.233 is on npm; latest is 1.0.233.");
  assert.equal(
    listed.summary,
    "- npm: [specwithcode@1.0.233](https://www.npmjs.com/package/specwithcode/v/1.0.233), latest is 1.0.233",
  );
  const hidden = listedReport({ version: "1.0.233", result: { listed: false, minutes: 60 } });
  // A warning annotation, not an error: the run stays green.
  assert.match(hidden.log, /^::warning title=npm is still validating specwithcode@1\.0\.233::/);
  assert.match(hidden.log, /after 60 minutes/);
  for (const text of [hidden.log, hidden.summary]) {
    assert.ok(text.includes("specwithcode@1.0.233"));
    assert.ok(text.includes("https://www.npmjs.com/package/specwithcode?activeTab=versions"));
  }
});
