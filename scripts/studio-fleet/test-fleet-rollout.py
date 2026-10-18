#!/usr/bin/env python3
"""fleet_rollout and the update_request command line, against a fake fleet and temporary homes.

No host is contacted and no launchd job is started: the rollout tests drive fake hosts with a
fake clock, and the command-line tests run update_request.py (and the program fleet_rollout
streams to a host) in a temporary private home.

Run: cd scripts/studio-fleet && python3 -B test-fleet-rollout.py
"""
import contextlib
import copy
import io
import datetime
import types
import json
import os
import pathlib
import shlex
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import fleet_rollout  # noqa: E402
import update_request  # noqa: E402

OLD, NEW = '1.0.40', '1.0.41'


class Clock(object):
    """Shared fake time; sleep advances it and yields so worker threads interleave."""

    def __init__(self):
        self.now = 1_000_000.0
        self.lock = threading.Lock()

    def __call__(self):
        with self.lock:
            return self.now

    def sleep(self, seconds):
        with self.lock:
            self.now += seconds
        time.sleep(0.001)


class Fleet(object):
    """Fake hosts. A host installs once it was asked and `polls` more status reads passed, and
    only when `ready(identity)` allows it. Every call is logged in order."""

    def __init__(self, clock, polls=None, ready=None):
        self.clock = clock
        self.lock = threading.Lock()
        self.log = []
        self.version = {name: OLD for name in ('m4', 'm1', 'm3')}
        self.asked = {}
        self.left = dict(polls or {})
        self.ready = ready or (lambda fleet, identity: True)
        self.status = {name: 'waiting-for-quiet' for name in self.version}
        self.message = {name: 'Waiting for running tasks (2 running tasks)' for name in self.version}
        self.available = {}
        self.downloaded = {}

    def host(self, identity):
        def call(argv):
            assert argv[:3] == [argv[0], '--identity', identity], argv
            with self.lock:
                if argv[0] == 'request':
                    self.asked[identity] = list(argv)
                    self.log.append((identity, 'request', self.version[identity], list(argv)))
                    return {'identity': identity, 'result': 'requested', 'kicked': True}
                if identity in self.asked and self.version[identity] != NEW and self.ready(self, identity):
                    remaining = self.left.get(identity, 1)
                    if remaining <= 0:
                        self.version[identity] = NEW
                    self.left[identity] = remaining - 1
                self.log.append((identity, 'status', self.version[identity], list(argv)))
                return {'identity': identity, 'version': self.version[identity],
                        'installFinalized': self.version[identity] == NEW,
                        'status': 'installed' if self.version[identity] == NEW else self.status[identity],
                        'message': None if self.version[identity] == NEW else self.message[identity],
                        'downloadedVersion': self.downloaded.get(identity, NEW),
                        'availableVersion': self.available.get(identity, NEW)}
        return call

    def hosts(self):
        return {name: self.host(name) for name in ('m4', 'm1', 'm3')}

    def calls(self, identity, kind):
        return [entry for entry in self.log if entry[0] == identity and entry[1] == kind]


def quiet(_line):
    pass


HELD = {'idle': True, 'stoppedThreads': 1, 'interruptedRuns': 1, 'openTerminals': 0, 'blockers': [],
        'held': True, 'holdUntil': '2026-10-16T12:15:00.000Z', 'holdReason': 'install'}


class FakeHold(object):
    """M4's ServiceHold. Each drain and release is logged in the fleet's log, in order with the
    requests, as ('m4', 'hold' | 'release', version, [])."""

    def __init__(self, fleet, reply=None, error=None, release_error=None, unsupported=None):
        self.fleet = fleet
        self.reply = dict(HELD if reply is None else reply)
        self.error = error
        self.release_error = release_error
        self.unsupported = unsupported  # The reason ServiceHold.support() gives for an old CLI.

    def support(self):
        return (False, self.unsupported) if self.unsupported else (True, None)

    def _log(self, kind):
        with self.fleet.lock:
            self.fleet.log.append(('m4', kind, self.fleet.version['m4'], []))

    def prepare(self):
        self._log('hold')
        if self.error:
            raise fleet_rollout.HoldUnavailable(self.error)
        return dict(self.reply)

    def release(self):
        self._log('release')
        if self.release_error:
            raise fleet_rollout.HoldUnavailable(self.release_error)
        return {'idle': True, 'stoppedThreads': 0, 'blockers': [], 'held': False}


def kinds(fleet, identity='m4'):
    """The calls made to one host, in order, without status reads."""
    return [entry[1] for entry in fleet.log if entry[0] == identity and entry[1] != 'status']


class RolloutOrder(unittest.TestCase):
    def test_descriptor_switch_waits_for_final_receipt_before_workers(self):
        clock, reads = Clock(), []
        fleet = Fleet(clock, polls={'m4': 0})
        hosts = fleet.hosts()
        real = hosts['m4']

        def pending(argv):
            reply = real(argv)
            if argv[0] == 'status' and reply.get('version') == NEW:
                reads.append(len(fleet.log))
                reply['installFinalized'] = len(reads) >= 4
                reply['status'] = 'installed' if reply['installFinalized'] else 'installing'
            return reply

        hosts['m4'] = pending
        fleet_rollout.rollout(NEW, hosts, clock=clock, sleep=clock.sleep, say=quiet)
        self.assertEqual(len(reads), 4)
        self.assertTrue(all(entry[0] == 'm4' for entry in fleet.log[:reads[-1]]))

    def test_target_descriptor_without_final_receipt_never_starts_workers(self):
        for only in ('all', 'workers'):
            with self.subTest(only=only):
                clock, fleet = Clock(), Fleet(Clock())
                fleet.version['m4'] = NEW
                hosts = fleet.hosts()
                real = hosts['m4']

                def pending(argv):
                    reply = real(argv)
                    reply.update({'installFinalized': False, 'status': 'installing'})
                    return reply

                hosts['m4'] = pending
                with self.assertRaises(fleet_rollout.RolloutError):
                    fleet_rollout.rollout(NEW, hosts, only=only, local_deadline=90,
                                         clock=clock, sleep=clock.sleep, say=quiet)
                self.assertEqual(fleet.asked, {})

    def test_failed_final_check_after_descriptor_switch_stops_workers(self):
        clock, fleet = Clock(), Fleet(Clock(), polls={'m4': 0})
        hosts = fleet.hosts()
        real = hosts['m4']

        def failed(argv):
            reply = real(argv)
            if argv[0] == 'request':
                reply['request'] = {'installRequestedAt': '2026-10-17T00:26:00Z'}
            elif reply.get('version') == NEW:
                reply.update({'installFinalized': False, 'status': 'error',
                              'lastInstall': {'version': NEW, 'result': 'failed',
                                              'at': '2026-10-17T00:32:00Z', 'receipt': '/failed.json'}})
            return reply

        hosts['m4'] = failed
        with self.assertRaisesRegex(fleet_rollout.RolloutError, 'it failed'):
            fleet_rollout.rollout(NEW, hosts, clock=clock, sleep=clock.sleep, say=quiet)
        self.assertFalse(any(entry[0] != 'm4' for entry in fleet.log))

    def test_joined_automatic_install_failure_is_not_retried(self):
        clock, calls = Clock(), []

        def automatic(argv):
            calls.append(argv)
            self.assertEqual(argv[0], 'status', 'joining a live install must never request a retry')
            if len(calls) == 1:
                return {'version': NEW, 'status': 'installing', 'installRequestedAt': None}
            return {'version': OLD, 'status': 'error', 'installFinalized': False,
                    'lastInstall': {'version': NEW, 'result': 'failed',
                                    'at': '2026-10-17T00:32:00Z', 'receipt': '/automatic-failed.json'}}

        with self.assertRaisesRegex(fleet_rollout.RolloutError, 'it failed'):
            fleet_rollout.rollout(NEW, {'m4': automatic}, clock=clock, sleep=clock.sleep, say=quiet)
        self.assertEqual(len(calls), 2)

    def run_rollout(self, fleet, clock, **options):
        options.setdefault('poll', 15)
        return fleet_rollout.rollout(NEW, fleet.hosts(), clock=clock, sleep=clock.sleep, say=quiet, **options)

    def test_m4_installs_before_any_worker_is_asked(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m4': 3})
        results = self.run_rollout(fleet, clock)
        self.assertEqual({name: result['result'] for name, result in results.items()},
                         {'m4': 'installed', 'm1': 'installed', 'm3': 'installed'})
        first_worker = min(index for index, entry in enumerate(fleet.log) if entry[0] in ('m1', 'm3'))
        m4_done = min(index for index, entry in enumerate(fleet.log) if entry[0] == 'm4' and entry[2] == NEW)
        self.assertLess(m4_done, first_worker, 'a worker was contacted before M4 reported the new version')

    def test_m4_request_is_forced_and_held_and_workers_are_version_bound(self):
        clock = Clock()
        fleet = Fleet(clock)
        self.run_rollout(fleet, clock, hold_minutes=15)
        m4 = fleet.asked['m4']
        self.assertEqual(m4[:4], ['request', '--identity', 'm4', '--version'])
        self.assertIn('--force', m4)
        self.assertEqual(m4[m4.index('--hold-minutes') + 1], '15')
        self.assertIn('--kickstart', m4)
        for worker in ('m1', 'm3'):
            self.assertEqual(fleet.asked[worker][fleet.asked[worker].index('--version') + 1], NEW)
            self.assertNotIn('--force', fleet.asked[worker])

    def test_workers_go_together(self):
        """M1 installs only once M3 was asked too, so a one-at-a-time rollout would time out."""
        clock = Clock()
        fleet = Fleet(clock, polls={'m1': 2, 'm3': 2},
                      ready=lambda fleet, identity: identity == 'm4' or {'m1', 'm3'} <= set(fleet.asked))
        results = self.run_rollout(fleet, clock, worker_deadline=10 * 60)
        self.assertEqual(results['m1']['result'], 'installed')
        self.assertEqual(results['m3']['result'], 'installed')

    def test_downloaded_is_not_installed(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m4': 4})
        fleet.status['m4'] = 'downloaded'
        fleet.message['m4'] = None
        self.run_rollout(fleet, clock, only='m4')
        statuses = [entry for entry in fleet.calls('m4', 'status')]
        self.assertGreaterEqual(len(statuses), 5, 'the rollout stopped on downloaded instead of installedVersion')

    def test_m4_is_asked_again_only_after_the_hold(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m4': 10 ** 6})  # Never drains.
        with self.assertRaises(fleet_rollout.RolloutError) as caught:
            self.run_rollout(fleet, clock, only='m4', hold_minutes=15, local_deadline=40 * 60, poll=30)
        self.assertIn('did not install', str(caught.exception))
        self.assertIn('Waiting for running tasks', str(caught.exception))
        requests = fleet.calls('m4', 'request')
        self.assertEqual(len(requests), 3)  # At 0, after 15 min and after 30 min of a 40 min deadline.
        self.assertEqual(fleet.calls('m1', 'request') + fleet.calls('m3', 'request'), [])

    def test_a_stuck_m4_never_reaches_the_workers(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m4': 10 ** 6})
        with self.assertRaises(fleet_rollout.RolloutError):
            self.run_rollout(fleet, clock, local_deadline=5 * 60)
        self.assertFalse([entry for entry in fleet.log if entry[0] != 'm4'])

    def test_manual_upgrade_and_newer_offer_stop_at_once(self):
        for field, value, words in (('status', 'manual-required', 'manual upgrade'),
                                    ('available', '1.0.42', 'newer than')):
            with self.subTest(field=field):
                clock = Clock()
                fleet = Fleet(clock, polls={'m4': 10 ** 6})
                if field == 'status':
                    fleet.status['m4'] = value
                else:
                    fleet.available['m4'] = value
                with self.assertRaises(fleet_rollout.RolloutError) as caught:
                    self.run_rollout(fleet, clock, only='m4')
                self.assertIn(words, str(caught.exception))
                self.assertLessEqual(len(fleet.calls('m4', 'status')), 2)

    def test_a_failed_install_stops_without_asking_again(self):
        """A guarded update that rolled back after this rollout asked fails the rollout at once; a
        failure from before it, or an install left running past its timeout, does not."""
        cases = (('2026-10-16T12:00:05.000000+00:00', None, True),
                 ('2026-10-16T11:59:00.000000+00:00', None, False),
                 ('2026-10-16T12:00:05.000000+00:00',
                  'Installing SpecWithCode %s is taking longer than 15 minutes; it was left to finish.' % NEW, False))
        for at, message, stops in cases:
            with self.subTest(at=at, message=message):
                clock = Clock()
                fleet = Fleet(clock, polls={'m4': 6})
                real = fleet.host('m4')

                def m4(argv, real=real, fleet=fleet, at=at, message=message):
                    reply = real(argv)
                    if argv[0] == 'request':
                        reply['request'] = {'installRequestedAt': '2026-10-16T12:00:00.000Z'}
                    elif fleet.version['m4'] != NEW:
                        reply.update({'status': 'error', 'message': message or 'SpecWithCode %s did not install' % NEW,
                                      'lastInstall': {'version': NEW, 'at': at, 'result': 'failed', 'receipt': '/r.json'}})
                    return reply

                hosts = fleet.hosts()
                hosts['m4'] = m4
                run = lambda: fleet_rollout.rollout(NEW, hosts, only='m4', clock=clock, sleep=clock.sleep, say=quiet,
                                                    poll=15)
                if stops:
                    with self.assertRaises(fleet_rollout.RolloutError) as caught:
                        run()
                    self.assertIn('it failed', str(caught.exception))
                    self.assertIn('/r.json', str(caught.exception))
                    self.assertEqual(len(fleet.calls('m4', 'request')), 1)
                    self.assertEqual(len(fleet.calls('m4', 'status')), 2)
                else:
                    self.assertEqual(run()['m4']['result'], 'installed')

    def test_a_new_version_counts_only_once_its_checks_pass(self):
        """The installed version flips while the updater still checks the restart; a check that
        then fails, keeping the new release for review, fails the rollout instead of passing it."""
        for outcome in ('updated', 'failed'):
            with self.subTest(outcome=outcome):
                clock = Clock()
                fleet = Fleet(clock, polls={'m4': 10 ** 6})
                real, seen = fleet.host('m4'), []

                def m4(argv, real=real, seen=seen, outcome=outcome, fleet=fleet):
                    reply = real(argv)
                    if argv[0] == 'request':
                        reply['request'] = {'installRequestedAt': '2026-10-16T12:00:00.000Z'}
                    elif argv[0] == 'status' and fleet.calls('m4', 'request'):
                        seen.append(1)
                        reply['version'] = NEW
                        reply['installFinalized'] = len(seen) >= 4 and outcome == 'updated'
                        if len(seen) < 4:
                            reply['status'] = 'installing'
                        else:
                            reply.update({'status': 'up-to-date' if outcome == 'updated' else 'error',
                                          'lastInstall': {'version': NEW, 'at': '2026-10-16T12:00:05.000000+00:00',
                                                          'result': outcome, 'receipt': '/r.json'}})
                    return reply

                hosts = fleet.hosts()
                hosts['m4'] = m4
                run = lambda: fleet_rollout.roll_host('m4', m4, NEW, True, 15, 3600, 15, clock, clock.sleep, quiet)
                seen.clear()
                if outcome == 'updated':
                    self.assertEqual(run()['result'], 'installed')
                    self.assertEqual(len(seen), 4)
                else:
                    with self.assertRaises(fleet_rollout.RolloutError) as caught:
                        run()
                    self.assertIn('not confirmed', str(caught.exception))
                    self.assertIn('/r.json', str(caught.exception))

    def test_an_install_left_running_is_not_yet_installed(self):
        """An install the agent left to finish may still roll back; the poll waits for its outcome."""
        clock = Clock()
        fleet = Fleet(clock, polls={'m4': 10 ** 6})
        real, seen = fleet.host('m4'), []

        def m4(argv, real=real, seen=seen, fleet=fleet):
            reply = real(argv)
            if argv[0] == 'request':
                reply['request'] = {'installRequestedAt': '2026-10-16T12:00:00.000Z'}
            elif argv[0] == 'status' and fleet.calls('m4', 'request'):
                seen.append(1)
                reply['version'] = NEW
                reply['installFinalized'] = len(seen) >= 3
                if len(seen) < 3:
                    reply.update({'status': 'error',
                                  'message': 'Installing SpecWithCode %s is taking longer than 15 minutes; it was left to finish.' % NEW,
                                  'lastInstall': {'version': NEW, 'at': '2026-10-16T12:00:05.000000+00:00',
                                                  'result': 'failed', 'receipt': '/r.json'}})
                else:
                    reply.update({'status': 'up-to-date', 'lastInstall': {'version': NEW, 'at': '2026-10-16T12:20:00.000000+00:00',
                                                                         'result': 'updated', 'receipt': '/r.json'}})
            return reply

        self.assertEqual(fleet_rollout.roll_host('m4', m4, NEW, True, 15, 3600, 15, clock, clock.sleep, quiet)['result'], 'installed')
        self.assertEqual(len(seen), 3)

    def test_installed_host_gets_no_request(self):
        clock = Clock()
        fleet = Fleet(clock)
        fleet.version['m4'] = NEW
        self.assertEqual(self.run_rollout(fleet, clock, only='m4')['m4']['result'], 'already-installed')
        self.assertEqual(fleet.calls('m4', 'request'), [])

    def test_workers_alone_refuse_while_m4_is_behind(self):
        clock = Clock()
        fleet = Fleet(clock)
        with self.assertRaises(fleet_rollout.RolloutError) as caught:
            self.run_rollout(fleet, clock, only='workers')
        self.assertIn('install it first', str(caught.exception))
        self.assertEqual(fleet.asked, {})

    def test_status_outages_are_tolerated_then_fatal(self):
        for outages, installs in ((2, True), (fleet_rollout.STATUS_FAILURES, False)):
            with self.subTest(outages=outages):
                clock = Clock()
                fleet = Fleet(clock, polls={'m4': 2})
                real, left = fleet.host('m4'), {'n': outages}

                def flaky(argv, real=real, left=left, fleet=fleet):
                    if argv[0] == 'status' and fleet.asked and left['n']:
                        left['n'] -= 1
                        raise fleet_rollout.RolloutError('m4 did not answer')
                    return real(argv)

                hosts = fleet.hosts()
                hosts['m4'] = flaky
                run = lambda: fleet_rollout.rollout(NEW, hosts, only='m4', clock=clock, sleep=clock.sleep,
                                                    say=quiet, poll=15)
                if installs:
                    self.assertEqual(run()['m4']['result'], 'installed')
                else:
                    with self.assertRaises(fleet_rollout.RolloutError):
                        run()


class M4Hold(unittest.TestCase):
    """M4 is drained and held through its own service, as Update now does, before each forced
    request; M1 and M3 never are."""

    def run_rollout(self, fleet, clock, hold, lines=None, **options):
        options.setdefault('poll', 15)
        say = lines.append if lines is not None else quiet
        return fleet_rollout.rollout(NEW, fleet.hosts(), clock=clock, sleep=clock.sleep, say=say, hold=hold,
                                     **options)

    def test_m4_is_held_before_its_forced_request_and_workers_never_are(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m4': 3})
        lines = []
        results = self.run_rollout(fleet, clock, FakeHold(fleet), lines)
        self.assertEqual({name: result['result'] for name, result in results.items()},
                         {'m4': 'installed', 'm1': 'installed', 'm3': 'installed'})
        self.assertEqual(kinds(fleet), ['hold', 'request'])
        self.assertIn('--force', fleet.asked['m4'])
        for worker in ('m1', 'm3'):
            self.assertEqual(kinds(fleet, worker), ['request'])
            self.assertNotIn('--force', fleet.asked[worker])
        held = [line for line in lines if 'held the service' in line]
        self.assertEqual(len(held), 1)
        self.assertIn('stopped 1 thread (1 turn interrupted), closed 0 terminals', held[0])

    def test_the_hold_waits_until_the_agent_offers_the_version(self):
        """Before the agent found the release a drain would not hold, only stop work: M4 is asked
        without one, then held and asked again as soon as the agent offers it."""
        clock = Clock()
        fleet = Fleet(clock, polls={'m4': 6})
        fleet.status['m4'], fleet.message['m4'] = 'up-to-date', None
        fleet.downloaded['m4'] = fleet.available['m4'] = None
        real = fleet.host('m4')

        def m4(argv):
            reply = real(argv)
            if argv[0] == 'status' and len(fleet.calls('m4', 'status')) == 3:  # The agent found it.
                fleet.downloaded['m4'] = fleet.available['m4'] = NEW
                fleet.status['m4'], fleet.message['m4'] = 'waiting-for-quiet', 'Waiting for running tasks (1 running task)'
                reply = real(['status', '--identity', 'm4'])
            return reply

        hosts = fleet.hosts()
        hosts['m4'] = m4
        lines = []
        result = fleet_rollout.rollout(NEW, hosts, only='m4', clock=clock, sleep=clock.sleep, say=lines.append,
                                       hold=FakeHold(fleet), poll=15)
        self.assertEqual(result['m4']['result'], 'installed')
        self.assertEqual(result['m4']['requests'], 2)
        self.assertEqual(kinds(fleet), ['request', 'hold', 'request'])
        self.assertTrue(any('does not offer %s yet' % NEW in line for line in lines))

    def test_each_request_again_is_held_again_and_a_give_up_releases(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m4': 10 ** 6})  # Never drains.
        lines = []
        with self.assertRaises(fleet_rollout.RolloutError) as caught:
            self.run_rollout(fleet, clock, FakeHold(fleet), lines, only='m4', hold_minutes=15,
                             local_deadline=40 * 60, poll=30)
        self.assertIn('did not install', str(caught.exception))
        self.assertEqual(kinds(fleet), ['hold', 'request'] * 3 + ['release'])
        self.assertTrue(any('released the hold' in line for line in lines))

    def test_a_joined_install_is_neither_held_nor_asked_again(self):
        """M4 already runs the version while its checks after the restart go on: the rollout
        waits for the final receipt and never drains the restarted service."""
        clock = Clock()
        fleet = Fleet(clock)
        fleet.version['m4'] = NEW
        real = fleet.host('m4')

        def m4(argv):
            reply = real(argv)
            if argv[0] == 'status' and len(fleet.calls('m4', 'status')) <= 4:
                reply.update(installFinalized=False, status='downloaded', installedVersion=OLD)
            return reply

        hosts = fleet.hosts()
        hosts['m4'] = m4
        result = fleet_rollout.rollout(NEW, hosts, only='m4', clock=clock, sleep=clock.sleep, say=quiet,
                                       hold=FakeHold(fleet), poll=15)
        self.assertEqual(result['m4'], dict(result['m4'], result='installed', requests=0))
        self.assertEqual(kinds(fleet), [])

    def test_an_installing_agent_keeps_its_hold(self):
        """Releasing during the install would let work start before the restart."""
        clock = Clock()
        fleet = Fleet(clock, polls={'m4': 10 ** 6})
        real = fleet.host('m4')

        def m4(argv):
            reply = real(argv)
            if argv[0] == 'status' and fleet.calls('m4', 'request'):
                reply['status'] = 'installing'
            return reply

        hosts = fleet.hosts()
        hosts['m4'] = m4
        lines = []
        with self.assertRaises(fleet_rollout.RolloutError):
            fleet_rollout.rollout(NEW, hosts, only='m4', clock=clock, sleep=clock.sleep, say=lines.append,
                                  hold=FakeHold(fleet), local_deadline=10 * 60, poll=15)
        self.assertEqual(kinds(fleet), ['hold', 'request'])
        self.assertTrue(any('the agent is installing' in line for line in lines))

    def test_a_failed_install_releases_and_a_failed_release_only_warns(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m4': 10 ** 6})
        real = fleet.host('m4')

        def m4(argv):
            reply = real(argv)
            if argv[0] == 'request':
                reply['request'] = {'installRequestedAt': '2026-10-16T12:00:00.000Z'}
            elif fleet.calls('m4', 'request'):
                reply.update({'status': 'error', 'message': 'SpecWithCode %s did not install' % NEW,
                              'lastInstall': {'version': NEW, 'at': '2026-10-16T12:00:05.000000+00:00',
                                              'result': 'failed', 'receipt': '/r.json'}})
            return reply

        hosts = fleet.hosts()
        hosts['m4'] = m4
        lines = []
        with self.assertRaises(fleet_rollout.RolloutError) as caught:
            fleet_rollout.rollout(NEW, hosts, only='m4', clock=clock, sleep=clock.sleep, say=lines.append,
                                  hold=FakeHold(fleet, release_error='exit 1'), poll=15)
        self.assertIn('it failed', str(caught.exception))
        self.assertEqual(kinds(fleet), ['hold', 'request', 'release'])
        self.assertTrue(any('could not release the hold (exit 1)' in line for line in lines))

    def test_an_interrupted_rollout_releases(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m4': 10 ** 6})

        def sleep(_seconds):
            raise KeyboardInterrupt

        with self.assertRaises(KeyboardInterrupt):
            fleet_rollout.rollout(NEW, fleet.hosts(), only='m4', clock=clock, sleep=sleep, say=quiet,
                                  hold=FakeHold(fleet), poll=15)
        self.assertEqual(kinds(fleet), ['hold', 'request', 'release'])

    def test_an_unavailable_or_unheld_service_fails_fast_without_asking(self):
        """An older CLI without `service prepare-update`, a service that did not hold, or no answer:
        the rollout stops before the forced request instead of asking unheld, which a busy M4 can
        only wait out and fail (M4 on 1.0.43, 2026-10-18), and names Update now as the way on."""
        for hold_kind, words in (('unsupported', 'Unrecognized flag: --json'), ('not-held', 'it did not hold'),
                                 ('no-answer', 'no answer within 200s')):
            with self.subTest(hold=hold_kind):
                clock = Clock()
                fleet = Fleet(clock, polls={'m4': 2})
                hold = {'unsupported': FakeHold(fleet, error='the service CLI has no `service prepare-update --json` '
                                                             '(exit 1: Unrecognized flag: --json in command specweave-studio service)'),
                        'not-held': FakeHold(fleet, reply=dict(HELD, held=False)),
                        'no-answer': FakeHold(fleet, error='no answer within 200s')}[hold_kind]
                lines = []
                with self.assertRaises(fleet_rollout.RolloutError) as caught:
                    self.run_rollout(fleet, clock, hold, lines, only='m4')
                message = str(caught.exception)
                self.assertIn(words, message)
                self.assertIn('was not asked to install', message)
                self.assertIn('Update now', message)
                self.assertIn('--only workers', message)
                self.assertEqual(kinds(fleet), ['hold'])  # No request, so nothing unheld; nothing to release.
                self.assertFalse(any('asking without a hold' in line for line in lines))
                for worker in ('m1', 'm3'):
                    self.assertEqual(kinds(fleet, worker), [])

    def test_an_old_cli_is_refused_before_the_first_request(self):
        """Support is checked before any request, including the one asked before the agent offers
        the version, so an old CLI never gets an unheld forced request."""
        for offered in (True, False):
            with self.subTest(offered=offered):
                clock = Clock()
                fleet = Fleet(clock, polls={'m4': 2})
                if not offered:
                    fleet.status['m4'], fleet.message['m4'] = 'up-to-date', None
                    fleet.downloaded['m4'] = fleet.available['m4'] = None
                hold = FakeHold(fleet, unsupported='M4 runs 1.0.43; `service prepare-update` first shipped in 1.0.45')
                with self.assertRaises(fleet_rollout.RolloutError) as caught:
                    self.run_rollout(fleet, clock, hold, only='m4')
                self.assertIn('first shipped in 1.0.45', str(caught.exception))
                self.assertIn('Update now', str(caught.exception))
                self.assertEqual(kinds(fleet), [])

    def test_an_old_cli_still_joins_an_install_under_way(self):
        """M4 already moving to the version (Update now asked it) needs no hold from the rollout."""
        clock = Clock()
        fleet = Fleet(clock)
        fleet.version['m4'] = NEW
        real = fleet.host('m4')

        def m4(argv):
            reply = real(argv)
            if argv[0] == 'status' and len(fleet.calls('m4', 'status')) <= 2:
                reply.update(installFinalized=False, status='downloaded', installedVersion=OLD)
            return reply

        hosts = fleet.hosts()
        hosts['m4'] = m4
        result = fleet_rollout.rollout(NEW, hosts, only='m4', clock=clock, sleep=clock.sleep, say=quiet,
                                       hold=FakeHold(fleet, unsupported='M4 runs 1.0.43'), poll=15)
        self.assertEqual(result['m4']['result'], 'installed')
        self.assertEqual(kinds(fleet), [])

    def test_an_old_cli_joins_the_forced_install_update_now_asked_for(self):
        """Update now on an old M4 writes a held, forced request; the descriptor still names the
        old version until the restart, and the rollout joins instead of refusing."""
        clock = Clock()
        fleet = Fleet(clock)
        fleet.version['m4'] = NEW  # What M4 reports once the requested install finishes.
        real = fleet.host('m4')
        until = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=10)).isoformat()

        def m4(argv):
            reply = real(argv)
            if argv[0] == 'status' and len(fleet.calls('m4', 'status')) == 1:
                reply.update(version=OLD, installFinalized=False, status='waiting-for-quiet',
                             installRequest={'at': '2026-10-18T09:00:00Z', 'version': NEW}, installMode='force',
                             installRequestedAt='2026-10-18T09:00:00Z', installCancelledAt=None,
                             installHoldUntil=until)
            return reply

        hosts = fleet.hosts()
        hosts['m4'] = m4
        result = fleet_rollout.rollout(NEW, hosts, only='m4', clock=clock, sleep=clock.sleep, say=quiet,
                                       hold=FakeHold(fleet, unsupported='M4 runs 1.0.43'), poll=15)
        self.assertEqual(result['m4']['result'], 'installed')
        self.assertEqual(kinds(fleet), [])

    def test_a_cancelled_or_expired_update_now_request_is_not_joined(self):
        later = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=10)
        status = {'installRequest': {'version': NEW}, 'installMode': 'force',
                  'installRequestedAt': '2026-10-18T09:00:00Z', 'installHoldUntil': later.isoformat()}
        self.assertTrue(fleet_rollout.requested_by_update_now(status, NEW))
        self.assertFalse(fleet_rollout.requested_by_update_now(dict(status, installCancelledAt='2026-10-18T09:01:00Z'), NEW))
        self.assertFalse(fleet_rollout.requested_by_update_now(dict(status, installHoldUntil='2026-10-18T09:00:01Z'), NEW))
        self.assertFalse(fleet_rollout.requested_by_update_now(dict(status, installMode='normal'), NEW))
        self.assertFalse(fleet_rollout.requested_by_update_now(status, OLD))

    def test_without_a_hold_nothing_is_drained(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m4': 2})
        self.assertEqual(self.run_rollout(fleet, clock, None, only='m4')['m4']['result'], 'installed')
        self.assertEqual(kinds(fleet), ['request'])

    def test_no_hold_flag_and_dry_run(self):
        seen = {}

        def rollout(version, hosts, *args, **options):
            seen['hold'] = options.get('hold')
            return {}

        saved = fleet_rollout.rollout, fleet_rollout.fleet, fleet_rollout.ServiceHold
        fleet_rollout.rollout, fleet_rollout.fleet = rollout, lambda: {}
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        # A home without this Mac's installation.json: the real one must not decide the test.
        fleet_rollout.ServiceHold = type('ServiceHold', (saved[2],), {
            '__init__': lambda hold: saved[2].__init__(hold, home=temporary.name)})
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(fleet_rollout.main(['--version', NEW, '--only', 'm4', '--no-hold']), 0)
                self.assertIsNone(seen['hold'])
                self.assertEqual(fleet_rollout.main(['--version', NEW, '--only', 'm4']), 0)
                self.assertIsInstance(seen['hold'], fleet_rollout.ServiceHold)
                self.assertEqual(fleet_rollout.main(['--version', NEW, '--only', 'workers']), 0)
                self.assertIsNone(seen['hold'])
        finally:
            fleet_rollout.rollout, fleet_rollout.fleet, fleet_rollout.ServiceHold = saved

    def test_old_installed_version_is_refused_before_any_host_is_contacted(self):
        """main() reads installation.json: below 1.0.45 the hold it hands the rollout is
        unsupported (roll_host refuses unless Update now already asked); --dry-run reports it."""
        seen = []

        def rollout(version, hosts, *args, **options):
            seen.append(options.get('hold'))
            return {}

        with tempfile.TemporaryDirectory() as temporary:
            home = pathlib.Path(temporary)
            own = home / '.specwithcode' / 'm4'
            own.mkdir(parents=True)
            (own / 'installation.json').write_text(json.dumps({'identity': 'm4', 'version': '1.0.43'}))
            saved = fleet_rollout.rollout, fleet_rollout.fleet, fleet_rollout.ServiceHold
            fleet_rollout.rollout, fleet_rollout.fleet = rollout, lambda: {}
            fleet_rollout.ServiceHold = lambda: saved[2](home=home)
            try:
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    self.assertEqual(fleet_rollout.main(['--version', NEW, '--only', 'm4']), 0)
                supported, reason = seen[0].support()
                self.assertFalse(supported)
                for words in ('M4 runs 1.0.43', 'first shipped in 1.0.45'):
                    self.assertIn(words, reason)
                seen.clear()
                for version in ('1.0.43', '1.0.44'):
                    (own / 'installation.json').write_text(json.dumps({'identity': 'm4', 'version': version}))
                    out = io.StringIO()
                    with contextlib.redirect_stdout(out):
                        self.assertEqual(fleet_rollout.main(['--version', NEW, '--dry-run']), 0)
                    self.assertTrue(json.loads(out.getvalue())['hold'].startswith('unsupported: M4 runs ' + version))
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(fleet_rollout.main(['--version', NEW, '--only', 'm4', '--no-hold']), 0)
                    self.assertEqual(fleet_rollout.main(['--version', NEW, '--only', 'workers']), 0)
                self.assertEqual(seen, [None, None])
            finally:
                fleet_rollout.rollout, fleet_rollout.fleet, fleet_rollout.ServiceHold = saved


class ServiceHoldCommand(unittest.TestCase):
    """ServiceHold runs the service's own CLI from its installation.json, here a stand-in script
    in a temporary home that records its arguments; no service is contacted."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.home = pathlib.Path(self.temporary.name)
        self.own = self.home / '.specwithcode' / 'm4'
        self.own.mkdir(parents=True)
        self.wrapper = self.home / 'specweave-studio'
        self.argv = self.home / 'argv.json'
        self.receipt(cliWrapper=str(self.wrapper), studioHome=str(self.own))

    def tearDown(self):
        self.temporary.cleanup()

    def receipt(self, **fields):
        # 1.0.45 is the first release whose CLI has `service prepare-update`.
        fields.setdefault('version', '1.0.45')
        (self.own / 'installation.json').write_text(json.dumps(dict({'identity': 'm4'}, **fields)))

    def cli(self, stdout, code=0, stderr=''):
        """A stand-in CLI: records its arguments one per line, prints `stdout` and `stderr`."""
        self.wrapper.write_text('#!/bin/sh\nprintf "%%s\\n" "$@" > %s\nprintf %%s %s\nprintf %%s %s >&2\nexit %d\n' % (
            shlex.quote(str(self.argv)), shlex.quote(stdout), shlex.quote(stderr), code))
        self.wrapper.chmod(0o700)

    def ran(self):
        return self.argv.read_text().splitlines()

    def test_prepare_and_release_run_the_service_cli_for_its_home(self):
        hold = fleet_rollout.ServiceHold(home=self.home)
        self.cli(json.dumps(HELD))
        self.assertEqual(hold.prepare(), HELD)
        self.assertEqual(self.ran(), ['service', 'prepare-update', '--base-dir', str(self.own), '--stop-work', '--hold',
                                      '--reason', 'install', '--json'])
        self.cli('warning on stdout\n' + json.dumps({'idle': True, 'stoppedThreads': 0, 'blockers': [], 'held': False}))
        self.assertIs(hold.release()['held'], False)
        self.assertEqual(self.ran(), ['service', 'prepare-update', '--base-dir', str(self.own), '--release-hold', '--json'])

    def test_failures_are_unavailable_with_their_reason(self):
        hold = fleet_rollout.ServiceHold(home=self.home)
        for stdout, code, stderr, words in (
                (json.dumps({'error': 'No running SpecWithCode service owns %s.' % self.own}), 1, '', 'No running'),
                ('Usage: specweave-studio service <command>', 1, 'Unknown subcommand: prepare-update', 'exit 1: Unknown subcommand'),
                ('not json', 0, '', 'exit 0')):
            with self.subTest(words=words):
                self.cli(stdout, code, stderr)
                with self.assertRaises(fleet_rollout.HoldUnavailable) as caught:
                    hold.prepare()
                self.assertIn(words, str(caught.exception))
                self.assertIs(isinstance(caught.exception, fleet_rollout.HoldUnsupported), 'Unknown' in words)

    def test_an_old_cli_is_unsupported(self):
        """What M4's 1.0.43 CLI printed, and a receipt older than 1.0.45, which never runs the CLI."""
        hold = fleet_rollout.ServiceHold(home=self.home)
        self.cli('', 1, 'Unrecognized flag: --json in command specweave-studio service')
        with self.assertRaises(fleet_rollout.HoldUnsupported) as caught:
            hold.prepare()
        self.assertIn('Unrecognized flag: --json', str(caught.exception))
        self.argv.unlink()
        for version, supported in (('1.0.43', False), ('1.0.44', False), ('1.0.45', True), ('1.1.0', True), (None, True)):
            with self.subTest(version=version):
                self.receipt(cliWrapper=str(self.wrapper), studioHome=str(self.own), version=version)
                self.assertIs(hold.support()[0], supported)
        self.receipt(cliWrapper=str(self.wrapper), studioHome=str(self.own), version='1.0.43')
        self.assertEqual(hold.support(), (False, 'M4 runs 1.0.43; `service prepare-update` first shipped in 1.0.45'))
        for call in (hold.prepare, hold.release):
            with self.assertRaises(fleet_rollout.HoldUnsupported):
                call()
        self.assertFalse(self.argv.exists(), 'the CLI ran for a release that has no prepare-update')

    def test_a_receipt_without_a_runnable_cli_for_this_home_is_unavailable(self):
        hold = fleet_rollout.ServiceHold(home=self.home)
        for fields, words in (({'cliWrapper': str(self.wrapper), 'studioHome': str(self.home / 'other')}, 'names the home'),
                              ({'cliWrapper': 'specweave-studio', 'studioHome': str(self.own)}, 'no runnable cliWrapper'),
                              ({'studioHome': str(self.own)}, 'no runnable cliWrapper')):
            with self.subTest(fields=fields):
                self.cli(json.dumps(HELD))
                self.receipt(**fields)
                with self.assertRaises(fleet_rollout.HoldUnavailable) as caught:
                    hold.prepare()
                self.assertIn(words, str(caught.exception))
        (self.own / 'installation.json').unlink()
        with self.assertRaises(fleet_rollout.HoldUnavailable) as caught:
            hold.prepare()
        self.assertIn('no readable installation.json', str(caught.exception))
        self.assertFalse(self.argv.exists(), 'the CLI ran for a receipt that names no runnable CLI for this home')

    def test_offers_matches_the_services_own_check(self):
        """ServiceUpdateHold.updatePendingFor, narrowed to the version the rollout installs."""
        for status, expected in (({'status': 'waiting-for-quiet', 'downloadedVersion': NEW}, True),
                                 ({'status': 'available', 'availableVersion': NEW}, True),
                                 ({'status': 'error', 'downloadedVersion': NEW, 'installedVersion': OLD}, True),
                                 ({'status': 'error', 'downloadedVersion': NEW}, False),
                                 ({'status': 'up-to-date', 'availableVersion': None}, False),
                                 ({'status': 'downloaded', 'downloadedVersion': OLD, 'availableVersion': NEW}, False),
                                 ({'status': 'waiting-for-quiet', 'downloadedVersion': '1.0.42'}, False)):
            with self.subTest(status=status):
                self.assertIs(fleet_rollout.offers(status, NEW), expected)


class Inventory(unittest.TestCase):
    def test_hosts_come_from_the_inventory_over_pinned_ssh(self):
        with tempfile.TemporaryDirectory() as temporary:
            inventory = pathlib.Path(temporary) / 'hosts.json'
            inventory.write_text(json.dumps({'m1': {'host': 'worker-one.test', 'user': 'one', 'home': '/h1'},
                                             'm3': {'host': 'worker-three.test', 'user': 'three', 'home': '/h3'}}))
            previous = os.environ.get('STUDIO_FLEET_HOSTS')
            os.environ['STUDIO_FLEET_HOSTS'] = str(inventory)
            try:
                hosts = fleet_rollout.fleet(home=temporary)
            finally:
                if previous is None:
                    os.environ.pop('STUDIO_FLEET_HOSTS')
                else:
                    os.environ['STUDIO_FLEET_HOSTS'] = previous
        self.assertEqual(sorted(hosts), ['m1', 'm3', 'm4'])
        self.assertEqual(hosts['m4'].command, ['/usr/bin/python3', '-B', '-'])
        m1 = hosts['m1'].command
        self.assertEqual(m1[0], '/usr/bin/ssh')
        self.assertEqual(m1[-2:], ['one@worker-one.test', '/usr/bin/python3 -B -'])
        for option in ('BatchMode=yes', 'StrictHostKeyChecking=yes', 'IdentitiesOnly=yes', 'ControlMaster=no'):
            self.assertIn(option, m1)
        self.assertIn('UserKnownHostsFile=' + str(pathlib.Path(temporary) / '.local/share/specweave/fleet/known_hosts'), m1)
        self.assertEqual(hosts['m3'].command[-2], 'three@worker-three.test')


class RequestCommand(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.home = pathlib.Path(self.temporary.name)
        self.own = self.home / '.specwithcode' / 'm9'
        (self.own / 'updates').mkdir(parents=True)
        (self.own / 'installation.json').write_text(json.dumps({'identity': 'm9', 'version': OLD}))
        self.config = self.own / 'updates' / 'config.json'
        self.plist = self.home / 'Library' / 'LaunchAgents' / (update_request.agent_label('m9') + '.plist')
        self.plist.parent.mkdir(parents=True)
        self.plist.write_text('<plist/>')
        # launchd as the stub reports it; a test never reaches the real launchctl.
        self.launchd = {'loaded': True, 'disabled': False, 'kick': (0, ''), 'calls': []}
        patcher = mock.patch.object(update_request, 'launchctl_run', self.fake_launchctl)
        patcher.start()
        self.addCleanup(patcher.stop)
        platform = mock.patch.object(update_request.sys, 'platform', 'darwin')
        platform.start()
        self.addCleanup(platform.stop)

    def fake_launchctl(self, args, timeout=30):
        self.launchd['calls'].append(list(args))
        label = 'com.specweave.studio.m9.updater'
        if args[0] == 'print-disabled':
            return 0, '{\n\t"com.example.other" => disabled\n\t"%s" => %s\n}\n' % (
                label, 'disabled' if self.launchd['disabled'] else 'enabled'), ''
        if args[0] == 'print':
            return (0, '', '') if self.launchd['loaded'] else (113, '', 'Could not find service "%s"' % label)
        self.assertEqual(args, ['kickstart', 'gui/%d/%s' % (os.getuid(), label)])
        code, error = self.launchd['kick']
        return code, '', error

    def tearDown(self):
        self.temporary.cleanup()

    def cli(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = update_request.main(list(argv) + ['--home', str(self.home)])
        return code, json.loads(out.getvalue().strip().splitlines()[-1])

    def test_request_binds_the_version_and_keeps_other_settings(self):
        self.config.write_text(json.dumps({'schemaVersion': 1, 'repository': 'owner/private-feed', 'quietMinutes': 5,
                                           'installMode': 'force', 'installHoldUntil': '2026-01-01T00:00:00.000Z'}))
        code, reply = self.cli('request', '--identity', 'm9', '--version', NEW)
        self.assertEqual((code, reply['result'], reply['kicked']), (0, 'requested', None))
        config = json.loads(self.config.read_text())
        self.assertEqual(stat.S_IMODE(self.config.stat().st_mode), 0o600)
        self.assertEqual(config['repository'], 'owner/private-feed')
        self.assertEqual(config['quietMinutes'], 5)
        self.assertEqual(config['installMode'], 'normal')
        self.assertIsNone(config['installHoldUntil'])
        self.assertEqual(config['installRequest'], {'at': config['installRequestedAt'], 'version': NEW})
        self.assertEqual(config['checkRequestedAt'], config['installRequestedAt'])
        self.assertTrue(config['installRequestedAt'].endswith('Z'))
        self.assertEqual([path.name for path in (self.own / 'updates').iterdir()], ['config.json'])
        # The agent's own reading of the request: bound to NEW and pending.
        self.assertEqual(update_request.bound(config)['version'], NEW)
        state = {}
        pending = update_request.pending(config, state, (1, 0, 40), update_request._time(config['installRequestedAt']),
                                         lambda _config: False, RuntimeError)
        self.assertTrue(pending)

    def test_forced_request_holds_for_the_given_minutes(self):
        code, _reply = self.cli('request', '--identity', 'm9', '--version', NEW, '--force', '--hold-minutes', '15')
        self.assertEqual(code, 0)
        config = json.loads(self.config.read_text())
        self.assertEqual(config['installMode'], 'force')
        held = update_request._time(config['installHoldUntil']) - update_request._time(config['installRequestedAt'])
        self.assertEqual(held.total_seconds(), 15 * 60)
        for minutes in ('0', '16'):
            code, reply = self.cli('request', '--identity', 'm9', '--version', NEW, '--force', '--hold-minutes', minutes)
            self.assertEqual(code, 1)
            self.assertIn('hold-minutes', reply['error'])

    def test_installed_or_newer_versions_write_nothing(self):
        code, reply = self.cli('request', '--identity', 'm9', '--version', OLD)
        self.assertEqual((code, reply['result']), (0, 'already-installed'))
        code, reply = self.cli('request', '--identity', 'm9', '--version', '1.0.39')
        self.assertEqual(code, 1)
        self.assertIn('newer than', reply['error'])
        self.assertFalse(self.config.exists())

    def test_bad_input_is_refused(self):
        for argv, words in ((('request', '--identity', 'm9', '--version', '1.0'), 'Invalid version'),
                            (('request', '--identity', '../m9', '--version', NEW), 'Invalid identity'),
                            (('request', '--identity', 'm8', '--version', NEW), 'no update agent folder')):
            with self.subTest(argv=argv):
                code, reply = self.cli(*argv)
                self.assertEqual(code, 1)
                self.assertIn(words, reply['error'])
        self.config.symlink_to(self.home / 'elsewhere.json')
        code, reply = self.cli('request', '--identity', 'm9', '--version', NEW)
        self.assertEqual(code, 1)
        self.assertIn('regular file', reply['error'])

    def test_status_prefers_the_installation_receipt(self):
        (self.own / 'updates' / 'state.json').write_text(json.dumps(
            {'status': 'waiting-for-quiet', 'installedVersion': '1.0.39', 'downloadedVersion': NEW,
             'message': 'Waiting for running tasks (1 running task)'}))
        code, report = self.cli('status', '--identity', 'm9')
        self.assertEqual(code, 0)
        self.assertEqual((report['version'], report['installedVersion'], report['downloadedVersion']),
                         (OLD, '1.0.39', NEW))
        self.assertEqual(report['status'], 'waiting-for-quiet')
        self.assertFalse(report['installFinalized'])

    def test_status_reports_the_agent_job_as_launchd_sees_it(self):
        old = '2026-10-18T02:00:00Z'
        (self.own / 'updates' / 'state.json').write_text(json.dumps({'status': 'up-to-date', 'checkedAt': old}))
        late = update_request._time('2026-10-18T06:30:00Z')
        report = update_request.status(self.home, 'm9')
        self.assertEqual((report['agentLoaded'], report['agentDisabled']), (True, False))
        self.launchd.update(loaded=False, disabled=True)
        report = update_request.status(self.home, 'm9')
        self.assertEqual((report['agentLoaded'], report['agentDisabled']), (False, True))
        self.assertTrue(update_request.agent_status('m9', {'checkedAt': old}, {}, now=late)['stale'])
        self.assertFalse(update_request.agent_status('m9', {'checkedAt': '2026-10-18T05:00:00Z'}, {}, now=late)['stale'])
        self.assertFalse(update_request.agent_status('m9', {'checkedAt': old}, {'checkAutomatically': False},
                                                     now=late)['stale'])
        self.assertFalse(update_request.agent_status('m9', {'checkedAt': None}, {}, now=late)['stale'])
        # No plist: the agent was never set up (or was removed), so nothing reads as broken.
        self.plist.unlink()
        report = update_request.status(self.home, 'm9')
        self.assertEqual((report['agentLoaded'], report['agentDisabled']), (None, None))
        # A temporary --home has no launchd job of its own: the command line reads none for it.
        del self.launchd['calls'][:]
        code, report = self.cli('status', '--identity', 'm9')
        self.assertEqual((code, report['agentLoaded'], report['agentDisabled']), (0, None, None))
        self.assertEqual(self.launchd['calls'], [])

    def test_disabled_labels_are_read_from_print_disabled(self):
        label = 'com.specweave.studio.m4.updater'
        self.assertTrue(update_request.label_disabled('\t"%s" => disabled\n' % label, label))
        self.assertTrue(update_request.label_disabled('\t"%s" => true\n' % label, label))  # Before macOS 13.
        self.assertFalse(update_request.label_disabled('\t"%s" => enabled\n' % label, label))
        self.assertFalse(update_request.label_disabled('\t"%s.extra" => disabled\n' % label, label))
        self.assertFalse(update_request.label_disabled('', label))

    def test_a_kicked_request_is_written_only_for_a_job_that_can_run(self):
        for change, words in (({'disabled': True, 'loaded': False}, 'turned off in launchd'),
                              ({'loaded': False}, 'not loaded in launchd')):
            self.launchd.update(loaded=True, disabled=False)
            self.launchd.update(change)
            code, reply = self.cli('request', '--identity', 'm9', '--version', NEW, '--kickstart')
            self.assertEqual(code, 1)
            self.assertIn(words, reply['error'])
            self.assertIn('nothing would handle the request', reply['error'])
            self.assertFalse(self.config.exists())
            self.assertNotIn('kickstart', [call[0] for call in self.launchd['calls']])

    def test_a_refused_kickstart_fails_with_launchctl_reason(self):
        self.launchd['kick'] = (37, 'Operation not permitted while System Integrity Protection is engaged')
        code, reply = self.cli('request', '--identity', 'm9', '--version', NEW, '--kickstart')
        self.assertEqual(code, 1)
        self.assertIn('could not start the update agent', reply['error'])
        self.assertIn('Operation not permitted', reply['error'])
        self.assertIn('exit 37', reply['error'])
        self.launchd['kick'] = (0, '')
        code, reply = self.cli('request', '--identity', 'm9', '--version', NEW, '--kickstart')
        self.assertEqual((code, reply['result'], reply['kicked']), (0, 'requested', True))

    def completion_fixture(self):
        installation = {'identity': 'm9', 'version': NEW, 'sourceCommit': 'a' * 40,
                        'archiveSha256': 'b' * 64, 'service': {'label': 'com.specweave.studio.m9'}}
        receipt = self.own / 'updates' / 'receipts' / 'completed.json'
        receipt.parent.mkdir(exist_ok=True)
        snapshot = {'schemaVersion': 1, 'identity': 'm9', 'serviceLabel': installation['service']['label'],
                    'artifactSourceCommit': installation['sourceCommit'],
                    'archiveSha256': installation['archiveSha256']}
        proof = {'phase': 'verified', 'before': dict(snapshot), 'after': dict(snapshot),
                 'preservedRowsAuthAndIdentity': True, 'originalServicesPreserved': True,
                 'onlyKnownOwnedServiceRestarted': True}
        state = {'installedVersion': NEW, 'installedSourceCommit': installation['sourceCommit'],
                 'status': 'installed', 'lastInstall': {'version': NEW, 'result': 'updated',
                 'at': '2026-10-17T00:33:00Z', 'receipt': str(receipt)}}
        return installation, state, proof, receipt

    def test_finalization_requires_source_bound_guarded_receipt(self):
        base = self.completion_fixture()
        mutations = [
            ('valid', lambda i, s, p: None, True),
            ('failed agent', lambda i, s, p: s['lastInstall'].update(result='failed'), False),
            ('old agent version', lambda i, s, p: s.update(installedVersion=OLD), False),
            ('old source', lambda i, s, p: s.update(installedSourceCommit='c' * 40), False),
            ('old completion', lambda i, s, p: s['lastInstall'].update(version=OLD), False),
            ('no completion time', lambda i, s, p: s['lastInstall'].update(at=None), False),
            ('failed receipt', lambda i, s, p: p.update(result='update-failed'), False),
            ('unfinished receipt', lambda i, s, p: p.update(phase='restart-requested'), False),
            ('unproven preservation', lambda i, s, p: p.update(preservedRowsAuthAndIdentity=False), False),
            ('unproven services', lambda i, s, p: p.update(originalServicesPreserved=False), False),
            ('unproven restart', lambda i, s, p: p.update(onlyKnownOwnedServiceRestarted=False), False),
            ('wrong identity', lambda i, s, p: p['after'].update(identity='m4'), False),
            ('wrong service', lambda i, s, p: p['after'].update(serviceLabel='foreign'), False),
            ('wrong source', lambda i, s, p: p['after'].update(artifactSourceCommit='c' * 40), False),
            ('wrong archive', lambda i, s, p: p['after'].update(archiveSha256='c' * 64), False),
            ('malformed snapshot', lambda i, s, p: p.update(before=[]), False),
            ('malformed source', lambda i, s, p: i.update(sourceCommit=None), False),
            ('malformed service', lambda i, s, p: i.update(service=None), False),
        ]
        for name, mutate, expected in mutations:
            with self.subTest(name=name):
                installation, state, proof, receipt = copy.deepcopy(base)
                mutate(installation, state, proof)
                (self.own / 'installation.json').write_text(json.dumps(installation))
                (self.own / 'updates' / 'state.json').write_text(json.dumps(state))
                receipt.write_text(json.dumps(proof))
                self.assertEqual(self.cli('status', '--identity', 'm9')[1]['installFinalized'], expected)

    def test_completion_marker_missing_or_unowned_receipt_fails_closed(self):
        installation, state, proof, receipt = self.completion_fixture()
        (self.own / 'installation.json').write_text(json.dumps(installation))
        state_path = self.own / 'updates' / 'state.json'
        state_path.write_text(json.dumps(state))
        receipt.write_text(json.dumps(proof))
        for name in ('install-in-progress.json', 'install-gate.json'):
            marker = self.own / 'updates' / name
            marker.write_text('{}')
            self.assertFalse(self.cli('status', '--identity', 'm9')[1]['installFinalized'])
            marker.unlink()
        receipt.unlink()
        self.assertFalse(self.cli('status', '--identity', 'm9')[1]['installFinalized'])
        receipt.write_text('not JSON')
        self.assertFalse(self.cli('status', '--identity', 'm9')[1]['installFinalized'])
        outside = self.home / 'unowned.json'
        outside.write_text(json.dumps(proof))
        receipt.unlink()
        receipt.symlink_to(outside)
        self.assertFalse(self.cli('status', '--identity', 'm9')[1]['installFinalized'])
        state['lastInstall']['receipt'] = str(outside)
        state_path.write_text(json.dumps(state))
        self.assertFalse(self.cli('status', '--identity', 'm9')[1]['installFinalized'])

    def test_completion_refuses_files_changing_during_receipt_read(self):
        for changed in ('state.json', 'installation.json', 'install-gate.json'):
            with self.subTest(changed=changed):
                installation, state, proof, receipt = self.completion_fixture()
                (self.own / 'installation.json').write_text(json.dumps(installation))
                (self.own / 'updates' / 'state.json').write_text(json.dumps(state))
                receipt.write_text(json.dumps(proof))
                real = update_request._read_json

                def racing(path):
                    value = real(path)
                    if path == receipt:
                        target = self.own / changed if changed == 'installation.json' else self.own / 'updates' / changed
                        target.write_text('{}')
                    return value

                with mock.patch.object(update_request, '_read_json', side_effect=racing):
                    self.assertFalse(self.cli('status', '--identity', 'm9')[1]['installFinalized'])

    def test_the_streamed_program_runs_on_the_system_python(self):
        """What fleet_rollout sends a host: the module sources on stdin, no files on the host."""
        python = '/usr/bin/python3' if os.path.exists('/usr/bin/python3') else sys.executable
        host = fleet_rollout.Host('m9', [python, '-B', '-'], extra=['--home', str(self.home)])
        reply = host(['request', '--identity', 'm9', '--version', NEW])
        self.assertEqual(reply['result'], 'requested')
        self.assertEqual(host(['status', '--identity', 'm9'])['installRequest']['version'], NEW)
        with self.assertRaises(fleet_rollout.RolloutError) as caught:
            host(['request', '--identity', 'm9', '--version', 'x'])
        self.assertIn('Invalid version', str(caught.exception))
        installation, state, proof, receipt = self.completion_fixture()
        (self.own / 'installation.json').write_text(json.dumps(installation))
        (self.own / 'updates' / 'state.json').write_text(json.dumps(state))
        receipt.write_text(json.dumps(proof))
        self.assertTrue(host(['status', '--identity', 'm9'])['installFinalized'])

    def test_command_line_dry_run_contacts_nobody(self):
        with tempfile.TemporaryDirectory() as temporary:
            inventory = pathlib.Path(temporary) / 'hosts.json'
            inventory.write_text(json.dumps({'m1': {'host': 'a.test', 'user': 'u'}, 'm3': {'host': 'b.test', 'user': 'u'}}))
            env = dict(os.environ, STUDIO_FLEET_HOSTS=str(inventory), HOME=temporary)
            result = subprocess.run([sys.executable, '-B', str(HERE / 'fleet_rollout.py'), '--version', NEW, '--dry-run'],
                                    capture_output=True, text=True, timeout=60, env=env)
            no_hold = subprocess.run([sys.executable, '-B', str(HERE / 'fleet_rollout.py'), '--version', NEW, '--dry-run',
                                      '--no-hold'], capture_output=True, text=True, timeout=60, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(result.stdout)
        self.assertEqual(plan['order'], ['m4', 'm1+m3'])
        # No installed service in this home: the plan says so instead of failing.
        self.assertTrue(plan['hold'].startswith('unavailable: no readable installation.json'), plan['hold'])
        self.assertEqual(no_hold.returncode, 0, no_hold.stderr)
        self.assertIsNone(json.loads(no_hold.stdout)['hold'])
        bad = subprocess.run([sys.executable, '-B', str(HERE / 'fleet_rollout.py'), '--version', NEW, '--hold-minutes', '20'],
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(bad.returncode, 2)


if __name__ == '__main__':
    unittest.main()
