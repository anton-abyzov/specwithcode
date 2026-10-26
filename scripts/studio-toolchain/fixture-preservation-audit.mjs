import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const FIXTURE_UPSTREAM = '10f39eb9ac80c9a4b7f5097575dd2addc3b6f631';
export const FIXTURE_REVIEW_COMMITS = Object.freeze([
  '0b3c7c92330742fa17ed4fdfaa211c56df4ef58c',
  'e400f67aed5d5e34a9010298983e32a0ae2cb157',
  'e9a3cb08f2a073e594699446e7c28d67b5cb2f2a',
  '9d03b0c63a2611aaff707d7b55a344de27437387',
  // The repository rename (#197) rewrote only origin URLs in seven Codex replay fixtures.
  'f08e451aa562c04b5ef8a36074c7682155d3f67c',
]);
// A manifest edit is not an approval. This digest pins the independently reviewed
// closed set, including paths, both byte hashes/modes, reasons and review commits.
// The original review branches need not be fetched after their cherry-picks.
export const FIXTURE_MANIFEST_SHA256 = 'f1d2deb1203a7af2c7c88f212c4f0da51a5113cb77bbe76f35663652e5eac904';
const MANIFEST_PATH = 'scripts/studio-toolchain/reviewed-fixture-migrations.json';
// Studio-authored files that live in a protected directory but have no upstream
// counterpart. Same rule as above: each path, byte hash, mode, adding commit and
// reason is reviewed and pinned here; a listed path may never shadow upstream.
export const OWNED_FIXTURE_COMMITS = Object.freeze([
  '3328c7c1d6a4513e928bbaf474994a47c37cb40b', // 0922: Muse provider test server.
]);
export const OWNED_FIXTURE_MANIFEST_SHA256 = 'ede3bdf07ae4fef1e872d37a142b575ac99ab0192a587492c47de37daec6433c';
const OWNED_MANIFEST_PATH = 'scripts/studio-toolchain/owned-fixture-files.json';
const OWNED_REASONS = Object.freeze(['owned-provider-test-fixture']);
const FIXTURE_DIRECTORIES = new Set(['fixtures', '__fixtures__', 'replays']);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const gitBlobHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const git = (root, args, encoding = 'utf8') => execFileSync('git', args, {
  cwd: root, encoding, maxBuffer: 128 * 1024 * 1024,
});
export const isProtectedPath = path => path.startsWith('.repos/') || path.split('/').some(part => FIXTURE_DIRECTORIES.has(part));

function canonicalPath(path) {
  assert.equal(typeof path, 'string', 'Manifest path must be a string');
  assert.ok(path.length > 0 && !path.includes('\\') && !path.includes('\0') &&
    path.split('/').every(part => part && part !== '.' && part !== '..'), `Noncanonical protected path: ${path}`);
}

// Kept separate so path/schema rejection can be tested without changing the
// production digest. Production always loads through the pinned loader below.
export function validateFixtureManifest(manifest) {
  assert.equal(manifest.schemaVersion, 1, 'Unsupported fixture manifest version');
  assert.equal(manifest.upstreamCommit, FIXTURE_UPSTREAM, 'Wrong fixture baseline commit');
  assert.deepEqual(manifest.reviewCommits, FIXTURE_REVIEW_COMMITS, 'Wrong fixture review commits');
  assert.equal(manifest.entries.length, 197, 'The reviewed fixture set must contain exactly 197 entries');
  const seen = new Set();
  for (const entry of manifest.entries) {
    canonicalPath(entry.path);
    assert.ok(isProtectedPath(entry.path) && !entry.path.startsWith('.repos/'), `Ineligible migration path: ${entry.path}`);
    assert.ok(!seen.has(entry.path), `Duplicate fixture migration: ${entry.path}`);
    seen.add(entry.path);
    for (const key of ['upstreamSha256', 'reviewedSha256']) assert.match(entry[key], /^[a-f0-9]{64}$/, `Invalid ${key}: ${entry.path}`);
    for (const key of ['upstreamMode', 'reviewedMode']) assert.ok(['100644', '100755'].includes(entry[key]), `Invalid ${key}: ${entry.path}`);
    assert.ok(FIXTURE_REVIEW_COMMITS.includes(entry.reviewCommit), `Unknown review commit: ${entry.path}`);
    const reason = entry.path.endsWith('/fixtures/shared.ts') || entry.path.endsWith('/fixtures/index.ts') ? 'type-import'
      : entry.path.endsWith('/fixtures/opencode2_inbox/output.ts') ? 'strict-regex-product-identity'
      : entry.path.endsWith('.ndjson') ? 'product-identity-metadata'
      : entry.path.endsWith('.ts') ? 'product-name-prose' : null;
    assert.ok(reason, `Unknown migration file: ${entry.path}`);
    assert.equal(entry.reason, reason, `Wrong migration reason: ${entry.path}`);
  }
  return manifest;
}

export function loadReviewedFixtureManifest(root) {
  const bytes = readFileSync(join(root, MANIFEST_PATH));
  assert.equal(sha256(bytes), FIXTURE_MANIFEST_SHA256, 'Reviewed fixture manifest differs from its pinned digest');
  return validateFixtureManifest(JSON.parse(bytes.toString('utf8')));
}

const keysOf = value => Object.keys(value ?? {}).sort();
export function validateOwnedFixtureManifest(manifest) {
  assert.deepEqual(keysOf(manifest), ['addedCommits', 'entries', 'reasons', 'schemaVersion', 'upstreamCommit'], 'Owned fixture manifest has unknown fields');
  assert.equal(manifest.schemaVersion, 1, 'Unsupported owned fixture manifest version');
  assert.equal(manifest.upstreamCommit, FIXTURE_UPSTREAM, 'Wrong owned fixture baseline commit');
  assert.deepEqual(manifest.addedCommits, OWNED_FIXTURE_COMMITS, 'Wrong owned fixture commits');
  assert.deepEqual(keysOf(manifest.reasons), [...OWNED_REASONS].sort(), 'Wrong owned fixture reasons');
  assert.ok(Array.isArray(manifest.entries), 'Owned fixture entries must be a list');
  for (const entry of manifest.entries) {
    assert.deepEqual(keysOf(entry), ['addedCommit', 'mode', 'path', 'reason', 'sha256'], `Owned fixture entry has unknown fields: ${entry?.path}`);
    canonicalPath(entry.path);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/, `Invalid owned sha256: ${entry.path}`);
    assert.ok(['100644', '100755'].includes(entry.mode), `Invalid owned mode: ${entry.path}`);
    assert.ok(OWNED_FIXTURE_COMMITS.includes(entry.addedCommit), `Unknown owned fixture commit: ${entry.path}`);
    assert.ok(OWNED_REASONS.includes(entry.reason), `Unknown owned fixture reason: ${entry.path}`);
  }
  return manifest;
}

export function loadOwnedFixtureManifest(root) {
  const bytes = readFileSync(join(root, OWNED_MANIFEST_PATH));
  assert.equal(sha256(bytes), OWNED_FIXTURE_MANIFEST_SHA256, 'Owned fixture manifest differs from its pinned digest');
  return validateOwnedFixtureManifest(JSON.parse(bytes.toString('utf8')));
}

export function readProtectedBaseline(root, upstream) {
  const entries = new Map();
  for (const row of git(root, ['ls-tree', '-r', '-z', upstream]).split('\0').filter(Boolean)) {
    const tab = row.indexOf('\t');
    const [mode, type, object] = row.slice(0, tab).split(' ');
    const path = row.slice(tab + 1);
    if (!isProtectedPath(path)) continue;
    canonicalPath(path);
    assert.match(object, /^[a-f0-9]{40}$/, `Unexpected baseline object format: ${path}`);
    entries.set(path, { mode, type, object });
  }
  return entries;
}

function protectedRoot(path) {
  const parts = path.split('/');
  const index = parts[0] === '.repos' ? 0 : parts.findIndex(part => FIXTURE_DIRECTORIES.has(part));
  return parts.slice(0, index + 1).join('/');
}

// The caller supplies already pinned approvals; production has no configurable
// baseline, manifest, or approval override. Tests exercise this byte guard with
// tiny local Git repositories rather than editing production fixture trees.
export function verifyFixtureTree(root, baseline, approvals, owned = []) {
  const approved = new Map();
  for (const entry of approvals) {
    canonicalPath(entry.path);
    assert.ok(!entry.path.startsWith('.repos/') && isProtectedPath(entry.path), `Ineligible migration path: ${entry.path}`);
    assert.ok(!approved.has(entry.path), `Duplicate fixture migration: ${entry.path}`);
    const before = baseline.get(entry.path);
    assert.ok(before, `Reviewed fixture absent from baseline: ${entry.path}`);
    assert.equal(before.type, 'blob', `Reviewed fixture is not a baseline blob: ${entry.path}`);
    assert.equal(before.mode, entry.upstreamMode, `Wrong baseline mode: ${entry.path}`);
    const bytes = git(root, ['cat-file', 'blob', before.object], null);
    assert.equal(sha256(bytes), entry.upstreamSha256, `Wrong baseline bytes: ${entry.path}`);
    assert.notEqual(entry.upstreamSha256, entry.reviewedSha256, `Redundant fixture approval: ${entry.path}`);
    approved.set(entry.path, entry);
  }
  const ownedFiles = new Map();
  for (const entry of owned) {
    canonicalPath(entry.path);
    assert.ok(!entry.path.startsWith('.repos/') && isProtectedPath(entry.path), `Ineligible owned fixture path: ${entry.path}`);
    assert.ok(!ownedFiles.has(entry.path) && !approved.has(entry.path), `Duplicate owned fixture: ${entry.path}`);
    assert.ok(!baseline.has(entry.path), `Owned fixture shadows an upstream file: ${entry.path}`);
    ownedFiles.set(entry.path, entry);
  }

  const checkedDirectories = new Set();
  function checkedStat(path) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (checkedDirectories.has(parent)) continue;
      const stat = lstatSync(join(root, parent));
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `Protected parent is not a real directory: ${parent}`);
      checkedDirectories.add(parent);
    }
    return lstatSync(join(root, path));
  }

  let references = 0, unchangedFixtures = 0, gitlinks = 0;
  for (const [path, before] of baseline) {
    const absolute = join(root, path);
    const stat = checkedStat(path); // Missing files fail, even with assume-unchanged flags.
    if (before.mode === '160000') {
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `Reference gitlink substituted: ${path}`);
      assert.equal(git(root, ['ls-files', '--stage', '--', path]).split('\t')[0], `160000 ${before.object} 0`, `Reference gitlink changed: ${path}`);
      if (readdirSync(absolute).length > 0) {
        assert.equal(resolve(git(absolute, ['rev-parse', '--show-toplevel']).trim()), resolve(absolute), `Reference gitlink is not its own checkout: ${path}`);
        assert.equal(git(absolute, ['rev-parse', 'HEAD']).trim(), before.object, `Reference gitlink HEAD changed: ${path}`);
        assert.equal(git(absolute, ['status', '--porcelain', '--untracked-files=all']).trim(), '', `Reference gitlink contains edits: ${path}`);
      }
      gitlinks++;
    } else {
      const mode = stat.isSymbolicLink() ? '120000' : stat.isFile() ? (stat.mode & 0o111 ? '100755' : '100644') : 'unsupported';
      const approval = approved.get(path);
      assert.equal(mode, approval?.reviewedMode ?? before.mode, `Protected file mode/type changed: ${path}`);
      const bytes = mode === '120000' ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute);
      if (approval) assert.equal(sha256(bytes), approval.reviewedSha256, `Reviewed fixture bytes changed: ${path}`);
      else assert.equal(gitBlobHash(bytes), before.object, `Unreviewed protected bytes changed: ${path}`);
    }
    if (path.startsWith('.repos/')) references++;
    else if (!approved.has(path)) unchangedFixtures++;
  }
  for (const [path, entry] of ownedFiles) {
    const stat = checkedStat(path);
    const mode = stat.isSymbolicLink() ? '120000' : stat.isFile() ? (stat.mode & 0o111 ? '100755' : '100644') : 'unsupported';
    assert.equal(mode, entry.mode, `Owned fixture mode/type changed: ${path}`);
    assert.equal(sha256(readFileSync(join(root, path))), entry.sha256, `Owned fixture bytes changed: ${path}`);
  }
  const listed = path => baseline.has(path) || ownedFiles.has(path);

  // Git finds new fixture trees; walking existing protected trees additionally
  // rejects ignored files and symlinks that Git's normal status would omit.
  const currentPaths = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  for (const path of currentPaths) {
    if (isProtectedPath(path)) assert.ok(listed(path), `Unlisted protected file: ${path}`);
  }
  const roots = [...new Set([...baseline.keys(), ...ownedFiles.keys()].map(protectedRoot))].sort();
  function walk(path) {
    if (baseline.get(path)?.mode === '160000') return;
    const stat = checkedStat(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const name of readdirSync(join(root, path))) walk(`${path}/${name}`);
    } else assert.ok(listed(path), `Unlisted protected file: ${path}`);
  }
  for (const path of roots) walk(path);
  return { referenceEntriesPreserved: references, referenceGitlinksPreserved: gitlinks,
    unlistedFixtureFilesPreserved: unchangedFixtures, reviewedFixtureMigrationsVerified: approved.size,
    ownedFixtureFilesVerified: ownedFiles.size,
    reviewedFixtureBytesAndModesVerified: true, unlistedProtectedChangesRejected: true };
}

export function auditPreservedFixtures(root, upstream) {
  assert.equal(upstream, FIXTURE_UPSTREAM, 'Fixture audit must use the pinned upstream baseline');
  const manifest = loadReviewedFixtureManifest(root);
  const owned = loadOwnedFixtureManifest(root);
  const result = verifyFixtureTree(root, readProtectedBaseline(root, upstream), manifest.entries, owned.entries);
  return { ...result, upstreamCommit: upstream, reviewCommits: FIXTURE_REVIEW_COMMITS,
    manifestSha256: FIXTURE_MANIFEST_SHA256, ownedFixtureCommits: OWNED_FIXTURE_COMMITS,
    ownedManifestSha256: OWNED_FIXTURE_MANIFEST_SHA256 };
}
