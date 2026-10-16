#!/usr/bin/env python3
"""fleet_rollout and the update_request command line, against a fake fleet and temporary homes.

No host is contacted and no launchd job is started: the rollout tests drive fake hosts with a
fake clock, and the command-line tests run update_request.py (and the program fleet_rollout
streams to a host) in a temporary private home.

Run: cd scripts/studio-fleet && python3 -B test-fleet-rollout.py
"""
import contextlib
import io
import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest

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
                        'status': 'installed' if self.version[identity] == NEW else self.status[identity],
                        'message': None if self.version[identity] == NEW else self.message[identity],
                        'downloadedVersion': NEW, 'availableVersion': self.available.get(identity, NEW)}
        return call

    def hosts(self):
        return {name: self.host(name) for name in ('m4', 'm1', 'm3')}

    def calls(self, identity, kind):
        return [entry for entry in self.log if entry[0] == identity and entry[1] == kind]


def quiet(_line):
    pass


class RolloutOrder(unittest.TestCase):
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

    def test_command_line_dry_run_contacts_nobody(self):
        with tempfile.TemporaryDirectory() as temporary:
            inventory = pathlib.Path(temporary) / 'hosts.json'
            inventory.write_text(json.dumps({'m1': {'host': 'a.test', 'user': 'u'}, 'm3': {'host': 'b.test', 'user': 'u'}}))
            env = dict(os.environ, STUDIO_FLEET_HOSTS=str(inventory), HOME=temporary)
            result = subprocess.run([sys.executable, '-B', str(HERE / 'fleet_rollout.py'), '--version', NEW, '--dry-run'],
                                    capture_output=True, text=True, timeout=60, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(result.stdout)
        self.assertEqual(plan['order'], ['m4', 'm1+m3'])
        bad = subprocess.run([sys.executable, '-B', str(HERE / 'fleet_rollout.py'), '--version', NEW, '--hold-minutes', '20'],
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(bad.returncode, 2)


if __name__ == '__main__':
    unittest.main()
