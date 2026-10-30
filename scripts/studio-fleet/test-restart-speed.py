#!/usr/bin/env python3
"""The faster Restart to update path of the update agent and helper (temporary homes only):

- the agent stages a downloaded release ahead (`update.py --stage-release`, release_stage.py) and
  the apply then skips install.py, still verifying every byte; release_retention keeps it;
- a held service's gate acknowledgement ends the gate settle early, and a release without one
  waits it out in full;
- a held snapshot whose hold is older than the marker settle skips that settle;
- the receipt, the progress and the gate say verified before the cleanup, which never fails it;
- a forced request's first refused snapshots retry after 1, 2 and 2 s, then every RETRY_SECONDS;
- a check request beside an install request for the release a fresh check found asks GitHub nothing.

Run: cd scripts/studio-fleet && python3 -B test-restart-speed.py
"""
import datetime
import importlib.util
import json
import pathlib
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import install_progress  # noqa: E402
import release_retention  # noqa: E402
import release_stage  # noqa: E402
import studio_paths  # noqa: E402
import update_agent  # noqa: E402
import update_agent_reap  # noqa: E402
import update_agent_run  # noqa: E402
import update_service  # noqa: E402


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


updater_base = load('restart_speed_update_base', 'test-update.py')
update = updater_base.update  # The harness's own update.py module, so a patch here reaches the apply it runs.
agent_tests = load('restart_speed_agent_base', 'test-update-agent.py')


class StagedAhead(updater_base.ApplyRecovery):
    def stage_ahead(self):
        return release_stage.stage_ahead(self.own, self.home, self.archive, self.sha,
                                         run=self.transport, publish=update.publish_release)

    def published(self):
        return studio_paths.releases_root(self.home) / self.sha[:20]

    def test_a_release_staged_ahead_is_installed_without_unpacking_it_again(self):
        record = self.stage_ahead()
        self.assertEqual(self.stage_timeouts, [release_stage.AHEAD_TIMEOUT_SECONDS])
        self.assertEqual((record['archiveSha256'], record['release'], record['version']), (self.sha, str(self.published()), '0.1.0'))
        self.assertTrue(release_stage.staged(self.own, self.home, self.sha, self.published()))
        verified = []
        real = update.release_verified
        with mock.patch.object(update, 'release_verified', side_effect=lambda release: verified.append(release.name) or real(release)):
            self.execute()
        result = json.loads(self.output.read_text())
        self.assertEqual(result['phase'], 'verified')
        self.assertIs(result['releaseStagedAhead'], True)
        self.assertEqual(self.stage_timeouts, [release_stage.AHEAD_TIMEOUT_SECONDS])  # install.py ran only ahead.
        self.assertEqual(verified, [self.sha[:20]])  # Every byte is checked again before a pointer names it.
        self.assertIn(self.sha[:20], (self.own / 'launch.sh').read_text())
        self.assertFalse(release_stage.record_path(self.own, self.home).exists())  # Installed: the record goes.

    def test_a_staged_release_changed_since_is_refused_before_any_pointer_moves(self):
        self.stage_ahead()
        (self.published() / 'bin.mjs').write_bytes(b'changed-owned-code')
        with self.assertRaises(AssertionError):
            self.execute()
        self.assertEqual({path: path.read_bytes() for path in self.original}, self.original)
        self.assertEqual(self.restart_calls, [])

    def test_another_record_or_a_replaced_manifest_stages_again(self):
        self.stage_ahead()
        path = release_stage.record_path(self.own, self.home)
        record = json.loads(path.read_text())
        for changed in ({'archiveSha256': '0' * 64}, {'manifestSha256': '0' * 64}, {'release': str(self.home / 'elsewhere')},
                        {'schemaVersion': 2}):
            with self.subTest(changed=changed):
                path.write_text(json.dumps(dict(record, **changed)))
                self.assertFalse(release_stage.staged(self.own, self.home, self.sha, self.published()))
        path.write_text('{')
        self.assertFalse(release_stage.staged(self.own, self.home, self.sha, self.published()))
        path.write_text(json.dumps(dict(record, archiveSha256='0' * 64)))
        self.execute()
        self.assertIs(json.loads(self.output.read_text())['releaseStagedAhead'], False)
        self.assertEqual(len(self.stage_timeouts), 2)  # Ahead, then again in the apply.
        self.assertTrue(path.exists())  # A record of another archive is left for its own apply.

    def test_a_staging_ahead_never_runs_beside_an_apply(self):
        with update.installation_lock(self.home), self.assertRaisesRegex(AssertionError, 'Another installation operation'):
            self.stage_ahead()
        self.assertEqual(self.stage_timeouts, [])
        with self.assertRaisesRegex(AssertionError, 'Archive hash mismatch'):
            release_stage.stage_ahead(self.own, self.home, self.archive, '0' * 64, run=self.transport, publish=update.publish_release)

    def test_the_staged_release_is_kept_by_the_release_prune(self):
        self.stage_ahead()
        later = time.time() + 2 * release_retention.RECENT_SECONDS  # No longer recent.
        self.assertEqual(release_retention.prune_releases(self.home, [], now=later), [])  # Named by the record only.
        self.assertTrue(self.published().is_dir())
        release_stage.forget(self.own, self.home, self.sha)
        self.assertEqual(release_retention.prune_releases(self.home, [], now=later), [self.sha[:20]])

    def test_staging_a_newer_release_removes_the_one_staged_before(self):
        first = self.stage_ahead()
        installed = pathlib.Path(self.oldrelease)
        self.archive = self.home / 'archive-b.tgz'; self.archive.write_bytes(b'verified-synthetic-archive-b')
        self.sha = update.digest(self.archive.read_bytes())
        second = self.stage_ahead()
        self.assertNotEqual(first['release'], second['release'])
        self.assertFalse(pathlib.Path(first['release']).exists())  # Nothing names it any more.
        self.assertTrue(self.published().is_dir() and installed.is_dir())
        self.assertEqual(sorted(path.name for path in studio_paths.releases_root(self.home).iterdir()),
                         sorted([installed.name, self.sha[:20]]))
        self.assertTrue(release_stage.staged(self.own, self.home, self.sha, self.published()))

    def test_a_superseded_release_another_identity_names_stays(self):
        first = self.stage_ahead()
        other = self.own.parent / 'm1'; other.mkdir()
        (other / 'launch.sh').write_text('exec node ' + first['release'] + '/bin.mjs start\n')
        self.archive = self.home / 'archive-b.tgz'; self.archive.write_bytes(b'verified-synthetic-archive-b')
        self.sha = update.digest(self.archive.read_bytes())
        self.stage_ahead()
        self.assertTrue(pathlib.Path(first['release']).is_dir())
        self.assertTrue(self.published().is_dir())

    def test_restaging_the_same_release_keeps_it(self):
        self.stage_ahead()
        record = self.stage_ahead()
        self.assertTrue(self.published().is_dir())
        self.assertTrue(release_stage.staged(self.own, self.home, self.sha, pathlib.Path(record['release'])))

    def test_the_command_line_stages_ahead_and_prints_the_record(self):
        argv = ['update.py', '--identity', 'm4', '--stage-release', '--archive', str(self.archive), '--sha256', self.sha]
        owner = mock.Mock(own=self.own, home=self.home)
        with mock.patch.object(sys, 'argv', argv), mock.patch.object(update, 'InstallationDescriptor', return_value=owner), \
                mock.patch.object(update, 'run', side_effect=self.transport), mock.patch('builtins.print') as printed:
            update.main()
        self.assertEqual(json.loads(printed.call_args[0][0])['release'], str(self.published()))


class VerifiedBeforeCleanup(updater_base.ApplyRecovery):
    def test_verified_progress_and_an_open_gate_come_before_the_cleanup(self):
        seen = {}

        def prune(home, keep):
            seen['progress'] = json.loads((self.own / 'updates' / install_progress.FILE).read_text())['result']
            seen['gate'] = (self.own / 'updates' / update.INSTALL_GATE_FILE).exists()
            seen['receipt'] = json.loads(self.output.read_text())['phase']
            return []
        with mock.patch.object(update, 'prune_releases', side_effect=prune):
            self.execute()
        self.assertEqual(seen, {'progress': 'verified', 'gate': False, 'receipt': 'verified'})
        result = json.loads(self.output.read_text())
        self.assertIn('cleanup', result['timings'])
        for key in ('verifiedAt', 'serviceRestartBeganAt', 'restartStartedAt'):
            self.assertIsNotNone(update_service._utc(result[key]), key)
        # The real restart began after the heartbeat window opened and before the update was verified.
        self.assertLessEqual(result['restartStartedAt'], result['serviceRestartBeganAt'])
        self.assertLessEqual(result['serviceRestartBeganAt'], result['verifiedAt'])

    def test_a_failing_cleanup_leaves_the_update_verified(self):
        with mock.patch.object(update, 'prune_update_leftovers', side_effect=OSError('disk')):
            self.execute()
        result = json.loads(self.output.read_text())
        self.assertEqual((result['phase'], result['cleanupError']), ('verified', 'OSError'))
        self.assertEqual(self.restores, [])
        self.assertIn(self.sha[:20], (self.own / 'launch.sh').read_text())


class Held(unittest.TestCase):
    """A service held for the forced request in config.json, as test-update.py's GateSettle sets up."""
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='studio-restart-speed-')
        self.addCleanup(temp.cleanup)
        self.home = pathlib.Path(temp.name).resolve()
        self.own = self.home / '.specwithcode/m4'
        (self.own / 'updates').mkdir(parents=True)
        (self.own / 'userdata').mkdir(parents=True)
        self.now = datetime.datetime.now(datetime.timezone.utc)

    def hold(self, began, requested):
        at = lambda seconds: (self.now + datetime.timedelta(seconds=seconds)).isoformat().replace('+00:00', 'Z')
        write = lambda name, **value: (self.own / name).write_text(json.dumps(value))
        write('userdata/server-runtime.json', pid=100, host='127.0.0.1', port=8319, startedAt=at(-600))
        write('updates/hold.json', schemaVersion=1, holdId='h', pid=100, startedAt=at(began), expiresAt=at(600))
        write('updates/config.json', installMode='force', installRequestedAt=at(requested), installCancelledAt=None)
        return at(requested)


class GateAcknowledgement(Held):
    def gate(self):
        return {'helperPid': 4321, 'at': '2026-10-30T12:00:00.123456+00:00'}

    def ack(self, **changes):
        value = {'schemaVersion': 1, 'servicePid': 100, 'helperPid': 4321, 'gateAt': '2026-10-30T12:00:00.123456+00:00',
                 'at': '2026-10-30T12:00:00.2Z', **changes}
        (self.own / 'updates' / update_service.INSTALL_GATE_ACK_FILE).write_text(json.dumps(value))

    def wait(self, gate, on_sleep=None):
        clock, sleeps = [0.0], []

        def sleep(seconds):
            sleeps.append(seconds)
            clock[0] += seconds
            if on_sleep:
                on_sleep(len(sleeps))
        answered = update_service.await_gate_ack(self.own, self.home, 100, gate, 2, clock=lambda: clock[0], sleep=sleep)
        return answered, round(clock[0], 3)

    def test_an_acknowledged_gate_ends_the_settle_at_once(self):
        self.ack()
        self.assertEqual(self.wait(self.gate()), (True, 0.0))

    def test_the_settle_ends_when_the_service_answers(self):
        self.assertEqual(self.wait(self.gate(), on_sleep=lambda count: count == 3 and self.ack()), (True, 0.15))

    def test_a_service_that_never_answers_gets_the_whole_settle(self):
        self.assertEqual(self.wait(self.gate()), (False, 2.0))
        for changes in ({'servicePid': 101}, {'gateAt': '2026-10-30T11:59:00+00:00'}, {'helperPid': 1}, {'schemaVersion': 2}):
            with self.subTest(changes=changes):
                self.ack(**changes)  # Another service, an earlier gate or another helper's answers nothing here.
                self.assertEqual(self.wait(self.gate()), (False, 2.0))
        self.ack()
        self.assertEqual(self.wait(None), (False, 2.0))  # No gate was written: nothing can answer it.

    def test_the_helper_waits_for_an_answer_only_while_the_service_is_held(self):
        self.hold(began=-60, requested=-30)
        self.assertEqual(update.gate_settle(self.own, self.home, 100, update.INSTALL_GATE_SETTLE_SECONDS), ('held', 2))
        self.assertEqual(update.gate_settle(self.own, self.home, 101, update.INSTALL_GATE_SETTLE_SECONDS), ('full', 12))

    def test_clearing_the_gate_removes_the_answer_too(self):
        update.write_install_gate(self.own, self.home)
        self.ack()
        update.clear_install_gate(self.own, self.home)
        self.assertEqual(sorted(path.name for path in (self.own / 'updates').iterdir()), [])


class SnapshotSettle(Held):
    def settles(self, request):
        owner = mock.Mock(own=self.own, home=self.home)
        with mock.patch.object(update, 'InstallationDescriptor', return_value=owner):
            return update.snapshot_settles('m4', request)

    def test_a_snapshot_under_an_older_hold_skips_the_marker_settle(self):
        request = self.hold(began=-60, requested=-30)
        self.assertFalse(self.settles(request))

    def test_a_fresh_hold_another_request_or_none_still_settles(self):
        request = self.hold(began=-1, requested=0)
        self.assertTrue(self.settles(request))  # Compaction may have started a delete just before the hold.
        self.hold(began=-60, requested=-30)
        self.assertTrue(self.settles('2026-10-30T00:00:00Z'))
        self.assertTrue(self.settles(None))
        (self.own / 'updates/hold.json').unlink()
        self.assertTrue(self.settles(request))


class HeldRetries(unittest.TestCase):
    def agent(self, mode='force'):
        return mock.Mock(spec=['config'], config={'installMode': mode, 'installRequestedAt': '2026-10-30T12:00:00Z'})

    def test_a_forced_request_retries_sooner_at_first_in_each_window(self):
        agent, refused, window = self.agent(), ('waiting-for-quiet', 'Native work is not idle'), object()
        waits = [update_agent_reap._retry_wait(agent, update_agent, refused, window) for _ in range(5)]
        self.assertEqual(waits, [1, 2, 2, update_agent.RETRY_SECONDS, update_agent.RETRY_SECONDS])
        # A refused apply opens a new window: its first retries come sooner again.
        self.assertEqual(update_agent_reap._retry_wait(agent, update_agent, refused, object()), 1)
        agent.config['installRequestedAt'] = '2026-10-30T12:05:00Z'  # So does a newer request.
        self.assertEqual(update_agent_reap._retry_wait(agent, update_agent, refused, window), 1)

    def test_other_requests_and_refusals_keep_the_whole_wait(self):
        window = object()
        self.assertEqual(update_agent_reap._retry_wait(self.agent('normal'), update_agent, ('waiting-for-quiet', 'x'), window),
                         update_agent.RETRY_SECONDS)
        self.assertEqual(update_agent_reap._retry_wait(self.agent(), update_agent, ('error', 'x'), window), update_agent.RETRY_SECONDS)


class FreshCheck(unittest.TestCase):
    def agent(self, checked):
        agent = mock.Mock(spec=['state'])
        agent.state = {'checkedAt': update_agent.iso(update_agent.utcnow() - checked) if checked is not None else None}
        type(agent).__module__ = update_agent.__name__
        return agent

    def test_a_recent_check_of_the_requested_release_stands(self):
        meta = {'version': '0.2.0'}
        self.assertTrue(update_agent_run.fresh_check(self.agent(datetime.timedelta(minutes=9)), meta, '0.2.0'))
        for checked, wanted in ((datetime.timedelta(minutes=11), '0.2.0'), (None, '0.2.0'),
                                (datetime.timedelta(minutes=-5), '0.2.0'), (datetime.timedelta(0), '0.3.0'),
                                (datetime.timedelta(0), None)):
            with self.subTest(checked=checked, wanted=wanted):
                self.assertFalse(update_agent_run.fresh_check(self.agent(checked), meta, wanted))
        self.assertFalse(update_agent_run.fresh_check(self.agent(datetime.timedelta(0)), None, '0.2.0'))


class AgentPrestage(agent_tests.AgentCase):
    def test_a_download_is_staged_ahead_by_the_verified_helper(self):
        info = self.fake.add_release()
        self.config(installAutomatically=False)
        self.assertEqual(self.run_agent(), 0)
        # The fake helper predates --stage-release and refuses it: the pass still ends downloaded.
        self.assertEqual(self.state()['status'], 'downloaded')
        argv = [call['argv'] for call in self.calls()]
        runtime = self.updates / 'downloads' / '0.2.0' / info['runtime']
        self.assertEqual(argv, [['--identity', 'm4', '--stage-release', '--archive', str(runtime), '--sha256', info['runtimeSha']]])
        self.assertEqual(self.run_agent(), 0)  # A pass that downloads nothing stages nothing.
        self.assertEqual(len(self.calls()), 1)

    def test_a_pending_check_request_beside_the_install_request_asks_github_nothing_more(self):
        self.fake.add_release()
        self.config(installAutomatically=False)
        self.assertEqual(self.run_agent(), 0)
        requests = len(self.fake.requests)
        now = update_agent.iso(update_agent.utcnow())
        self.config(installAutomatically=False, quietMinutes=60, checkRequestedAt=now, installRequestedAt=now,
                    installMode='force', installHoldUntil=agent_tests.later(15), installRequest={'at': now, 'version': '0.2.0'})
        self.assertEqual(self.run_agent(), 0, self.log)
        self.assertEqual(self.fake.requests[requests:], [])  # Neither the release list nor an asset.
        state = self.state()
        self.assertEqual((state['handledCheckRequestAt'], state['handledInstallRequestAt']), (now, now))
        self.assertEqual(state['status'], 'installed')

if __name__ == '__main__':
    unittest.main()
