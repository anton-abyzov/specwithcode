import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { FIXTURE_MANIFEST_SHA256, FIXTURE_REVIEW_COMMITS, FIXTURE_UPSTREAM, OWNED_FIXTURE_MANIFEST_SHA256, loadOwnedFixtureManifest, loadReviewedFixtureManifest, readProtectedBaseline, validateFixtureManifest, validateOwnedFixtureManifest, verifyFixtureTree } from './fixture-preservation-audit.mjs';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = 'scripts/studio-toolchain/reviewed-fixture-migrations.json';
const pinnedBytes = readFileSync(join(sourceRoot, manifestPath));
const pinnedManifest = JSON.parse(pinnedBytes);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const reviewedPath = 'app/fixtures/reviewed.ndjson';
const oldRecording = '{"clientInfo":{"name":"T3 Code"},"user_request":"Keep this exact user prose: café.","id":"message-7"}\n';
const reviewedRecording = oldRecording.replace('T3 Code', 'SpecWithCode');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'studio-fixture-audit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, bytes) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); };
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  put(reviewedPath, oldRecording);
  put('app/fixtures/unchanged.ndjson', '{"request":"untouched"}\n');
  put('app/fixtures/run.sh', '#!/bin/sh\nexit 0\n');
  put('.repos/reference.txt', 'unchanged upstream reference\n');
  put('.gitignore', 'ignored.*\n');
  chmodSync(join(root, 'app/fixtures/run.sh'), 0o755);
  git(['init', '-q']); git(['add', '.']);
  const baseline = readProtectedBaseline(root, git(['write-tree']));
  put(reviewedPath, reviewedRecording);
  const approvals = [{ path: reviewedPath, upstreamSha256: sha(oldRecording), reviewedSha256: sha(reviewedRecording), upstreamMode: '100644', reviewedMode: '100644' }];
  return { root, put, git, baseline, approvals, run: () => verifyFixtureTree(root, baseline, approvals) };
}

test('approved bytes/modes pass while references and every unlisted fixture remain exact', t => {
  assert.deepEqual(fixture(t).run(), { referenceEntriesPreserved: 1, referenceGitlinksPreserved: 0,
    unlistedFixtureFilesPreserved: 2, reviewedFixtureMigrationsVerified: 1, ownedFixtureFilesVerified: 0,
    reviewedFixtureBytesAndModesVerified: true, unlistedProtectedChangesRejected: true });
});
test('altered user prose is rejected even inside an approved recording', t => {
  const f = fixture(t); f.put(reviewedPath, reviewedRecording.replace('exact user prose', 'different task'));
  assert.throws(f.run, /Reviewed fixture bytes changed/);
});
test('arbitrary metadata is rejected even inside an approved recording', t => {
  const f = fixture(t); f.put(reviewedPath, reviewedRecording.replace('message-7', 'message-8'));
  assert.throws(f.run, /Reviewed fixture bytes changed/);
});
test('unlisted fixture content is rejected', t => {
  const f = fixture(t); f.put('app/fixtures/unchanged.ndjson', '{"request":"edited"}\n');
  assert.throws(f.run, /Unreviewed protected bytes changed/);
});
test('reference content is rejected', t => {
  const f = fixture(t); f.put('.repos/reference.txt', 'edited\n');
  assert.throws(f.run, /Unreviewed protected bytes changed/);
});
for (const kind of ['tracked', 'untracked', 'ignored']) test(`${kind} new protected files are rejected`, t => {
  const f = fixture(t); const path = `app/fixtures/${kind === 'ignored' ? 'ignored.ndjson' : 'new.ndjson'}`;
  f.put(path, 'not reviewed\n'); if (kind === 'tracked') f.git(['add', path]);
  assert.throws(f.run, /Unlisted protected file/);
});
test('a new fixture tree outside existing protected roots is rejected', t => {
  const f = fixture(t); f.put('new-app/replays/new.ndjson', 'not reviewed\n');
  assert.throws(f.run, /Unlisted protected file/);
});
test('an ignored new reference file is rejected', t => {
  const f = fixture(t); f.put('.repos/ignored.txt', 'not reviewed\n');
  assert.throws(f.run, /Unlisted protected file/);
});
test('assume-unchanged cannot hide edited fixture bytes', t => {
  const f = fixture(t); f.git(['update-index', '--assume-unchanged', 'app/fixtures/unchanged.ndjson']);
  f.put('app/fixtures/unchanged.ndjson', 'edited\n'); assert.throws(f.run, /Unreviewed protected bytes changed/);
});
test('deletion of an approved recording is rejected', t => {
  const f = fixture(t); rmSync(join(f.root, reviewedPath)); assert.throws(f.run, /ENOENT/);
});
test('an approved file cannot be replaced by a same-content symlink', t => {
  const f = fixture(t); f.put('same-content.ndjson', reviewedRecording); rmSync(join(f.root, reviewedPath));
  symlinkSync('../../same-content.ndjson', join(f.root, reviewedPath)); assert.throws(f.run, /mode\/type changed/);
});
test('a protected parent cannot be substituted with a directory symlink', t => {
  const f = fixture(t); renameSync(join(f.root, 'app/fixtures'), join(f.root, 'saved-fixtures'));
  symlinkSync('../saved-fixtures', join(f.root, 'app/fixtures')); assert.throws(f.run, /not a real directory/);
});
test('an approved file executable-mode substitution is rejected', t => {
  const f = fixture(t); chmodSync(join(f.root, reviewedPath), 0o755); assert.throws(f.run, /mode\/type changed/);
});
test('an unlisted executable-mode substitution is rejected', t => {
  const f = fixture(t); chmodSync(join(f.root, 'app/fixtures/run.sh'), 0o644); assert.throws(f.run, /mode\/type changed/);
});
test('an incorrect baseline hash is rejected', t => {
  const f = fixture(t); f.approvals[0].upstreamSha256 = '0'.repeat(64); assert.throws(f.run, /Wrong baseline bytes/);
});
test('an incorrect baseline mode is rejected', t => {
  const f = fixture(t); f.approvals[0].upstreamMode = '100755'; assert.throws(f.run, /Wrong baseline mode/);
});
test('a missing approval rejects the changed fixture', t => {
  const f = fixture(t); f.approvals.length = 0; assert.throws(f.run, /Unreviewed protected bytes changed/);
});
test('a fabricated approval cannot add a file absent from the baseline', t => {
  const f = fixture(t); f.approvals.push({ ...f.approvals[0], path: 'app/fixtures/unknown.ndjson' });
  assert.throws(f.run, /absent from baseline/);
});
test('duplicate approvals are rejected', t => {
  const f = fixture(t); f.approvals.push({ ...f.approvals[0] }); assert.throws(f.run, /Duplicate fixture migration/);
});
for (const path of ['../app/fixtures/reviewed.ndjson', '/app/fixtures/reviewed.ndjson', 'app/fixtures/../reviewed.ndjson', 'app\\fixtures\\reviewed.ndjson', 'app//fixtures/reviewed.ndjson']) {
  test(`noncanonical approval path is rejected: ${path}`, t => {
    const f = fixture(t); f.approvals[0].path = path; assert.throws(f.run, /Noncanonical protected path/);
    const m = structuredClone(pinnedManifest); m.entries[0].path = path;
    assert.throws(() => validateFixtureManifest(m), /Noncanonical protected path/);
  });
}
test('references cannot be added to the approval list', t => {
  const f = fixture(t); f.approvals[0].path = '.repos/reference.txt'; assert.throws(f.run, /Ineligible migration path/);
});
test('the committed 197-file manifest matches its independent digest', () => {
  assert.equal(sha(pinnedBytes), FIXTURE_MANIFEST_SHA256);
  assert.equal(loadReviewedFixtureManifest(sourceRoot).entries.length, 197);
});
test('the repository rename approvals cover only the Codex replay origin URLs', () => {
  const rename = 'f08e451aa562c04b5ef8a36074c7682155d3f67c';
  const paths = ['provider_thread_resume', 'thread_fork_native_continue', 'thread_fork_native_siblings',
    'thread_merge_back_continue', 'thread_merge_back_siblings', 'thread_rollback', 'thread_rollback_after_restart']
    .map(name => `apps/server/src/orchestration-v2/testkit/fixtures/${name}/codex_transcript.ndjson`);
  const entries = pinnedManifest.entries.filter(entry => entry.reviewCommit === rename);
  assert.deepEqual(entries.map(entry => entry.path).sort(), [...paths].sort());
  const gitIn = args => execFileSync('git', args, { cwd: sourceRoot, maxBuffer: 64 * 1024 * 1024 });
  const show = (rev, path) => gitIn(['show', `${rev}:${path}`]);
  // The manifest the rename commit itself shipped, pinned by the audit at that commit.
  const previousBytes = show(rename, manifestPath);
  assert.equal(sha(previousBytes), '3a983321e10e5ab354c94e4b1f8268d2f28e3900652a54c72e6de615fbe10bcb');
  const previous = JSON.parse(previousBytes);
  const expected = structuredClone(previous);
  expected.reviewCommits.push(rename);
  expected.reasons['product-identity-metadata'] = previous.reasons['product-identity-metadata']
    .replace('metadata, instruction', 'metadata, repository origin URLs, instruction');
  const previousByPath = new Map(previous.entries.map(entry => [entry.path, entry]));
  for (const entry of entries) Object.assign(expected.entries.find(old => old.path === entry.path), { reviewedSha256: entry.reviewedSha256, reviewCommit: rename });
  assert.deepEqual(pinnedManifest, expected, 'The rename review changed more than its seven entries');
  const oldUrl = '"originUrl":"https://github.com/anton-abyzov/specwithcode.git"';
  const newUrl = '"originUrl":"https://github.com/anton-abyzov/specwithcode.git"';
  for (const entry of entries) {
    const old = previousByPath.get(entry.path);
    assert.ok(old.reviewCommit !== rename && FIXTURE_REVIEW_COMMITS.includes(old.reviewCommit), `No earlier review: ${entry.path}`);
    const beforeBytes = show(`${rename}^`, entry.path);
    assert.equal(sha(beforeBytes), old.reviewedSha256, `Rename parent is not the earlier reviewed bytes: ${entry.path}`);
    const before = beforeBytes.toString('utf8');
    assert.ok(before.split(oldUrl).length - 1 >= 1, `No origin URL to replace: ${entry.path}`);
    const after = show(rename, entry.path);
    assert.ok(after.equals(Buffer.from(before.split(oldUrl).join(newUrl), 'utf8')), `Rename changed more than the origin URL: ${entry.path}`);
    assert.equal(sha(after), entry.reviewedSha256, `Reviewed hash is not the rename bytes: ${entry.path}`);
    assert.equal(gitIn(['ls-tree', rename, '--', entry.path]).toString('utf8').split(' ')[0], entry.reviewedMode, `Rename changed the mode: ${entry.path}`);
  }
});
for (const mutation of ['missing', 'extra', 'hash', 'baseline', 'review', 'reason']) test(`the production loader rejects a ${mutation} manifest edit`, t => {
  const root = mkdtempSync(join(tmpdir(), 'studio-manifest-audit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const m = structuredClone(pinnedManifest);
  if (mutation === 'missing') m.entries.pop();
  if (mutation === 'extra') m.entries.push({ ...m.entries[0], path: 'app/fixtures/extra.ndjson' });
  if (mutation === 'hash') m.entries[0].reviewedSha256 = sha('arbitrary replacement bytes');
  if (mutation === 'baseline') m.upstreamCommit = '0'.repeat(40);
  if (mutation === 'review') m.entries[0].reviewCommit = '0'.repeat(40);
  if (mutation === 'reason') m.entries[0].reason = 'allow arbitrary changes';
  mkdirSync(dirname(join(root, manifestPath)), { recursive: true }); writeFileSync(join(root, manifestPath), JSON.stringify(m));
  assert.throws(() => loadReviewedFixtureManifest(root), /pinned digest/);
});
test('manifest schema independently rejects missing entries and the wrong baseline', () => {
  const missing = structuredClone(pinnedManifest); missing.entries.pop();
  assert.throws(() => validateFixtureManifest(missing), /exactly 197/);
  const wrong = structuredClone(pinnedManifest); wrong.upstreamCommit = '0'.repeat(40);
  assert.throws(() => validateFixtureManifest(wrong), /Wrong fixture baseline/);
});

// Studio-owned files in protected trees: only the pinned list, byte- and mode-exact.
const ownedPath = 'owned-app/fixtures/serve.cjs';
const ownedBytes = '// owned deterministic test server\n';
function withOwned(t) {
  const f = fixture(t); f.put(ownedPath, ownedBytes);
  f.owned = [{ path: ownedPath, sha256: sha(ownedBytes), mode: '100644' }];
  f.run = () => verifyFixtureTree(f.root, f.baseline, f.approvals, f.owned);
  return f;
}
test('a listed owned fixture passes byte- and mode-exact', t => {
  assert.equal(withOwned(t).run().ownedFixtureFilesVerified, 1);
});
test('an owned fixture is rejected without its listing', t => {
  const f = withOwned(t); f.owned.length = 0; assert.throws(f.run, /Unlisted protected file: owned-app/);
});
for (const kind of ['tracked', 'untracked', 'ignored']) test(`${kind === 'ignored' ? 'an' : 'a'} ${kind} unlisted file beside an owned fixture is rejected`, t => {
  const f = withOwned(t); const path = `owned-app/fixtures/${kind === 'ignored' ? 'ignored.cjs' : 'other.cjs'}`;
  f.put(path, 'not reviewed\n'); if (kind === 'tracked') f.git(['add', path]);
  assert.throws(f.run, /Unlisted protected file/);
});
test('a listed owned fixture whose bytes change is rejected', t => {
  const f = withOwned(t); f.put(ownedPath, ownedBytes + 'process.exit(0);\n');
  assert.throws(f.run, /Owned fixture bytes changed/);
});
test('a listed owned fixture cannot change mode or become a symlink', t => {
  const f = withOwned(t); chmodSync(join(f.root, ownedPath), 0o755); assert.throws(f.run, /Owned fixture mode\/type changed/);
  const g = withOwned(t); g.put('same-owned.cjs', ownedBytes); rmSync(join(g.root, ownedPath));
  symlinkSync('../../same-owned.cjs', join(g.root, ownedPath)); assert.throws(g.run, /Owned fixture mode\/type changed/);
});
test('a deleted owned fixture is rejected', t => {
  const f = withOwned(t); rmSync(join(f.root, ownedPath)); assert.throws(f.run, /ENOENT/);
});
test('an owned listing cannot cover a file that exists upstream', t => {
  const f = withOwned(t);
  f.owned.push({ path: 'app/fixtures/unchanged.ndjson', sha256: sha('{"request":"edited"}\n'), mode: '100644' });
  f.put('app/fixtures/unchanged.ndjson', '{"request":"edited"}\n');
  assert.throws(f.run, /shadows an upstream file/);
});
test('an owned listing cannot cover references, unprotected paths or duplicates', t => {
  for (const path of ['.repos/owned.txt', 'owned-app/src/serve.cjs']) {
    const f = withOwned(t); f.owned[0].path = path; assert.throws(f.run, /Ineligible owned fixture path/);
  }
  const f = withOwned(t); f.owned.push({ ...f.owned[0] }); assert.throws(f.run, /Duplicate owned fixture/);
  const g = withOwned(t); g.owned.push({ ...g.owned[0], path: reviewedPath }); assert.throws(g.run, /Duplicate owned fixture/);
  const h = withOwned(t); h.owned[0].path = 'owned-app/fixtures/../serve.cjs'; assert.throws(h.run, /Noncanonical protected path/);
});

const ownedManifestPath = 'scripts/studio-toolchain/owned-fixture-files.json';
const ownedPinnedBytes = readFileSync(join(sourceRoot, ownedManifestPath));
const ownedPinned = JSON.parse(ownedPinnedBytes);
test('the committed owned fixture list matches its digest and its adding commits', () => {
  assert.equal(sha(ownedPinnedBytes), OWNED_FIXTURE_MANIFEST_SHA256);
  const { entries } = loadOwnedFixtureManifest(sourceRoot);
  assert.deepEqual(entries.map(entry => entry.path), ['apps/server/src/provider/muse/fixtures/serve.cjs']);
  const upstream = readProtectedBaseline(sourceRoot, FIXTURE_UPSTREAM);
  const gitIn = args => execFileSync('git', args, { cwd: sourceRoot, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  for (const entry of entries) {
    assert.ok(!upstream.has(entry.path), `Owned fixture exists upstream: ${entry.path}`);
    assert.equal(sha(gitIn(['show', `${entry.addedCommit}:${entry.path}`])), entry.sha256, `Not the added bytes: ${entry.path}`);
    assert.equal(gitIn(['ls-tree', entry.addedCommit, '--', entry.path]).toString('utf8').split(' ')[0], entry.mode, `Not the added mode: ${entry.path}`);
    assert.throws(() => gitIn(['cat-file', '-e', `${entry.addedCommit}^:${entry.path}`]), `Not added by its commit: ${entry.path}`);
  }
});
for (const mutation of ['extra', 'hash', 'mode', 'commit', 'reason', 'field']) test(`the owned list loader rejects a ${mutation} edit`, t => {
  const root = mkdtempSync(join(tmpdir(), 'studio-owned-audit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const m = structuredClone(ownedPinned);
  if (mutation === 'extra') m.entries.push({ ...m.entries[0], path: 'apps/server/src/provider/muse/fixtures/extra.cjs' });
  if (mutation === 'hash') m.entries[0].sha256 = sha('arbitrary replacement bytes');
  if (mutation === 'mode') m.entries[0].mode = '100755';
  if (mutation === 'commit') m.entries[0].addedCommit = '0'.repeat(40);
  if (mutation === 'reason') m.entries[0].reason = 'allow arbitrary files';
  if (mutation === 'field') m.entries[0].allowAnyBytes = true;
  mkdirSync(dirname(join(root, ownedManifestPath)), { recursive: true }); writeFileSync(join(root, ownedManifestPath), JSON.stringify(m, null, 2) + '\n');
  assert.throws(() => loadOwnedFixtureManifest(root), /pinned digest/);
});
test('owned list schema is closed independently of its digest', () => {
  const edit = change => { const m = structuredClone(ownedPinned); change(m); return () => validateOwnedFixtureManifest(m); };
  assert.doesNotThrow(edit(() => {}));
  assert.throws(edit(m => { m.allowUnlisted = true; }), /unknown fields/);
  assert.throws(edit(m => { m.entries[0].allowAnyBytes = true; }), /unknown fields/);
  assert.throws(edit(m => { m.entries[0].addedCommit = '0'.repeat(40); }), /Unknown owned fixture commit/);
  assert.throws(edit(m => { m.entries[0].reason = 'anything'; }), /Unknown owned fixture reason/);
  assert.throws(edit(m => { m.reasons.anything = 'x'; }), /Wrong owned fixture reasons/);
  assert.throws(edit(m => { m.entries[0].mode = '120000'; }), /Invalid owned mode/);
  assert.throws(edit(m => { m.entries[0].path = '../serve.cjs'; }), /Noncanonical protected path/);
  assert.throws(edit(m => { m.upstreamCommit = '0'.repeat(40); }), /Wrong owned fixture baseline/);
});
