#!/usr/bin/env python3
"""Bounded updater recovery: temporary homes and the loopback fixture only."""
import copy
import datetime
import importlib.util
import json
import pathlib
import sys
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import update_agent
import update_agent_recovery as recovery

_spec = importlib.util.spec_from_file_location('agent_tests_for_recovery', str(HERE / 'test-update-agent.py'))
fixture = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fixture)


class RecoveryCase(fixture.AgentCase):
    def pointers(self):
        for path in (self.own / 'launch.sh', self.home / '.local/bin/specweave-studio',
                     self.home / 'Library/LaunchAgents/com.specweave.studio.m4.plist'):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('owned fixture pointer')

    def agent(self):
        agent = update_agent.Agent(self.home, 'm4', True, lambda line: None)
        agent.inst = update_agent.load_installation(self.home, 'm4')
        agent.config = update_agent.load_config(self.updates, self.home)
        agent.state = update_agent.load_state(agent.state_path, self.home)
        return agent

    def preflight(self, extra=None, after=None):
        real = update_agent.run_helper_process
        def run(command, *args, **kwargs):
            result = real(command, *args, **kwargs)
            if '--prestate' in command and result == 'failed':
                receipt = pathlib.Path(command[command.index('--output') + 1])
                value = {'identity': 'm4', 'phase': 'preflight', 'result': 'update-failed',
                         'pointers': 'unchanged', 'error': 'AssertionError: Guarded prestate changed: rows'}
                value.update(extra or {})
                receipt.write_text(json.dumps(value))
                if after:
                    after()
            return result
        return mock.patch.object(update_agent, 'run_helper_process', run)

    def failed_once(self):
        self.fake.add_release()
        self.config(quietMinutes=0)
        self.pointers()
        self.control(applyRefusals=100)
        with self.preflight():
            self.run_agent()
            self.run_agent()
        self.assertEqual(len(self.apply_calls()), 1)
        self.assertEqual(self.state()['automaticRetry']['attempts'], 1)

    def save_state(self, state):
        (self.updates / 'state.json').write_text(json.dumps(state))

    def completion(self):
        installed = json.loads((self.own / 'installation.json').read_text())
        return {'phase': 'verified', 'preservedRowsAuthAndIdentity': True,
                'originalServicesPreserved': True, 'onlyKnownOwnedServiceRestarted': True,
                'before': {'schemaVersion': 1, 'identity': 'm4', 'serviceLabel': 'com.specweave.studio.m4',
                           'artifactSourceCommit': fixture.OLD_COMMIT},
                'after': {'schemaVersion': 1, 'identity': 'm4', 'serviceLabel': 'com.specweave.studio.m4',
                          'artifactSourceCommit': installed['sourceCommit'], 'archiveSha256': installed['archiveSha256']}}


class IntermediateRecovery(RecoveryCase):
    def test_selects_highest_supported_intermediate_without_installing_twice(self):
        self.fake.add_release('0.4.0', from_sources=(fixture.NEW_COMMIT,))
        self.fake.add_release('0.3.0', from_sources=(fixture.OTHER_COMMIT, fixture.OLD_COMMIT))
        self.fake.add_release('0.2.0')
        self.config(quietMinutes=0)
        self.control(newVersion='0.3.0')
        self.run_agent()
        self.assertEqual(self.state()['availableVersion'], '0.3.0')
        # These verified older bundles contain only their original update.py + launcher.py.
        verified = json.loads((self.updates / 'downloads/0.3.0/verified.json').read_text())
        self.assertFalse(any('update_agent_recovery' in name for name in verified['helpers']['files']))
        self.run_agent()
        self.assertEqual(self.state()['installedVersion'], '0.3.0')
        self.assertEqual(len(self.apply_calls()), 1)
        self.control(newVersion='0.4.0')
        self.run_agent()  # A fresh Agent instance rebinds discovery to the installed intermediate.
        self.assertEqual(self.state()['availableVersion'], '0.4.0')
        self.assertEqual(len(self.apply_calls()), 1)
        self.run_agent()
        self.assertEqual(self.state()['installedVersion'], '0.4.0')
        self.assertEqual(len(self.apply_calls()), 2)
        self.run_agent()
        self.assertEqual(self.state()['status'], 'up-to-date')
        self.assertEqual(len(self.apply_calls()), 2)

    def test_no_compatible_chain_explains_the_bounded_feed(self):
        self.fake.add_release('0.4.0', from_sources=(fixture.NEW_COMMIT,))
        self.fake.add_release('0.3.0', from_sources=(fixture.OTHER_COMMIT,))
        self.fake.releases += [{'tag_name': 'v0.1.4'}] + [
            {'tag_name': 'v0.0.%d' % number} for number in range(27)]
        self.run_agent()
        self.assertEqual(self.state()['status'], 'manual-required')
        self.assertIn('newest 30 releases', self.state()['message'])
        self.assertEqual(self.apply_calls(), [])

    def test_full_feed_with_current_plain_version_records_a_successful_check(self):
        for prerelease in (False, True):  # Plain tags count even when GitHub marks a release prerelease.
            with self.subTest(prerelease=prerelease):
                self.fake.releases = [{'tag_name': 'v0.0.%d' % number} for number in range(29)] + [
                    {'tag_name': 'v0.1.4', 'draft': False, 'prerelease': prerelease}]
                self.config(checkRequestedAt=update_agent.iso(update_agent.utcnow()))
                state = update_agent.blank_state()
                state.update(availableVersion='0.2.0', availableTag='v0.2.0', downloadedVersion='0.2.0')
                self.save_state(state)
                self.assertEqual(self.run_agent(), 0)
                state = self.state()
                self.assertEqual(state['status'], 'up-to-date')
                self.assertIsNotNone(update_agent.parse_time(state['checkedAt']))
                self.assertIsNone(state['message'])
                for key in ('availableVersion', 'availableTag', 'downloadedVersion'):
                    self.assertIsNone(state[key])
                requests = len(self.fake.requests)
                self.run_agent()
                self.assertEqual(len(self.fake.requests), requests)  # Successful checks keep their hourly cadence.
        self.assertEqual(self.apply_calls(), [])
        self.assertEqual(self.fake.blob_requests(), [])

    def test_a_full_feed_without_the_current_plain_release_remains_incomplete(self):
        for unknown in ({'tag_name': 'v0.0.29'}, {'tag_name': 'v0.1.4', 'draft': True},
                        {'tag_name': 'v0.1.4-beta.1'}, {'tag_name': 'v0.1.4-nightly'}):
            with self.subTest(unknown=unknown):
                self.fake.releases = [{'tag_name': 'v0.0.%d' % number} for number in range(29)] + [unknown]
                self.run_agent()
                self.assertEqual(self.state()['status'], 'manual-required')
                self.assertIn('newest 30', self.state()['message'])
                self.assertIsNone(self.state()['checkedAt'])
                self.assertEqual(self.apply_calls(), [])
        self.fake.releases.append({'tag_name': 'v0.2.0'})
        self.run_agent()
        self.assertEqual(self.state()['status'], 'error')  # Refuse an unbounded API response.

    def test_duplicate_current_or_newer_versions_do_not_prove_a_complete_feed(self):
        for version in ('0.1.4', '0.2.0'):
            with self.subTest(version=version):
                self.fake.releases = [{'tag_name': 'v0.0.%d' % number} for number in range(28)] + [
                    {'tag_name': 'v' + version}, {'tag_name': 'v' + version}]
                self.run_agent()
                self.assertEqual(self.state()['status'], 'error')
                self.assertIn('ambiguous duplicate versions', self.state()['message'])
                self.assertIsNone(self.state()['checkedAt'])
                self.assertEqual(self.apply_calls(), [])

    def test_malformed_or_missing_plan_and_checksum_errors_do_not_skip_to_an_older_release(self):
        newest = self.fake.add_release('0.3.0', from_sources=(fixture.NEW_COMMIT,))['release']
        self.fake.add_release()
        self.fake.releases += [{'tag_name': 'v0.1.4'}] + [
            {'tag_name': 'v0.0.%d' % number} for number in range(27)]
        self.config(quietMinutes=0)
        plan = next(asset for asset in newest['assets'] if asset['name'] == update_agent.PLAN_ASSET)
        sums = next(asset for asset in newest['assets'] if asset['name'] == update_agent.SUMS_ASSET)
        original = self.fake.blobs[plan['id']]
        cases = [('malformed', lambda: self.fake.blobs.update({plan['id']: b'broken'}), 'error'),
                 ('missing', lambda: newest['assets'].remove(plan), 'manual-required'),
                 ('checksums', lambda: self.fake.blobs.update({sums['id']: b'broken'}), 'error')]
        for name, mutate, status in cases:
            with self.subTest(name=name):
                newest['assets'] = [a for a in newest['assets'] if a['name'] != update_agent.PLAN_ASSET] + [plan]
                self.fake.blobs[plan['id']] = original
                self.config(quietMinutes=0, checkRequestedAt=update_agent.iso(update_agent.utcnow()))
                mutate()
                self.run_agent()
                self.assertEqual(self.state()['status'], status)
                self.assertEqual(self.apply_calls(), [])

    def test_network_failure_never_uses_a_previously_verified_lower_target_even_next_pass(self):
        self.fake.add_release()
        self.config(quietMinutes=0)
        self.run_agent()  # Downloaded and baseline ready, but not yet installed.
        self.fake.add_release('0.3.0', from_sources=(fixture.NEW_COMMIT,))
        self.config(quietMinutes=0, checkRequestedAt=update_agent.iso(update_agent.utcnow()))
        real = update_agent.Agent.fetch_bytes
        def fail_plan(agent, url, accept, limit):
            if '/assets/' in url:
                raise update_agent.AgentError('simulated network failure')
            return real(agent, url, accept, limit)
        with mock.patch.object(update_agent.Agent, 'fetch_bytes', fail_plan):
            for _ in range(2):
                self.run_agent()
                self.assertEqual(self.state()['status'], 'error')
                self.assertIsNone(self.state()['checkedAt'])
                self.assertEqual(self.apply_calls(), [])

    def test_corrupt_highest_supported_archive_is_held_not_downgraded(self):
        self.fake.add_release('0.3.0', corrupt_runtime=True)
        self.fake.add_release()
        self.fake.releases += [{'tag_name': 'v0.1.4'}] + [
            {'tag_name': 'v0.0.%d' % number} for number in range(27)]
        self.config(quietMinutes=0)
        self.run_agent()
        self.assertEqual(self.state()['availableVersion'], '0.3.0')
        self.assertEqual(self.state()['status'], 'error')
        self.run_agent()
        self.assertEqual(self.apply_calls(), [])

    def test_cached_release_and_verification_bind_source_repository_plan_and_asset_id(self):
        self.fake.add_release()
        self.config(installAutomatically=False)
        self.run_agent()
        agent = self.agent()
        meta = agent.load_release('0.2.0')
        self.assertIsNotNone(agent.load_verified(meta))
        for field, value in [('sourceCommit', fixture.OTHER_COMMIT), ('version', '0.1.5')]:
            with self.subTest(field=field):
                old = agent.inst[field]
                agent.inst[field] = value
                self.assertIsNone(agent.load_release('0.2.0'))
                self.assertIsNone(agent.load_verified(meta))
                agent.inst[field] = old
        agent.config['repository'] = 'other/repository'
        self.assertIsNone(agent.load_release('0.2.0'))
        self.assertIsNone(agent.load_verified(meta))
        agent.config['repository'] = fixture.REPO
        for change in ('asset', 'plan'):
            mutated = copy.deepcopy(meta)
            if change == 'asset':
                mutated['assets'][update_agent.PLAN_ASSET]['id'] += 1000
            else:
                mutated['planSha256'] = 'f' * 64
            self.assertIsNone(agent.load_verified(mutated))
        path = agent.release_dir('0.2.0') / update_agent.PLAN_ASSET
        path.write_bytes(path.read_bytes() + b' ')
        self.assertIsNone(agent.load_release('0.2.0'))

    def test_changed_predecessor_during_snapshot_blocks_first_automatic_and_explicit_apply(self):
        self.fake.add_release()
        self.config(quietMinutes=0)
        self.run_agent()
        real = update_agent.Agent.take_snapshot
        def changed_installation(agent, *args):
            self.write_installation('0.1.5', fixture.OTHER_COMMIT)
            return real(agent, *args)
        for explicit in (False, True):
            with self.subTest(explicit=explicit):
                self.write_installation('0.1.4', fixture.OLD_COMMIT)
                self.config(quietMinutes=0, installRequestedAt=update_agent.iso(update_agent.utcnow()) if explicit else None)
                with mock.patch.object(update_agent.Agent, 'take_snapshot', changed_installation):
                    self.run_agent()
                self.assertEqual(self.state()['status'], 'error')
                self.assertEqual(self.apply_calls(), [])
                self.assertIsNone(self.state()['checkedAt'])
                self.assertFalse((self.updates / 'install-in-progress.json').exists())


class AutomaticRecovery(RecoveryCase):
    def test_preflight_refusal_recovers_after_backoff_with_fresh_snapshots(self):
        self.failed_once()
        self.run_agent()
        self.assertEqual(len(self.snapshot_calls()), 2)  # Backoff does not snapshot or apply.
        self.offset += datetime.timedelta(minutes=11)
        self.control()
        self.run_agent()
        self.assertEqual(len(self.apply_calls()), 1)
        self.run_agent()
        self.assertEqual(self.state()['status'], 'installed')
        self.assertIsNone(self.state()['automaticRetry'])
        self.assertEqual(len(self.apply_calls()), 2)
        prestates = [call['argv'][call['argv'].index('--prestate') + 1] for call in self.apply_calls()]
        self.assertNotEqual(*prestates)

    def test_budget_persists_across_instances_and_exhaustion_holds_a_new_target(self):
        self.failed_once()
        with self.preflight():
            for attempt, advance in ((2, 11), (3, 21)):
                self.offset += datetime.timedelta(minutes=advance)
                self.run_agent()
                self.run_agent()
                self.assertEqual(self.state()['automaticRetry']['attempts'], attempt)
                self.assertEqual(len(self.apply_calls()), attempt)
        self.offset += datetime.timedelta(minutes=61)
        self.run_agent()
        self.assertEqual(len(self.apply_calls()), 3)
        self.fake.add_release('0.3.0')
        self.config(quietMinutes=0, checkRequestedAt=update_agent.iso(update_agent.utcnow()))
        self.control(newVersion='0.3.0')
        self.run_agent()
        self.run_agent()
        self.assertEqual(self.state()['availableVersion'], '0.3.0')
        self.assertEqual(self.state()['status'], 'error')
        self.assertEqual(len(self.apply_calls()), 3)

    def test_a_kept_release_that_failed_its_check_is_not_reported_as_not_installed(self):
        self.fake.add_release()
        self.config(quietMinutes=0)
        # What update.py writes when the restarted release failed a check and was kept for review.
        self.control(applyFailAfterSwitch=True, switchReceipt={
            'phase': 'restart-requested', 'pointers': 'new-release', 'attemptedAfter': {'servicePid': 5151},
            'error': 'AssertionError: Owned restart window is not bounded', 'rollbackError': 'AssertionError'})
        self.run_agent()
        self.run_agent()
        state = self.state()
        self.assertEqual((state['status'], state['installedVersion']), ('error', '0.2.0'))
        self.assertIn('0.2.0 was kept after a restart check failed', state['message'])
        self.assertNotIn('did not install', state['message'])

    def test_a_kept_release_whose_rollback_failed_does_not_claim_liveness(self):
        self.fake.add_release()
        self.config(quietMinutes=0)
        self.control(applyFailAfterSwitch=True, switchReceipt={
            'pointers': 'new-release', 'attemptedAfter': {'servicePid': 5151},
            'rollback': 'held-new-release-state-restore-failed'})
        self.run_agent()
        self.run_agent()
        self.assertIn('0.2.0 was kept after a restart check failed', self.state()['message'])
        self.assertNotIn('is running', self.state()['message'])

    def test_failed_bootstrap_after_bootout_does_not_turn_old_observation_into_liveness(self):
        self.fake.add_release()
        self.config(quietMinutes=0)
        # Bootout succeeded, then state restore and recovery bootstrap failed. The helper
        # leaves the old observation and new pointers, but the service can now be stopped.
        self.control(applyFailAfterSwitch=True, switchReceipt={
            'pointers': 'new-release', 'attemptedAfter': {'servicePid': 5151},
            'rollback': 'held-new-release-stopping',
            'rollbackError': 'AssertionError: Owned operation failed; arbitrary command output withheld'})
        self.run_agent()
        self.run_agent()
        state = self.state()
        self.assertEqual((state['status'], state['lastInstall']['result']), ('error', 'failed'))
        self.assertIn('not confirmed', state['message'])
        self.assertNotIn('is running', state['message'])

    def test_a_new_version_on_disk_without_a_kept_restart_is_still_reported_as_not_installed(self):
        self.fake.add_release()
        self.config(quietMinutes=0)
        # Pointers left mixed by a failed restore: installation.json names 0.2.0, the old service runs.
        self.control(applyFailAfterSwitch=True, switchReceipt={'pointers': 'mixed-see-backup'})
        self.run_agent()
        self.run_agent()
        self.assertIn('0.2.0 did not install', self.state()['message'])

    def test_generic_and_partial_failure_stay_held_when_target_changes(self):
        self.fake.add_release()
        self.config(quietMinutes=0)
        self.control(applyFailAfterSwitch=True)
        self.run_agent()
        self.run_agent()
        self.assertEqual(self.state()['lastInstall']['result'], 'failed')
        self.fake.add_release('0.3.0', from_sources=(fixture.NEW_COMMIT,))
        self.control(newVersion='0.3.0')
        self.run_agent()
        self.run_agent()
        self.assertEqual(self.state()['status'], 'error')
        self.assertEqual(len(self.apply_calls()), 1)
        # A generic failure with unchanged installation is held by the same rule.
        self.write_installation('0.1.4', fixture.OLD_COMMIT)
        self.config(quietMinutes=0, checkRequestedAt=update_agent.iso(update_agent.utcnow()))
        self.run_agent()
        self.assertEqual(self.state()['status'], 'error')
        self.assertEqual(len(self.apply_calls()), 1)

    def test_new_explicit_request_can_retry_an_exhausted_or_ambiguous_hold(self):
        self.failed_once()
        state = self.state()
        state['automaticRetry'] = None
        self.save_state(state)
        self.config(quietMinutes=0, installRequestedAt=update_agent.iso(update_agent.utcnow()),
                    installRequestedVersion='0.2.0')
        self.control()
        self.run_agent()
        self.assertEqual(self.state()['status'], 'installed')
        self.assertEqual(len(self.apply_calls()), 2)

    def test_changed_plan_cannot_reset_an_exhausted_refusal_budget(self):
        self.failed_once()
        state = self.state()
        state['automaticRetry']['attempts'] = recovery.MAX_ATTEMPTS
        self.save_state(state)
        self.fake.releases = []
        self.fake.add_release(args=('--allow-existing-browser-heartbeat',))
        self.config(quietMinutes=0, checkRequestedAt=update_agent.iso(update_agent.utcnow()))
        self.control()
        self.offset += datetime.timedelta(hours=1)
        self.run_agent()
        self.run_agent()
        self.assertEqual(self.state()['status'], 'error')
        self.assertEqual(len(self.apply_calls()), 1)

    def test_generic_failure_holds_a_new_target_even_with_unchanged_source(self):
        self.fake.add_release()
        self.config(quietMinutes=0)
        self.control(applyFail=True)
        self.run_agent()
        self.run_agent()
        self.fake.add_release('0.3.0')
        self.config(quietMinutes=0, checkRequestedAt=update_agent.iso(update_agent.utcnow()))
        self.control(newVersion='0.3.0')
        self.run_agent()
        self.run_agent()
        self.assertEqual(self.state()['status'], 'error')
        self.assertIsNone(self.state()['automaticRetry'])
        self.assertEqual(len(self.apply_calls()), 1)

    def test_partial_timeout_and_unproven_completion_cannot_start_the_next_hop(self):
        self.fake.add_release()
        self.config(quietMinutes=0)
        self.control(applyFailAfterSwitch=True)
        real = update_agent.run_helper_process
        def timeout(command, *args, **kwargs):
            result = real(command, *args, **kwargs)
            return 'timeout' if '--prestate' in command else result
        with mock.patch.object(update_agent, 'run_helper_process', timeout):
            self.run_agent()
            self.run_agent()
        self.fake.add_release('0.3.0', from_sources=(fixture.NEW_COMMIT,))
        self.control(newVersion='0.3.0')
        receipt = pathlib.Path(self.state()['lastInstall']['receipt'])
        marker = self.updates / 'install-in-progress.json'
        marker_bytes = marker.read_bytes()
        proofs = [None, 'broken', '{}', '{"phase":"verified"}',
                  '{"phase":"verified","preservedRowsAuthAndIdentity":true}',
                  '{"phase":"verified","preservedRowsAuthAndIdentity":true,'
                  '"originalServicesPreserved":true,"onlyKnownOwnedServiceRestarted":true}',
                  '{"phase":"verified","preservedRowsAuthAndIdentity":true,'
                  '"originalServicesPreserved":true,"result":"update-failed"}']
        for part, key, value in [('before', 'identity', 'main'), ('after', 'identity', 'main'),
                                 ('before', 'artifactSourceCommit', fixture.OTHER_COMMIT),
                                 ('after', 'artifactSourceCommit', fixture.OTHER_COMMIT),
                                 ('after', 'archiveSha256', 'f' * 64), ('after', 'serviceLabel', 'other')]:
            proof = self.completion()
            proof[part][key] = value
            proofs.append(json.dumps(proof))
        for proof in proofs:
            with self.subTest(proof=proof):
                if proof is None:
                    receipt.unlink()
                else:
                    receipt.write_text(proof)
                marker.write_bytes(marker_bytes)
                self.run_agent()  # Settle the interrupted helper without inferring success from version.
                self.assertEqual(self.state()['lastInstall']['result'], 'failed')
                self.run_agent()  # A newly discovered compatible hop remains held.
                self.assertEqual(self.state()['status'], 'error')
                self.assertEqual(len(self.apply_calls()), 1)

    def test_distinct_verified_installation_can_start_the_next_hop(self):
        self.fake.add_release()
        self.config(quietMinutes=0)
        self.control(applyFailAfterSwitch=True)
        self.run_agent()
        self.run_agent()
        receipt = pathlib.Path(self.state()['lastInstall']['receipt'])
        receipt.write_text(json.dumps(self.completion()))
        self.fake.add_release('0.3.0', from_sources=(fixture.NEW_COMMIT,))
        self.config(quietMinutes=0, checkRequestedAt=update_agent.iso(update_agent.utcnow()))
        self.control(newVersion='0.3.0')
        self.run_agent()
        self.assertEqual(len(self.apply_calls()), 1)
        self.run_agent()
        self.assertEqual(self.state()['status'], 'installed')
        self.assertEqual(len(self.apply_calls()), 2)

    def test_active_work_blocks_a_due_retry_and_its_quiet_baseline_is_fresh(self):
        self.failed_once()
        self.offset += datetime.timedelta(minutes=11)
        self.control(snapshotFail=True)
        self.run_agent()
        self.assertEqual(self.state()['status'], 'waiting-for-quiet')
        self.assertEqual(len(self.apply_calls()), 1)
        self.control()
        self.run_agent()
        self.assertEqual(len(self.apply_calls()), 1)
        self.run_agent()
        self.assertEqual(len(self.apply_calls()), 2)

    def test_snapshot_crossing_the_retry_deadline_cannot_apply(self):
        self.failed_once()
        self.offset += datetime.timedelta(hours=23, minutes=58)
        self.control()
        self.run_agent()
        real = update_agent.Agent.take_snapshot
        def slow_snapshot(agent, *args):
            result = real(agent, *args)
            self.offset += datetime.timedelta(minutes=5)
            return result
        with mock.patch.object(update_agent.Agent, 'take_snapshot', slow_snapshot):
            self.run_agent()
        self.assertEqual(self.state()['status'], 'error')
        self.assertEqual(len(self.apply_calls()), 1)
        self.assertIsNone(self.state()['automaticRetry'])

    def test_changed_install_or_pointer_and_receipt_tampering_never_authorize_retry(self):
        self.failed_once()
        self.offset += datetime.timedelta(minutes=11)
        agent = self.agent()
        verified = agent.load_verified(agent.load_release('0.2.0'))
        before = copy.deepcopy(agent.state)
        receipt = pathlib.Path(before['automaticRetry']['receipt'])
        receipt_data = receipt.read_bytes()
        pointer = self.own / 'launch.sh'
        for mutate, restore in ((lambda: pointer.write_text('changed'), lambda: pointer.write_text('owned fixture pointer')),
                                (lambda: receipt.write_bytes(receipt_data + b' '), lambda: receipt.write_bytes(receipt_data))):
            agent.state = copy.deepcopy(before)
            mutate()
            self.assertIsNotNone(recovery.automatic_retry(agent, verified))
            self.assertIsNone(agent.state['automaticRetry'])
            restore()
        self.write_installation('0.1.5', fixture.OLD_COMMIT)
        agent.state = before
        self.assertIsNotNone(recovery.automatic_retry(agent, verified))

    def test_integrity_failure_during_a_due_retry_keeps_the_installation_held(self):
        self.failed_once()
        self.offset += datetime.timedelta(minutes=11)
        self.control()
        self.run_agent()  # Fresh quiet baseline for the due retry.
        agent = self.agent()
        verified = agent.load_verified(agent.load_release('0.2.0'))
        runtime = agent.release_dir('0.2.0') / verified['runtime']['asset']
        runtime.write_bytes(b'tampered cached archive')
        self.run_agent()
        self.assertEqual(self.state()['status'], 'error')
        self.assertIsNone(self.state()['automaticRetry'])
        self.run_agent()  # Even a successful verified redownload must not reset the hold.
        self.assertEqual(self.state()['status'], 'error')
        self.assertEqual(len(self.apply_calls()), 1)

    def test_malformed_budget_and_receipt_fields_are_held_without_crashing(self):
        self.failed_once()
        self.offset += datetime.timedelta(minutes=11)
        agent = self.agent()
        verified = agent.load_verified(agent.load_release('0.2.0'))
        saved = copy.deepcopy(agent.state)
        for field, value in [('attempts', '2'), ('attempts', True), ('attempts', 0), ('attempts', 99),
                             ('receiptSha256', None), ('firstAttemptAt', 'bad'), ('binding', None),
                             ('nextAttemptAt', update_agent.iso(update_agent.utcnow() + datetime.timedelta(days=2)))]:
            with self.subTest(field=field, value=value):
                agent.state = copy.deepcopy(saved)
                agent.state['automaticRetry'][field] = value
                self.assertIsNotNone(recovery.automatic_retry(agent, verified))
                self.assertIsNone(agent.state['automaticRetry'])
        agent.state = copy.deepcopy(saved)
        agent.state['automaticRetry']['attempts'] = 'broken'
        recovery.record_refusal(agent, verified, saved['lastInstall']['receipt'],
                                recovery.installation_fingerprint(agent))
        self.assertIsNone(agent.state['automaticRetry'])
        self.offset += datetime.timedelta(days=2)
        agent.state = saved
        self.assertIsNotNone(recovery.automatic_retry(agent, verified))

    def test_only_exact_nonmutating_preflight_receipts_are_eligible(self):
        self.failed_once()
        agent = self.agent()
        receipt = pathlib.Path(agent.state['lastInstall']['receipt'])
        original = json.loads(receipt.read_text())
        before = recovery.installation_fingerprint(agent)
        for field, value in [('phase', 'prepared'), ('phase', 'restart-requested'), ('identity', 'main'),
                             ('pointers', 'previous-release'), ('error', 'TimeoutError: Guarded prestate changed'),
                             ('restartStartedAt', None), ('rollback', 'done'), ('rollbackError', None),
                             ('stateBackup', None), ('backup', {}), ('partial', False), ('unknown', True)]:
            with self.subTest(field=field):
                receipt.write_text(json.dumps(dict(original, **{field: value})))
                self.assertIsNone(recovery.refusal_proof(agent, receipt, before))
        receipt.unlink()
        self.assertIsNone(recovery.refusal_proof(agent, receipt, before))

    def test_auto_off_cancel_or_new_request_during_snapshot_stops_current_attempt(self):
        self.failed_once()
        self.offset += datetime.timedelta(minutes=11)
        self.control()
        real = update_agent.Agent.take_snapshot
        for change in ({'installAutomatically': False},
                       {'installCancelledAt': update_agent.iso(update_agent.utcnow())},
                       {'installRequestedAt': update_agent.iso(update_agent.utcnow())}):
            with self.subTest(change=change):
                # Exercise withdrawal directly after a real fresh snapshot without run_once's
                # separate, intentionally authorized handling of a newly arrived explicit request.
                agent = self.agent()
                agent.config.update(installAutomatically=True, installRequestedAt=None, installCancelledAt=None)
                self.config(quietMinutes=0)
                verified = agent.load_verified(agent.load_release('0.2.0'))
                def change_after_snapshot(current, *args):
                    result = real(current, *args)
                    self.config(quietMinutes=0, **change)
                    return result
                with mock.patch.object(update_agent.Agent, 'take_snapshot', change_after_snapshot):
                    agent.quiet_then_install(verified, False)
                self.assertEqual(len(self.apply_calls()), 1)
                self.assertIsNone(agent.state['automaticRetry'])


class NewerReleaseRecovery(RecoveryCase):
    """A post-restart failure that was fully rolled back holds its own version, while a newer
    release (with newer helpers) gets one automatic attempt (M1/M3 stuck on 1.0.29 after 1.0.30)."""

    def rolled_back_once(self, failures=1, receipt=None):
        self.fake.add_release()
        self.config(quietMinutes=0)
        self.pointers()
        self.control(applyRolledBack=failures, rolledBackReceipt=receipt or {}, newVersion='0.3.0')
        self.run_agent()
        self.run_agent()
        self.assertEqual(len(self.apply_calls()), 1)
        last = self.state()['lastInstall']
        self.assertEqual((last['version'], last['result']), ('0.2.0', 'failed'))
        self.run_agent()
        self.assertEqual(self.state()['status'], 'error')
        self.assertIn('0.2.0 did not install automatically', self.state()['message'])
        self.assertEqual(len(self.apply_calls()), 1)  # The failed version itself stays held.

    def offer_newer(self):
        self.fake.add_release('0.3.0')
        self.config(quietMinutes=0, checkRequestedAt=update_agent.iso(update_agent.utcnow()))
        self.run_agent()
        self.run_agent()

    def test_a_newer_release_installs_automatically_after_a_rolled_back_failure(self):
        self.rolled_back_once()
        self.offer_newer()
        self.assertEqual(len(self.apply_calls()), 2)
        self.assertEqual(self.state()['status'], 'installed')
        self.assertEqual(self.state()['lastInstall']['version'], '0.3.0')

    def test_a_newer_release_that_fails_too_is_held_after_one_attempt(self):
        self.rolled_back_once(failures=2)
        self.offer_newer()
        self.assertEqual(len(self.apply_calls()), 2)
        self.assertEqual(self.state()['lastInstall']['version'], '0.3.0')
        for _ in range(3):
            self.offset += datetime.timedelta(minutes=30)
            self.run_agent()
        self.assertEqual(len(self.apply_calls()), 2)
        self.assertEqual(self.state()['status'], 'error')
        self.assertIn('0.3.0 did not install automatically', self.state()['message'])

    def test_an_incomplete_or_unproven_rollback_never_starts_a_newer_release(self):
        self.rolled_back_once()
        receipt = pathlib.Path(self.state()['lastInstall']['receipt'])
        clean = json.loads(receipt.read_text())
        self.fake.add_release('0.3.0')
        self.config(quietMinutes=0, checkRequestedAt=update_agent.iso(update_agent.utcnow()))
        for change in ({'rollbackError': 'AssertionError: Owned service did not stop for the state restore'},
                       {'rollback': 'held-new-release-state-restore-failed'},
                       {'rollback': 'held-for-safe-review'}, {'rollback': None},
                       {'pointers': 'new-release'}, {'pointers': 'mixed-see-backup'},
                       {'identity': 'm1'}, {'result': 'updated'}):
            with self.subTest(change=change):
                receipt.write_text(json.dumps(dict(clean, **change)))
                self.run_agent()
                self.run_agent()
                self.assertEqual(len(self.apply_calls()), 1)
                self.assertEqual(self.state()['status'], 'error')
        receipt.write_text('not json')
        self.run_agent()
        self.assertEqual(len(self.apply_calls()), 1)
        receipt.write_text(json.dumps(clean))  # The proven rollback alone lets 0.3.0 install.
        self.run_agent()
        self.run_agent()
        self.assertEqual(len(self.apply_calls()), 2)
        self.assertEqual(self.state()['status'], 'installed')

    def test_a_changed_installation_or_receipt_location_holds_the_newer_release(self):
        self.rolled_back_once()
        self.fake.add_release('0.3.0')
        agent = self.agent()
        agent.state['checkedAt'] = None
        verified = {'version': '0.3.0', 'binding': {'installedSourceCommit': fixture.OLD_COMMIT}}
        self.assertTrue(recovery.newer_release_after_rollback(agent, verified))
        self.assertFalse(recovery.newer_release_after_rollback(agent, dict(verified, version='0.2.0')))
        self.assertFalse(recovery.newer_release_after_rollback(agent, dict(verified, version='0.1.9')))
        self.assertFalse(recovery.newer_release_after_rollback(
            agent, dict(verified, binding={'installedSourceCommit': fixture.OTHER_COMMIT})))
        last = agent.state['lastInstall']
        for change in ({'previousSourceCommit': fixture.OTHER_COMMIT}, {'result': 'updated'}, {'version': None},
                       {'receipt': None}, {'receipt': str(self.home / 'elsewhere.json')}):
            with self.subTest(change=change):
                agent.state['lastInstall'] = dict(last, **change)
                self.assertFalse(recovery.newer_release_after_rollback(agent, verified))
        agent.state['lastInstall'] = last
        self.assertTrue(recovery.newer_release_after_rollback(agent, verified))


if __name__ == '__main__':
    unittest.main()
