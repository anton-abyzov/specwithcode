#!/usr/bin/env python3
"""A worker that answers no status reads for minutes after its install, then reports the version,
ends verified, not lost (M1 on 1.0.187); a request the host does not acknowledge is sent again,
a bounded number of times (increment 1239, AC-04 and AC-05).

Run: cd scripts/studio-fleet && python3 -B test-rollout-slow-restart.py
"""
import pathlib
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import fleet_rollout  # noqa: E402
from rollout_test_fakes import NEW, Clock, Fleet, quiet  # noqa: E402


def silent_for(fleet, clock, identity, seconds):
    """The host's status reads fail for `seconds` after its request, as during a restart."""
    real, since = fleet.host(identity), {}

    def call(argv):
        if argv[0] == 'request':
            since['at'] = clock()
        if argv[0] == 'status' and 'at' in since and clock() - since['at'] < seconds:
            raise fleet_rollout.RolloutError('%s did not answer within 90s' % identity)
        return real(argv)
    return call


class SlowRestart(unittest.TestCase):
    def roll(self, fleet, clock, hosts, lines=None):
        fleet.version['m4'] = NEW
        return fleet_rollout.rollout(NEW, hosts, only='workers', clock=clock, sleep=clock.sleep,
                                     say=(lines.append if lines is not None else quiet), poll=5)

    def test_ninety_seconds_of_silence_then_verified(self):
        clock, lines = Clock(), []
        fleet = Fleet(clock, polls={'m1': 1, 'm3': 1})
        hosts = fleet.hosts()
        hosts['m1'] = silent_for(fleet, clock, 'm1', 90)
        results = self.roll(fleet, clock, hosts, lines)
        self.assertEqual(results['m1']['result'], 'installed')
        self.assertTrue(any('m1: status unavailable' in line for line in lines))
        self.assertGreaterEqual(sum('m1: status unavailable' in line for line in lines),
                                fleet_rollout.STATUS_FAILURES)  # The old rule would have lost it.

    def test_silence_past_the_window_is_lost(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m1': 1, 'm3': 1})
        hosts = fleet.hosts()
        hosts['m1'] = silent_for(fleet, clock, 'm1', fleet_rollout.STATUS_OUTAGE_SECONDS + 120)
        with self.assertRaises(fleet_rollout.RolloutPartial) as caught:
            self.roll(fleet, clock, hosts)
        self.assertIn('gave no status for', caught.exception.results['m1']['reason'])


class Acknowledgement(unittest.TestCase):
    def test_installed_row_names_the_acknowledged_request(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m1': 1, 'm3': 1})
        fleet.version['m4'] = NEW
        results = fleet_rollout.rollout(NEW, fleet.hosts(), only='workers', clock=clock, sleep=clock.sleep, say=quiet)
        self.assertEqual(results['m1']['acknowledgedAt'], fleet.written['m1'][0])

    def unacknowledging(self, fleet, identity, drops):
        real, left = fleet.host(identity), {'n': drops}

        def call(argv):
            value = real(argv)
            if argv[0] == 'request' and left['n']:
                left['n'] -= 1
                value = dict(value)
                value.pop('request', None)  # The host wrote nothing back.
                fleet.asked.pop(identity, None)  # ...and nothing reached its agent.
            return value
        return call

    def test_unacknowledged_request_is_sent_again_after_the_ack_window(self):
        clock, lines = Clock(), []
        fleet = Fleet(clock, polls={'m1': 1, 'm3': 1})
        fleet.version['m4'] = NEW
        hosts = fleet.hosts()
        hosts['m1'] = self.unacknowledging(fleet, 'm1', 1)
        start = clock()
        results = fleet_rollout.rollout(NEW, hosts, only='workers', clock=clock, sleep=clock.sleep, say=lines.append)
        self.assertEqual(results['m1']['result'], 'installed')
        self.assertEqual(len(fleet.calls('m1', 'request')), 2)
        self.assertLess(clock() - start, fleet_rollout.REQUEST_WINDOW)  # Not a whole request window.
        self.assertTrue(any('not acknowledged' in line for line in lines))

    def test_boot_service_self_update_answers_without_a_stamp_and_counts_as_acknowledged(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m1': 1, 'm3': 1})
        fleet.version['m4'] = NEW
        hosts = fleet.hosts()
        real = fleet.host('m1')

        def linux(argv):  # fleetUpdate.ts: a boot-service request answers request: null.
            value = real(argv)
            if argv[0] == 'request':
                value = dict(value, request=None, method='boot-service')
            return value
        hosts['m1'] = linux
        results = fleet_rollout.rollout(NEW, hosts, only='workers', clock=clock, sleep=clock.sleep, say=quiet)
        self.assertEqual(results['m1']['result'], 'installed')
        self.assertEqual(len(fleet.calls('m1', 'request')), 1)
        self.assertNotIn('acknowledgedAt', results['m1'])

    def test_never_acknowledged_host_is_not_updated(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m1': 1, 'm3': 1})
        fleet.version['m4'] = NEW
        hosts = fleet.hosts()
        hosts['m1'] = self.unacknowledging(fleet, 'm1', 99)
        with self.assertRaises(fleet_rollout.RolloutPartial) as caught:
            fleet_rollout.rollout(NEW, hosts, only='workers', clock=clock, sleep=clock.sleep, say=quiet)
        self.assertIn('never acknowledged', caught.exception.results['m1']['reason'])
        self.assertEqual(len(fleet.calls('m1', 'request')), fleet_rollout.ACK_RETRIES + 1)


if __name__ == '__main__':
    unittest.main()
