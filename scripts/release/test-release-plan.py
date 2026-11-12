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
import time
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

    def test_a_version_is_refused_while_the_newest_release_owes_main_its_merge(self):
        result = decide('1.0.261', merged=False)
        self.assertEqual(result['action'], 'refuse')
        self.assertIn('v1.0.260 is published but not merged', result['reason'])
        self.assertEqual(decide('1.0.260', resume=True, merged=False)['action'], 'release')

    def test_resume_continues_even_a_tagged_version(self):
        for version in ('1.0.260', '1.0.261'):
            result = decide(version, resume=True)
            self.assertEqual((result['action'], result['version'], result['resume']),
                             ('release', version, True))

    def test_a_malformed_version_is_refused(self):
        for version in ('v1.0.261', '1.0', '2.0.0', '1.0.261-rc1', '1.0.261; rm -rf /', '1.0.0261'):
            self.assertEqual(decide(version, resume=True)['action'], 'refuse', version)
            self.assertEqual(decide(version)['action'], 'refuse', version)

    def test_a_refusal_never_carries_a_second_line(self):
        reason = decide('1.0.261\naction=release\nversion=9.9.9')['reason']
        with tempfile.TemporaryDirectory() as tmp:
            output = os.path.join(tmp, 'output')
            with mock.patch.dict(os.environ, {'GITHUB_OUTPUT': output}):
                release_plan.write_output([('action', 'refuse'), ('reason', reason),
                                           ('note', 'one\r\ntwo')])
            lines = pathlib.Path(output).read_text().splitlines()
        self.assertEqual([line.split('=', 1)[0] for line in lines], ['action', 'reason', 'note'])
        self.assertEqual(lines[2], 'note=one two')


def fake_gh(tags, trees, compare='behind', prs='', branch=True, mergeable=()):
    """prs: the states of release/<latest>'s pull requests. branch: whether that branch exists.
    mergeable: what each look at its open pull request (#253) answers, the last one repeated."""
    calls, looks = [], list(mergeable)

    def run(*args):
        calls.append(args)
        path = args[-3] if args[0] == 'api' else ''
        if 'matching-refs/tags' in path:
            return ''.join(f'refs/tags/v{tag}\n' for tag in tags) + 'refs/tags/v1.0.5-rc1\n'
        if 'matching-refs/heads/release/' in path:
            name = path.split('matching-refs/', 1)[1]
            return f'refs/{name}\nrefs/{name}-old\n' if branch else f'refs/{name}-old\n'
        if '/commits/' in path:
            ref = path.rsplit('/', 1)[1]
            return f'sha-{ref}\n{trees[ref]}\n'
        if '/compare/' in path:
            return compare + '\n'
        if args[:2] == ('pr', 'list') and 'all' in args:
            return prs + '\n'
        if args[:2] == ('pr', 'list') and 'open' in args:
            if not looks:
                return '\n'
            return f'253 {looks.pop(0) if len(looks) > 1 else looks[0]}\n'
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

    def test_a_given_version_still_reads_whether_the_latest_release_merged(self):
        run = fake_gh(TAGS, {}, compare='diverged', prs='OPEN')
        facts = release_plan.gather('o/r', 'main', '1.0.261', run)
        self.assertFalse(facts['latest_merged'])
        plan = release_plan.decide('1.0.261', False, facts['tags'], '', '', facts['latest_merged'])
        self.assertEqual(plan['action'], 'refuse')
        # Nothing but the tags is read for a version that will be refused by its shape.
        run = fake_gh(TAGS, {})
        release_plan.gather('o/r', 'main', 'v1.0.261\naction=release', run)
        self.assertEqual(len(run.calls), 1)

    def merged(self, **state):
        run = fake_gh(TAGS, {'main': 't1', 'v1.0.260': 't0'}, compare='diverged', **state)
        return release_plan.gather('o/r', 'main', '', run)['latest_merged']

    def test_a_squash_merged_release_counts_as_merged(self):
        self.assertTrue(self.merged(prs='CLOSED MERGED'))

    def test_an_open_or_never_opened_merge_back_is_owed(self):
        self.assertFalse(self.merged(prs='OPEN'))
        self.assertFalse(self.merged(prs='CLOSED OPEN'))
        # Published, then the run died before its merge stage opened the pull request.
        self.assertFalse(self.merged(prs='', branch=True))

    def test_a_release_given_up_or_tagged_by_hand_owes_nothing(self):
        self.assertTrue(self.merged(prs='CLOSED'))
        self.assertTrue(self.merged(prs='', branch=False))

    def conflict(self, *mergeable):
        run = fake_gh(TAGS, {'main': 't1', 'v1.0.260': 't0'}, compare='diverged', prs='OPEN',
                      mergeable=mergeable)
        with mock.patch.object(release_plan.time, 'sleep') as sleep:
            return release_plan.gather('o/r', 'main', '', run)['conflict'], sleep.call_count

    def test_a_conflicting_merge_back_is_reported_with_its_number(self):
        self.assertEqual(self.conflict('CONFLICTING'), (253, 0))
        self.assertEqual(self.conflict('MERGEABLE'), (0, 0))
        self.assertEqual(self.conflict(), (0, 0))

    def test_mergeability_still_being_worked_out_is_asked_again(self):
        self.assertEqual(self.conflict('UNKNOWN', 'UNKNOWN', 'CONFLICTING'), (253, 2))
        # One that never settles is left to release.sh's merge stage.
        self.assertEqual(self.conflict('UNKNOWN'), (0, 4))


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
        # The mark outlives a continued run that fails; one that works clears it.
        self.assertEqual(self.attempt()[0], 'refuse')
        release_plan.hold(VERSION, '', self.staging)
        self.assertFalse((self.stage / 'held').exists())
        release_plan.hold('1.0.300', '', self.staging)

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

    def test_resume_with_nothing_on_this_mac_says_what_to_do(self):
        (self.stage / 'release.json').unlink()
        how, why = self.attempt(resume=True)
        self.assertEqual(how, 'refuse')
        self.assertIn(f'merge release/{VERSION} into main', why)

    def test_the_candidate_is_the_build_trees_head_not_the_branch(self):
        # release.sh reads HEAD: with the build tree elsewhere, the branch says nothing.
        git(self.build, 'checkout', '-q', '--detach')
        self.commit(self.origin, 'main moved')
        self.assertEqual(self.attempt()[0], 'resume')
        self.assertTrue(self.stage.is_dir())

    def server(self, *command):
        proc = subprocess.Popen(command, start_new_session=True)
        self.addCleanup(proc.wait)
        self.addCleanup(lambda: proc.poll() is None and os.killpg(proc.pid, 9))
        (self.stage / 'server.pid').write_text(f'{proc.pid}\n')
        for _ in range(50):
            if 'sleep' in subprocess.run(['ps', '-o', 'command=', '-p', str(proc.pid)],
                                         capture_output=True, text=True).stdout:
                break
            time.sleep(0.1)
        return proc

    def test_starting_over_stops_the_earlier_attempts_server_suite(self):
        proc = self.server('sh', '-c', f'exec -a "release.sh --internal-server {VERSION}" sleep 60')
        self.commit(self.origin, 'main moved')
        self.assertEqual(self.attempt()[0], 'fresh')
        self.assertIsNotNone(proc.wait(timeout=5))

    def test_starting_over_waits_for_the_whole_group_not_only_its_leader(self):
        # The leader goes at once on TERM; a runner in its group closes later.
        proc = self.server('sh', '-c', f"(trap '' TERM; sleep 2) & exec -a 'release.sh --internal-server {VERSION}' sleep 60")
        self.commit(self.origin, 'main moved')
        began = time.monotonic()
        self.assertEqual(self.attempt()[0], 'fresh')
        self.assertGreater(time.monotonic() - began, 1.0)
        self.assertIsNotNone(proc.wait(timeout=5))

    def test_a_pid_that_is_not_this_versions_server_suite_is_left_alone(self):
        proc = self.server('sleep', '60')
        self.commit(self.origin, 'main moved')
        self.assertEqual(self.attempt()[0], 'fresh')
        self.assertIsNone(proc.poll())

    def test_a_server_suite_that_will_not_stop_keeps_the_attempt(self):
        self.commit(self.origin, 'main moved')
        with mock.patch.object(release_plan, 'stop_server', return_value=False):
            how, why = self.attempt()
        self.assertEqual(how, 'refuse')
        self.assertIn('server suite', why)
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
                code, _, _, out = self.run_cli(
                    ['attempt', '--repo', 'o/r', '--version', VERSION, '--resume'], None)
                self.assertEqual(code, 1)
                self.assertIn('nothing of', out)
                stage = pathlib.Path(env['RELEASE_STAGING_ROOT'], VERSION)
                stage.mkdir(parents=True)
                (stage / 'release.json').write_text('{}')
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


GH_STUB = r'''#!/bin/bash
# Tags v1.0.1 to v1.0.20; a commit is in every release from v1.0.$GH_FIRST on.
printf '%s\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  "api --paginate") for patch in $(seq 20 -1 1); do echo "refs/tags/v1.0.$patch"; done; echo refs/tags/v1.0.5-rc1 ;;
  "api repos/"*/commits/*) echo sha ;;
  "api repos/"*)
    version="${2#*compare/v}" version="${version%%...*}"
    if [ "${version##*.}" = "${GH_BROKEN:-}" ]; then echo "HTTP 502" >&2; exit 1; fi
    if [ "${version##*.}" -ge "$GH_FIRST" ]; then echo behind; else echo ahead; fi ;;
  "workflow run") ;;
  "run list")
    label="$(sed -n 's/.*requested_by=//p' "$GH_LOG" | tail -1)"
    case "$*" in *"endswith(\"$label\")"*) echo 777 ;; esac ;;
  *) exit 1 ;;
esac
'''


class RequestHelper(unittest.TestCase):
    """request-release.sh, with gh replaced by a stub on PATH."""

    def run_helper(self, *args, first=7, broken=''):
        with tempfile.TemporaryDirectory() as tmp:
            stub, log = pathlib.Path(tmp, 'gh'), pathlib.Path(tmp, 'log')
            stub.write_text(GH_STUB)
            stub.chmod(0o755)
            log.touch()
            env = dict(os.environ, PATH=f"{tmp}{os.pathsep}{os.environ['PATH']}", GH_LOG=str(log),
                       GH_FIRST=str(first), GH_BROKEN=broken, RELEASE_REPO='o/r')
            done = subprocess.run(['bash', str(HERE / 'request-release.sh'), *args],
                                  capture_output=True, text=True, env=env, check=False)
            return done.returncode, done.stdout + done.stderr, log.read_text().splitlines()

    def test_released_names_the_first_release_that_holds_the_commit(self):
        for first in (1, 7, 20):
            code, said, calls = self.run_helper('--released', 'abc1234', first=first)
            self.assertEqual((code, said.strip()), (0, f'abc1234 is released in v1.0.{first}'))
            # A search, not a walk over every tag.
            self.assertLessEqual(sum('compare' in call for call in calls), 6)

    def test_released_exits_2_while_no_release_holds_it(self):
        code, said, _ = self.run_helper('--released', 'abc1234', first=99)
        self.assertEqual(code, 2)
        self.assertIn('not in a release yet (newest: v1.0.20)', said)
        self.assertEqual(self.run_helper('--released', 'main')[0], 1)

    def test_released_never_takes_a_failed_lookup_for_an_answer(self):
        # v1.0.20 is the first tag asked about, v1.0.10 the first inside the search.
        for broken in ('20', '10'):
            code, said, _ = self.run_helper('--released', 'abc1234', broken=broken)
            self.assertEqual(code, 1, said)
            self.assertIn(f'cannot compare abc1234 with v1.0.{broken}', said)

    def test_a_request_dispatches_without_a_version_and_finds_its_run(self):
        code, said, calls = self.run_helper('--by', 'thread "x"; $(id) \\')
        self.assertEqual(code, 0, said)
        self.assertIn('run 777', said)
        dispatch = [call for call in calls if call.startswith('workflow run')]
        self.assertEqual(len(dispatch), 1)
        self.assertNotIn('version=', dispatch[0])
        self.assertRegex(dispatch[0], r'requested_by=thread x id  \d{6}-\d+$')

    def test_help_prints_only_the_header(self):
        code, said, calls = self.run_helper('--help')
        self.assertEqual((code, calls), (0, []))
        self.assertIn('--released COMMIT', said)
        self.assertNotIn('set -euo', said)


if __name__ == '__main__':
    unittest.main()
