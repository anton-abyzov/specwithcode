#!/usr/bin/env python3
"""The rollout obeys each machine's "Pause running work for updates" (update_policy).

M4 with the setting off is held only when idle, nothing is interrupted, and it ends `deferred` once it
is still busy after 30 minutes, which still fails the run. A worker whose status says off is never
forced and ends `deferred`, without failing the run, only when its agent still waits for running work
after 30 minutes. Either keeps its full deadline otherwise: one that goes quiet or starts installing
installs, and one that fails for any other reason fails as before. M4 whose service did not answer is
held only when idle but never deferred. A worker or M4 whose service predates the setting is rolled
out as before.

Run: cd scripts/studio-fleet && python3 -B test-fleet-rollout-pause-setting.py
Nothing here touches a real service, fleet or lock: the hosts are fakes, M4's CLI a stand-in.
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
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
# Never M4's real rollout lock: a test run must neither wait for a live release nor block one.
os.environ['STUDIO_FLEET_ROLLOUT_LOCK'] = os.path.join(
    tempfile.mkdtemp(prefix='fleet-rollout-lock-'), 'fleet-rollout.lock')
import fleet_rollout  # noqa: E402
import update_policy  # noqa: E402
from rollout_test_fakes import NEW, OLD, Clock, FakeHold, Fleet, kinds, quiet  # noqa: E402

OFF = {'pauseWorkForUpdates': False}
ON = {'pauseWorkForUpdates': True}
BUSY = {'idle': False, 'held': False, 'stoppedThreads': 0, 'interruptedRuns': 0, 'openTerminals': 0,
        'blockers': [{'kind': 'run', 'count': 1, 'threadTitle': 'Build SpecOS on Linux'}]}
HELD = {'idle': True, 'held': True, 'stoppedThreads': 1, 'interruptedRuns': 1, 'openTerminals': 0, 'blockers': [],
        'holdUntil': '2026-11-12T12:15:00.000Z'}
# The update agent's own line while running work keeps it from installing (update_policy.RUNNING_WORK).
WORKING = update_policy.RUNNING_WORK[0] + ' (1 running task) (attempt 3)'


def busy_worker(name):
    """A fleet `ready` hook: `name` never gets quiet, so it never installs."""
    return lambda fleet, identity: identity != name


def quiet_from(name, at, status='installing', message='Installing SpecWithCode'):
    """A fleet `ready` hook: `name` is busy until the fake clock reaches `at`, then shows `status`
    and counts its polls down to the install; every other host is ready at once."""
    def ready(fleet, identity):
        if identity != name:
            return True
        if fleet.clock.now < at:
            return False
        fleet.status[name], fleet.message[name] = status, message
        return True
    return ready


def off_and_busy(fleet, name='m1'):
    """`name` reports the setting off and, until it is quiet, the agent's wait for running work."""
    fleet.extra[name] = OFF
    fleet.message[name] = WORKING


def linux(fleet, name, reason, error):
    """`name` as a Linux boot service whose self-update failed with `reason` once it was asked."""
    hosts = fleet.hosts()
    plain = hosts[name]

    def call(argv):
        value = plain(argv)
        if argv[0] == 'status' and fleet.calls(name, 'request'):
            value.update(method='boot-service', phase='failed', lastErrorReason=reason, lastError=error)
        return value
    hosts[name] = call
    return hosts


class Workers(unittest.TestCase):
    def roll(self, fleet, clock, hosts=None, **kwargs):
        fleet.version['m4'] = NEW
        return fleet_rollout.rollout(NEW, hosts or fleet.hosts(), only='workers', clock=clock, sleep=clock.sleep,
                                     say=quiet, **kwargs)

    def test_a_busy_worker_with_the_setting_off_ends_deferred_after_30_minutes(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m3': 1}, ready=busy_worker('m1'))
        off_and_busy(fleet)
        begin = clock()
        results = self.roll(fleet, clock)  # m1 is required, and still nothing raises.
        self.assertEqual(results['m3']['result'], 'installed')
        row = results['m1']
        self.assertEqual(row['result'], update_policy.DEFERRED)
        for words in ('m1 is left on %s until it is quiet' % OLD, '"Pause running work for updates" is off on m1',
                      "its owner's setting, not a failure", 'report it as a fact, not a blocker', WORKING):
            self.assertIn(words, row['reason'])
        self.assertGreaterEqual(clock() - begin, update_policy.DEFER_SECONDS)
        self.assertLess(clock() - begin, update_policy.DEFER_SECONDS + 60)  # Not the 60-minute worker deadline.
        self.assertNotIn('desktopApp', row)  # As --no-desktop-apps: no row of this run has one.
        self.assertEqual(update_policy.summary_result(results, 'installed'), update_policy.DEFERRED)

    def test_a_deferred_mac_leaves_its_desktop_app_for_later(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m3': 1}, ready=busy_worker('m1'))
        off_and_busy(fleet)
        skip = 'needs pinned fleet SSH (pass --ssh-fallback); its own updater installs %s on quit' % NEW
        results = self.roll(fleet, clock, desktop_skip=skip)
        self.assertEqual(results['m1']['result'], update_policy.DEFERRED)
        app = results['m1']['desktopApp']
        self.assertEqual(app['result'], 'skipped')
        self.assertTrue(app['reason'].startswith('deferred: '), app)
        self.assertEqual(results['m3']['desktopApp'], {'result': 'skipped', 'reason': skip})
        self.assertEqual(update_policy.summary_result(results, 'installed'), update_policy.DEFERRED)
        # Beside a failed worker the run is still partial, app rows or not.
        failed = dict(results, m3={'identity': 'm3', 'result': 'not-updated', 'reason': 'm3 tried it and it failed'})
        self.assertEqual(update_policy.summary_result(failed, 'partial'), 'partial')

    def test_worker_force_never_forces_a_worker_with_the_setting_off(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m3': 1}, ready=busy_worker('m1'))
        off_and_busy(fleet)
        results = self.roll(fleet, clock, worker_force=True)
        self.assertEqual(results['m1']['result'], update_policy.DEFERRED)
        self.assertTrue(fleet.calls('m1', 'request'))
        for entry in fleet.calls('m1', 'request'):
            self.assertNotIn('--force', entry[3])
        self.assertIn('--force', fleet.asked['m3'])  # The other worker is forced as asked.

    def test_a_worker_with_the_setting_off_that_gets_quiet_installs(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m1': 3, 'm3': 1})
        off_and_busy(fleet)
        self.assertEqual(self.roll(fleet, clock)['m1']['result'], 'installed')

    def test_a_worker_with_the_setting_off_that_is_not_busy_fails_at_its_deadline(self):
        for status, message in (('error', 'launchctl could not load the update agent'),
                                ('downloading', 'Downloading SpecWithCode %s' % NEW),
                                ('up-to-date', None),
                                ('waiting-for-quiet', "The updater's check took too long; retrying"),
                                ('waiting-for-quiet', 'Waiting for a folder copy to or from another machine to finish')):
            with self.subTest(status=status, message=message):
                clock = Clock()
                fleet = Fleet(clock, polls={'m3': 1}, ready=busy_worker('m1'))
                fleet.extra['m1'] = OFF
                fleet.status['m1'], fleet.message['m1'] = status, message
                begin = clock()
                with self.assertRaises(fleet_rollout.RolloutPartial) as caught:
                    self.roll(fleet, clock)
                row = caught.exception.results['m1']
                self.assertEqual(row['result'], 'not-updated')
                self.assertIn('did not install %s within 60 min; last: %s' % (NEW, status), row['reason'])
                self.assertGreaterEqual(clock() - begin, 60 * 60)
                self.assertEqual(update_policy.summary_result(caught.exception.results, 'partial'), 'partial')

    def test_a_worker_with_the_setting_off_that_goes_quiet_late_installs_inside_its_deadline(self):
        for minutes in (25, 29):  # Quiet before the 30-minute point; its install runs well past it.
            with self.subTest(minutes=minutes):
                clock = Clock()
                fleet = Fleet(clock, polls={'m1': 20 * 60 // 5, 'm3': 1},
                              ready=quiet_from('m1', clock.now + minutes * 60))
                off_and_busy(fleet)
                begin = clock()
                results = self.roll(fleet, clock)
                self.assertEqual(results['m1']['result'], 'installed')
                self.assertGreater(clock() - begin, update_policy.DEFER_SECONDS + 10 * 60)
                self.assertLess(clock() - begin, 60 * 60)

    def test_a_worker_installing_at_the_30_minute_point_is_neither_deferred_nor_failed_early(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m1': 40 * 60 // 5, 'm3': 1}, ready=quiet_from('m1', clock.now + 10 * 60))
        off_and_busy(fleet)
        begin = clock()
        results = self.roll(fleet, clock)
        self.assertEqual(results['m1']['result'], 'installed')
        self.assertGreater(clock() - begin, 45 * 60)

    def test_a_worker_busy_again_after_it_started_installing_fails_at_its_deadline(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m3': 1})
        off_and_busy(fleet)

        def ready(fleet, identity):  # Installing from minute 10 to 35, then back to waiting on running work.
            if identity != 'm1':
                return True
            elapsed = fleet.clock.now - begin
            fleet.status['m1'], fleet.message['m1'] = (('installing', 'Installing') if 10 * 60 <= elapsed < 35 * 60
                                                       else ('waiting-for-quiet', WORKING))
            return False
        fleet.ready = ready
        begin = clock()
        with self.assertRaises(fleet_rollout.RolloutPartial) as caught:
            self.roll(fleet, clock)
        row = caught.exception.results['m1']
        self.assertEqual(row['result'], 'not-updated')
        self.assertIn('did not install %s within 60 min' % NEW, row['reason'])

    def test_a_linux_boot_service_that_gives_up_busy_ends_deferred(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m3': 1}, ready=busy_worker('m1'))
        fleet.extra['m1'] = OFF
        hosts = linux(fleet, 'm1', 'busy', 'm1 stayed busy for 30 minutes. "Pause running work for updates" is off')
        begin = clock()
        results = self.roll(fleet, clock, hosts=hosts, desktop_skip='needs pinned fleet SSH')
        self.assertEqual(results['m1']['result'], update_policy.DEFERRED)
        self.assertIn('m1 stayed busy for 30 minutes', results['m1']['reason'])
        self.assertNotIn('desktopApp', results['m1'])  # A Linux boot service has no desktop app to leave.
        self.assertLess(clock() - begin, 120)  # It answered busy; the rollout did not sit out its deadline.

    def test_a_linux_boot_service_that_fails_otherwise_still_fails(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m3': 1}, ready=busy_worker('m1'))
        fleet.extra['m1'] = OFF
        hosts = linux(fleet, 'm1', 'install-failed', 'the staged preflight failed')
        with self.assertRaises(fleet_rollout.RolloutPartial) as caught:
            self.roll(fleet, clock, hosts=hosts)
        self.assertEqual(caught.exception.results['m1']['result'], 'not-updated')

    def test_a_worker_older_than_the_setting_is_unchanged(self):
        for extra in ({}, ON):  # No key (an older service, or SSH), and the setting on.
            with self.subTest(extra=extra):
                clock = Clock()
                fleet = Fleet(clock, polls={'m3': 1}, ready=busy_worker('m1'))
                fleet.extra['m1'], fleet.message['m1'] = extra, WORKING
                begin = clock()
                with self.assertRaises(fleet_rollout.RolloutPartial) as caught:
                    self.roll(fleet, clock, worker_force=True)
                row = caught.exception.results['m1']
                self.assertEqual(row['result'], 'not-updated')
                self.assertIn('did not install %s within 60 min' % NEW, row['reason'])
                self.assertGreaterEqual(clock() - begin, 60 * 60)
                self.assertIn('--force', fleet.asked['m1'])
                self.assertEqual(update_policy.summary_result(caught.exception.results, 'partial'), 'partial')

    def test_a_deferred_worker_beside_a_failed_one_is_still_partial(self):
        clock = Clock()
        fleet = Fleet(clock, ready=lambda fleet, identity: False)
        off_and_busy(fleet)
        with self.assertRaises(fleet_rollout.RolloutPartial) as caught:
            self.roll(fleet, clock)
        rows = caught.exception.results
        self.assertEqual((rows['m1']['result'], rows['m3']['result']), (update_policy.DEFERRED, 'not-updated'))
        self.assertNotIn('m1', str(caught.exception))  # Only the failure is the run's error.
        self.assertEqual(update_policy.summary_result(rows, 'partial'), 'partial')


class M4(unittest.TestCase):
    """main() looks at M4's service once and turns its hold idle-only when the setting is off."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = pathlib.Path(temp.name)
        own = self.home / '.specwithcode/m4'
        own.mkdir(parents=True)
        wrapper = self.home / 'cli'
        wrapper.write_text('#!/bin/sh\nexit 99\n')
        wrapper.chmod(0o700)
        (own / 'installation.json').write_text(json.dumps({
            'version': '1.0.243', 'cliWrapper': str(wrapper), 'studioHome': str(own)}))
        self.clock = Clock()
        self.fleet = Fleet(self.clock, polls={'m4': 2, 'm1': 1, 'm3': 1})
        self.commands = []
        self.answer = OFF
        self.prepare = BUSY

    def run_cli(self, argv, **kwargs):
        self.commands.append(list(argv))
        if '--hold' not in argv:  # The look, which stops and holds nothing.
            reply = dict(self.answer, idle=False, held=False, stoppedThreads=0)
        else:
            reply = dict(self.prepare() if callable(self.prepare) else self.prepare)
        return subprocess.CompletedProcess(argv, 0, stdout=json.dumps(reply), stderr='')

    def main(self, *flags, apps=False):
        real, hold = fleet_rollout.rollout, fleet_rollout.ServiceHold
        seen = {}

        def rollout(*args, **kwargs):
            seen['deadline'] = args[4]
            kwargs.update(clock=self.clock, sleep=self.clock.sleep, say=quiet)
            return real(*args, **kwargs)
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(fleet_rollout, 'fleet', lambda: self.fleet.hosts()), \
                mock.patch.object(fleet_rollout, 'rollout', rollout), \
                mock.patch.object(fleet_rollout, 'ServiceHold', lambda: hold(home=self.home, run=self.run_cli)), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = fleet_rollout.main(['--version', NEW] + ([] if apps else ['--no-desktop-apps']) + list(flags))
        lines = out.getvalue().strip().splitlines()
        return code, json.loads(lines[-1]), out.getvalue() + err.getvalue(), seen

    def test_off_holds_m4_only_when_idle_and_defers_it(self):
        begin = self.clock()
        code, summary, printed, seen = self.main()
        self.assertEqual(code, 1)  # The release's later stages need M4 on the version (D-09).
        self.assertEqual(summary['result'], update_policy.DEFERRED)
        self.assertEqual(seen['deadline'], 115 * 60)  # Its full deadline; the deferral point is separate.
        rows = summary['hosts']
        self.assertEqual(rows['m4']['result'], update_policy.DEFERRED)
        self.assertIn('"Pause running work for updates" is off on m4', rows['m4']['reason'])
        self.assertIn('Build SpecOS on Linux', rows['m4']['reason'])
        self.assertEqual((rows['m1']['reason'], rows['m3']['reason']), (update_policy.M4_LATER,) * 2)
        self.assertIn('M4 is held only when idle and nothing is interrupted', printed)
        holds = [argv for argv in self.commands if '--hold' in argv]
        self.assertTrue(holds)
        for argv in holds:  # Idle-only every time: nothing was drained.
            self.assertIn('--if-idle', argv)
            self.assertNotIn('--stop-work', argv)
        self.assertEqual(len([argv for argv in self.commands if '--hold' not in argv]), 1)  # One look.
        self.assertEqual(self.fleet.asked, {})  # Nothing asked to install, no worker asked.
        self.assertLess(self.clock() - begin, update_policy.DEFER_SECONDS + 60)

    def test_off_and_quiet_late_installs_inside_its_full_deadline(self):
        begin = self.clock()
        quiet = dict(HELD, stoppedThreads=0, interruptedRuns=0)
        self.prepare = lambda: quiet if self.clock() - begin >= 25 * 60 else BUSY
        self.fleet = Fleet(self.clock, polls={'m4': 20 * 60 // 5})  # It needs 20 minutes once held.
        code, summary, _printed, _seen = self.main('--only', 'm4')
        self.assertEqual((code, summary['result'], summary['hosts']['m4']['result']), (0, 'installed', 'installed'))
        self.assertGreater(self.clock() - begin, update_policy.DEFER_SECONDS + 10 * 60)
        self.assertTrue(all('--stop-work' not in argv for argv in self.commands))

    def test_off_and_quiet_installs_through_the_idle_hold(self):
        self.prepare = dict(HELD, stoppedThreads=0, interruptedRuns=0)
        code, summary, _printed, _seen = self.main('--only', 'm4')
        self.assertEqual((code, summary['result'], summary['hosts']['m4']['result']), (0, 'installed', 'installed'))
        self.assertTrue(all('--stop-work' not in argv for argv in self.commands))
        self.assertIn('--force', self.fleet.asked['m4'])

    def test_on_and_a_service_older_than_the_setting_drain_as_before(self):
        for answer in (ON, {}):
            with self.subTest(answer=answer):
                self.setUp()
                self.answer, self.prepare = answer, HELD
                code, summary, printed, seen = self.main('--only', 'm4')
                self.assertEqual((code, summary['result']), (0, 'installed'))
                self.assertEqual(seen['deadline'], 115 * 60)
                self.assertNotIn('held only when idle', printed)
                self.assertIn(['--stop-work', '--hold'], [argv[5:7] for argv in self.commands])

    def test_a_service_that_does_not_answer_is_held_only_when_idle_and_never_deferred(self):
        def silent(argv, **kwargs):
            self.commands.append(list(argv))
            if '--hold' not in argv:
                raise subprocess.TimeoutExpired(argv, 60)
            return subprocess.CompletedProcess(argv, 0, stdout=json.dumps(BUSY), stderr='')
        self.run_cli = silent
        begin = self.clock()
        code, summary, printed, seen = self.main()
        self.assertEqual((code, summary['result']), (1, 'partial'))
        self.assertEqual(seen['deadline'], 115 * 60)
        row = summary['hosts']['m4']
        self.assertEqual(row['result'], 'not-updated')  # Nothing says its owner chose to leave it.
        self.assertIn('did not install %s within 115 min' % NEW, row['reason'])
        self.assertNotIn('is off', row['reason'])
        self.assertGreaterEqual(self.clock() - begin, 115 * 60)
        self.assertEqual(summary['hosts']['m1']['reason'], 'not asked: M4 did not finalize %s' % NEW)
        self.assertIn("could not be read from M4's service", printed)
        self.assertNotIn('is off on M4', printed)
        self.assertNotIn('left for later', printed)
        holds = [argv for argv in self.commands if '--hold' in argv]
        self.assertTrue(holds)
        for argv in holds:
            self.assertIn('--if-idle', argv)
            self.assertNotIn('--stop-work', argv)

    def test_wait_for_idle_and_no_hold_never_look(self):
        self.prepare = dict(HELD, stoppedThreads=0, interruptedRuns=0)
        self.main('--only', 'm4', '--wait-for-idle')
        self.assertTrue(all('--hold' in argv for argv in self.commands))
        self.commands = []
        self.fleet = Fleet(self.clock, polls={'m4': 2})
        self.main('--only', 'm4', '--no-hold')
        self.assertEqual(self.commands, [])

    def test_a_worker_with_the_setting_off_that_is_not_busy_fails_the_run(self):
        self.fleet.version['m4'] = NEW
        self.fleet.extra['m1'] = OFF
        self.fleet.status['m1'], self.fleet.message['m1'] = 'error', 'launchctl could not load the update agent'
        self.fleet.ready = busy_worker('m1')
        code, summary, _printed, _seen = self.main('--only', 'workers')
        self.assertEqual((code, summary['result']), (1, 'partial'))
        self.assertEqual(summary['hosts']['m1']['result'], 'not-updated')
        self.assertIn('launchctl could not load the update agent', summary['hosts']['m1']['reason'])

    def test_a_deferred_mac_worker_reports_its_app_skipped(self):
        self.fleet.version['m4'] = NEW
        off_and_busy(self.fleet)
        self.fleet.ready = busy_worker('m1')
        code, summary, _printed, _seen = self.main('--only', 'workers', apps=True)
        self.assertEqual((code, summary['result']), (0, update_policy.DEFERRED))
        app = summary['hosts']['m1']['desktopApp']
        self.assertEqual(app['result'], 'skipped')
        self.assertTrue(app['reason'].startswith('deferred: '), app)
        self.assertEqual(summary['hosts']['m3']['desktopApp']['result'], 'skipped')  # Its own updater, on quit.

    def test_only_deferred_workers_exit_0(self):
        self.fleet.version['m4'] = NEW
        off_and_busy(self.fleet)
        self.fleet.ready = busy_worker('m1')
        code, summary, printed, _seen = self.main('--only', 'workers')
        self.assertEqual((code, summary['result']), (0, update_policy.DEFERRED))
        self.assertEqual(summary['hosts']['m1']['result'], update_policy.DEFERRED)
        self.assertEqual(self.commands, [])  # Workers only: M4's service is never looked at.


class Policy(unittest.TestCase):
    def test_the_m4_hold_fake_has_no_setting(self):
        # rollout_test_fakes.FakeHold has no pause_work: the existing rollout tests run as before.
        self.assertIsNone(getattr(FakeHold(Fleet(Clock())), 'pause_work', None))
        clock = Clock()
        fleet = Fleet(clock, polls={'m4': 2})
        result = fleet_rollout.rollout(NEW, fleet.hosts(), only='m4', hold=FakeHold(fleet), clock=clock,
                                       sleep=clock.sleep, say=quiet)
        self.assertEqual(result['m4']['result'], 'installed')
        self.assertEqual(kinds(fleet), ['hold', 'request'])


if __name__ == '__main__':
    unittest.main()
