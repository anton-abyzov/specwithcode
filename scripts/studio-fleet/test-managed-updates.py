#!/usr/bin/env python3
"""Synthetic destination/auth/consent tests. No live service, credentials or network."""
import contextlib
import copy
import datetime
import importlib.util
import io
import json
import os
import pathlib
import plistlib
import sqlite3
import tempfile
import unittest
from unittest import mock

import managed_updates as managed
import update
import update_agent as agent

HERE = pathlib.Path(__file__).parent
spec = importlib.util.spec_from_file_location('descriptor_test_fixtures', HERE / 'test-installation-descriptor.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)


class ManagedConsent(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='studio managed consent ')
        self.addCleanup(temporary.cleanup)
        self.home = pathlib.Path(temporary.name).resolve()
        self.identity = 'lab-502'
        self.own = self.home / '.specwithcode' / self.identity
        self.state = self.own / 'userdata'
        self.state.mkdir(parents=True)
        self.environment = 'env-owned-502'
        (self.state / 'environment-id').write_text(self.environment + '\n')
        (self.home / '.specwithcode/install/releases').mkdir(parents=True)
        self.receipt = {'identity': self.identity, 'uid': 502, 'user': 'fixture-user',
                        'studioHome': str(self.own), 'stateDir': str(self.state), 'host': '127.0.0.1',
                        'port': 24319, 'cliWrapper': str(self.home / '.local/bin/specweave-studio-lab-502'),
                        'archiveSha256': 'a' * 64, 'sourceCommit': 'b' * 40, 'version': '1.0.17',
                        'webSessionPolicy': 'worker-relay',
                        'release': str(self.home / '.specwithcode/install/releases' / ('a' * 20)),
                        'service': {'installed': True, 'label': 'com.specweave.studio.lab-502', 'domain': 'gui/502'}}
        self.receipt_path = self.own / 'installation.json'
        self.receipt_path.write_text(json.dumps(self.receipt))
        self.database = self.state / 'statev2.sqlite'
        with sqlite3.connect(str(self.database)) as db:
            db.execute('CREATE TABLE auth_sessions (session_id TEXT PRIMARY KEY, subject TEXT, scopes TEXT, '
                       'issued_at TEXT, expires_at TEXT, revoked_at TEXT, client_label TEXT)')
        self.controller = {'sessionId': 'session-admin', 'subject': 'paired-client'}
        self.scopes = ['orchestration:read', 'environment:maintain', 'access:write']
        self.grant()
        self.updates = self.own / 'updates'
        self.consent_path = self.updates / 'managed-consent.json'
        script = self.home / '.specwithcode/install/updater/update_agent.py'
        script.parent.mkdir(); script.write_text('# synthetic agent')
        self.plist = self.home / 'Library/LaunchAgents/com.specweave.studio.lab-502.updater.plist'
        self.plist.parent.mkdir(parents=True)
        self.plist.write_bytes(plistlib.dumps({'Label': 'com.specweave.studio.lab-502.updater',
            'ProgramArguments': ['/usr/bin/python3', str(script), '--identity', self.identity],
            'WorkingDirectory': str(self.updates), 'StandardOutPath': str(self.updates / 'agent.log'),
            'StandardErrorPath': str(self.updates / 'agent.log')}))
        self.context = contextlib.ExitStack(); self.addCleanup(self.context.close)
        self.context.enter_context(fixtures.simulated_owner(self.home))
        self.context.enter_context(mock.patch.object(managed.sys, 'platform', 'darwin'))
        # A forgotten stub must never access a network or read real GitHub credentials.
        self.context.enter_context(mock.patch.object(agent.Agent, 'open_url', side_effect=AssertionError('Unexpected network')))
        self.context.enter_context(mock.patch.object(agent, 'find_gh_token', side_effect=AssertionError('Unexpected auth access')))
        # launchd as the stub reports it: never the real launchctl.
        self.launchd = {'loaded': True, 'disabled': False, 'calls': []}
        self.context.enter_context(mock.patch.object(agent.update_request, 'launchctl_run', self.fake_launchctl))

    def fake_launchctl(self, args, timeout=30):
        self.launchd['calls'].append(list(args))
        self.assertIn(args[0], ('print', 'print-disabled'), 'status must only read launchd')
        if args[0] == 'print-disabled':
            label = 'com.specweave.studio.lab-502.updater'
            return 0, 'disabled services = {\n\t"%s" => %s\n}\n' % (
                label, 'disabled' if self.launchd['disabled'] else 'enabled'), ''
        return (0, 'state = running\n', '') if self.launchd['loaded'] else (113, '', 'Could not find service')

    def grant(self, controller=None, scopes=None, **values):
        controller = controller or self.controller
        current = datetime.datetime.now(datetime.timezone.utc)
        fields = {'issued_at': (current - datetime.timedelta(hours=1)).isoformat(),
                  'expires_at': (current + datetime.timedelta(hours=1)).isoformat(), 'revoked_at': None}
        fields.update(values)
        with sqlite3.connect(str(self.database)) as db:
            db.execute('INSERT OR REPLACE INTO auth_sessions VALUES (?, ?, ?, ?, ?, ?, ?)',
                       (controller['sessionId'], controller['subject'], json.dumps(self.scopes if scopes is None else scopes),
                        fields['issued_at'], fields['expires_at'], fields['revoked_at'], 'Desktop owner ADMIN spoof'))

    def request(self, action='status', expected=0, controller=None):
        value = {'action': action, 'environmentId': self.environment,
                 'controller': controller or dict(self.controller)}
        if action != 'status':
            value['input'] = {'installationId': self.identity, 'environmentId': self.environment}
            if action != 'check': value['input']['expectedRevision'] = expected
            if action.startswith('enroll'): value['input']['consent'] = True
            if action.endswith('-local'):
                value['approval'] = {'kind': 'native-owner', 'confirmed': True, 'installationId': self.identity,
                                     'environmentId': self.environment, 'expectedRevision': expected}
        return value

    def run_request(self, action='status', expected=0, controller=None):
        return managed.execute(str(self.state), self.request(action, expected, controller))

    def assert_code(self, code, request):
        with self.assertRaises(managed.ManagedError) as caught:
            managed.execute(str(self.state), request)
        self.assertEqual(caught.exception.code, code)

    def saved(self):
        return json.loads(self.consent_path.read_text())

    def authorization(self, revision=1):
        return {'environmentId': self.environment, 'controller': dict(self.controller),
                'input': {'installationId': self.identity, 'environmentId': self.environment,
                          'expectedRevision': revision}}

    def test_status_is_read_only_and_has_contract_shape(self):
        before = sorted(str(path.relative_to(self.home)) for path in self.home.rglob('*'))
        value = self.run_request()
        self.assertEqual(value, {'environmentId': self.environment, 'installationId': self.identity,
                                'support': 'supported', 'localAutomation': 'enabled',
                                'remoteConsent': 'not-enrolled', 'revision': 0, 'operation': 'idle',
                                'currentVersion': '1.0.17', 'availableVersion': None, 'checkedAt': None,
                                'agentLoaded': True, 'agentDisabled': False, 'stale': False})
        self.assertEqual(before, sorted(str(path.relative_to(self.home)) for path in self.home.rglob('*')))
        self.assertEqual(self.launchd['calls'], [['print-disabled', 'gui/502'],
                                                 ['print', 'gui/502/com.specweave.studio.lab-502.updater']])

    def test_status_reports_a_disabled_unloaded_or_overdue_agent(self):
        self.launchd.update(loaded=False, disabled=True)
        value = self.run_request()
        self.assertEqual((value['agentLoaded'], value['agentDisabled'], value['stale']), (False, True, False))
        self.launchd.update(disabled=False)
        self.assertEqual((self.run_request()['agentLoaded'], self.run_request()['agentDisabled']), (False, False))
        self.launchd.update(loaded=True)
        self.updates.mkdir(mode=0o700)
        old = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=4)).isoformat()
        (self.updates / 'state.json').write_text(json.dumps({**agent.blank_state(), 'status': 'up-to-date',
                                                              'checkedAt': old}))
        value = self.run_request()
        self.assertEqual((value['operation'], value['checkedAt'], value['stale']), ('up-to-date', old, True))
        recent = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=90)).isoformat()
        (self.updates / 'state.json').write_text(json.dumps({**agent.blank_state(), 'checkedAt': recent}))
        self.assertFalse(self.run_request()['stale'])
        # Automatic checks off: an old check is expected, not a stopped agent.
        (self.updates / 'state.json').write_text(json.dumps({**agent.blank_state(), 'checkedAt': old}))
        (self.updates / 'config.json').write_text(json.dumps({**agent.DEFAULT_CONFIG, 'checkAutomatically': False}))
        self.assertFalse(self.run_request()['stale'])
        self.launchd['calls'].clear()
        with mock.patch.object(managed.sys, 'platform', 'linux'):
            value = self.run_request()
        self.assertEqual((value['agentLoaded'], value['agentDisabled'], value['stale']), (None, None, False))
        self.assertEqual(self.launchd['calls'], [])

    def test_enrollment_binds_uid502_service_environment_and_logical_origin(self):
        receipt = self.receipt_path.read_bytes(); database = self.database.read_bytes()
        value = self.run_request('enroll')
        self.assertEqual((value['revision'], value['remoteConsent']), (1, 'enrolled'))
        saved = self.saved()
        self.assertEqual(saved['binding']['uid'], 502)
        self.assertEqual(saved['binding']['origin'], 'specwithcode://environment/' + self.environment)
        self.assertEqual(saved['binding']['serviceDomain'], 'gui/502')
        self.assertEqual(saved['controller'], self.controller)
        self.assertEqual(self.consent_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(receipt, self.receipt_path.read_bytes())
        self.assertEqual(database, self.database.read_bytes())
        self.assertFalse((self.updates / 'config.json').exists())

    def test_standard_pairing_worker_or_one_missing_scope_cannot_enroll_or_revoke(self):
        for scopes in (['environment:maintain'], ['access:write'], ['orchestration:read'], [], ['server:write']):
            self.grant(scopes=scopes)
            for action in ('enroll', 'revoke'):
                with self.subTest(scopes=scopes, action=action):
                    self.assert_code('unauthorized', self.request(action))
        self.assertFalse(self.updates.exists())

    def test_grant_expiry_revocation_subject_and_future_issuance_are_authoritative(self):
        for fields in ({'expires_at': '2000-01-01T00:00:00Z'}, {'revoked_at': '2026-01-01T00:00:00Z'},
                       {'issued_at': '2100-01-01T00:00:00Z'}, {'expires_at': 'invalid'},
                       {'expires_at': '2100-01-01T00:00:00'}):
            self.grant(**fields)
            self.assert_code('unauthorized', self.request('enroll'))
        self.grant()
        spoof = self.request('enroll'); spoof['controller']['subject'] = 'administrator'
        self.assert_code('unauthorized', spoof)
        self.assertFalse(self.updates.exists())

    def test_arbitrary_payload_metadata_is_never_authority(self):
        for extra in ('uid', 'home', 'origin', 'scopes', 'client', 'role'):
            request = self.request('enroll'); request[extra] = 'trusted-admin'
            self.assert_code('binding-changed', request)
        self.assertFalse(self.updates.exists())

    def test_grant_is_reread_under_lock_after_precheck(self):
        original = managed.consent_lock
        @contextlib.contextmanager
        def revoke_before_lock(destination):
            self.grant(revoked_at='2026-01-01T00:00:00Z')
            with original(destination): yield
        with mock.patch.object(managed, 'consent_lock', revoke_before_lock):
            self.assert_code('unauthorized', self.request('enroll'))
        self.assertFalse(self.consent_path.exists())

    def test_revision_cas_reconnect_idempotence_and_revocation(self):
        self.run_request('enroll')
        first = self.consent_path.read_bytes()
        self.assert_code('conflict', self.request('enroll', 0))
        self.assertEqual(self.run_request('enroll', 1)['revision'], 1)
        self.assertEqual(first, self.consent_path.read_bytes())
        self.assertEqual(self.run_request()['remoteConsent'], 'enrolled')
        value = self.run_request('revoke', 1)
        self.assertEqual((value['revision'], value['remoteConsent']), (2, 'revoked'))
        revoked = self.consent_path.read_bytes()
        self.assert_code('revoked', self.request('check'))
        self.assert_code('conflict', self.request('enroll', 1))
        self.assertEqual(self.run_request('revoke', 2)['revision'], 2)
        self.assertEqual(revoked, self.consent_path.read_bytes())

    def test_another_controller_needs_explicit_fresh_admin_reapproval(self):
        self.run_request('enroll')
        other = {'sessionId': 'replacement', 'subject': self.controller['subject']}
        self.grant(other, scopes=['orchestration:read', 'environment:maintain'])
        self.assertEqual(self.run_request(controller=other)['remoteConsent'], 'other-controller')
        self.assert_code('approval-required', self.request('check', controller=other))
        self.assert_code('unauthorized', self.request('enroll', 1, other))
        self.grant(other)
        self.assertEqual(self.run_request('enroll', 1, other)['revision'], 2)
        self.assert_code('approval-required', self.request('check'))

    def test_origin_is_transport_independent_and_never_client_chosen(self):
        self.run_request('enroll')
        original = self.saved()['binding']
        # No route, Host/Origin header, IP or display label is an enrollment key.
        self.grant()
        self.assertEqual(self.run_request()['remoteConsent'], 'enrolled')
        self.assertEqual(self.saved()['binding'], original)
        request = self.request('check'); request['input']['origin'] = 'https://claimed.example'
        self.assert_code('binding-changed', request)

    def test_changed_environment_or_installation_binding_rejects(self):
        self.run_request('enroll')
        before = self.consent_path.read_bytes()
        for key, value in [('port', 25319), ('uid', 501), ('studioHome', str(self.home)),
                           ('service', {'installed': True, 'label': 'foreign', 'domain': 'gui/502'})]:
            self.receipt_path.write_text(json.dumps({**self.receipt, key: value}))
            with self.subTest(key=key), self.assertRaises((managed.ManagedError, AssertionError)):
                self.run_request('check')
        self.receipt_path.write_text(json.dumps(self.receipt))
        (self.state / 'environment-id').write_text('replacement-environment')
        self.assert_code('binding-changed', self.request('check'))
        self.assertEqual(before, self.consent_path.read_bytes())

    def test_wrong_target_unsafe_state_symlink_and_foreign_owner_reject_before_write(self):
        for key, value in [('installationId', '../foreign'), ('environmentId', 'foreign')]:
            request = self.request('enroll'); request['input'][key] = value
            self.assert_code('binding-changed', request)
        alias = self.home / 'alias'; alias.symlink_to(self.state, target_is_directory=True)
        with self.assertRaises(AssertionError): managed.execute(str(alias), self.request('enroll'))
        with fixtures.simulated_owner(self.home, foreign=self.receipt_path), self.assertRaises(AssertionError):
            self.run_request('enroll')
        self.assertFalse(self.updates.exists())

    def test_rejects_symlink_or_public_mode_consent(self):
        self.run_request('enroll')
        self.consent_path.chmod(0o644)
        self.assert_code('binding-changed', self.request())
        self.consent_path.chmod(0o600)
        saved = self.consent_path.read_bytes(); self.consent_path.unlink()
        other = self.home / 'foreign.json'; other.write_bytes(saved)
        self.consent_path.symlink_to(other)
        with self.assertRaises(AssertionError): self.run_request()

    def test_same_home_multiple_installations_cannot_select_another_state(self):
        request = self.request('enroll'); request['input']['installationId'] = 'second-service'
        self.assert_code('binding-changed', request)
        self.assertFalse(self.consent_path.exists())

    def test_local_confirmation_enrolls_active_pair_without_changing_scopes(self):
        self.grant(scopes=['environment:maintain', 'orchestration:read'])
        before = self.database.read_bytes()
        self.assertEqual(self.run_request('enroll-local')['remoteConsent'], 'enrolled')
        self.assertEqual(self.saved()['approval']['kind'], 'native-owner')
        self.assertEqual(before, self.database.read_bytes())
        self.assertEqual(self.run_request('revoke-local', 1)['remoteConsent'], 'revoked')

    def test_local_confirmation_cannot_be_missing_cancelled_or_retargeted(self):
        for key, value in [('confirmed', False), ('confirmed', 1), ('installationId', 'foreign'), ('environmentId', 'foreign'),
                           ('expectedRevision', 5), ('kind', 'renderer')]:
            request = self.request('enroll-local'); request['approval'][key] = value
            self.assert_code('approval-required', request)
        request = self.request('enroll-local'); del request['approval']
        self.assert_code('binding-changed', request)
        self.assertFalse(self.updates.exists())

    def test_local_confirmation_still_requires_active_maintainer(self):
        self.grant(scopes=['access:write'])
        self.assert_code('unauthorized', self.request('enroll-local'))
        self.grant(revoked_at='2026-01-01T00:00:00Z')
        self.assert_code('unauthorized', self.request('enroll-local'))

    def test_status_requires_read_scope_and_check_requires_maintain(self):
        self.run_request('enroll')
        self.grant(scopes=['environment:maintain'])
        self.assert_code('unauthorized', self.request())
        self.grant(scopes=['orchestration:read'])
        self.assertEqual(self.run_request()['remoteConsent'], 'enrolled')
        self.assert_code('unauthorized', self.request('check'))

    def test_absent_agent_stays_unavailable_even_when_enrolled_and_never_bootstraps(self):
        self.plist.unlink()
        self.assertEqual(self.run_request()['localAutomation'], 'unavailable')
        self.assertEqual(self.run_request('enroll')['localAutomation'], 'unavailable')
        self.assertFalse(self.plist.exists())
        self.assertFalse((self.updates / 'config.json').exists())

    def test_wrong_agent_plist_is_rejected_instead_of_reported_enabled(self):
        plist = plistlib.loads(self.plist.read_bytes()); plist['Label'] = 'foreign.updater'
        self.plist.write_bytes(plistlib.dumps(plist))
        with self.assertRaises(AssertionError): self.run_request()

    def test_check_result_does_not_override_active_install_or_new_installed_version(self):
        self.run_request('enroll')
        with mock.patch.object(agent.Agent, 'discover_version', return_value=('available', '1.0.18')):
            self.run_request('check')
        state = {**agent.blank_state(), 'status': 'installing'}
        (self.updates / 'state.json').write_text(json.dumps(state))
        self.assertEqual(self.run_request()['operation'], 'installing')
        (self.updates / 'state.json').unlink()
        self.receipt_path.write_text(json.dumps({**self.receipt, 'version': '1.0.18'}))
        value = self.run_request()
        self.assertEqual(value['currentVersion'], '1.0.18')
        self.assertIsNone(value['availableVersion'])

    def test_check_only_preserves_preferences_database_install_and_agent_state(self):
        self.run_request('enroll')
        config = {**agent.DEFAULT_CONFIG, 'repository': 'private-owner/private-feed',
                  'checkAutomatically': False, 'downloadInBackground': False, 'installAutomatically': False}
        config_path = self.updates / 'config.json'; config_path.write_text(json.dumps(config))
        agent_state = self.updates / 'state.json'; agent_state.write_text(json.dumps(agent.blank_state()))
        protected = {path: path.read_bytes() for path in (config_path, agent_state, self.database, self.receipt_path, self.consent_path)}
        feed = [{'tag_name': 'v1.0.18', 'draft': False}, {'tag_name': 'v99.0.0', 'draft': True}]
        with mock.patch.object(agent.Agent, 'fetch_bytes', return_value=json.dumps(feed).encode()) as fetch, \
             mock.patch.object(agent.Agent, 'run_pass', side_effect=AssertionError('ordinary pass')), \
             mock.patch.object(agent.Agent, 'check', side_effect=AssertionError('caching discovery')), \
             mock.patch.object(agent.Agent, 'download_and_verify', side_effect=AssertionError('download')), \
             mock.patch.object(agent.Agent, 'quiet_then_install', side_effect=AssertionError('install')):
            result = self.run_request('check')
        self.assertEqual((result['operation'], result['availableVersion'], result['localAutomation']),
                         ('available', '1.0.18', 'disabled'))
        self.assertIn('/repos/private-owner/private-feed/releases?per_page=30', fetch.call_args.args[0])
        for path, value in protected.items(): self.assertEqual(value, path.read_bytes())
        self.assertFalse((self.updates / 'downloads').exists())
        self.assertFalse((self.updates / 'helpers').exists())

    def test_check_with_revoked_grant_during_discovery_does_not_save(self):
        self.run_request('enroll')
        def discovery(_):
            self.grant(revoked_at='2026-01-01T00:00:00Z')
            return 'up-to-date', None
        with mock.patch.object(agent.Agent, 'discover_version', discovery):
            self.assert_code('unauthorized', self.request('check'))
        self.assertFalse((self.updates / 'managed-check.json').exists())

    def test_error_discovery_is_sanitized_and_never_false_up_to_date(self):
        self.run_request('enroll')
        with mock.patch.object(agent.Agent, 'discover_version', side_effect=agent.AgentError('secret fake credential')):
            result = self.run_request('check')
        self.assertEqual(result['operation'], 'error')
        self.assertNotIn('secret', (self.updates / 'managed-check.json').read_text())

    def test_unmanaged_fresh_default_home_and_unsupported_are_explicit(self):
        fresh = self.home / '.specwithcode/userdata'; fresh.mkdir(parents=True)
        (fresh / 'environment-id').write_text(self.environment)
        (fresh / 'statev2.sqlite').write_bytes(self.database.read_bytes())
        result = managed.execute(str(fresh), self.request())
        self.assertEqual((result['support'], result['installationId'], result['localAutomation']), ('unmanaged', None, 'unavailable'))
        with self.assertRaises(managed.ManagedError) as error:
            managed.execute(str(fresh), self.request('enroll'))
        self.assertEqual(error.exception.code, 'unmanaged')
        with mock.patch.object(managed.sys, 'platform', 'linux'):
            self.assertEqual(self.run_request()['support'], 'unsupported')
            self.assert_code('unsupported', self.request('enroll'))

    def test_apply_rereads_revoked_consent_and_grant_under_shared_lock(self):
        self.run_request('enroll'); self.run_request('revoke', 1)
        with mock.patch.object(update, '_apply') as apply:
            with self.assertRaises(managed.ManagedError) as error:
                update.apply(self.identity, {'webSessionPolicy': 'worker-relay'}, None, None, None,
                             remote_authorization=self.authorization())
            self.assertEqual(error.exception.code, 'revoked'); apply.assert_not_called()
        self.run_request('enroll', 2); self.grant(revoked_at='2026-01-01T00:00:00Z')
        with mock.patch.object(update, '_apply') as apply:
            with self.assertRaises(managed.ManagedError) as error:
                update.apply(self.identity, {'webSessionPolicy': 'worker-relay'}, None, None, None,
                             remote_authorization=self.authorization(3))
            self.assertEqual(error.exception.code, 'unauthorized'); apply.assert_not_called()

    def test_apply_locks_serialize_revoke_and_preserve_local_automation(self):
        self.run_request('enroll')
        def applying(*args, **kwargs):
            self.assert_code('busy', self.request('revoke', 1))
            with self.assertRaisesRegex(AssertionError, 'in progress'):
                with managed.installation.installation_lock(self.home): pass
            return 'guarded'
        with mock.patch.object(update, '_apply', side_effect=applying):
            self.assertEqual(update.apply(self.identity, {'webSessionPolicy': 'worker-relay'}, None, None, None,
                                         remote_authorization=self.authorization()), 'guarded')
        self.run_request('revoke', 1)
        with mock.patch.object(update, '_apply', return_value='legacy-local') as apply, \
             mock.patch.object(managed, 'remote_apply_guard', side_effect=AssertionError('local classified remote')):
            self.assertEqual(update.apply(self.identity, {'webSessionPolicy': 'worker-relay'}, None, None, None), 'legacy-local')
            apply.assert_called_once()

    def test_remote_apply_rejects_stale_revision_and_foreign_target(self):
        self.run_request('enroll')
        for key, value in [('expectedRevision', 0), ('installationId', 'foreign'), ('environmentId', 'foreign')]:
            request = self.authorization(); request['input'][key] = value
            with mock.patch.object(update, '_apply') as apply, self.assertRaises(managed.ManagedError):
                update.apply(self.identity, {'webSessionPolicy': 'worker-relay'}, None, None, None,
                             remote_authorization=request)
            apply.assert_not_called()

    def test_cli_is_bounded_and_emits_only_code_on_failure(self):
        for payload in (b'!', b'x' * (managed.MAX_INPUT + 1), json.dumps(self.request('enroll')).encode()):
            output = io.StringIO()
            with mock.patch.object(managed, 'execute', side_effect=RuntimeError('secret fake credential')):
                code = managed.main(['--state-dir', str(self.state)], io.BytesIO(payload), output)
            self.assertEqual(code, 1)
            value = json.loads(output.getvalue())
            self.assertEqual(set(value), {'ok', 'error'})
            self.assertEqual(set(value['error']), {'code'})
            self.assertNotIn('secret', output.getvalue())

    def test_cli_success_matches_status_contract(self):
        output = io.StringIO()
        self.assertEqual(managed.main(['--state-dir', str(self.state)],
                                     io.BytesIO(json.dumps(self.request()).encode()), output), 0)
        self.assertEqual(json.loads(output.getvalue()), {'ok': True, 'status': self.run_request()})

    def test_discovery_limits_duplicates_missing_window_and_version_order(self):
        checker = agent.Agent(self.home, self.identity, False, lambda _: None)
        checker.inst = {'version': '1.0.17'}
        fixtures = [([{'tag_name': 'v1.0.18'}, {'tag_name': 'v1.0.20'}], ('available', '1.0.20')),
                    ([{'tag_name': 'v1.0.17'}], ('up-to-date', None)),
                    ([{'tag_name': 'not-version'}] * 30, ('manual-required', None))]
        for feed, expected in fixtures:
            with mock.patch.object(checker, 'fetch_bytes', return_value=json.dumps(feed).encode()):
                self.assertEqual(checker.discover_version(), expected)
        for feed in ([{}] * 31, [{'tag_name': 'v1.0.18'}] * 2, {}):
            with mock.patch.object(checker, 'fetch_bytes', return_value=json.dumps(feed).encode()), self.assertRaises(agent.AgentError):
                checker.discover_version()


if __name__ == '__main__':
    unittest.main()
