#!/usr/bin/env python3
"""Per-phase timings in the receipts update.py writes: whole milliseconds under `timings`, added
to every receipt from 'prepared' on (a verified install, a rollback, a refusal before the
restart) and to none of the preflight receipt's five keys. The proofs and checks are unchanged,
and every reader of these receipts answers as it did without the key. Temporary homes and
test-update.py's ApplyRecovery harness only, whose clock moves only when the update sleeps."""
import datetime
import importlib.util
import json
import os
import pathlib
import pwd
import sys
import tempfile
import unittest
from unittest.mock import patch

import fleet_health
import install_progress
import update_agent
import update_agent_recovery as recovery
import update_request


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(filename))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


updater_base = module('timings_update_base', 'test-update.py')
update = updater_base.update  # The update.py module the harness patches.

# In the order they happen; each receipt holds those done by then.
PHASES = ['beforeRead', 'backupSpace', 'verifyAndStage', 'prestateCheck', 'swapPointers', 'gateSettle',
          'checkBeforeRestart', 'stop', 'finalCheck', 'serviceStop', 'backupClone', 'restart', 'readinessCheap',
          'readiness', 'keptRelease', 'guardedComparison']
FAILED = ['untilFailure', 'rollback', 'total']
PREFLIGHT_KEYS = {'identity', 'phase', 'result', 'error', 'pointers'}


class ApplyTimings(unittest.TestCase):
    def harness(self):
        fixture = updater_base.ApplyRecovery(methodName='runTest')
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        return fixture

    def assert_whole_milliseconds(self, timings):
        self.assertTrue(all(type(value) is int and value >= 0 for value in timings.values()), timings)

    def test_a_verified_install_records_every_phase(self):
        fixture = self.harness()
        seen = {}
        def at_restart():
            seen['restart-requested'] = json.loads(fixture.output.read_text())
        fixture.on_restart = at_restart
        fixture.execute()
        result = json.loads(fixture.output.read_text())
        self.assertEqual(result['phase'], 'verified')
        timings = result['timings']
        self.assertEqual(list(timings), PHASES + ['cleanup', 'total'])
        self.assert_whole_milliseconds(timings)
        # Only sleeps move the harness clock: the install gate's settle and one readiness poll,
        # after which the full read is taken at once.
        self.assertEqual(timings['gateSettle'], update.INSTALL_GATE_SETTLE_SECONDS * 1000)
        self.assertEqual((timings['readinessCheap'], timings['readiness']), (500, 0))
        self.assertEqual(timings['total'], sum(value for name, value in timings.items() if name != 'total'))
        # The receipt written before the restart already held the phases done by then.
        before_restart = seen['restart-requested']
        self.assertEqual(before_restart['phase'], 'restart-requested')
        self.assertEqual(list(before_restart['timings']), PHASES[:PHASES.index('backupClone') + 1])

    def test_each_phase_holds_the_time_its_own_step_took(self):
        """Each step spends its own number of milliseconds on the harness clock (a power of two,
        so a sum names its steps): a lap moved across a step books that time to another phase."""
        fixture = self.harness()
        steps = []
        def spending(name, milliseconds, step):
            def timed(*args, **kwargs):
                steps.append(name)
                fixture.clock[0] += milliseconds / 1000
                return step(*args, **kwargs)
            return timed
        reads = iter([1, 8, 512])  # The before-read, the check after staging, the first reading after the restart.
        snapshot_since = fixture.snapshot_since
        fixture.snapshot_since = lambda *args, **kwargs: spending('snapshot', next(reads), snapshot_since)(*args, **kwargs)
        fixture.on_stage = spending('stage', 2, lambda: None)
        checks = iter([16, 128])  # Right after the gate settles, and right before the stop.
        rows_since = fixture.rows_since
        fixture.rows_since = lambda *args: spending('check', next(checks), rows_since)(*args)
        fixture.quiescence_guard = spending('stop', 32, fixture.quiescence_guard)
        fixture.backup_state = spending('backup', 64, fixture.backup_state)
        fixture.service_answers = spending('answer', 4096, fixture.service_answers)
        start = fixture.clock[0]
        with patch.object(update, 'publish_release', side_effect=spending('publish', 4, update.publish_release)), \
                patch.object(update, 'stop_service', side_effect=spending('serviceStop', 2048, update.stop_service)), \
                patch.object(update, 'start_service', side_effect=spending('restart', 256, update.start_service)), \
                patch.object(update, 'prune_releases', side_effect=spending('prune', 1024, update.prune_releases)):
            fixture.execute()
        result = json.loads(fixture.output.read_text())
        self.assertEqual(result['phase'], 'verified')
        self.assertEqual(steps, ['snapshot', 'stage', 'publish', 'snapshot', 'check', 'stop', 'check', 'serviceStop',
                                 'backup', 'restart', 'answer', 'snapshot', 'prune'])
        settle = update.INSTALL_GATE_SETTLE_SECONDS * 1000
        self.assertEqual(result['timings'], {
            'beforeRead': 1, 'backupSpace': 0, 'verifyAndStage': 2 + 4, 'prestateCheck': 8, 'swapPointers': 0,
            'gateSettle': settle, 'checkBeforeRestart': 16, 'stop': 32, 'finalCheck': 128, 'serviceStop': 2048,
            'backupClone': 64, 'restart': 256, 'readinessCheap': 500 + 4096, 'readiness': 512, 'keptRelease': 0,
            'guardedComparison': 0, 'cleanup': 1024, 'total': round((fixture.clock[0] - start) * 1000)})
        self.assertEqual(result['timings']['total'], 8191 + settle + 500)

    def test_a_rollback_records_the_phases_done_the_failure_and_the_rollback(self):
        fixture = self.harness()
        fixture.after_mutation = lambda after: after.update(archiveSha256='another-owned-release')
        with self.assertRaisesRegex(AssertionError, 'intended artifact'):
            fixture.execute()
        failure = json.loads(fixture.output.read_text())
        self.assertEqual((failure['result'], failure['rollback']), ('update-failed', 'restored-runtime-pointers-and-state'))
        self.assertNotIn('rollbackError', failure)
        timings = failure['timings']
        self.assertEqual(list(timings), PHASES[:PHASES.index('keptRelease') + 1] + FAILED)
        self.assert_whole_milliseconds(timings)
        self.assertEqual(timings['total'], sum(value for name, value in timings.items() if name != 'total'))

    def test_a_refusal_before_the_restart_records_its_timings_and_is_still_retried(self):
        fixture = self.harness()
        fixture.scenario = 'pre-restart-active'
        with self.assertRaises(AssertionError):
            fixture.execute()
        failure = json.loads(fixture.output.read_text())
        self.assertEqual((failure['phase'], failure['rollback']), ('pointers-written', 'restored-exact-owned-runtime-pointers'))
        self.assertEqual(list(failure['timings']), PHASES[:PHASES.index('gateSettle') + 1] + FAILED)
        self.assert_whole_milliseconds(failure['timings'])

    def test_a_failed_rollback_still_records_how_long_it_took(self):
        fixture = self.harness()
        fixture.scenario = 'postrestart-active'
        with self.assertRaises(AssertionError):
            fixture.execute()
        failure = json.loads(fixture.output.read_text())
        self.assertEqual(failure['rollback'], 'held-for-safe-review')
        self.assertIn('rollbackError', failure)
        # The service answered at once; its full read never could, retried until the deadline.
        self.assertEqual(list(failure['timings']), PHASES[:PHASES.index('readinessCheap') + 1] + FAILED)
        self.assertGreaterEqual(failure['timings']['readinessCheap'] + failure['timings']['untilFailure'],
                                update.READINESS_DEADLINE_SECONDS * 1000)

    def test_the_preflight_receipt_keeps_its_five_keys(self):
        fixture = self.harness()
        refusal = AssertionError('Guarded prestate changed: rows')
        with patch.object(update, 'assert_prestate', side_effect=refusal), self.assertRaises(AssertionError):
            fixture.execute()
        self.assertFalse(fixture.output.exists())  # Refused before 'prepared': main() writes the receipt.
        update.write_preflight_failure(fixture.output, 'm4', refusal)
        self.assertEqual(set(json.loads(fixture.output.read_text())), PREFLIGHT_KEYS)

    def test_the_agents_timings_reach_the_progress_file_and_every_receipt_but_the_preflight_one(self):
        """The agent's wait before this helper (update_agent_run.Timings) is copied as it came, next to,
        never into, the helper's own `timings`, which the desktop sums for the install's start."""
        handed = {'requestWait': 1500, 'beforeInstall': 200, 'verifyHelpers': 30, 'snapshot': 61000,
                  'retryWait': 10000, 'total': 71230}
        progress_path = lambda fixture: fixture.own / 'updates' / install_progress.FILE
        cases = (('verified', None, json.dumps(handed)), ('refused before the restart', 'pre-restart-active', json.dumps(handed)),
                 ('an older agent passes none', None, None))
        for name, scenario, agent_env in cases:
            with self.subTest(name):
                fixture = self.harness()
                fixture.scenario = scenario or fixture.scenario
                env = {install_progress.AGENT_TIMINGS_ENV: agent_env} if agent_env else {}
                with patch.dict(os.environ, env):
                    if scenario:
                        with self.assertRaises(AssertionError):
                            fixture.execute()
                    else:
                        fixture.execute()
                expected = handed if agent_env else {}
                self.assertEqual(json.loads(fixture.output.read_text())['agentTimings'], expected)
                progress = json.loads(progress_path(fixture).read_text())
                self.assertEqual(progress['agentTimings'], expected)
                self.assertNotIn('requestWait', progress['timings'])
        fixture = self.harness()
        with patch.dict(os.environ, {install_progress.AGENT_TIMINGS_ENV: json.dumps(handed)}), \
                patch.object(update, 'assert_prestate', side_effect=AssertionError('Guarded prestate changed: rows')), \
                self.assertRaises(AssertionError):
            fixture.execute()
        self.assertEqual(json.loads(progress_path(fixture).read_text())['agentTimings'], handed)  # Visible on a refusal too.

    def test_the_helpers_disk_policy_reaches_every_receipt_but_the_preflight_one(self):
        """`diskIoPolicy`: 0 when the agent lifted its LowPriorityIO throttle for the apply, 3 under it."""
        for policy, scenario in ((0, None), (3, None), (None, None), (0, 'pre-restart-active')):
            with self.subTest(policy=policy, scenario=scenario):
                fixture = self.harness()
                fixture.scenario = scenario or fixture.scenario
                with patch.object(install_progress, 'disk_io_policy', return_value=policy):
                    if scenario:
                        with self.assertRaises(AssertionError):
                            fixture.execute()
                    else:
                        fixture.execute()
                self.assertEqual(json.loads(fixture.output.read_text())['diskIoPolicy'], policy)
        if sys.platform == 'darwin':
            self.assertIn(install_progress.disk_io_policy(), range(0, 6))  # This process's own, read for real.


# The installation a reader binds a receipt to (test-update-agent.py's write_installation).
SOURCE, ARCHIVE = 'a' * 40, 'd' * 64
TIMINGS = {'beforeRead': 4100, 'verifyAndStage': 9000, 'gateSettle': 12000, 'total': 98765}


class ReceiptReaders(unittest.TestCase):
    """Each reader gives the same answer for a receipt with timings as without them, and accepts
    the receipts it accepted before. A preflight receipt is the one place a key is refused."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='studio-update-timings-readers-')
        self.addCleanup(temporary.cleanup)
        self.home = pathlib.Path(temporary.name).resolve()
        account = pwd.getpwuid(os.getuid())
        patcher = patch.object(update_agent.installation_descriptor.pwd, 'getpwuid',
                               return_value=type('Account', (), {'pw_dir': str(self.home), 'pw_name': account.pw_name})())
        patcher.start()
        self.addCleanup(patcher.stop)
        self.own = self.home / '.specwithcode' / 'm4'
        self.receipts = self.own / 'updates' / 'receipts'
        self.receipts.mkdir(parents=True)
        self.installation = {
            'schemaVersion': 1, 'identity': 'm4', 'studioHome': str(self.own), 'stateDir': str(self.own / 'userdata'),
            'version': '0.2.0', 'sourceCommit': SOURCE, 'archiveSha256': ARCHIVE,
            'release': str(self.home / '.specwithcode/install/releases' / ('d' * 20)), 'node': '/usr/bin/node',
            'uid': os.getuid(), 'user': account.pw_name, 'cliWrapper': str(self.home / '.local/bin/specweave-studio'),
            'host': '127.0.0.1', 'port': 8319,
            'service': {'installed': True, 'label': 'com.specweave.studio.m4', 'domain': 'gui/' + str(os.getuid())}}
        (self.own / 'installation.json').write_text(json.dumps(self.installation))
        for path in (self.own / 'launch.sh', self.home / '.local/bin/specweave-studio',
                     self.home / 'Library/LaunchAgents/com.specweave.studio.m4.plist'):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('owned fixture pointer')
        self.agent = update_agent.Agent(self.home, 'm4', True, lambda line: None)
        self.agent.inst = update_agent.load_installation(self.home, 'm4')

    def both(self, name, receipt, read):
        """read(path) for the receipt as written and with timings added: the same answer."""
        plain, timed = self.receipts / (name + '.json'), self.receipts / (name + '-timed.json')
        plain.write_text(json.dumps(receipt))
        timed.write_text(json.dumps(dict(receipt, timings=TIMINGS)))
        answers = read(plain), read(timed)
        self.assertEqual(answers[0], answers[1], name)
        return answers[1]

    def verified(self):
        part = {'schemaVersion': 1, 'identity': 'm4', 'serviceLabel': 'com.specweave.studio.m4'}
        return {'phase': 'verified', 'preservedRowsAuthAndIdentity': True, 'originalServicesPreserved': True,
                'onlyKnownOwnedServiceRestarted': True, 'before': dict(part, artifactSourceCommit='b' * 40),
                'after': dict(part, artifactSourceCommit=SOURCE, archiveSha256=ARCHIVE)}

    def test_a_verified_receipt_is_still_a_completion(self):
        self.assertTrue(self.both('verified', self.verified(),
                                  lambda path: recovery.completion_proof(self.agent, str(path))))

    def test_a_verified_receipt_still_finalizes_an_install_request(self):
        updates = self.own / 'updates'
        def finalized(path):
            state = {'installedVersion': '0.2.0', 'installedSourceCommit': SOURCE,
                     'lastInstall': {'result': 'updated', 'at': '2026-10-20T12:00:00Z', 'version': '0.2.0', 'receipt': str(path)}}
            (updates / 'state.json').write_text(json.dumps(state))
            return update_request.finalized(self.own, 'm4', self.installation, state)
        self.assertTrue(self.both('finalized', self.verified(), finalized))

    def test_a_clean_rollback_still_lets_a_newer_release_install(self):
        receipt = {'identity': 'm4', 'result': 'update-failed', 'pointers': 'previous-release',
                   'rollback': 'restored-runtime-pointers-and-state', 'phase': 'restart-requested'}
        def newer(path):
            self.agent.state['lastInstall'] = {'result': 'failed', 'version': '0.2.1', 'receipt': str(path),
                                               'previousSourceCommit': SOURCE}
            return recovery.newer_release_after_rollback(
                self.agent, {'version': '0.3.0', 'binding': {'installedSourceCommit': SOURCE}})
        self.assertTrue(self.both('rolled-back', receipt, newer))

    def test_a_refusal_before_the_restart_is_still_retried(self):
        receipt = {'identity': 'm4', 'phase': 'pointers-written', 'result': 'update-failed',
                   'pointers': 'previous-release', 'rollback': 'restored-exact-owned-runtime-pointers',
                   'error': 'AssertionError: Native work changed before restart'}
        self.assertTrue(self.both('refused', receipt, lambda path: recovery.refused_before_restart(self.agent, path, '0.3.0')))

    def test_a_held_release_is_still_kept_after_the_restart(self):
        receipt = {'identity': 'm4', 'phase': 'restart-requested', 'result': 'update-failed', 'pointers': 'new-release',
                   'rollback': 'held-for-safe-review', 'attemptedAfter': {'servicePid': 101}}
        self.assertTrue(self.both('held', receipt, lambda path: self.agent.kept_after_restart(str(path))))

    def test_fleet_health_reports_a_failed_install_the_same(self):
        receipt = {'identity': 'm4', 'result': 'update-failed', 'rollback': 'held-for-safe-review',
                   'error': 'AssertionError: Updated service did not become ready within 120 s'}
        def health(path):
            state = {'status': 'error', 'installedVersion': '0.2.0', 'message': 'did not install',
                     'lastInstall': {'result': 'failed', 'version': '0.3.0', 'receipt': str(path),
                                     'at': datetime.datetime(2026, 10, 20, tzinfo=datetime.timezone.utc).isoformat()}}
            (self.own / 'updates' / 'state.json').write_text(json.dumps(state))
            finding = fleet_health.check_updates(self.own)
            finding['lastInstall'].pop('receipt')  # The two receipts differ only by name.
            return finding
        self.assertIn('held for review', self.both('health', receipt, health)['summary'])

    def test_a_preflight_refusal_is_proven_only_with_its_five_keys(self):
        receipt = {'identity': 'm4', 'phase': 'preflight', 'result': 'update-failed', 'pointers': 'unchanged',
                   'error': 'AssertionError: Guarded prestate changed: rows'}
        before = recovery.installation_fingerprint(self.agent)
        self.assertIsNotNone(before)
        plain, timed = self.receipts / 'preflight.json', self.receipts / 'preflight-timed.json'
        plain.write_text(json.dumps(receipt))
        timed.write_text(json.dumps(dict(receipt, timings=TIMINGS)))
        self.assertIsNotNone(recovery.refusal_proof(self.agent, str(plain), before))
        # Why write_preflight_failure adds no timings: installed agents would not retry it.
        self.assertIsNone(recovery.refusal_proof(self.agent, str(timed), before))


if __name__ == '__main__':
    unittest.main()
