#!/usr/bin/env python3
"""Update now pressed on a host while fleet_rollout waits for it writes a held, forced request for the
version. Asking again over it would replace it, and the service's hold and the update agent would then
follow the rollout's request instead of the press's run, so the rollout waits on that install, as on one
under way at the start, and asks once more only after it ended: its hold ran out, or the agent answered it
without installing it. No host is asked again while its agent installs. Drives test-fleet-rollout.py's fake
fleet.

Run: cd scripts/studio-fleet && python3 -B test-fleet-rollout-update-now.py
"""
import datetime
import importlib.util
import pathlib
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import fleet_rollout  # noqa: E402

_spec = importlib.util.spec_from_file_location('rollout_tests_for_update_now', str(HERE / 'test-fleet-rollout.py'))
rollout_tests = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rollout_tests)
Clock, Fleet, FakeHold, NEW, OLD, kinds = (rollout_tests.Clock, rollout_tests.Fleet, rollout_tests.FakeHold,
                                           rollout_tests.NEW, rollout_tests.OLD, rollout_tests.kinds)
DOWNLOAD_FAILED = 'Downloading SpecWithCode %s failed: timed out' % NEW


def held_request(minutes=40):
    """What a host's status shows while the forced request Update now wrote for NEW stands."""
    until = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=minutes)).isoformat()
    return {'installRequest': {'at': '2026-10-18T09:00:00Z', 'version': NEW}, 'installMode': 'force',
            'installRequestedAt': '2026-10-18T09:00:00Z', 'installCancelledAt': None, 'installHoldUntil': until}


class UpdateNowDuringARollout(unittest.TestCase):
    def test_a_worker_is_not_asked_again_while_update_now_asked_for_the_version(self):
        """Update now pressed on a worker while the rollout waits writes a held, forced request for the
        version: asking again would replace it, and the service's hold and the agent would follow the
        rollout's request instead of the press's run. The rollout asks once more only after it ended."""
        clock = Clock()
        fleet = Fleet(clock, polls={'m1': 10 ** 6})
        real, asked = fleet.host('m1'), []
        press = held_request()

        def m1(argv):
            if argv[0] == 'request':
                asked.append(clock())
                if len(asked) == 2:
                    fleet.left['m1'] = 1
            reply = real(argv)
            if argv[0] == 'status' and len(asked) == 1 and clock() - asked[0] < 25 * 60:
                reply.update(press)  # Cancelled 25 minutes after the rollout's request.
            return reply

        hosts = fleet.hosts()
        hosts['m1'] = m1
        lines = []
        results = fleet_rollout.rollout(NEW, hosts, clock=clock, sleep=clock.sleep, say=lines.append, poll=15)
        self.assertEqual(results['m1']['result'], 'installed')
        self.assertEqual(results['m1']['requests'], 2)
        self.assertGreaterEqual(asked[1] - asked[0], 25 * 60)
        self.assertEqual(len([line for line in lines if line.startswith('m1: Update now asked for')]), 1)

    def test_update_now_pressed_while_the_rollout_waits_for_an_offer_is_neither_held_nor_asked_over(self):
        """M4's agent does not offer the release yet, so the rollout only asked it to check. Update now
        is pressed there: the agent offers the release and the press's held, forced request stands. The
        rollout neither drains nor asks over that request while it stands, through a window's end too."""
        clock = Clock()
        fleet = Fleet(clock)
        fleet.status['m4'], fleet.message['m4'] = 'up-to-date', None
        fleet.downloaded['m4'] = fleet.available['m4'] = None
        real = fleet.host('m4')
        press = held_request()

        def m4(argv):
            if argv[0] == 'status':
                reads = len(fleet.calls('m4', 'status'))
                if reads == 2:  # Update now: the agent offers the release.
                    fleet.downloaded['m4'] = fleet.available['m4'] = NEW
                    fleet.status['m4'], fleet.message['m4'] = 'waiting-for-quiet', 'Waiting for running tasks (1 running task)'
                elif reads == 80:  # The press's run installed it, 20 minutes on.
                    fleet.version['m4'] = NEW
            reply = real(argv)
            if argv[0] == 'status' and fleet.available['m4'] == NEW and fleet.version['m4'] != NEW:
                reply.update(press)
            return reply

        hosts = fleet.hosts()
        hosts['m4'] = m4
        lines = []
        result = fleet_rollout.rollout(NEW, hosts, only='m4', clock=clock, sleep=clock.sleep, say=lines.append,
                                       hold=FakeHold(fleet), hold_minutes=15, poll=15)
        self.assertEqual(result['m4']['result'], 'installed')
        self.assertEqual(result['m4']['requests'], 0)
        self.assertEqual(kinds(fleet), ['check'])
        self.assertTrue(any(line.startswith('m4: Update now asked for') for line in lines))

    def test_a_press_the_agent_answered_without_installing_it_has_ended(self):
        """The agent marks a request handled as it installs it, and also when it fails before any install (a
        download, a plan it cannot use), which writes no lastInstall. Only the install, or a helper left to
        finish past its timeout, keeps a handled press standing, at the start (joined) and while waiting."""
        press = held_request()
        handled = dict(press, status='installing', message='Installing SpecWithCode %s' % NEW,
                       handledInstallRequestAt=press['installRequestedAt'])
        self.assertTrue(fleet_rollout.requested_by_update_now(handled, NEW))
        left = dict(handled, status='error', message='Installing SpecWithCode %s is taking longer than 40 minutes; '
                    'it was left to finish. See the update receipt.' % NEW)
        self.assertTrue(fleet_rollout.requested_by_update_now(left, NEW))
        failed = dict(handled, status='error', message=DOWNLOAD_FAILED)
        self.assertFalse(fleet_rollout.requested_by_update_now(failed, NEW))
        self.assertTrue(fleet_rollout.requested_by_update_now(dict(failed, handledInstallRequestAt=None), NEW))

    def test_a_worker_press_the_agent_answered_without_installing_is_asked_over_at_the_windows_end(self):
        """Its hold (the run's deadline) is still ahead, but nothing installs for it: the rollout asks again at
        its own window's end instead of waiting that hold out, which can outlast the worker's deadline."""
        clock = Clock()
        fleet = Fleet(clock, polls={'m1': 10 ** 6})
        real, asked = fleet.host('m1'), []
        press = held_request()

        def m1(argv):
            if argv[0] == 'request':
                asked.append(clock())
                if len(asked) == 2:
                    fleet.left['m1'] = 1
            reply = real(argv)
            if argv[0] == 'status' and len(asked) == 1:
                reply.update(press, status='error', message=DOWNLOAD_FAILED,
                             handledInstallRequestAt=press['installRequestedAt'])
            return reply

        hosts = fleet.hosts()
        hosts['m1'] = m1
        results = fleet_rollout.rollout(NEW, hosts, clock=clock, sleep=clock.sleep, say=lambda line: None, poll=15)
        self.assertEqual(results['m1']['result'], 'installed')
        self.assertEqual(asked[1] - asked[0], fleet_rollout.REQUEST_WINDOW)

    def test_m4_drains_once_the_agent_answered_a_press_without_installing(self):
        """M4's agent was only asked to check. Update now is pressed there and its download fails: the press
        has ended, so the rollout drains and asks as soon as the agent offers the release."""
        clock = Clock()
        fleet = Fleet(clock)
        fleet.status['m4'], fleet.message['m4'] = 'up-to-date', None
        fleet.downloaded['m4'] = fleet.available['m4'] = None
        real = fleet.host('m4')
        press = held_request()

        def m4(argv):
            if argv[0] == 'status' and len(fleet.calls('m4', 'status')) == 2:
                fleet.available['m4'] = NEW
                fleet.status['m4'], fleet.message['m4'] = 'error', DOWNLOAD_FAILED
            reply = real(argv)
            if argv[0] == 'status' and fleet.available['m4'] == NEW and not fleet.written['m4']:
                reply.update(press, handledInstallRequestAt=press['installRequestedAt'], installedVersion=OLD)
            return reply

        hosts = fleet.hosts()
        hosts['m4'] = m4
        result = fleet_rollout.rollout(NEW, hosts, only='m4', clock=clock, sleep=clock.sleep, say=lambda line: None,
                                       hold=FakeHold(fleet), hold_minutes=15, local_deadline=40 * 60, poll=15)
        self.assertEqual(result['m4']['result'], 'installed')
        self.assertEqual(kinds(fleet), ['check', 'hold', 'request'])
        self.assertLess(result['m4']['seconds'], 5 * 60)

    def test_a_worker_installing_a_press_past_its_hold_is_not_asked_over(self):
        """The press's install, under way from 4 minutes on, outlasts its hold (the run's deadline, 13 minutes
        on): a request at the next window's end would replace the request being installed, and the worker's
        service hold and its agent would follow that one instead. The rollout waits for the install."""
        clock = Clock()
        fleet = Fleet(clock, polls={'m1': 10 ** 6})
        real, start, written = fleet.host('m1'), [None], []
        at = '2026-10-18T09:00:00Z'

        def m1(argv):
            reply = real(argv)
            if argv[0] == 'request':
                written.append((clock() - start[0]) / 60 if start[0] is not None else 0)
                start[0] = start[0] or clock()
                return reply
            if start[0] is None:
                return reply
            minutes = (clock() - start[0]) / 60
            if minutes >= 25:  # The press's install verified.
                fleet.version['m1'] = NEW
                return real(argv)
            if minutes >= 1:  # forced_pending reads the wall clock: the hold runs out 13 minutes on.
                until = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=13 - minutes)
                reply.update(installRequest={'at': at, 'version': NEW}, installMode='force', installRequestedAt=at,
                             installCancelledAt=None, installHoldUntil=until.isoformat())
                if minutes >= 4:  # update_agent.apply: handled, then 'installing' while the helper runs.
                    reply.update(status='installing', message='Installing SpecWithCode %s' % NEW,
                                 handledInstallRequestAt=at)
            return reply

        hosts = fleet.hosts()
        hosts['m1'] = m1
        results = fleet_rollout.rollout(NEW, hosts, clock=clock, sleep=clock.sleep, say=lambda line: None, poll=15)
        self.assertEqual(results['m1']['result'], 'installed')
        self.assertEqual(written, [0], 'requests written at these minutes: %r' % written)

    def test_the_rollouts_own_held_request_is_not_waited_on_as_update_nows(self):
        """M4's state names the rollout's own forced request, still held as its window ends: that one is
        not Update now's, so the rollout drains and asks again as before."""
        clock = Clock()
        fleet = Fleet(clock, polls={'m4': 10 ** 6})
        real = fleet.host('m4')
        until = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=60)).isoformat()

        def m4(argv):
            reply = real(argv)
            if argv[0] == 'status' and fleet.written['m4']:
                at = fleet.written['m4'][-1]
                reply.update(installRequest={'at': at, 'version': NEW}, installMode='force', installRequestedAt=at,
                             installCancelledAt=None, installHoldUntil=until)
            return reply

        hosts = fleet.hosts()
        hosts['m4'] = m4
        lines = []
        with self.assertRaises(fleet_rollout.RolloutError):
            fleet_rollout.rollout(NEW, hosts, only='m4', clock=clock, sleep=clock.sleep, say=lines.append,
                                  hold=FakeHold(fleet), hold_minutes=15, local_deadline=40 * 60, poll=30)
        self.assertEqual(len(fleet.calls('m4', 'request')), 3)
        self.assertFalse([line for line in lines if 'Update now asked for' in line])


if __name__ == '__main__':
    unittest.main()
