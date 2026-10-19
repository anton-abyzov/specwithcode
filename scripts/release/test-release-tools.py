#!/usr/bin/env python3
"""release_tools.py in temporary folders: workspace packages, SHA256SUMS, the Google pair file,
the previous release, release notes, the public notes check, which failed server files are worth
a retry, stage-1 ordering and the retry lines of the timing table. release.sh --self-test runs it.

Run: python3 -B scripts/release/test-release-tools.py
"""
import contextlib
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import release_tools  # noqa: E402

GIT = ['git', '-c', 'user.name=Release Test', '-c', 'user.email=release-test@example.invalid',
       '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main']
GIT_ENV = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1')


def cli(*argv, stdin=''):
    out, err = io.StringIO(), io.StringIO()
    previous = sys.stdin
    sys.stdin = io.StringIO(stdin)
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = release_tools.main(list(argv))
    finally:
        sys.stdin = previous
    return code, out.getvalue(), err.getvalue()


class Temporary(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def package(self, directory, test=True, name=None):
        path = self.root / directory
        path.mkdir(parents=True, exist_ok=True)
        scripts = {'test': 'vp test run'} if test else {'build': 'vp build'}
        (path / 'package.json').write_text(json.dumps({'name': name or directory, 'scripts': scripts}))


class Packages(Temporary):
    def test_every_tested_package_but_the_root_and_the_server(self):
        (self.root / 'pnpm-workspace.yaml').write_text(
            'packages:\n  - "apps/*"\n  - packages/*\n  - scripts\n\ncatalog:\n  x: 1\n')
        self.package('.', name='monorepo')
        for directory in ('apps/server', 'apps/web', 'packages/shared', 'scripts'):
            self.package(directory)
        self.package('packages/untested', test=False)
        self.package('apps/web/node_modules/dep')
        self.assertEqual([entry[0] for entry in release_tools.packages(self.root)],
                         ['apps/web', 'packages/shared', 'scripts'])
        (self.root / 'apps/server/package.json').write_text('{"name": "server", "scripts": {}}')
        with self.assertRaises(release_tools.ToolError):
            release_tools.packages(self.root)


class PinnedObjects(Temporary):
    def test_object_ids_in_audit_sources_only_once_and_sorted(self):
        (self.root / 'node_modules').mkdir()
        (self.root / 'node_modules/x.mjs').write_text("'cccccccccccccccccccccccccccccccccccccccc'")
        (self.root / 'a.test.mjs').write_text("git show 0123456789abcdef0123456789abcdef01234567:pnpm-lock.yaml aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 0123456789abcdef0123456789abcdef01234567")
        (self.root / 'reviewed.json').write_text('{"commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "long": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0"}')
        (self.root / 'notes.md').write_text('dddddddddddddddddddddddddddddddddddddddd')
        self.assertEqual(release_tools.pinned_objects(self.root), ['0123456789abcdef0123456789abcdef01234567', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'])
        self.assertEqual(release_tools.pinned_objects(self.root / 'missing'), [])


class Sums(Temporary):
    def test_written_appended_verified_and_tampering_caught(self):
        for name in ('a.zip', 'b.tar.gz', 'plan.json'):
            (self.root / name).write_text('content of %s' % name)
        sums = self.root / 'SHA256SUMS'
        self.assertEqual(cli('sums', '--dir', str(self.root), '--out', str(sums), 'a.zip', 'b.tar.gz')[0], 0)
        self.assertEqual(cli('sums', '--dir', str(self.root), '--out', str(sums), '--append', 'plan.json')[0], 0)
        self.assertEqual([line.split()[1] for line in sums.read_text().splitlines()], ['a.zip', 'b.tar.gz', 'plan.json'])
        self.assertEqual(cli('verify-sums', '--dir', str(self.root), 'a.zip', 'plan.json')[0], 0)
        self.assertEqual(cli('sums', '--dir', str(self.root), '--out', str(sums), '--append', 'a.zip')[0], 1)
        (self.root / 'a.zip').write_text('changed')
        code, _out, err = cli('verify-sums', '--dir', str(self.root), 'a.zip')
        self.assertEqual(code, 1)
        self.assertIn('does not match', err)
        self.assertEqual(cli('verify-sums', '--dir', str(self.root), 'missing.zip')[0], 1)


class PreviousWithoutPlanInSums(Temporary):
    """The prev stage: 1.0.38 shipped a SHA256SUMS without studio-update.json."""

    def release(self, plan_listed, plan_digest='right', sums_digest='right'):
        (self.root / 'studio-update.json').write_text('{"version": "1.0.38"}\n')
        (self.root / 'deployment-helpers-manifest.json').write_text('{"files": []}\n')
        names = ['deployment-helpers-manifest.json'] + (['studio-update.json'] if plan_listed else [])
        self.assertEqual(cli('sums', '--dir', str(self.root), '--out', str(self.root / 'SHA256SUMS'), *names)[0], 0)
        assets = []
        for name in ('SHA256SUMS', 'studio-update.json', 'deployment-helpers-manifest.json'):
            kind = {'SHA256SUMS': sums_digest, 'studio-update.json': plan_digest}.get(name, 'right')
            digest = {'right': 'sha256:' + release_tools.sha256(self.root / name), 'wrong': 'sha256:' + '0' * 64,
                      'none': None}[kind]
            assets.append({'name': name, 'digest': digest})
        (self.root / 'assets.json').write_text(json.dumps(assets))

    def verify(self):
        return cli('verify-sums', '--dir', str(self.root), '--digests', str(self.root / 'assets.json'),
                   'studio-update.json', 'deployment-helpers-manifest.json')

    def test_listed_plan_passes_with_or_without_digests(self):
        self.release(plan_listed=True)
        self.assertEqual(self.verify()[:2], (0, ''))
        self.release(plan_listed=True, plan_digest='none', sums_digest='none')
        self.assertEqual(self.verify()[:2], (0, ''))

    def test_unlisted_plan_is_accepted_only_on_its_github_digest(self):
        self.release(plan_listed=False)
        code, out, _err = self.verify()
        self.assertEqual(code, 0)
        self.assertIn('studio-update.json is not listed in SHA256SUMS; it matches the sha256 digest', out)

    def test_unlisted_plan_without_a_digest_is_refused(self):
        self.release(plan_listed=False, plan_digest='none')
        code, _out, err = self.verify()
        self.assertEqual(code, 1)
        self.assertIn('studio-update.json is not listed in SHA256SUMS and GitHub records no digest', err)
        # Without --digests the old rule stands: not listed is not verified.
        self.assertEqual(cli('verify-sums', '--dir', str(self.root), 'studio-update.json')[0], 1)

    def test_a_digest_that_disagrees_is_refused_even_when_listed(self):
        self.release(plan_listed=False, plan_digest='wrong')
        self.assertIn('studio-update.json does not match the digest', self.verify()[2])
        self.release(plan_listed=True, plan_digest='wrong')
        self.assertIn('studio-update.json does not match the digest', self.verify()[2])
        self.release(plan_listed=True, sums_digest='wrong')
        code, _out, err = self.verify()
        self.assertEqual(code, 1)
        self.assertIn('SHA256SUMS does not match the digest', err)

    def test_unreadable_asset_list_is_refused(self):
        self.release(plan_listed=False)
        (self.root / 'assets.json').write_text('')
        self.assertEqual(self.verify()[0], 1)
        (self.root / 'assets.json').write_text('{"message": "Not Found"}')
        self.assertEqual(self.verify()[0], 1)


class GooglePair(Temporary):
    SECRET = 'value-that-must-not-print'

    def test_check_and_copy_never_print_values(self):
        source = self.root / 'source.env'
        source.write_text('OTHER=1\nexport STUDIO_GOOGLE_OAUTH_CLIENT_ID="id-%s"\n'
                          'STUDIO_GOOGLE_OAUTH_CLIENT_SECRET=%s\n' % (self.SECRET, self.SECRET))
        target = self.root / 'private' / 'google.env'
        code, out, err = cli('google-env', 'copy', str(source), str(target))
        self.assertEqual(code, 0)
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertNotIn('OTHER', target.read_text())
        self.assertEqual(cli('google-env', 'check', str(target))[0], 0)
        self.assertEqual(cli('google-env', 'copy', str(source), str(target))[0], 1)  # never overwrites
        os.chmod(str(target), 0o644)
        failures = [cli('google-env', 'check', str(target))]
        os.chmod(str(target), 0o600)
        with open(str(target), 'a') as handle:
            handle.write('EXTRA=1\n')
        failures.append(cli('google-env', 'check', str(target)))
        target.write_text('STUDIO_GOOGLE_OAUTH_CLIENT_ID=x\nSTUDIO_GOOGLE_OAUTH_CLIENT_SECRET=""\n')
        failures.append(cli('google-env', 'check', str(target)))
        failures.append(cli('google-env', 'check', str(self.root / 'absent.env')))
        for code, out, err in failures:
            self.assertEqual(code, 1)
            self.assertNotIn(self.SECRET, out + err)
        self.assertNotIn(self.SECRET, out + err)


class Versions(unittest.TestCase):
    def test_previous_is_the_newest_published_release_below(self):
        releases = json.dumps([{'tagName': 'v1.0.36', 'isDraft': False}, {'tagName': 'v1.0.40', 'isDraft': True},
                               {'tagName': 'v1.0.9', 'isDraft': False}, {'tagName': 'v1.0.38', 'isDraft': False},
                               {'tagName': 'desktop-v2', 'isDraft': False}])
        self.assertEqual(cli('previous', '--version', '1.0.40', stdin=releases)[:2], (0, '1.0.38\n'))
        self.assertEqual(cli('previous', '--version', '1.0.37', stdin=releases)[:2], (0, '1.0.36\n'))
        self.assertEqual(cli('previous', '--version', '1.0.1', stdin=releases)[0], 1)
        self.assertEqual(cli('newer', '1.0.10', '1.0.9')[0], 0)
        self.assertEqual(cli('newer', '1.0.9', '1.0.9')[0], 1)
        self.assertEqual(cli('newer', '1.0', '1.0.9')[0], 1)


class Notes(Temporary):
    def test_subjects_since_the_previous_release_without_the_bump(self):
        repo = self.root / 'repo'
        subprocess.run(GIT + ['init', '-q', str(repo)], check=True, env=GIT_ENV)

        def commit(subject):
            (repo / 'file.txt').write_text(subject)
            subprocess.run(GIT + ['-C', str(repo), 'add', '-A'], check=True, env=GIT_ENV)
            subprocess.run(GIT + ['-C', str(repo), 'commit', '-q', '-m', subject], check=True, env=GIT_ENV)
            return subprocess.run(['git', '-C', str(repo), 'rev-parse', 'HEAD'], check=True, capture_output=True,
                                  text=True, env=GIT_ENV).stdout.strip()

        base = commit('Previous release')
        commit('Show usage per project (#250)')
        head = commit('Prepare SpecWithCode 1.2.0 release')
        text = release_tools.notes(repo, head, '1.2.0', base)
        self.assertIn('- Show usage per project\n', text)
        self.assertNotIn('Prepare SpecWithCode', text)
        self.assertNotIn('Previous release', text)
        self.assertIn('is not in this history', release_tools.notes(repo, head, '1.2.0', 'f' * 40))


class PublicNotes(Temporary):
    def test_private_names_are_replaced_and_private_shapes_refused(self):
        rules = self.root / 'rules.json'
        rules.write_text(json.dumps({'replace': [['Internal Name', 'Public Name']], 'deny': ['never-ship-this']}))
        text = release_tools.public_notes('See anton-abyzov/specwithcode#12 and Internal Name.\n', str(rules))
        self.assertEqual(text, 'See anton-abyzov/specwithcode#12 and Public Name.\n')
        # The branch shape is assembled so this file passes the public mirror's own deny check.
        for leak in ('never-ship-this', 'a path /Users/someone/x', 'host 192.168.1.20', 'on Pats-MacBook-Pro',
                     'branch ' + 'codex' + '/0912-thing'):
            with self.assertRaises(release_tools.ToolError):
                release_tools.public_notes('Note: %s\n' % leak, str(rules))


class ShardFailures(Temporary):
    def summary(self, shards):
        path = self.root / 'shards.json'
        path.write_text(json.dumps({'shards': shards}))
        return str(path)

    def shard(self, index, failed=(), exit_code=None, timed_out=False, signal=None, times=None):
        report = self.root / ('server-%d.json' % index)
        report.write_text(json.dumps({'testResults': [
            {'name': '/tree/apps/server/' + name, 'startTime': 1000, 'endTime': 1000 + int(1000 * seconds)}
            for name, seconds in (times or {}).items()]}))
        return {'index': index, 'exitCode': (1 if failed else 0) if exit_code is None else exit_code,
                'timedOut': timed_out, 'signal': signal, 'failedFiles': list(failed), 'report': str(report)}

    def test_failed_files_with_their_seconds(self):
        path = self.summary([self.shard(1, ['src/a.test.ts'], times={'src/a.test.ts': 17.2}),
                             self.shard(2), self.shard(3, ['src/b.test.ts'])])
        self.assertEqual(release_tools.shard_failures(path, 5), [('src/a.test.ts', 17), ('src/b.test.ts', 0)])
        self.assertEqual(cli('shard-failures', '--summary', path, '--names'), (0, 'src/a.test.ts\nsrc/b.test.ts\n', ''))

    def test_nothing_to_retry_after_a_crash_a_timeout_or_too_many_files(self):
        crashed = self.summary([self.shard(1, [], exit_code=1), self.shard(2, ['src/a.test.ts'])])
        self.assertEqual(release_tools.shard_failures(crashed, 5), [])
        timed_out = self.summary([self.shard(1, ['src/a.test.ts'], timed_out=True)])
        self.assertEqual(release_tools.shard_failures(timed_out, 5), [])
        many = self.summary([self.shard(1, ['src/%d.test.ts' % n for n in range(6)])])
        self.assertEqual(release_tools.shard_failures(many, 5), [])
        self.assertEqual(release_tools.shard_failures(self.summary([self.shard(1)]), 5), [])


class StageOneOrder(Temporary):
    def secs(self, attempt, name, value, age):
        path = self.root / 'stage1' / attempt / (name + '.secs')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('%d\n' % value)
        os.utime(str(path), (1000000 - age, 1000000 - age))

    def test_longest_first_by_the_newest_time(self):
        self.secs('old', 'fleet', 10, age=100)
        self.secs('new', 'fleet', 109, age=1)
        self.secs('new', 'apps_web', 90, age=1)
        self.secs('new/try-1', 'scripts', 500, age=1)  # A first try is not a job's time.
        history = release_tools.stage1_history([str(self.root / 'stage1'), str(self.root / 'missing')])
        self.assertEqual(history, {'fleet': 109, 'apps_web': 90})
        self.assertEqual(release_tools.stage1_order(['scripts', 'apps_web', 'tiny', 'fleet'], history),
                         ['fleet', 'apps_web', 'scripts', 'tiny'])

    def test_newest_fleet_results(self):
        for attempt, age in (('a', 50), ('b', 5)):
            summary = self.root / 'stage1' / attempt / 'fleet' / 'summary.txt'
            summary.parent.mkdir(parents=True)
            summary.write_text('TEST RESULT SECS\n')
            os.utime(str(summary), (1000000 - age, 1000000 - age))
        self.assertEqual(release_tools.stage1_fleet_dirs([str(self.root / 'stage1')]),
                         [str(self.root / 'stage1/b/fleet'), str(self.root / 'stage1/a/fleet')])


class Retries(Temporary):
    def test_flakes_are_summarised_and_a_repeat_is_named(self):
        stages, retries = self.root / 'stages.jsonl', self.root / 'retries.jsonl'
        release_tools.timing_record(stages, 'stage1', 0, 160, 'ok', 'abc', 1)
        release_tools.timing_retry(retries, 'stage1', 'fleet', 109, 65, 'passed', '/s/try-1/fleet.log', 'test-reap.py', 'abc', 1)
        release_tools.timing_retry(retries, 'server', 'src/a.test.ts', 17, 9, 'failed', '/s/shards.json', '', 'abc', 1)
        summary = release_tools.timing_summary(stages, '1.2.0', retries)
        by_stage = dict((stage['stage'], stage) for stage in summary['stages'])
        self.assertEqual((by_stage['stage1']['flakes'], by_stage['stage1']['retriesFailed']), (1, 0))
        self.assertEqual((by_stage['server']['flakes'], by_stage['server']['retriesFailed']), (0, 1))
        self.assertEqual(len(summary['retries']), 2)
        previous = {'version': '1.1.0', 'stages': [], 'retries': [{'stage': 'stage1', 'job': 'fleet', 'result': 'passed'}]}
        lines, _slower = release_tools.timing_compare(summary, previous)
        text = '\n'.join(lines)
        self.assertIn('1 flake: fleet', text)
        self.assertIn('FLAKY (passed only on retry): stage1/fleet 109s then 65s, first try /s/try-1/fleet.log (test-reap.py)', text)
        self.assertIn('REPEAT FLAKE: stage1/fleet also flaked in 1.1.0', text)
        self.assertIn('Failed again on retry: server/src/a.test.ts', text)
        lines, _slower = release_tools.timing_compare(summary, {'version': '1.0.9', 'stages': []})
        self.assertNotIn('REPEAT FLAKE', '\n'.join(lines))
        self.assertEqual(release_tools.timing_summary(stages, '1.2.0', str(self.root / 'none.jsonl'))['retries'], [])
        self.assertEqual([entry['job'] for entry in release_tools.timing_retries(retries, 'server', 'abc')], ['src/a.test.ts'])


if __name__ == '__main__':
    unittest.main()
