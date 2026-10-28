#!/usr/bin/env python3
"""Settings continuity across a service update: parsed values, not bytes.

Run: cd scripts/studio-fleet && python3 -B test-settings-continuity.py
"""
import json
import pathlib
import re
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import settings_continuity as continuity  # noqa: E402

REPO = HERE.parent.parent
P1, P2, P3 = 'project-1', 'project-2', 'project-3'
SECRET = 'sk-test-SHOULD-never-appear-0123456789'


def proof(value):
    return continuity.settings_proof(json.dumps(value, indent=2).encode())


def base():
    """Shaped like a fleet machine's settings.json (as of 1.0.29): app values, folded overrides."""
    return {'defaultRuntimeMode': 'full-access',
            'projectSettingsOverrides': {
                P1: {'defaultModelSelection': {'provider': 'claudeAgent', 'model': 'claude-opus-5-5'},
                     'defaultRuntimeMode': 'approval-required', 'providerLimitAction': 'switch'},
                P2: {'defaultRuntimeMode': 'approval-required', 'providerLimitAction': 'ask'}},
            'projectSettingsFolded': True, 'autoResumeLimitedThreads': True, 'branchNamePrefix': 'anton',
            'providers': {'codex': {'binaryPath': '/opt/homebrew/bin/codex', 'setupMode': 'existing'},
                          'cursor': {'enabled': False}},
            'providerInstances': {'copilot': {'driver': 'acp', 'enabled': True, 'environment': [{'name': 'A', 'value': SECRET}]}},
            'bitbucket': {'accessToken': SECRET}}


def changed(value, *edits):
    value = json.loads(json.dumps(value))
    for edit in edits:
        edit(value)
    return value


def simplified(value):
    value['projectSettingsSimplified'] = True


def check(before, after):
    return continuity.assert_settings_preserved(proof(before), proof(after))


class Proof(unittest.TestCase):
    def test_proof_holds_key_paths_and_hashes_never_values(self):
        value = proof(base())
        text = json.dumps(value)
        self.assertNotIn(SECRET, text)
        self.assertNotIn('claude-opus-5-5', text)
        self.assertNotIn('/opt/homebrew', text)
        self.assertIn('/projectSettingsOverrides/project-1/defaultModelSelection/model', value)
        self.assertTrue(all(re.fullmatch(r'[ov]:[0-9a-f]{64}', node) for node in value.values()))

    def test_pointers_escape_slashes_and_tildes(self):
        value = continuity.settings_proof(b'{"github":{"tokens":{"a/b~c":"x"}}}')
        self.assertIn('/github/tokens/a~1b~0c', value)
        self.assertEqual(continuity.split('/github/tokens/a~1b~0c'), ['github', 'tokens', 'a/b~c'])

    def test_unreadable_or_non_object_settings_have_no_proof(self):
        for data in (b'', b'not json', b'[1, 2]', b'"text"', b'{"x": NaN}', b'\xff\xfe'):
            with self.subTest(data=data):
                self.assertIsNone(continuity.settings_proof(data))

    def test_formatting_key_order_and_integral_floats_are_the_same_settings(self):
        one = continuity.settings_proof(b'{"a": 1, "b": {"c": [1, 2], "d": true}}')
        two = continuity.settings_proof(b'{\n  "b": {"d": true, "c": [1.0, 2]},\n  "a": 1.0\n}\n')
        self.assertEqual(one, two)
        self.assertNotEqual(one, continuity.settings_proof(b'{"a": 1, "b": {"c": [2, 1], "d": true}}'))


class Preservation(unittest.TestCase):
    def test_identical_settings_are_preserved(self):
        self.assertEqual(check(base(), base())['changedValues'], 0)

    def test_keys_a_new_release_adds_are_allowed(self):
        report = check(base(), changed(base(), lambda v: v.update(newSetting={'enabled': True})))
        self.assertEqual((report['changedValues'], report['addedValues'], report['migrations']), (0, 1, {}))

    def test_the_1_0_30_marker_rewrite_seen_on_m4_is_preserved(self):
        # Reproduced on M4: 1.0.33 started on a 1.0.19 settings.json adds only the marker.
        report = check(base(), changed(base(), simplified))
        self.assertEqual(report['migrations'], {'project-settings-simplified': {'droppedOverrides': 0, 'keys': []}})

    def test_a_changed_or_disappeared_user_value_fails_naming_only_its_key_path(self):
        cases = [(lambda v: v.update(branchNamePrefix='other'), '/branchNamePrefix'),
                 (lambda v: v.pop('autoResumeLimitedThreads'), '/autoResumeLimitedThreads'),
                 (lambda v: v['providers']['codex'].update(binaryPath='/usr/bin/codex'), '/providers/codex/binaryPath'),
                 (lambda v: v['providerInstances']['copilot']['environment'][0].update(value='other'),
                  '/providerInstances/copilot/environment'),
                 (lambda v: v['projectSettingsOverrides'][P2].update(providerLimitAction='wait'),
                  '/projectSettingsOverrides/project-2/providerLimitAction'),
                 (lambda v: v['projectSettingsOverrides'][P1].pop('defaultRuntimeMode'),
                  '/projectSettingsOverrides/project-1/defaultRuntimeMode'),
                 (lambda v: v.update(projectSettingsFolded=False), '/projectSettingsFolded'),
                 (lambda v: v['providers'].pop('cursor'), '/providers/cursor/enabled')]
        for edit, path in cases:
            for marker in ((), (simplified,)):
                with self.subTest(path=path, marker=bool(marker)):
                    with self.assertRaises(AssertionError) as raised:
                        check(base(), changed(base(), edit, *marker))
                    self.assertIn(path, str(raised.exception))
                    self.assertNotIn(SECRET, str(raised.exception))
                    self.assertNotIn('/usr/bin/codex', str(raised.exception))

    def test_a_malformed_proof_is_refused(self):
        for before, after in (({}, proof(base())), (proof(base()), {'': 'x:1'}), (None, proof(base()))):
            with self.subTest(before=before, after=after), self.assertRaisesRegex(AssertionError, 'malformed'):
                continuity.assert_settings_preserved(before, after)


class ProjectSettingsSimplified(unittest.TestCase):
    """simplifyProjectSettingsOverrides (1.0.30), applied once with its marker."""

    def test_overrides_equal_to_the_app_value_are_dropped(self):
        def drop(v):
            v['projectSettingsOverrides'][P2]['defaultRuntimeMode'] = 'full-access'
        before = changed(base(), drop)
        after = changed(before, simplified, lambda v: v['projectSettingsOverrides'][P2].pop('defaultRuntimeMode'))
        report = check(before, after)
        self.assertEqual(report['migrations']['project-settings-simplified'],
                         {'droppedOverrides': 1, 'keys': ['defaultRuntimeMode']})

    def test_an_override_equal_to_a_default_app_value_is_dropped_and_its_entry_with_it(self):
        # The app value is the release default, so the file stores none; the override goes.
        before = changed(base(), lambda v: v['projectSettingsOverrides'].update({P3: {'threadFinishAction': 'pull_request'}}))
        after = changed(before, simplified, lambda v: v['projectSettingsOverrides'].pop(P3))
        self.assertEqual(check(before, after)['migrations']['project-settings-simplified']['droppedOverrides'], 1)

    def test_a_value_every_project_shared_becomes_the_app_value(self):
        def same(v):
            v['projectSettingsOverrides'][P1]['providerLimitAction'] = 'ask'
        before = changed(base(), same, lambda v: v.update(providerLimitAction='switch'))
        def promote(v):
            v['providerLimitAction'] = 'ask'
            for project in (P1, P2):
                v['projectSettingsOverrides'][project].pop('providerLimitAction')
        report = check(before, changed(before, simplified, promote))
        self.assertEqual(report['migrations']['project-settings-simplified']['keys'], ['providerLimitAction'])

    def test_a_shared_model_becomes_the_app_value_stored_without_its_default_parts(self):
        model = {'provider': 'codex', 'model': 'gpt-5.5-codex'}
        def same(v):
            v['projectSettingsOverrides'][P1]['defaultModelSelection'] = dict(model)
            v['projectSettingsOverrides'][P2]['defaultModelSelection'] = dict(model)
        before = changed(base(), same, lambda v: v.update(defaultModelSelection={'provider': 'claudeAgent', 'model': 'x'}))
        def promote(v):
            v['defaultModelSelection'] = {'model': 'gpt-5.5-codex'}  # provider equals the default
            for project in (P1, P2):
                v['projectSettingsOverrides'][project].pop('defaultModelSelection')
        check(before, changed(before, simplified, promote))
        def promote_elsewhere(v):
            promote(v)
            v['defaultModelSelection'] = {'model': 'another-model'}
        with self.assertRaisesRegex(AssertionError, '/defaultModelSelection/'):
            check(before, changed(before, simplified, promote_elsewhere))

    def test_an_override_unlike_the_stored_app_value_must_stay(self):
        # project-2 overrides approval-required while the app value is full-access.
        after = changed(base(), simplified, lambda v: v['projectSettingsOverrides'][P2].pop('defaultRuntimeMode'))
        with self.assertRaisesRegex(AssertionError, '/projectSettingsOverrides/project-2/defaultRuntimeMode'):
            check(base(), after)

    def test_disagreeing_dropped_overrides_or_an_unrelated_app_change_fail(self):
        def drop_both(v):
            v['projectSettingsOverrides'][P1].pop('providerLimitAction')
            v['projectSettingsOverrides'][P2].pop('providerLimitAction')
        with self.assertRaisesRegex(AssertionError, 'providerLimitAction'):
            check(base(), changed(base(), simplified, drop_both))  # 'switch' and 'ask' disagree
        with self.assertRaisesRegex(AssertionError, '/defaultRuntimeMode'):
            check(base(), changed(base(), simplified, lambda v: v.update(defaultRuntimeMode='approval-required')))

    def test_against_a_default_app_value_only_the_migration_update_may_drop_an_override(self):
        # Neither file stores the app model (it is the release default), so the drop is taken on
        # the migration's rule, and only in the update that adds the marker.
        drop = lambda v: v['projectSettingsOverrides'][P1].pop('defaultModelSelection')
        check(base(), changed(base(), simplified, drop))
        with self.assertRaisesRegex(AssertionError, '/projectSettingsOverrides/project-1/defaultModelSelection/model'):
            check(base(), changed(base(), drop))

    def test_an_override_value_cannot_drop_for_one_project_and_stay_for_another(self):
        same = lambda v: v['projectSettingsOverrides'][P1].update(providerLimitAction='ask')
        before = changed(base(), same)
        after = changed(before, simplified, lambda v: v['projectSettingsOverrides'][P1].pop('providerLimitAction'))
        with self.assertRaisesRegex(AssertionError, '/projectSettingsOverrides/project-1/providerLimitAction'):
            check(before, after)

    def test_without_adding_the_marker_no_override_may_drop(self):
        drop = lambda v: v['projectSettingsOverrides'][P2].pop('defaultRuntimeMode')
        before = changed(base(), lambda v: v['projectSettingsOverrides'][P2].update(defaultRuntimeMode='full-access'))
        with self.assertRaises(AssertionError):
            check(before, changed(before, drop))  # no marker
        with self.assertRaises(AssertionError):
            check(changed(before, simplified), changed(before, simplified, drop))  # marker already there

    def test_legacy_project_maps_follow_the_remaining_overrides(self):
        def legacy(v):
            v['defaultAutoPull'] = True
            v['projectSettingsOverrides'][P2]['defaultAutoPull'] = True
            v['projectAutoPullOverrides'] = {P2: True}
        before = changed(base(), legacy)
        def drop(v):
            v['projectSettingsOverrides'][P2].pop('defaultAutoPull')
            v.pop('projectAutoPullOverrides')
        check(before, changed(before, simplified, drop))
        with self.assertRaisesRegex(AssertionError, '/projectAutoPullOverrides/project-2'):
            check(before, changed(before, simplified, lambda v: v.pop('projectAutoPullOverrides')))


class MachineLocalWorktreeStorage(unittest.TestCase):
    def test_distinct_machine_local_project_paths_are_preserved(self):
        before = {'worktreeLocationMode': 'managed', 'worktreesDirectory': '',
                  'projectSettingsSimplified': True,
                  'projectSettingsOverrides': {
                      P1: {'worktreeLocationMode': 'custom', 'worktreesDirectory': '/Volumes/builds/one'},
                      P2: {'worktreeLocationMode': 'custom', 'worktreesDirectory': '/Volumes/builds/two'}}}
        self.assertEqual(check(before, json.loads(json.dumps(before)))['result'], 'preserved')
        for key, value in (('worktreeLocationMode', 'managed'),
                           ('worktreesDirectory', '/another-machine/worktrees')):
            with self.subTest(key=key), self.assertRaisesRegex(AssertionError, key):
                check(before, changed(before, lambda v: v['projectSettingsOverrides'][P1].update({key: value})))
            with self.subTest(dropped=key), self.assertRaisesRegex(AssertionError, key):
                check(before, changed(before, lambda v: v['projectSettingsOverrides'][P1].pop(key)))

    def test_first_simplification_only_drops_storage_equal_to_the_local_app_value(self):
        before = {'worktreeLocationMode': 'custom', 'worktreesDirectory': '/Volumes/builds/shared',
                  'projectSettingsOverrides': {
                      P1: {'worktreeLocationMode': 'custom', 'worktreesDirectory': '/Volumes/builds/shared'}}}
        after = changed(before, simplified, lambda v: v['projectSettingsOverrides'].pop(P1))
        self.assertEqual(check(before, after)['migrations']['project-settings-simplified']['keys'],
                         ['worktreeLocationMode', 'worktreesDirectory'])
        different = changed(before, lambda v: v['projectSettingsOverrides'][P1].update(
            worktreesDirectory='/Volumes/builds/project'))
        with self.assertRaisesRegex(AssertionError, 'worktreesDirectory'):
            check(different, changed(different, simplified, lambda v: v['projectSettingsOverrides'].pop(P1)))

    def test_storage_has_no_general_migration_exception(self):
        before = {'worktreeLocationMode': 'custom', 'worktreesDirectory': '/Volumes/builds/local'}
        for edits in ((), (simplified,)):
            with self.subTest(marker=bool(edits)), self.assertRaisesRegex(AssertionError, 'worktreesDirectory'):
                check(before, changed(before, lambda v: v.update(worktreesDirectory='/peer/worktrees'), *edits))

    def test_an_absent_app_value_cannot_explain_losing_an_explicit_path_or_mode(self):
        for key, value in (('worktreesDirectory', '/Volumes/builds/project'),
                           ('worktreeLocationMode', 'custom')):
            before = {'projectSettingsOverrides': {P1: {key: value}}}
            with self.subTest(key=key), self.assertRaisesRegex(AssertionError, key):
                check(before, changed(before, simplified, lambda v: v['projectSettingsOverrides'].pop(P1)))
        before = {'projectSettingsOverrides': {P1: {'worktreesDirectory': ''}}}
        self.assertEqual(check(before, changed(before, simplified,
                         lambda v: v['projectSettingsOverrides'].pop(P1)))['result'], 'preserved')


class SecretMovedToStore(unittest.TestCase):
    def test_typed_in_tokens_may_become_the_redaction_placeholder(self):
        before = changed(base(), lambda v: v.update(github={'tokens': {'github.com': SECRET}}))
        def move(v):
            v['bitbucket']['accessToken'] = continuity.SECRET_REDACTED
            v['github']['tokens']['github.com'] = continuity.SECRET_REDACTED
        report = check(before, changed(before, move))
        self.assertEqual(report['migrations'], {'secret-moved-to-store': {'values': 2}})

    def test_no_other_value_may_become_the_placeholder(self):
        after = changed(base(), lambda v: v.update(branchNamePrefix=continuity.SECRET_REDACTED))
        with self.assertRaisesRegex(AssertionError, '/branchNamePrefix'):
            check(base(), after)


class SourceOfTruth(unittest.TestCase):
    """The documented constants match the server sources they mirror (skipped outside the repo)."""

    def source(self, relative):
        path = REPO / relative
        if not path.is_file():
            self.skipTest('repository sources are not beside the helpers')
        return path.read_text()

    def test_project_scoped_keys_match_the_contracts(self):
        text = self.source('packages/contracts/src/settings.ts')
        block = re.search(r'PROJECT_SCOPED_SERVER_SETTING_KEYS = \[(.*?)\] as const', text, re.S).group(1)
        self.assertEqual(set(re.findall(r'"([A-Za-z]+)"', block)), set(continuity.PROJECT_SCOPED_KEYS))
        self.assertIn('projectSettingsSimplified:', text)

    def test_secret_and_legacy_names_match_the_server(self):
        contracts = self.source('packages/contracts/src/settings.ts')
        self.assertIn('export const REDACTED_SECRET_MARKER = "%s";' % continuity.SECRET_REDACTED, contracts)
        server = self.source('apps/server/src/serverSettings.ts')
        self.assertIn('const SECRET_REDACTED = REDACTED_SECRET_MARKER;', server)
        self.assertIn('const BITBUCKET_SECRET_FIELDS = ["accessToken", "apiToken"] as const;', server)
        shared = self.source('packages/shared/src/serverSettings.ts')
        for legacy, key in continuity.LEGACY_PROJECT_MAPS.items():
            self.assertRegex(shared, r'%s\[projectId\] = entry\.%s;' % (legacy, key))


if __name__ == '__main__':
    unittest.main()
