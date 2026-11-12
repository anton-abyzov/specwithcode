import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  FIXTURE_MANIFEST_SHA256,
  FIXTURE_REVIEW_COMMITS,
  STUDIO_ASSERTION_HELPERS,
  loadReviewedFixtureManifest,
  readProtectedBaseline,
  validateFixtureManifest,
  verifyFixtureTree,
} from "./fixture-preservation-audit.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = "scripts/studio-toolchain/reviewed-fixture-migrations.json";
const pinnedBytes = readFileSync(join(sourceRoot, manifestPath));
const pinnedManifest = JSON.parse(pinnedBytes);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Review commits outside the public history (the upstream repository and the archived development
// repository, anton-abyzov/specwithcode-dev); a clone without one skips the check that reads it.
const hasCommit = (commit) => {
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
      cwd: sourceRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
};
const needs = (...commits) => {
  const missing = commits.filter((commit) => !hasCommit(commit));
  return missing.length === 0 ? {} : { skip: `commits not in this clone: ${missing.join(", ")}` };
};
const reviewedPath = "app/fixtures/reviewed.ndjson";
const oldRecording =
  '{"clientInfo":{"name":"T3 Code"},"user_request":"Keep this exact user prose: café.","id":"message-7"}\n';
const reviewedRecording = oldRecording.replace("T3 Code", "SpecWithCode");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "studio-fixture-audit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, bytes) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  };
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  put(reviewedPath, oldRecording);
  put("app/fixtures/unchanged.ndjson", '{"request":"untouched"}\n');
  put("app/fixtures/run.sh", "#!/bin/sh\nexit 0\n");
  put(".repos/reference.txt", "unchanged upstream reference\n");
  put(".gitignore", "ignored.*\n");
  chmodSync(join(root, "app/fixtures/run.sh"), 0o755);
  git(["init", "-q"]);
  git(["add", "."]);
  const baseline = readProtectedBaseline(root, git(["write-tree"]));
  put(reviewedPath, reviewedRecording);
  const approvals = [
    {
      path: reviewedPath,
      upstreamSha256: sha(oldRecording),
      reviewedSha256: sha(reviewedRecording),
      upstreamMode: "100644",
      reviewedMode: "100644",
    },
  ];
  return {
    root,
    put,
    git,
    baseline,
    approvals,
    run: () => verifyFixtureTree(root, baseline, approvals),
  };
}

test("approved bytes/modes pass while references and every unlisted fixture remain exact", (t) => {
  assert.deepEqual(fixture(t).run(), {
    referenceEntriesPreserved: 1,
    referenceGitlinksPreserved: 0,
    unlistedFixtureFilesPreserved: 2,
    reviewedFixtureMigrationsVerified: 1,
    studioFixtureFilesRead: 0,
    reviewedFixtureBytesAndModesVerified: true,
    unlistedReferenceChangesRejected: true,
  });
});
test("altered user prose is rejected even inside an approved recording", (t) => {
  const f = fixture(t);
  f.put(reviewedPath, reviewedRecording.replace("exact user prose", "different task"));
  assert.throws(f.run, /Reviewed fixture bytes changed/);
});
test("arbitrary metadata is rejected even inside an approved recording", (t) => {
  const f = fixture(t);
  f.put(reviewedPath, reviewedRecording.replace("message-7", "message-8"));
  assert.throws(f.run, /Reviewed fixture bytes changed/);
});
test("unlisted fixture content is rejected", (t) => {
  const f = fixture(t);
  f.put("app/fixtures/unchanged.ndjson", '{"request":"edited"}\n');
  assert.throws(f.run, /Unreviewed protected bytes changed/);
});
test("reference content is rejected", (t) => {
  const f = fixture(t);
  f.put(".repos/reference.txt", "edited\n");
  assert.throws(f.run, /Unreviewed protected bytes changed/);
});
// A fixture upstream does not have is Studio's own: counted here, and read for
// upstream names by the brand audit. It cannot stand in for an inherited file.
for (const kind of ["tracked", "untracked"])
  test(`a ${kind} fixture that upstream does not have is Studio's own`, (t) => {
    const f = fixture(t);
    f.put("app/fixtures/new.ndjson", "studio recording\n");
    f.put("new-app/replays/new.ndjson", "studio recording\n");
    if (kind === "tracked") f.git(["add", "app/fixtures/new.ndjson", "new-app/replays/new.ndjson"]);
    assert.equal(f.run().studioFixtureFilesRead, 2);
    assert.equal(f.run().unlistedFixtureFilesPreserved, 2);
  });
test("a file Git ignores cannot sit in a fixture directory", (t) => {
  const f = fixture(t);
  f.put("app/fixtures/ignored.ndjson", "unread\n");
  assert.throws(f.run, /Ignored file in a fixture directory: app\/fixtures\/ignored/);
  const g = fixture(t);
  g.put("new-app/fixtures/kept.ndjson", "studio recording\n");
  g.put("new-app/fixtures/ignored.ndjson", "unread\n");
  assert.throws(g.run, /Ignored file in a fixture directory: new-app\/fixtures\/ignored/);
});
test("a Studio fixture cannot be a symlink", (t) => {
  const f = fixture(t);
  f.put("elsewhere.ndjson", "studio recording\n");
  symlinkSync("../../elsewhere.ndjson", join(f.root, "app/fixtures/new.ndjson"));
  assert.throws(f.run, /Studio fixture is not a regular file/);
});
test("a Studio fixture beside an inherited one does not excuse a change to it", (t) => {
  const f = fixture(t);
  f.put("app/fixtures/new.ndjson", "studio recording\n");
  f.put("app/fixtures/unchanged.ndjson", '{"request":"edited"}\n');
  assert.throws(f.run, /Unreviewed protected bytes changed/);
});
for (const kind of ["tracked", "untracked", "ignored"])
  test(`${kind === "ignored" ? "an" : "a"} ${kind} new reference file is rejected`, (t) => {
    const f = fixture(t);
    const path = `.repos/${kind === "ignored" ? "ignored.txt" : "new.txt"}`;
    f.put(path, "not upstream\n");
    if (kind === "tracked") f.git(["add", path]);
    assert.throws(f.run, /Unlisted reference file/);
  });
test("assume-unchanged cannot hide edited fixture bytes", (t) => {
  const f = fixture(t);
  f.git(["update-index", "--assume-unchanged", "app/fixtures/unchanged.ndjson"]);
  f.put("app/fixtures/unchanged.ndjson", "edited\n");
  assert.throws(f.run, /Unreviewed protected bytes changed/);
});
test("deletion of an approved recording is rejected", (t) => {
  const f = fixture(t);
  rmSync(join(f.root, reviewedPath));
  assert.throws(f.run, /ENOENT/);
});
test("an approved file cannot be replaced by a same-content symlink", (t) => {
  const f = fixture(t);
  f.put("same-content.ndjson", reviewedRecording);
  rmSync(join(f.root, reviewedPath));
  symlinkSync("../../same-content.ndjson", join(f.root, reviewedPath));
  assert.throws(f.run, /mode\/type changed/);
});
test("a protected parent cannot be substituted with a directory symlink", (t) => {
  const f = fixture(t);
  renameSync(join(f.root, "app/fixtures"), join(f.root, "saved-fixtures"));
  symlinkSync("../saved-fixtures", join(f.root, "app/fixtures"));
  assert.throws(f.run, /not a real directory/);
});
test("an approved file executable-mode substitution is rejected", (t) => {
  const f = fixture(t);
  chmodSync(join(f.root, reviewedPath), 0o755);
  assert.throws(f.run, /mode\/type changed/);
});
test("an unlisted executable-mode substitution is rejected", (t) => {
  const f = fixture(t);
  chmodSync(join(f.root, "app/fixtures/run.sh"), 0o644);
  assert.throws(f.run, /mode\/type changed/);
});
test("an incorrect baseline hash is rejected", (t) => {
  const f = fixture(t);
  f.approvals[0].upstreamSha256 = "0".repeat(64);
  assert.throws(f.run, /Wrong baseline bytes/);
});
test("an incorrect baseline mode is rejected", (t) => {
  const f = fixture(t);
  f.approvals[0].upstreamMode = "100755";
  assert.throws(f.run, /Wrong baseline mode/);
});
test("a missing approval rejects the changed fixture", (t) => {
  const f = fixture(t);
  f.approvals.length = 0;
  assert.throws(f.run, /Unreviewed protected bytes changed/);
});
test("a fabricated approval cannot add a file absent from the baseline", (t) => {
  const f = fixture(t);
  f.approvals.push({ ...f.approvals[0], path: "app/fixtures/unknown.ndjson" });
  assert.throws(f.run, /absent from baseline/);
});
test("duplicate approvals are rejected", (t) => {
  const f = fixture(t);
  f.approvals.push({ ...f.approvals[0] });
  assert.throws(f.run, /Duplicate fixture migration/);
});
for (const path of [
  "../app/fixtures/reviewed.ndjson",
  "/app/fixtures/reviewed.ndjson",
  "app/fixtures/../reviewed.ndjson",
  "app\\fixtures\\reviewed.ndjson",
  "app//fixtures/reviewed.ndjson",
]) {
  test(`noncanonical approval path is rejected: ${path}`, (t) => {
    const f = fixture(t);
    f.approvals[0].path = path;
    assert.throws(f.run, /Noncanonical protected path/);
    const m = structuredClone(pinnedManifest);
    m.entries[0].path = path;
    assert.throws(() => validateFixtureManifest(m), /Noncanonical protected path/);
  });
}
test("references cannot be added to the approval list", (t) => {
  const f = fixture(t);
  f.approvals[0].path = ".repos/reference.txt";
  assert.throws(f.run, /Ineligible migration path/);
});
test("the committed 197-file manifest matches its independent digest", () => {
  assert.equal(sha(pinnedBytes), FIXTURE_MANIFEST_SHA256);
  assert.equal(loadReviewedFixtureManifest(sourceRoot).entries.length, 197);
});
// The review recorded here re-pinned thirteen entries to the bytes this
// repository's own history carries. Everything it changed is derived below from
// the manifest before it, so the review cannot have touched anything else.
const previousManifestCommit = "072265ee0093a9744d4cbcbf774ceb14b46b22d9";
const publicReviewCommits = FIXTURE_REVIEW_COMMITS.slice(5);
const replayNames = [
  "provider_thread_resume",
  "thread_fork_native_continue",
  "thread_fork_native_prior_turn",
  "thread_fork_native_siblings",
  "thread_merge_back_continue",
  "thread_merge_back_siblings",
  "thread_rollback",
  "thread_rollback_after_restart",
];
const replayPaths = replayNames.map(
  (name) => `apps/server/src/orchestration-v2/testkit/fixtures/${name}/codex_transcript.ndjson`,
);
const gitIn = (args) => execFileSync("git", args, { cwd: sourceRoot, maxBuffer: 64 * 1024 * 1024 });
const show = (rev, path) => gitIn(["show", `${rev}:${path}`]);
test(
  "the public history review re-pins only eight origin URLs and five assertion helpers",
  needs(previousManifestCommit, ...publicReviewCommits),
  () => {
    assert.equal(publicReviewCommits.length, 5);
    const previousBytes = show(previousManifestCommit, manifestPath);
    assert.equal(
      sha(previousBytes),
      "f1d2deb1203a7af2c7c88f212c4f0da51a5113cb77bbe76f35663652e5eac904",
    );
    const expected = JSON.parse(previousBytes);
    expected.reviewCommits.push(...publicReviewCommits);
    expected.reasons["studio-test-assertion"] = pinnedManifest.reasons["studio-test-assertion"];
    assert.match(
      expected.reasons["studio-test-assertion"],
      /recorded provider bytes are untouched/,
    );
    const entries = pinnedManifest.entries.filter((entry) =>
      publicReviewCommits.includes(entry.reviewCommit),
    );
    assert.deepEqual(
      entries.map((entry) => entry.path).sort(),
      [...replayPaths, ...STUDIO_ASSERTION_HELPERS].sort(),
    );
    for (const entry of entries) {
      const old = expected.entries.find((candidate) => candidate.path === entry.path);
      assert.notEqual(old.reviewedSha256, entry.reviewedSha256, `Nothing re-pinned: ${entry.path}`);
      Object.assign(old, {
        reviewedSha256: entry.reviewedSha256,
        reviewCommit: entry.reviewCommit,
        reason: STUDIO_ASSERTION_HELPERS.includes(entry.path)
          ? "studio-test-assertion"
          : "product-identity-metadata",
      });
      assert.equal(
        sha(show(entry.reviewCommit, entry.path)),
        entry.reviewedSha256,
        `Reviewed hash is not the bytes of its commit: ${entry.path}`,
      );
      assert.equal(
        gitIn(["ls-tree", entry.reviewCommit, "--", entry.path]).toString("utf8").split(" ")[0],
        entry.reviewedMode,
        `Reviewed mode is not the mode of its commit: ${entry.path}`,
      );
    }
    assert.deepEqual(pinnedManifest, expected, "The review changed more than its thirteen entries");
  },
);
// Needs the archived development repository: the bytes reviewed before this
// repository existed are only there.
const renameCommit = "f08e451aa562c04b5ef8a36074c7682155d3f67c";
test(
  "the eight replay fixtures differ from their earlier reviewed bytes only in the origin URL",
  needs(previousManifestCommit, renameCommit),
  () => {
    const previous = JSON.parse(show(previousManifestCommit, manifestPath));
    const originUrl = /"originUrl":"[^"]*"/g;
    const publicUrls = [
      '"originUrl":"https://github.com/anton-abyzov/specwithcode.git"',
      '"originUrl":"git@github.com:anton-abyzov/specwithcode.git"',
    ];
    for (const path of replayPaths) {
      const before = show(renameCommit, path);
      assert.equal(
        sha(before),
        previous.entries.find((entry) => entry.path === path).reviewedSha256,
        `Not the earlier reviewed bytes: ${path}`,
      );
      const after = readFileSync(join(sourceRoot, path), "utf8");
      const urls = after.match(originUrl) ?? [];
      assert.ok(urls.length > 0, `No origin URL: ${path}`);
      for (const url of urls) assert.ok(publicUrls.includes(url), `${path}: ${url}`);
      assert.equal(
        after.replace(originUrl, '"originUrl":""'),
        before.toString("utf8").replace(originUrl, '"originUrl":""'),
        `More than the origin URL changed: ${path}`,
      );
    }
  },
);
test("only the closed list of helpers may carry the assertion reason", () => {
  const m = structuredClone(pinnedManifest);
  const other = m.entries.find(
    (entry) => entry.path.endsWith(".ts") && !STUDIO_ASSERTION_HELPERS.includes(entry.path),
  );
  other.reason = "studio-test-assertion";
  assert.throws(() => validateFixtureManifest(m), /Wrong migration reason/);
  const n = structuredClone(pinnedManifest);
  n.entries.find((entry) => entry.path === STUDIO_ASSERTION_HELPERS[0]).reason =
    "product-name-prose";
  assert.throws(() => validateFixtureManifest(n), /Wrong migration reason/);
});
for (const mutation of ["missing", "extra", "hash", "baseline", "review", "reason"])
  test(`the production loader rejects a ${mutation} manifest edit`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "studio-manifest-audit-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const m = structuredClone(pinnedManifest);
    if (mutation === "missing") m.entries.pop();
    if (mutation === "extra")
      m.entries.push({ ...m.entries[0], path: "app/fixtures/extra.ndjson" });
    if (mutation === "hash") m.entries[0].reviewedSha256 = sha("arbitrary replacement bytes");
    if (mutation === "baseline") m.upstreamCommit = "0".repeat(40);
    if (mutation === "review") m.entries[0].reviewCommit = "0".repeat(40);
    if (mutation === "reason") m.entries[0].reason = "allow arbitrary changes";
    mkdirSync(dirname(join(root, manifestPath)), { recursive: true });
    writeFileSync(join(root, manifestPath), JSON.stringify(m));
    assert.throws(() => loadReviewedFixtureManifest(root), /pinned digest/);
  });
test("manifest schema independently rejects missing entries and the wrong baseline", () => {
  const missing = structuredClone(pinnedManifest);
  missing.entries.pop();
  assert.throws(() => validateFixtureManifest(missing), /exactly 197/);
  const wrong = structuredClone(pinnedManifest);
  wrong.upstreamCommit = "0".repeat(40);
  assert.throws(() => validateFixtureManifest(wrong), /Wrong fixture baseline/);
});
