#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { validateArtifactIdentity } from '../studio-projects/version.mjs';
import { verifyRuntimeBins } from './runtime-package.mjs';

assert.equal(process.versions.node, '22.20.0', 'Verify with the pinned production Node22 runtime');
const root = realpathSync(resolve(process.argv[2]));
const manifest = JSON.parse(readFileSync(join(root, 'studio-manifest.json')));
const runtimePackageJson = JSON.parse(readFileSync(join(root, 'package.json')));
const artifactVersion = validateArtifactIdentity(manifest, runtimePackageJson);
verifyRuntimeBins(runtimePackageJson);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const indexed = new Set();
for (const entry of manifest.files) {
  assert.ok(!indexed.has(entry.path), 'Duplicate manifest path');
  assert.ok(['file', 'symlink'].includes(entry.type), 'Unknown manifest entry type');
  indexed.add(entry.path);
  const path = resolve(root, entry.path);
  assert.ok(path.startsWith(root + sep), 'Unsafe manifest path');
  const stat = lstatSync(path);
  if (entry.type === 'symlink') {
    assert.ok(stat.isSymbolicLink());
    assert.equal(readlinkSync(path), entry.target);
    assert.ok(realpathSync(path).startsWith(root + sep), 'Dependency escapes the artifact');
  } else {
    assert.ok(stat.isFile());
    assert.equal(hash(readFileSync(path)), entry.sha256, `File digest differs: ${entry.path}`);
  }
}
function verifyIndex(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name), stat = lstatSync(path);
    if (stat.isDirectory()) verifyIndex(path);
    else assert.ok(path === join(root, 'studio-manifest.json') || indexed.has(path.slice(root.length + 1)), 'Unindexed artifact file');
  }
}
verifyIndex(root);
assert.ok(indexed.has('bin.mjs') && indexed.has('package.json'), 'Entrypoint/package must be indexed');
for (const path of ['LICENSE', 'UPSTREAM.md', 'third-party-licenses.json', 'client/third-party-licenses.json']) {
  assert.ok(existsSync(join(root, path)), `Required legal notice missing: ${path}`);
}
const req = createRequire(join(root, 'bin.mjs'));
const loaded = [];
for (const name of manifest.runtimeRoots) {
  assert.ok(realpathSync(req.resolve(name)).startsWith(root + sep), 'Module resolved outside artifact');
  req(name);
  loaded.push(name);
}
const env = { HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.USER,
  PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', NODE_PATH: '' };
const version = execFileSync(process.execPath, [join(root, 'bin.mjs'), '--version'],
  { cwd: root, env, encoding: 'utf8', timeout: 30_000 }).trim();
assert.equal(version, `specweave-studio v${artifactVersion}`);
const help = execFileSync(process.execPath, [join(root, 'bin.mjs'), '--help'],
  { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
assert.ok(help.includes('specweave-studio') && help.includes('start'));
console.log(JSON.stringify({ sourceCommit: manifest.sourceCommit, node: process.version,
  standalone: true, version, filesVerified: manifest.files.length, runtimeRootsLoaded: loaded,
  legalNoticesVerified: true, inferenceExecuted: false }));
