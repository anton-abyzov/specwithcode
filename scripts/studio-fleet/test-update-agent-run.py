#!/usr/bin/env python3
"""Update agent tests for updates/run.json (0988): the agent claims the run the desktop created,
keeps its lease fresh with a heartbeat, retries until the run's deadline (the one clock), ends it
as verified, failed or cancelled, and advertises runSupport. Reuses test-update-agent.py's
temporary homes, loopback fake GitHub API and fake helper.

Run: cd scripts/studio-fleet && python3 -B test-update-agent-run.py
Nothing here touches a real Studio home, launchd, GitHub or gh.
"""
import datetime
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import types
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import update_agent  # noqa: E402
import update_agent_run as runs  # noqa: E402
import update_request  # noqa: E402

_spec = importlib.util.spec_from_file_location('agent_tests_for_runs', str(HERE / 'test-update-agent.py'))
agent_tests = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(agent_tests)
AgentCase, later = agent_tests.AgentCase, agent_tests.later

RUN_ID = '6f1c2a34-7d1e-4f5a-9b2c-0e1d2c3b4a59'


def iso_in(minutes=0, seconds=0):
    return (datetime.datetime.now(datetime.timezone.utc)
            + datetime.timedelta(minutes=minutes, seconds=seconds)).isoformat().replace('+00:00', 'Z')


class RunCase(AgentCase):
    def write_run(self, **values):
        self.updates.mkdir(mode=0o700, exist_ok=True)
        record = {'schemaVersion': 1, 'runId': RUN_ID, 'rev': 1, 'createdAt': iso_in(), 'createdBy': 'desktop',
                  'targetVersion': '0.2.0', 'fromVersion': '0.1.4', 'appTargetVersion': None,
                  'requestedAt': self.requested, 'deadlineAt': iso_in(minutes=30), 'phase': 'requested',
                  'owner': None, 'heartbeatAt': None, 'leaseUntil': None, 'message': None, 'receipt': None,
                  'endedAt': None}
        record.update(values)
        (self.updates / 'run.json').write_text(json.dumps(record))
        return record

    def run_record(self):
        return json.loads((self.updates / 'run.json').read_text())

    def request(self, run_id=RUN_ID, requested=None, **values):
        requested = requested or self.requested
        values.setdefault('installHoldUntil', iso_in(minutes=30))
        self.config(installAutomatically=False, quietMinutes=60, installMode='force', installRequestedAt=requested,
                    installRequest={'at': requested, 'version': '0.2.0'}, installRunId=run_id, **values)

    def setUp(self):
        super().setUp()
        # Requests are dated "now" so REQUEST_TTL alone never decides them, unless a test says so.
        self.requested = iso_in()


class Claim(RunCase):
    def test_a_matching_run_is_claimed_and_ends_verified_with_its_receipt(self):
        self.fake.add_release()
        self.write_run()
        self.request()
        self.assertEqual(self.run_agent(), 0)
        record = self.run_record()
        self.assertEqual(self.state()['status'], 'installed')
        self.assertEqual(record['phase'], 'verified')
        self.assertIsNone(record['owner'])
        self.assertEqual(record['receipt'], self.state()['lastInstall']['receipt'])
        self.assertIsNotNone(record['endedAt'])
        self.assertGreater(record['rev'], 1)

    def test_a_run_another_request_names_is_never_claimed(self):
        self.fake.add_release()
        before = self.write_run()
        self.request(run_id='0f0f0f0f-0000-4000-8000-000000000000')
        self.run_agent()
        self.assertEqual(self.run_record(), before)  # Not ours: untouched.
        self.assertEqual(self.state()['status'], 'installed')  # The request itself is served as before runs.

    def test_a_run_for_another_request_time_is_never_claimed(self):
        self.fake.add_release()
        before = self.write_run(requestedAt=iso_in(seconds=-30))
        self.request()
        self.run_agent()
        self.assertEqual(self.run_record(), before)

    def test_a_terminal_run_is_never_claimed_or_rewritten(self):
        self.fake.add_release()
        for phase in runs.TERMINAL:
            with self.subTest(phase=phase):
                before = self.write_run(phase=phase, endedAt=iso_in())
                self.request()
                self.run_agent()
                self.assertEqual(self.run_record(), before)

    def test_a_fresh_lease_of_another_owner_is_respected(self):
        self.fake.add_release()
        before = self.write_run(owner={'kind': 'agent', 'pid': os.getpid() + 1, 'agentVersion': 1,
                                       'claimedAt': iso_in()}, leaseUntil=iso_in(seconds=60), phase='waiting')
        self.request()
        self.run_agent()
        self.assertEqual(self.run_record(), before)
        # A lapsed lease is taken over.
        self.write_run(owner=before['owner'], leaseUntil=iso_in(seconds=-1), phase='waiting')
        self.request()
        self.state_reset()
        self.run_agent()
        self.assertEqual(self.run_record()['phase'], 'verified')

    def state_reset(self):
        path = self.updates / 'state.json'
        if path.exists():
            path.unlink()

    def test_without_install_run_id_the_pass_runs_as_before(self):
        self.fake.add_release()
        self.write_run()
        self.request(run_id=None)
        self.run_agent()
        self.assertEqual(self.run_record()['phase'], 'requested')
        self.assertEqual(self.state()['status'], 'installed')

    def test_a_malformed_run_id_is_refused_as_invalid_settings(self):
        self.request(run_id='../../etc')
        self.assertEqual(self.run_agent(), 1)
        self.assertEqual(self.state()['message'], 'Update settings are invalid')


class Lease(RunCase):
    def test_the_heartbeat_advances_while_the_helper_applies(self):
        self.fake.add_release()
        self.write_run()
        self.request()
        self.control(applySleep=1.2)
        seen = []
        real = runs.Run.renew

        def renew(run, record):
            real(run, record)
            seen.append((record['phase'], record['heartbeatAt']))
        with mock.patch.object(runs, 'HEARTBEAT_SECONDS', 0.1), mock.patch.object(runs.Run, 'renew', renew):
            self.run_agent()
        installing = [beat for phase, beat in seen if phase == 'installing']
        self.assertGreaterEqual(len(installing), 5)  # Renewed during the apply, not only at status changes.
        self.assertEqual(len(set(installing)), len(installing))
        self.assertEqual(self.run_record()['phase'], 'verified')

    def test_mirrors_waiting_then_installing(self):
        self.fake.add_release()
        self.write_run()
        self.request()
        self.control(snapshotFailures=1)
        phases = []
        self.on_sleep = lambda: phases.append((self.run_record()['phase'], self.run_record()['message']))
        self.run_agent()
        self.assertEqual(phases, [('waiting', 'Waiting for running tasks, queued messages and open questions to finish (attempt 1)')])
        self.assertEqual(self.run_record()['phase'], 'verified')

    def test_an_apply_timeout_keeps_the_run_installing_without_an_owner(self):
        self.fake.add_release()
        self.write_run()
        self.request()
        self.control(applySleep=3)
        with mock.patch.object(update_agent, 'APPLY_TIMEOUT', 1):
            self.run_agent()
        record = self.run_record()
        self.assertEqual(record['phase'], 'installing')
        self.assertIsNone(record['owner'])
        self.assertLessEqual(update_agent.parse_time(record['leaseUntil']), update_agent.utcnow())
        self.assertIsNone(record['endedAt'])
        # The next pass settles the interrupted install and ends the run.
        import time
        time.sleep(2.5)
        self.run_agent()
        self.assertEqual(self.run_record()['phase'], 'verified')


class OneClock(RunCase):
    def test_the_retry_window_is_the_run_deadline_not_the_hold_or_force_window(self):
        self.fake.add_release()
        self.write_run(deadlineAt=iso_in(minutes=3))
        self.request(installHoldUntil=iso_in(minutes=1))
        self.control(snapshotFail=True)
        with mock.patch.object(update_agent, 'FORCE_WINDOW', datetime.timedelta(minutes=1)):
            self.run_agent()
        self.assertGreater(self.offset, datetime.timedelta(minutes=2))
        self.assertLessEqual(self.offset, datetime.timedelta(minutes=3))
        record = self.run_record()
        self.assertEqual(record['phase'], 'failed')  # The owner decides: its deadline passed before the apply.
        self.assertIn('Waiting for running tasks', record['message'])
        self.assertEqual(self.state()['handledInstallRequestAt'], self.requested)  # It never installs later on its own.

    def test_the_request_ttl_extends_to_the_run_deadline(self):
        self.fake.add_release()
        old = iso_in(minutes=-20)
        self.write_run(requestedAt=old, deadlineAt=iso_in(minutes=10))
        self.request(requested=old)
        self.run_agent()
        self.assertEqual(self.state()['status'], 'installed')
        self.assertEqual(self.run_record()['phase'], 'verified')
        state = {'handledInstallRequestAt': None}
        config = {'installRequestedAt': old, 'installRequest': {'at': old, 'version': '0.2.0'}}
        now = update_agent.utcnow()
        self.assertEqual(update_request._verdict(config, dict(state), None, now, lambda c: False), (False, update_request.EXPIRED))
        self.assertEqual(update_request._verdict(config, dict(state), None, now, lambda c: False,
                                                 ttl_until=now + datetime.timedelta(minutes=1)), (True, None))

    def test_a_cancel_ends_the_run_cancelled(self):
        self.fake.add_release()
        self.write_run()
        self.request()
        self.control(snapshotFail=True)
        self.on_sleep = lambda: self.request(installCancelledAt=later(seconds=1))
        self.run_agent()
        record = self.run_record()
        self.assertEqual((record['phase'], record['message']), ('cancelled', update_agent.CANCELLED))
        self.assertEqual(self.apply_calls(), [])

    def test_a_failed_install_ends_the_run_failed(self):
        self.fake.add_release()
        self.write_run()
        self.request()
        self.control(applyFail=True)
        self.run_agent()
        record = self.run_record()
        self.assertEqual(record['phase'], 'failed')
        self.assertIn('did not install', record['message'])
        self.assertEqual(record['receipt'], self.state()['lastInstall']['receipt'])

    def test_a_fleet_or_cli_request_for_a_newer_release_as_the_install_starts_ends_the_run_replaced(self):
        """A request from the fleet or the CLI (no run: a press while a run is live only follows it) for a
        release published after the pass checked, written as the pass starts installing the run's release: the
        pass leaves the newer request pending, as when it comes during a snapshot, and ends the run cancelled,
        naming that release, never failed: the next pass installs the newer release."""
        self.fake.add_release()
        self.write_run()
        self.request()
        self.control(newVersion='0.3.0')
        set_status, newer = update_agent.Agent.set_status, {}

        def status_as_a_newer_request_arrives(agent, status, message=None):
            set_status(agent, status, message)
            if status == 'installing' and not newer:
                self.fake.add_release('0.3.0')
                newer['at'] = iso_in(seconds=30)
                self.config(installAutomatically=False, quietMinutes=60, installMode='force',
                            installRequestedAt=newer['at'], installHoldUntil=iso_in(minutes=15),
                            installRequest={'at': newer['at'], 'version': '0.3.0'})
        with mock.patch.object(update_agent.Agent, 'set_status', status_as_a_newer_request_arrives):
            self.assertEqual(self.run_agent(), 0)
        record = self.run_record()
        self.assertEqual((record['phase'], record['message'], record['owner']),
                         ('cancelled', runs.REPLACED % '0.3.0', None), record)
        self.assertIsNotNone(record['endedAt'])
        state = self.state()
        self.assertEqual((state['status'], state['installedVersion'], state['handledInstallRequestAt']),
                         ('installed', '0.3.0', newer['at']))
        self.assertEqual(len(self.apply_calls()), 1)

    def test_a_request_for_a_newer_release_during_retries_ends_the_run_replaced_for_good(self):
        """A rollout's request for a newer release (no installRunId), written while the pass retries the run's
        request, ends that pass and the run, cancelled and naming that release: config.json no longer names the
        run, so no pass takes it on again, and left open it would wait without an owner until its deadline. It
        stays ended when the next pass refuses that request, as it does for a release not published yet."""
        self.fake.add_release()
        self.write_run()
        self.request()
        self.control(snapshotFailures=1)
        newer = {}

        def write_newer():
            newer['at'] = iso_in(seconds=30)
            self.config(installAutomatically=False, quietMinutes=60, installMode='force',
                        installRequestedAt=newer['at'], installHoldUntil=iso_in(minutes=15),
                        installRequest={'at': newer['at'], 'version': '0.2.1'})
            self.on_sleep = None
        self.on_sleep = write_newer
        self.assertEqual(self.run_agent(), 1)
        record = self.run_record()
        self.assertEqual((record['phase'], record['message'], record['owner']),
                         ('cancelled', runs.REPLACED % '0.2.1', None), record)
        self.assertIsNotNone(record['endedAt'])
        state = self.state()
        self.assertEqual((state['status'], state['handledInstallRequestAt']), ('error', newer['at']))
        self.assertIn('SpecWithCode 0.2.1 was asked for', state['message'])
        self.assertEqual(self.apply_calls(), [])
        self.run_agent()  # The desktop's re-kick: a later pass leaves the ended run as it is.
        self.assertEqual(self.run_record(), record)


class TakenOn(RunCase):
    """A run whose request a pass takes on part way, while it serves an earlier request that names no run
    (a plain request from the fleet or the CLI, which no window follows, so Update now makes a run), and a
    request for the same release that names no run (the fleet asks once more), taken on while a pass owns a run."""

    def at(self, minutes=0):
        """A time on the agent's clock, which the retry sleeps move on."""
        return (update_agent.utcnow() + datetime.timedelta(minutes=minutes)).isoformat().replace('+00:00', 'Z')

    def plain(self, force=False):
        """A request from the fleet or the CLI for the run's release: no run, held 15 minutes when forced."""
        at = self.at()
        self.config(installAutomatically=False, quietMinutes=60, installMode='force' if force else 'normal',
                    installRequestedAt=at, installHoldUntil=self.at(15) if force else None,
                    installRequest={'at': at, 'version': '0.2.0'}, installRunId=None)
        return at

    def press(self, deadline=30):
        """Update now: the window makes the run and asks for its request, held until the run's deadline."""
        self.requested, until = self.at(), self.at(deadline)
        self.write_run(requestedAt=self.requested, deadlineAt=until)
        self.request(installHoldUntil=until)

    def serve_a_plain_request_then_press(self, then=None, deadline=30):
        self.fake.add_release()
        plain = self.plain()
        steps = []

        def on_sleep():
            steps.append(len(steps) + 1)
            if len(steps) == 1:
                self.press(deadline)
            elif then is not None:
                then()
                self.on_sleep = None
        self.on_sleep = on_sleep
        return plain

    def while_the_helper_runs(self, write, minutes):
        """The first apply's helper runs `minutes` (on the agent's clock), and `write` lands as it starts."""
        real, written = runs.apply_env, []

        def apply_env(agent):
            if not written:
                written.append(write())
                self.offset += datetime.timedelta(minutes=minutes)
            return real(agent)
        return mock.patch.object(runs, 'apply_env', apply_env)

    def test_the_pass_claims_the_run_of_a_request_it_takes_on(self):
        self.control(snapshotFailures=1)
        self.serve_a_plain_request_then_press()
        self.assertEqual(self.run_agent(), 0)
        record = self.run_record()
        self.assertEqual((record['phase'], record['owner']), ('verified', None), record)
        self.assertEqual(record['receipt'], self.state()['lastInstall']['receipt'])
        self.assertEqual(self.state()['handledInstallRequestAt'], self.requested)

    def test_a_newer_releases_request_ends_a_run_taken_on_part_way(self):
        """The run is this pass's once it takes the run's request on, so a request for a newer release that
        ends the pass ends that run too, instead of leaving it live for a later install to mark it verified."""
        self.control(snapshotFailures=2, newVersion='0.3.0')
        newer = {}

        def write_newer():
            self.fake.add_release('0.3.0')
            newer['at'] = iso_in(seconds=30)
            self.config(installAutomatically=False, quietMinutes=60, installMode='force',
                        installRequestedAt=newer['at'], installHoldUntil=iso_in(minutes=15),
                        installRequest={'at': newer['at'], 'version': '0.3.0'})
        self.serve_a_plain_request_then_press(then=write_newer)
        self.assertEqual(self.run_agent(), 0)
        record = self.run_record()
        self.assertEqual((record['phase'], record['message'], record['owner']),
                         ('cancelled', runs.REPLACED % '0.3.0', None), record)
        state = self.state()
        self.assertEqual((state['status'], state['installedVersion'], state['handledInstallRequestAt']),
                         ('installed', '0.3.0', newer['at']))

    def assert_failed_once(self, again):
        """The run ended failed with the pass; the request the pass took on since keeps that failure as its
        answer instead of the run's request, so no later pass installs the release that failed again."""
        record = self.run_record()
        self.assertEqual((record['phase'], record['owner']), ('failed', None), record)
        self.assertIn('did not install', record['message'])
        self.assertEqual(self.state()['handledInstallRequestAt'], again['at'])
        self.offset += datetime.timedelta(minutes=1)
        self.run_agent()
        self.assertEqual(len(self.apply_calls()), 1)

    def test_a_same_release_request_taken_on_after_the_run_keeps_its_failure(self):
        self.control(snapshotFailures=2, applyRolledBack=1)
        again = {}
        self.serve_a_plain_request_then_press(then=lambda: again.update(at=self.plain()))
        self.run_agent()
        self.assert_failed_once(again)

    def test_a_same_release_request_taken_on_after_a_run_claimed_at_the_start_keeps_its_failure(self):
        self.fake.add_release()
        self.press()
        self.control(snapshotFailures=1, applyRolledBack=1)
        again = {}

        def ask_again():
            again['at'] = self.plain()
            self.on_sleep = None
        self.on_sleep = ask_again
        self.run_agent()
        self.assert_failed_once(again)

    def test_a_forced_request_taken_on_after_the_run_keeps_its_held_window(self):
        """The fleet asks once more, forced, after the pass took on a run with 2 minutes to go: the pass
        retries that request through its own window, not only until the run's deadline, and ends the run."""
        self.control(snapshotFail=True)
        again = {}

        def ask_again():
            again['at'], again['offset'] = self.plain(force=True), self.offset
        self.serve_a_plain_request_then_press(then=ask_again, deadline=2)
        with mock.patch.object(update_agent, 'FORCE_WINDOW', datetime.timedelta(minutes=6)):
            self.run_agent()
        served = self.offset - again['offset']
        self.assertGreater(served, datetime.timedelta(minutes=5), served)
        self.assertLessEqual(served, datetime.timedelta(minutes=6), served)
        record = self.run_record()
        self.assertEqual((record['phase'], record['owner']), ('failed', None), record)

    def test_a_plain_request_taken_on_after_the_run_is_retried_as_long_as_the_presss_hold(self):
        """The fleet asks once more without force (a 2-minute window) after the pass took on a run with 6
        minutes to go. The service's hold, taken for the press just before its request was written, times a
        plain request from its own start (HOLD_TTL_MS, FORCE_WINDOW here) and reads a waiting-for-quiet as the
        give-up only from RETRY_SECONDS before then: the pass retries it until FORCE_WINDOW after the press,
        past its own window and the run's deadline, so the hold ends with the pass instead of staying on.
        The run ends with the pass instead of being left live and ownerless, which no later pass claims."""
        self.control(snapshotFail=True)
        again = {}

        def ask_again():
            again['at'] = self.plain()
        self.serve_a_plain_request_then_press(then=ask_again, deadline=6)
        with mock.patch.object(update_agent, 'FORCE_WINDOW', datetime.timedelta(minutes=8)):
            self.run_agent()
        state, pressed = self.state(), update_agent.parse_time(self.requested)
        gave_up = update_agent.parse_time(state['updatedAt'])
        self.assertEqual((state['status'], state['answeredInstallRequestAt']), ('waiting-for-quiet', again['at']))
        self.assertGreaterEqual(gave_up, pressed + datetime.timedelta(minutes=8, seconds=-update_agent.RETRY_SECONDS))
        self.assertLessEqual(gave_up, pressed + datetime.timedelta(minutes=8))
        record = self.run_record()
        self.assertEqual((record['phase'], record['message'], record['owner']),
                         ('failed', state['message'], None), record)

    def test_a_runs_request_taken_on_part_way_lapses_at_the_runs_deadline(self):
        """Update now pressed as the helper starts applying a fleet request, which it refuses before the
        restart 12 minutes later: the run's request, older than REQUEST_TTL by then, is judged by the run's
        deadline, as at the start of a pass, so the pass claims the run and installs."""
        self.fake.add_release()
        self.plain(force=True)
        self.control(applyRefusals=1)
        with self.while_the_helper_runs(self.press, 12):
            self.assertEqual(self.run_agent(), 0)
        record = self.run_record()
        self.assertEqual((record['phase'], record['owner']), ('verified', None), record)
        self.assertEqual(self.state()['handledInstallRequestAt'], self.requested)
        self.assertEqual(len(self.apply_calls()), 2)

    def test_a_runs_request_taken_on_past_its_deadline_ends_the_run_with_the_reason(self):
        """As above, with the run's deadline passed by then: this pass claims the run and ends it failed,
        saying the request expired, instead of leaving it for a later pass to fail without a reason."""
        self.fake.add_release()
        self.plain(force=True)
        self.control(applyRefusals=1)
        with self.while_the_helper_runs(lambda: self.press(deadline=10), 12):
            self.assertEqual(self.run_agent(), 1)
        record = self.run_record()
        self.assertEqual((record['phase'], record['message'], record['owner']),
                         ('failed', update_request.EXPIRED, None), record)
        self.assertEqual(len(self.apply_calls()), 1)

    def test_a_same_release_request_taken_on_while_a_run_is_owned_keeps_its_own_life(self):
        """The CLI asks once more as the helper starts applying the run's request, which it refuses before
        the restart 12 minutes later: that request, older than REQUEST_TTL by then, lapses as it would
        without the run, instead of being served under the run's deadline past the window the service's
        hold gives it, and the run ends with the pass, saying why."""
        self.fake.add_release()
        self.press()
        self.control(applyRefusals=1)
        again = {}
        with self.while_the_helper_runs(lambda: again.update(at=self.plain()), 12):
            self.assertEqual(self.run_agent(), 1)
        record = self.run_record()
        self.assertEqual((record['phase'], record['message'], record['owner']),
                         ('failed', update_request.EXPIRED, None), record)
        self.assertEqual(self.state()['handledInstallRequestAt'], again['at'])
        self.assertEqual(len(self.apply_calls()), 1)

    def test_a_far_future_request_taken_on_while_a_run_is_owned_is_settled(self):
        """A request dated far ahead (a broken clock or writer), taken on while the pass owns a run, is
        settled as it would be without the run, instead of failing the pass on its date."""
        self.fake.add_release()
        self.press()
        self.control(snapshotFailures=1)
        far = '9999-12-31T23:59:59.000Z'

        def write_far():
            self.config(installAutomatically=False, quietMinutes=60, installMode='normal', installRequestedAt=far,
                        installHoldUntil=None, installRequest={'at': far, 'version': '0.2.0'}, installRunId=None)
            self.on_sleep = None
        self.on_sleep = write_far
        self.assertEqual(self.run_agent(), 0)
        state = self.state()
        self.assertEqual((state['status'], state['handledInstallRequestAt']), ('downloaded', far), state)
        record = self.run_record()
        self.assertEqual((record['phase'], record['owner']), ('failed', None), record)
        self.assertIn('did not install', record['message'])

    def test_a_same_release_request_taken_on_past_the_runs_deadline_keeps_its_own_life(self):
        """As above, with a run 5 minutes from its deadline and a helper that runs 7: the fleet's request,
        7 minutes old, is served within its own 10 minutes though the run's deadline has passed."""
        self.fake.add_release()
        self.press(deadline=5)
        self.control(applyRefusals=1)
        again = {}
        with self.while_the_helper_runs(lambda: again.update(at=self.plain()), 7):
            self.assertEqual(self.run_agent(), 0)
        self.assertEqual(self.run_record()['phase'], 'verified')
        self.assertEqual(self.state()['handledInstallRequestAt'], again['at'])
        self.assertEqual(len(self.apply_calls()), 2)


def _retry_deadline_before_this_module(agent, started, applied=False):
    """Agent.retry_deadline as update_agent.py had it from 1.0.69 to 1.0.112, and on main after."""
    if runs.retry_until(agent) is not None:
        return runs.retry_until(agent)  # A run's one clock.
    hold = update_agent.parse_time(agent.config['installHoldUntil']) if agent.config['installMode'] == 'force' else None
    return min(hold, started + update_agent.FORCE_WINDOW) if hold else started + update_agent.REQUEST_WINDOW


class OlderAgentScript(RunCase):
    """install_launch_agent writes the companion modules before update_agent.py, so an install cut off part
    way (a full disk, its timeout, a crash) leaves an older update_agent.py beside this module, and the
    desktop starts a pass of it anyway. That script asks retry_until with no window of its own."""

    def test_retry_until_asked_without_a_window_answers_as_it_did(self):
        deadline = update_agent.utcnow()
        agent = types.SimpleNamespace(run=None, config={'installRequestedAt': 'fleet'})
        self.assertIsNone(runs.retry_until(agent))
        agent.run = types.SimpleNamespace(deadline=deadline, requested_at='press')
        self.assertEqual(runs.retry_until(agent), deadline)
        agent.config['installRequestedAt'] = 'press'
        self.assertEqual(runs.retry_until(agent), deadline)

    def test_an_older_script_retries_a_runs_request_and_installs(self):
        self.fake.add_release()
        self.write_run()
        self.request()
        self.control(snapshotFailures=1)
        with mock.patch.object(update_agent.Agent, 'retry_deadline', _retry_deadline_before_this_module):
            self.assertEqual(self.run_agent(), 0)
        self.assertEqual((self.run_record()['phase'], self.state()['status']), ('verified', 'installed'))

    def test_the_release_an_older_scripts_pass_before_named_does_not_replace_its_own_run(self):
        """Its run_once resets only state (and serving) between passes, so the release whose request ended its
        first pass is still named as its second claims that release's own run, which no newer one replaced: the
        run ends as the pass decided it, failed here (with Try again), not cancelled as replaced by itself."""
        self.fake.add_release()
        self.write_run(deadlineAt=iso_in(minutes=2))
        self.request(installHoldUntil=iso_in(minutes=2))
        self.control(snapshotFail=True)
        claim = runs.claim

        def claim_after_a_pass_that_named_it(agent):
            agent.newer_release = '0.2.0'
            return claim(agent)
        with mock.patch.object(runs, 'claim', claim_after_a_pass_that_named_it):
            self.run_agent()
        record = self.run_record()
        self.assertEqual((record['phase'], record['owner']), ('failed', None), record)

    def test_an_older_script_retries_a_request_without_a_run_and_installs(self):
        self.fake.add_release()
        self.config(installAutomatically=False, quietMinutes=60, installMode='force', installRequestedAt=self.requested,
                    installHoldUntil=iso_in(minutes=15), installRequest={'at': self.requested, 'version': '0.2.0'},
                    installRunId=None)
        self.control(snapshotFailures=1)
        with mock.patch.object(update_agent.Agent, 'retry_deadline', _retry_deadline_before_this_module):
            self.assertEqual(self.run_agent(), 0)
        self.assertEqual(self.state()['status'], 'installed')


class Handshake(RunCase):
    def test_state_advertises_run_support_and_keeps_it_on_reload(self):
        self.fake.add_release()
        self.config(checkAutomatically=True, installAutomatically=False)
        self.run_agent()
        self.assertEqual(self.state()['runSupport'], runs.RUN_SUPPORT)
        # An older agent rewrote state.json without the key: the next pass puts it back.
        state = self.state()
        del state['runSupport']
        (self.updates / 'state.json').write_text(json.dumps(state))
        self.run_agent()
        self.assertEqual(self.state()['runSupport'], 1)

    def test_status_reports_run_support(self):
        self.config()
        self.run_agent()
        self.log = ''
        self.run_agent('--status')
        self.assertEqual(json.loads(self.log)['runSupport'], 1)

    def test_a_headless_request_clears_a_desktop_run_id(self):
        self.request()
        written = update_request.write_request(self.home, 'm4', '0.2.0', force=True, hold_minutes=5)
        self.assertNotIn('installRunId', written)
        self.assertIsNone(json.loads((self.updates / 'config.json').read_text())['installRunId'])


class StampedLog(RunCase):
    def test_pass_lines_carry_a_timestamp_and_install_mode_json_stays_plain(self):
        self.config(checkAutomatically=False)
        self.run_agent()
        line = self.log.strip().splitlines()[-1]
        self.assertRegex(line, r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ update-agent m4: disabled')
        self.log = ''
        self.run_agent('--status')
        json.loads(self.log)  # --status prints plain JSON.
        self.assertEqual(runs.stamp('x', datetime.datetime(2026, 10, 21, 12, 0, 1, tzinfo=datetime.timezone.utc)),
                         '2026-10-21T12:00:01Z x')

    def test_errors_on_stderr_are_stamped_in_pass_mode(self):
        (self.own / 'installation.json').write_text('{}')
        self.run_agent()
        self.assertTrue(re.search(r'^\d{4}-\d\d-\d\dT\S+Z update-agent m4: error: ', self.log, re.M), self.log)


class HelperDiskIo(unittest.TestCase):
    """The apply and a held snapshot leave the agent's LowPriorityIO disk throttle (normal_disk_io).
    Beside BackgroundPriorityTests in test-update-agent.py, which is over the file-size cap."""

    def test_apply_and_held_snapshot_children_leave_the_disk_throttle(self):
        """launchd's LowPriorityIO runs the agent at IOPOL_THROTTLE (3), which children inherit; an apply
        and a held snapshot, which a person waits for, run at IOPOL_DEFAULT (0), every other child keeps it."""
        probe = 'import ctypes,sys;sys.stdout.write(str(ctypes.CDLL(None).getiopolicy_np(0,0)))'
        script = ('import ctypes,subprocess,sys;sys.path.insert(0,%r);assert ctypes.CDLL(None).setiopolicy_np(0,0,3)==0;'
                  'import update_agent;'
                  'run=lambda fn:subprocess.run([sys.executable,"-c",%r],capture_output=True,text=True,preexec_fn=fn).stdout;'
                  'sys.stdout.write(run(update_agent.leave_background)+" "+run(update_agent.leave_background_io))'
                  ) % (str(pathlib.Path(update_agent.__file__).parent), probe)
        result = subprocess.run([sys.executable, '-c', script], capture_output=True, text=True, timeout=300)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '3 0')

    def test_only_normal_io_children_leave_the_disk_throttle(self):
        calls = []
        def record(*args, **kwargs):
            calls.append(kwargs.get('preexec_fn'))
            raise OSError('stop')
        with mock.patch.object(update_agent.subprocess, 'run', side_effect=record), \
                mock.patch.object(update_agent.subprocess, 'Popen', side_effect=record):
            for wait_detached in (False, True):
                update_agent.run_helper_process(['/usr/bin/true'], '/', {}, 5, wait_detached=wait_detached, normal_io=True)
                update_agent.run_helper_process(['/usr/bin/true'], '/', {}, 5, wait_detached=wait_detached)
        self.assertEqual(calls, [update_agent.leave_background_io, update_agent.leave_background] * 2)


if __name__ == '__main__':
    unittest.main()
