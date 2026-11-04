#!/usr/bin/env python3
"""When M4 finalizes a version by any path (Update now with createdBy desktop, the hourly agent), its
agent starts a workers reconcile from that release's helpers, so M1 and M3 on N-1 get a request and a
row (the 1.0.186 case; increment 1239, AC-07).

Run: cd scripts/studio-fleet && python3 -B test-reconcile-on-finalize.py
"""
import contextlib
import io
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import fleet_rollout  # noqa: E402
import update_agent  # noqa: E402
import update_agent_cache as cache  # noqa: E402
from rollout_test_fakes import NEW, OLD, Clock, Fleet, quiet  # noqa: E402


class FakeAgent(object):
    def __init__(self, home, identity='m4'):
        self.home = pathlib.Path(home)
        self.identity = identity
        self.own = self.home / '.specwithcode' / identity
        self.updates = self.own / 'updates'
        self.test_mode = True

    def helper_python(self):
        return sys.executable


FakeAgent.__module__ = 'update_agent'  # cache reaches the agent's helpers through its module.


class Launch(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.home = pathlib.Path(self.dir.name)
        self.spawned = []
        self.patch = mock.patch.object(cache, 'SPAWN', lambda argv, **kwargs: self.spawned.append((argv, kwargs)))
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.dir.cleanup()

    def agent(self, identity='m4', machines=True, helpers=True):
        agent = FakeAgent(self.home, identity)
        agent.updates.mkdir(parents=True)
        if machines:
            (agent.own / 'studio-fleet.json').write_text(json.dumps({'machines': [{'id': 'm1'}, {'id': 'm3'}]}))
        if helpers:
            root = agent.updates / 'helpers' / NEW / 'specwithcode-helpers' / 'scripts' / 'studio-fleet'
            root.mkdir(parents=True)
            (root / 'fleet_rollout.py').write_text('# the release\'s rollout\n')
            (root / 'test-fleet-rollout.py').write_text('# not copied\n')
        return agent

    def test_m4_install_starts_a_detached_reconcile_from_the_release_helpers(self):
        agent = self.agent()
        log = cache.reconcile_workers(agent, NEW)
        self.assertEqual(len(self.spawned), 1)
        argv, kwargs = self.spawned[0]
        folders = list((agent.updates / 'reconcile').iterdir())
        self.assertEqual(len(folders), 1)
        self.assertTrue(folders[0].name.startswith(NEW + '-'))
        copy = folders[0] / 'studio-fleet'
        self.assertEqual(argv[1:], ['-B', str(copy / 'fleet_rollout.py'), '--version', NEW, '--reconcile'])
        self.assertTrue(kwargs['start_new_session'])
        self.assertTrue((copy / 'fleet_rollout.py').is_file())
        self.assertFalse((copy / 'test-fleet-rollout.py').exists())
        self.assertEqual(log, folders[0] / 'reconcile.log')
        # The helpers can now be cleaned up: the reconcile runs from its own copy.
        cache.cleanup_versions(agent, update_agent.version_tuple(NEW))
        self.assertTrue((copy / 'fleet_rollout.py').is_file())

    def test_a_second_reconcile_never_removes_a_running_one_and_old_ones_go(self):
        agent = self.agent()
        first = cache.reconcile_workers(agent, NEW).parent
        old = agent.updates / 'reconcile' / ('1.0.30-1-1')
        old.mkdir()
        stale = cache.time.time() - cache.RECONCILE_KEEP_SECONDS - 60
        os.utime(str(old), (stale, stale))
        with mock.patch.object(cache.os, 'getpid', lambda: 424242):  # Same second, another agent pass.
            second = cache.reconcile_workers(agent, NEW).parent
        self.assertNotEqual(first, second)
        self.assertTrue((first / 'studio-fleet' / 'fleet_rollout.py').is_file())
        self.assertFalse(old.exists())

    def test_workers_never_reconcile(self):
        self.assertIsNone(cache.reconcile_workers(self.agent('m1'), NEW))
        self.assertEqual(self.spawned, [])

    def test_m4_without_a_fleet_does_nothing(self):
        self.assertIsNone(cache.reconcile_workers(self.agent(machines=False), NEW))
        self.assertEqual(self.spawned, [])

    def test_switch_turns_it_off(self):
        with mock.patch.dict(os.environ, {'STUDIO_FLEET_RECONCILE': '0'}):
            self.assertIsNone(cache.reconcile_workers(self.agent(), NEW))
        self.assertEqual(self.spawned, [])

    def test_missing_helpers_never_raise(self):
        self.assertIsNone(cache.reconcile_workers(self.agent(helpers=False), NEW))

    def test_complete_install_calls_it_on_success_only(self):
        source = (HERE / 'update_agent.py').read_text()
        success = source.index("'result': 'updated'")
        call = source.index('cache.reconcile_workers(self, version)')
        failed = source.index("'result': 'failed', 'receipt': str(receipt)")
        self.assertLess(success, call)
        self.assertLess(call, failed)


class Reconcile(unittest.TestCase):
    def test_update_now_on_m4_brings_m1_and_m3_with_rows(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m1': 1, 'm3': 1})
        fleet.version['m4'] = NEW  # M4 got it through Update now (createdBy desktop); nobody asked the workers.
        real = fleet_rollout.rollout

        def fake_rollout(*args, **kwargs):
            kwargs.update(clock=clock, sleep=clock.sleep, say=quiet)
            return real(*args, **kwargs)
        out = io.StringIO()
        with tempfile.TemporaryDirectory() as home, \
                mock.patch.object(fleet_rollout, 'fleet', lambda: fleet.hosts()), \
                mock.patch.object(fleet_rollout, 'rollout', fake_rollout), \
                mock.patch.object(fleet_rollout, 'lock_path', lambda: pathlib.Path(home) / 'lock'), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = fleet_rollout.main(['--version', NEW, '--reconcile', '--no-desktop-apps'])
        self.assertEqual(code, 0)
        value = json.loads(out.getvalue().strip().splitlines()[-1])
        self.assertEqual({name: value['hosts'][name]['result'] for name in ('m1', 'm3')},
                         {'m1': 'installed', 'm3': 'installed'})
        self.assertEqual(fleet.calls('m4', 'request'), [])  # M4 is never asked again.
        self.assertEqual(len(fleet.calls('m1', 'request')), 1)
        self.assertEqual(fleet.version['m1'], NEW)
        self.assertNotEqual(OLD, NEW)

    def test_reconcile_waits_for_m4_to_save_its_install(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m1': 1, 'm3': 1})
        real_m4, reads = fleet.host('m4'), {'n': 0}

        def m4(argv):  # The agent saves its state a few seconds after it started the reconcile.
            reads['n'] += 1
            if reads['n'] == 3:
                fleet.version['m4'] = NEW
            return real_m4(argv)
        hosts = fleet.hosts()
        hosts['m4'] = m4
        results = fleet_rollout.rollout(NEW, hosts, only='workers', clock=clock, sleep=clock.sleep, say=quiet,
                                        m4_wait=fleet_rollout.RECONCILE_WAIT)
        self.assertEqual(results['m1']['result'], 'installed')

    def test_reconcile_refuses_when_m4_has_not_finalized(self):
        clock = Clock()
        fleet = Fleet(clock)
        out = io.StringIO()
        with tempfile.TemporaryDirectory() as home, \
                mock.patch.object(fleet_rollout, 'fleet', lambda: fleet.hosts()), \
                mock.patch.object(fleet_rollout, 'lock_path', lambda: pathlib.Path(home) / 'lock'), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            with mock.patch.object(fleet_rollout, 'RECONCILE_WAIT', 0):
                code = fleet_rollout.main(['--version', NEW, '--reconcile', '--no-desktop-apps'])
        self.assertEqual(code, 1)
        self.assertEqual(fleet.asked, {})


if __name__ == '__main__':
    unittest.main()
