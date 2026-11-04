// @effect-diagnostics nodeBuiltinImport:off - exercises the installed Git shim.
import { it } from '@effect/vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { installManualWorktreeGuard } from './ManualWorktreeGuard.ts';

const fixtureTest = process.platform === 'win32' ? it.skip : it;
fixtureTest('permits disposable worktrees and refuses sandbox escapes', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'guard-fixture-')));
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'guard-outside-')));
  try {
    const repo = join(base, 'repo'); mkdirSync(repo);
    const guard = installManualWorktreeGuard({ stateDir: join(base, 'state'), serverEnvironment: process.env, platform: process.platform });
    assert.ok(guard);
    const git = join(guard.directory, 'git');
    const run = (args: string[], cwd = repo) => spawnSync(git, args, { cwd, encoding: 'utf8' });
    assert.equal(run(['init']).status, 0);
    assert.equal(run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'initial']).status, 0);
    const allowed = run(['-C', repo, 'worktree', 'add', '-b', 'allowed', join(base, 'allowed')]);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(run(['worktree', 'add', '-qb', 'nested', join(base, 'new-parent', 'nested')]).status, 0);
    assert.equal(run(['worktree', 'add', '-b', 'escape', join(other, 'escape')]).status, 128);
    symlinkSync(other, join(base, 'link'));
    assert.equal(run(['worktree', 'add', '-b', 'link', join(base, 'link', 'escape')]).status, 128);
    assert.equal(run(['worktree', 'add', '-b', 'dotdot', join(base, '..', 'escape')]).status, 128);
    // Git -C ignores CDPATH; validation must resolve the identical repository.
    const otherRepo = join(other, 'repo'); mkdirSync(otherRepo);
    assert.equal(run(['init'], otherRepo).status, 0);
    assert.equal(run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'initial'], otherRepo).status, 0);
    const redirected = spawnSync(git, ['-C', 'repo', 'worktree', 'add', '-b', 'redirected', join(base, 'redirected')], {
      cwd: other, env: { ...process.env, CDPATH: base }, encoding: 'utf8',
    });
    assert.equal(redirected.status, 128, redirected.stderr);
    // Shell cd '-' means OLDPWD, but Git -C '-' names a literal directory.
    const dashRepo = join(other, '-'); mkdirSync(dashRepo);
    assert.equal(run(['init'], dashRepo).status, 0);
    assert.equal(run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'initial'], dashRepo).status, 0);
    const dash = run(['-C', repo, '-C', other, '-C', '-', 'worktree', 'add', '-b', 'dash', join(base, 'dash')]);
    assert.equal(dash.status, 128, dash.stderr);
    symlinkSync(other, join(repo, '-'));
    const dashDestination = run(['-C', base, '-C', 'repo', 'worktree', 'add', '-b', 'dash-destination', '--', '-/escaped']);
    assert.equal(dashDestination.status, 128, dashDestination.stderr);
    const newlineSibling = base + '\n'; mkdirSync(newlineSibling);
    try {
      assert.equal(run(['worktree', 'add', '-b', 'newline-sibling', join(newlineSibling, 'escaped')]).status, 128);
    } finally { rmSync(newlineSibling, { recursive: true, force: true }); }
    symlinkSync(other, newlineSibling);
    try {
      assert.equal(run(['worktree', 'add', '-b', 'newline-link', join(newlineSibling, 'escaped')]).status, 128);
    } finally { rmSync(newlineSibling, { force: true }); }
    // An externally owned common directory cannot masquerade as a local fixture.
    const fake = join(base, 'fake'); mkdirSync(fake);
    writeFileSync(join(fake, '.git'), `gitdir: ${join(other, '.git')}\n`);
    assert.equal(run(['init'], other).status, 0);
    assert.equal(run(['worktree', 'add', '-b', 'external', join(base, 'external')], fake).status, 128);
  } finally {
    rmSync(base, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true });
  }
});
