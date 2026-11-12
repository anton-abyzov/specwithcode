#!/usr/bin/env python3
"""release_plan.py: which version a Release macOS run cuts, when it cuts none, and whether an
earlier attempt on the release Mac is continued, started over or refused.
release.sh --self-test runs it.

Run: python3 -B scripts/release/test-release-plan.py
"""
import contextlib
import io
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import release_plan  # noqa: E402

TAGS = ['1.0.9', '1.0.26', '1.0.99', '1.0.100', '1.0.259', '1.0.260']


def decide(requested='', resume=False, tags=TAGS, main_tree='main', latest_tree='tag', merged=True,
           conflict=0):
    return release_plan.decide(requested, resume, tags, main_tree, latest_tree, merged, conflict)


class Request(unittest.TestCase):
    """No version: the run releases what main holds."""

    def test_cuts_the_next_patch_when_main_changed(self):
        result = decide()
        self.assertEqual((result['action'], result['version'], result['resume'], result['mode']),
                         ('release', '1.0.261', False, 'request'))

    def test_the_highest_tag_is_by_number_not_by_text(self):
        self.assertEqual(decide(tags=['1.0.99', '1.0.100', '1.0.9'])['version'], '1.0.101')
        self.assertEqual(decide(tags=['1.9.5', '1.10.0'])['version'], '1.10.1')

    def test_tags_outside_the_policy_are_ignored(self):
        self.assertEqual(decide(tags=['1.0.4', '2.0.0', '1.0.5-rc1', '01.0.9'])['version'], '1.0.5')

    def test_does_nothing_when_main_is_the_latest_release(self):
        result = decide(main_tree='same', latest_tree='same')
        self.assertEqual((result['action'], result['version']), ('noop', '1.0.260'))

    def test_two_requests_in_a_row_cut_one_version(self):
        first = decide()
        self.assertEqual(first['version'], '1.0.261')
        # The second run plans after the first one tagged and merged.
        second = decide(tags=TAGS + ['1.0.261'], main_tree='released', latest_tree='released')
        self.assertEqual(second['action'], 'noop')

    def test_a_failed_release_is_cut_again_under_the_same_version(self):
        # No tag was made, so the next request plans the same version; the release Mac continues it.
        self.assertEqual(decide()['version'], decide()['version'])

    def test_finishes_a_published_release_that_never_merged(self):
        result = decide(merged=False)
        self.assertEqual((result['action'], result['version'], result['resume'], result['mode']),
                         ('release', '1.0.260', True, 'finish'))

    def test_halts_when_that_release_cannot_merge(self):
        result = decide(merged=False, conflict=253)
        self.assertEqual(result['action'], 'refuse')
        self.assertIn('#253', result['reason'])
        # A version given with resume is still continued: that is how the merge is finished.
        self.assertEqual(decide('1.0.260', resume=True, merged=False, conflict=253)['action'], 'release')

    def test_an_unreadable_main_tree_is_never_a_noop(self):
        self.assertEqual(decide(main_tree='', latest_tree='')['action'], 'release')

    def test_refuses_without_any_release_tag(self):
        self.assertEqual(decide(tags=[])['action'], 'refuse')

    def test_resume_needs_a_version(self):
        self.assertEqual(decide(resume=True)['action'], 'refuse')


class Version(unittest.TestCase):
    """A version given on purpose."""

    def test_a_released_version_is_refused(self):
        result = decide('1.0.260')
        self.assertEqual(result['action'], 'refuse')
        self.assertIn('already released', result['reason'])

    def test_a_version_below_the_newest_is_refused(self):
        self.assertEqual(decide('1.0.150')['action'], 'refuse')

    def test_the_next_version_and_a_jump_are_released(self):
        for version in ('1.0.261', '1.1.0'):
            result = decide(version)
            self.assertEqual((result['action'], result['version'], result['resume'], result['mode']),
                             ('release', version, False, 'version'))

    def test_resume_continues_even_a_tagged_version(self):
        for version in ('1.0.260', '1.0.261'):
            result = decide(version, resume=True)
            self.assertEqual((result['action'], result['version'], result['resume']),
                             ('release', version, True))

    def test_a_malformed_version_is_refused(self):
        for version in ('v1.0.261', '1.0', '2.0.0', '1.0.261-rc1', '1.0.261; rm -rf /', '1.0.0261'):
            self.assertEqual(decide(version, resume=True)['action'], 'refuse', version)
            self.assertEqual(decide(version)['action'], 'refuse', version)


def fake_gh(tags, trees, compare='behind', merged_prs='0', conflict='0'):
    calls = []

    def run(*args):
        calls.append(args)
        path = args[-3] if args[0] == 'api' else ''
        if 'matching-refs' in path:
            return ''.join(f'refs/tags/v{tag}\n' for tag in tags) + 'refs/tags/v1.0.5-rc1\n'
        if '/commits/' in path:
            ref = path.rsplit('/', 1)[1]
            return f'sha-{ref}\n{trees[ref]}\n'
        if '/compare/' in path:
            return compare + '\n'
        if args[:2] == ('pr', 'list') and 'merged' in args:
            return merged_prs + '\n'
        if args[:2] == ('pr', 'list') and 'open' in args:
            return conflict + '\n'
        raise AssertionError(args)

    run.calls = calls
    return run


class Gather(unittest.TestCase):
    def test_reads_tags_trees_and_merge_state(self):
        run = fake_gh(TAGS, {'main': 't1', 'v1.0.260': 't0'})
        facts = release_plan.gather('o/r', 'main', '', run)
        self.assertEqual(facts['tags'], TAGS)
        self.assertEqual((facts['main_sha'], facts['main_tree'], facts['latest_tree'], facts['latest_merged']),
                         ('sha-main', 't1', 't0', True))

    def test_a_given_version_needs_only_the_tags(self):
        run = fake_gh(TAGS, {})
        release_plan.gather('o/r', 'main', '1.0.261', run)
        self.assertEqual(len(run.calls), 1)

    def test_a_squash_merged_release_counts_as_merged(self):
        run = fake_gh(TAGS, {'main': 't1', 'v1.0.260': 't0'}, compare='diverged', merged_prs='1')
        self.assertTrue(release_plan.gather('o/r', 'main', '', run)['latest_merged'])

    def test_a_published_release_with_no_merged_pull_request_is_not_merged(self):
        run = fake_gh(TAGS, {'main': 't1', 'v1.0.260': 't0'}, compare='ahead', merged_prs='0')
        facts = release_plan.gather('o/r', 'main', '', run)
        self.assertEqual((facts['latest_merged'], facts['conflict']), (False, 0))

    def test_a_conflicting_merge_back_is_reported_with_its_number(self):
        run = fake_gh(TAGS, {'main': 't1', 'v1.0.260': 't0'}, compare='diverged', conflict='253')
        self.assertEqual(release_plan.gather('o/r', 'main', '', run)['conflict'], 253)


GIT = ['git', '-c', 'user.name=Release Test', '-c', 'user.email=release-test@example.invalid',
       '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main']
GIT_ENV = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1')
VERSION = '1.0.261'


def git(cwd, *args):
    return subprocess.run([*GIT, '-C', str(cwd), *args], check=True, capture_output=True, text=True,
                          env=GIT_ENV).stdout.strip()


class Attempt(unittest.TestCase):
    """On the release Mac: an origin with main, a build tree on release/<version>, a staging folder."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = pathlib.Path(self.tmp.name)
        self.origin, self.trees, self.staging = root / 'origin', root / 'trees', root / 'staging'
        self.build = self.trees / 'build'
        self.origin.mkdir()
        git(self.origin, 'init', '-q')
        self.commit(self.origin, 'feature one')
        self.trees.mkdir()
        subprocess.run([*GIT, 'clone', '-q', str(self.origin), str(self.build)], check=True, env=GIT_ENV)
        git(self.build, 'checkout', '-q', '-b', f'release/{VERSION}')
        self.commit(self.build, f'Prepare SpecWithCode {VERSION} release')
        self.stage = self.staging / VERSION
        self.stage.mkdir(parents=True)
        (self.stage / 'release.json').write_text('{}')

    def commit(self, tree, subject):
        git(tree, 'commit', '-q', '--allow-empty', '-m', subject)

    def attempt(self, resume=False, version=VERSION):
        with mock.patch.dict(os.environ, GIT_ENV):
            return release_plan.attempt(version, resume, self.staging, self.trees, str(self.origin))

    def retired(self):
        return [path.name for path in self.staging.iterdir() if path.name.startswith('.retired-')]

    def test_no_earlier_attempt_starts_fresh(self):
        self.assertEqual(self.attempt(version='1.0.262')[0], 'fresh')

    def test_a_flaky_failure_is_continued_once_then_refused(self):
        self.assertEqual(self.attempt()[0], 'resume')
        how, why = self.attempt()
        self.assertEqual(how, 'refuse')
        self.assertIn('nothing changed', why)
        self.assertTrue(self.stage.is_dir())
        # Asked for by name, it is continued whatever happened before.
        self.assertEqual(self.attempt(resume=True)[0], 'resume')

    def test_main_moving_starts_the_version_over_from_main(self):
        self.commit(self.origin, 'the fix, merged to main')
        how, why = self.attempt()
        self.assertEqual(how, 'fresh')
        self.assertIn('starting 1.0.261 over', why)
        self.assertFalse(self.stage.exists())
        # Under the name staging_retention.py sweeps.
        import staging_retention
        self.assertEqual(len(self.retired()), 1)
        self.assertTrue(staging_retention.RETIRED.fullmatch(self.retired()[0]))

    def test_a_fix_committed_to_the_release_branch_is_kept_and_continued(self):
        self.commit(self.build, 'Fix the startup check')
        self.commit(self.origin, 'unrelated work on main')
        self.assertEqual(self.attempt()[0], 'resume')
        self.assertTrue(self.stage.is_dir())
        self.assertEqual(self.retired(), [])
        # The same candidate again is refused; a second fix is a new candidate.
        self.assertEqual(self.attempt()[0], 'refuse')
        self.commit(self.build, 'Fix it properly')
        self.assertEqual(self.attempt()[0], 'resume')

    def test_a_published_release_is_always_finished(self):
        (self.stage / 'published.sha').write_text('abc')
        self.commit(self.origin, 'merged after publish')
        for _ in range(3):
            self.assertEqual(self.attempt()[0], 'resume')
        self.assertTrue(self.stage.is_dir())

    def test_a_release_stopped_on_purpose_needs_resume(self):
        release_plan.hold(VERSION, 'drafts', self.staging, 'run 7')
        self.commit(self.origin, 'main moved')
        how, why = self.attempt()
        self.assertEqual(how, 'refuse')
        self.assertIn('after drafts, run 7', why)
        self.assertTrue(self.stage.is_dir())
        self.assertEqual(self.attempt(resume=True)[0], 'resume')
        # Continued by name, it is an ordinary attempt again.
        self.assertFalse((self.stage / 'held').exists())

    def test_hold_marks_only_a_staging_folder_release_sh_made(self):
        release_plan.hold('1.0.300', 'drafts', self.staging)
        self.assertFalse((self.staging / '1.0.300').exists())

    def test_a_locked_attempt_is_left_to_release_sh(self):
        (self.stage / 'lock').mkdir()
        self.commit(self.origin, 'main moved')
        self.assertEqual(self.attempt()[0], 'resume')
        self.assertTrue(self.stage.is_dir())

    def test_a_missing_build_tree_or_branch_is_left_to_release_sh(self):
        git(self.build, 'checkout', '-q', 'main')
        git(self.build, 'branch', '-q', '-D', f'release/{VERSION}')
        self.commit(self.origin, 'main moved')
        self.assertEqual(self.attempt()[0], 'resume')
        self.assertTrue(self.stage.is_dir())

    def test_a_folder_release_sh_did_not_make_is_not_touched(self):
        (self.stage / 'release.json').unlink()
        self.commit(self.origin, 'main moved')
        self.assertEqual(self.attempt()[0], 'fresh')
        self.assertTrue(self.stage.is_dir())


class Cli(unittest.TestCase):
    def run_cli(self, argv, run):
        out = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp:
            output, summary = os.path.join(tmp, 'output'), os.path.join(tmp, 'summary')
            env = dict(os.environ, GITHUB_OUTPUT=output, GITHUB_STEP_SUMMARY=summary)
            with mock.patch.object(release_plan, 'gh', run), mock.patch.dict(os.environ, env), \
                    contextlib.redirect_stdout(out):
                # gather() takes its reader as a default argument, bound at import.
                with mock.patch.object(release_plan.gather, '__defaults__', (run,)):
                    code = release_plan.main(argv)
            lines = pathlib.Path(output).read_text().splitlines() if os.path.exists(output) else []
            written = dict(line.split('=', 1) for line in lines)
            said = pathlib.Path(summary).read_text() if os.path.exists(summary) else ''
            return code, written, said, out.getvalue()

    def test_attempt_writes_resumed_for_the_release_step(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = {'RELEASE_STAGING_ROOT': os.path.join(tmp, 'staging'), 'RELEASE_TREES': os.path.join(tmp, 'trees')}
            with mock.patch.dict(os.environ, env):
                code, written, _, _ = self.run_cli(['attempt', '--repo', 'o/r', '--version', VERSION], None)
                self.assertEqual((code, written['resumed']), (0, 'false'))
                code, written, _, _ = self.run_cli(
                    ['attempt', '--repo', 'o/r', '--version', VERSION, '--resume'], None)
                self.assertEqual((code, written['resumed']), (0, 'true'))
                code, _, _, out = self.run_cli(['attempt', '--repo', 'o/r', '--version', 'next'], None)
                self.assertEqual(code, 1)
                self.assertIn('::error::', out)

    def test_a_request_writes_the_version_for_the_release_job(self):
        run = fake_gh(TAGS, {'main': 't1', 'v1.0.260': 't0'})
        code, written, summary, out = self.run_cli(['plan', '--repo', 'o/r'], run)
        self.assertEqual(code, 0)
        self.assertEqual((written['action'], written['version'], written['resume'], written['mode'],
                          written['main_sha']), ('release', '1.0.261', 'false', 'request', 'sha-main'))
        self.assertIn('1.0.261', summary)
        self.assertIn('::notice::', out)

    def test_a_released_main_ends_green_with_nothing_to_do(self):
        run = fake_gh(TAGS, {'main': 't0', 'v1.0.260': 't0'})
        code, written, _, out = self.run_cli(['plan', '--repo', 'o/r'], run)
        self.assertEqual((code, written['action']), (0, 'noop'))
        self.assertIn('already released as v1.0.260', out)

    def test_a_refusal_fails_the_job(self):
        run = fake_gh(TAGS, {})
        code, written, _, out = self.run_cli(['plan', '--repo', 'o/r', '--version', '1.0.260'], run)
        self.assertEqual((code, written['action']), (1, 'refuse'))
        self.assertIn('::error::', out)


if __name__ == '__main__':
    unittest.main()
