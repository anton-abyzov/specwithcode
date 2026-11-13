#!/usr/bin/env python3
"""Tests for release_train.py: python3 -B scripts/release/test-release-train.py"""
import datetime
import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import release_train  # noqa: E402

NOW = datetime.datetime(2026, 11, 20, 15, 0, tzinfo=datetime.timezone.utc)
ALL = list(release_train.MANIFESTS)


def at(hours_ago):
    return release_train.iso(NOW - datetime.timedelta(hours=hours_ago))


def release(version, hours_ago, prerelease=True, assets=ALL, body='', draft=False):
    return {'tag_name': f'v{version}', 'prerelease': prerelease, 'draft': draft,
            'published_at': at(hours_ago), 'body': body,
            'assets': [{'name': name} for name in assets]}


def stable(version, hours_ago=100, promoted=None):
    body = f'<!-- release-train: promoted {at(promoted)} -->\n' if promoted is not None else ''
    return release(version, hours_ago, prerelease=False, body=body)


class Decide(unittest.TestCase):
    def test_promotes_the_newest_build_that_soaked(self):
        releases = [release('1.1.3', 2), release('1.1.2', 30), release('1.1.1', 40), stable('1.1.0', 80, 60)]
        result = release_train.decide(releases, NOW)
        self.assertEqual((result['action'], result['version']), ('promote', '1.1.2'))
        self.assertEqual(result['included'], ['1.1.2', '1.1.1'])

    def test_nothing_soaked_is_a_green_noop(self):
        result = release_train.decide([release('1.1.3', 2), stable('1.1.0', 80, 60)], NOW)
        self.assertEqual(result['action'], 'noop')
        self.assertIn('soaking', result['reason'])

    def test_one_promotion_a_day(self):
        releases = [release('1.1.2', 30), stable('1.1.1', 50, promoted=5)]
        self.assertEqual(release_train.decide(releases, NOW)['action'], 'noop')

    def test_held_and_incomplete_builds_are_skipped(self):
        held = '<!-- release-train: hold: breaks login -->\n**Held from stable:** breaks login\n'
        releases = [release('1.1.3', 30, body=held), release('1.1.2', 30, assets=['latest-mac.yml']),
                    release('1.1.1', 40), stable('1.1.0', 80, 60)]
        result = release_train.decide(releases, NOW)
        self.assertEqual(result['version'], '1.1.1')

    def test_1_0_builds_never_ride_the_train(self):
        releases = [release('1.0.280', 40), stable('1.0.276')]
        self.assertEqual(release_train.decide(releases, NOW)['action'], 'noop')

    def test_first_promotion_of_1_1_0_over_the_frozen_1_0_line(self):
        releases = [release('1.1.0', 30), stable('1.0.276')]
        result = release_train.decide(releases, NOW)
        self.assertEqual((result['action'], result['version']), ('promote', '1.1.0'))
        notes = release_train.stable_notes('1.1.0', releases[0], releases, result['included'], NOW)
        self.assertIn('first stable release', notes)
        self.assertIn('frozen at 1.0.276', notes)

    def test_a_named_version_still_needs_its_soak(self):
        releases = [release('1.1.3', 2), release('1.1.2', 30), stable('1.1.0', 80, 60)]
        self.assertEqual(release_train.decide(releases, NOW, requested='1.1.3')['action'], 'refuse')
        self.assertEqual(release_train.decide(releases, NOW, requested='1.1.2')['version'], '1.1.2')
        self.assertEqual(release_train.decide(releases, NOW, requested='1.1.0')['action'], 'refuse')

    def hotfix(self, merged=True, labels=('hotfix',), contains=('1.1.3',)):
        return {'number': 42, 'merged': merged, 'labels': list(labels), 'contains': set(contains)}

    def test_a_labelled_hotfix_skips_soak_and_interval(self):
        releases = [release('1.1.3', 1), release('1.1.2', 30), stable('1.1.1', 50, promoted=2)]
        result = release_train.decide(releases, NOW, hotfix=self.hotfix())
        self.assertEqual((result['action'], result['version']), ('promote', '1.1.3'))

    def test_an_unlabelled_or_unmerged_hotfix_is_refused(self):
        releases = [release('1.1.3', 1), stable('1.1.1', 50, 30)]
        for hotfix in (self.hotfix(labels=()), self.hotfix(merged=False)):
            self.assertEqual(release_train.decide(releases, NOW, hotfix=hotfix)['action'], 'refuse')

    def test_a_hotfix_waits_for_a_build_that_holds_it(self):
        releases = [release('1.1.3', 1), stable('1.1.1', 50, 30)]
        result = release_train.decide(releases, NOW, hotfix=self.hotfix(contains=()))
        self.assertEqual(result['action'], 'refuse')
        self.assertIn('request a release first', result['reason'])


class Commands(unittest.TestCase):
    def fake(self, releases, pull=None):
        calls = []

        def run(*args, stdin=None):
            calls.append(args)
            if args[:2] == ('api', '--paginate'):
                return json.dumps([releases])
            if args[0] == 'api' and '/pulls/' in args[1]:
                return json.dumps(pull)
            if args[0] == 'api' and '/compare/' in args[1]:
                return 'ahead\n'
            if args[:2] == ('release', 'view'):
                return json.dumps({'isPrerelease': False, 'isDraft': False})
            return ''
        return run, calls

    def test_promote_edits_the_release_to_stable_latest(self):
        run, calls = self.fake([release('1.1.2', 30), stable('1.1.0', 80, 60)])
        self.assertEqual(release_train.main(['promote', '--repo', 'o/r'], run=run, now=NOW), 0)
        edit = [call for call in calls if call[:2] == ('release', 'edit')]
        self.assertEqual(len(edit), 1)
        self.assertIn('--prerelease=false', edit[0])
        self.assertIn('--latest', edit[0])

    def test_dry_run_and_noop_edit_nothing(self):
        run, calls = self.fake([release('1.1.2', 30), stable('1.1.0', 80, 60)])
        self.assertEqual(release_train.main(['promote', '--repo', 'o/r', '--dry-run'], run=run, now=NOW), 0)
        run2, calls2 = self.fake([release('1.1.2', 3), stable('1.1.0', 80, 60)])
        self.assertEqual(release_train.main(['promote', '--repo', 'o/r'], run=run2, now=NOW), 0)
        self.assertFalse([call for call in calls + calls2 if call[:2] == ('release', 'edit')])

    def test_hotfix_reads_the_pull_request(self):
        pull = {'merged': True, 'merge_commit_sha': 'a' * 40, 'labels': [{'name': 'hotfix'}]}
        run, calls = self.fake([release('1.1.3', 1), stable('1.1.1', 50, 2)], pull)
        self.assertEqual(release_train.main(['promote', '--repo', 'o/r', '--hotfix-pr', '42'], run=run, now=NOW), 0)
        self.assertTrue([call for call in calls if call[:2] == ('release', 'edit')])

    def test_hold_and_unhold_mark_the_release_body(self):
        run, calls = self.fake([release('1.1.2', 30, body='notes')])
        bodies = []
        real = release_train.edit_body

        def capture(repo, version, body, *flags, run=None):
            bodies.append(body)
        release_train.edit_body = capture
        try:
            self.assertEqual(release_train.main(['hold', '--repo', 'o/r', '--version', '1.1.2', '--reason',
                                                 'breaks -->login'], run=run, now=NOW), 0)
        finally:
            release_train.edit_body = real
        self.assertEqual(release_train.held({'body': bodies[0]}), 'breaks login')
        self.assertTrue(bodies[0].rstrip().endswith('notes'))
        self.assertIsNone(release_train.held({'body': release_train.HOLD_RE.sub('', bodies[0])}))

    def test_bad_versions_are_refused(self):
        run, _ = self.fake([])
        self.assertEqual(release_train.main(['promote', '--repo', 'o/r', '--version', '1.1'], run=run, now=NOW), 2)


if __name__ == '__main__':
    unittest.main()
