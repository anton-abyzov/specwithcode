#!/usr/bin/env python3
"""A service that exits during an update's snapshot: synthetic process tables and a temporary
home only, never the live service. The 1.0.112 install on M4 (2026-10-28) refused because the
service was booted out during the minutes-long database read; that stays a refusal, but one the
update agent retries, while a foreign or replaced service process still refuses as before."""
import copy
import importlib.util
import pathlib
import tempfile
import types
import unittest
from unittest.mock import patch

import json

import quiescence
import update_agent
import update_agent_recovery
from service_handles import DETACHED_DATABASE, LOCKS_LOST

spec = importlib.util.spec_from_file_location('owned_update_quiescence', pathlib.Path(__file__).with_name('update.py'))
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)

NODE = '/verified/node22'
ARGS = ['/usr/bin/caffeinate', '-s', '/private/owned/m4/launch.sh']
START = 'Thu Oct 8 13:26:00 2026'


def process(pid, parent, executable, uid=501, started=START):
    return {'pid': pid, 'parent': parent, 'uid': uid, 'startedAt': started, 'executable': executable}


def table(root=100, uid=501, executable=NODE, started=START):
    values = {1: process(1, 0, '/sbin/launchd', 0), 200: process(200, 1, '/private/unrelated/node')}
    if root is not None:
        values[root] = process(root, 1, executable, uid, started)
        values[root + 1] = process(root + 1, root, '/usr/bin/caffeinate', uid)
    return values


def capture(*tables):
    values = iter(tables)
    return quiescence.capture_quiescence(100, 501, NODE, ARGS, process_reader=lambda: copy.deepcopy(next(values)),
                                         argv_reader=lambda pid: ARGS)


class OwnedTree(unittest.TestCase):
    def test_present_service_passes(self):
        self.assertEqual(capture(table(), table())['root']['pid'], 100)

    def test_an_exited_service_is_reported_as_exited(self):
        with self.assertRaisesRegex(AssertionError, '^%s$' % quiescence.SERVICE_EXITED):
            capture(table(root=None))

    def test_a_service_that_exits_between_the_two_inventories_is_exited(self):
        with self.assertRaisesRegex(AssertionError, '^%s$' % quiescence.SERVICE_EXITED):
            capture(table(), table(root=None))

    def test_a_foreign_uid_under_the_pid_still_refuses_as_changed(self):
        with self.assertRaisesRegex(AssertionError, '^%s$' % quiescence.SERVICE_CHANGED):
            capture(table(uid=502))

    def test_another_executable_under_the_pid_still_refuses(self):
        with self.assertRaisesRegex(AssertionError, 'Owned service executable changed'):
            capture(table(executable='/private/unrelated/node'))

    def test_a_reused_pid_between_inventories_still_refuses(self):
        with self.assertRaisesRegex(AssertionError, 'Owned process identities changed during inventory'):
            capture(table(), table(started='Fri Oct 9 09:00:00 2026'))


class Snapshot(unittest.TestCase):
    """update._snapshot with every service, database and listener check stubbed; only the
    process tables vary. `tables` is what each ps read returns, in order."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        home = pathlib.Path(self.temp.name).resolve()
        own = home / 'own'
        (own / 'userdata').mkdir(parents=True)
        files = {'launcher': own / 'launch.sh', 'plist': own / 'agent.plist', 'wrapper': own / 'wrapper.sh',
                 'installation': own / 'installation.json'}
        for path in [*files.values(), own / 'userdata/environment-id']:
            path.write_text('x')
        (own / 'userdata/settings.json').write_text('{}')
        self.service = dict(files, home=home, own=own, label='com.specweave.studio.test', node=pathlib.Path(NODE),
                            content={'ProgramArguments': ARGS}, runtime={'pid': 100},
                            owner=types.SimpleNamespace(uid=501, policy='default'),
                            receipt={'port': 8319, 'archiveSha256': 'a' * 64, 'sourceCommit': 'b' * 40, 'cookieName': 'c'})
        self.reads = []

    def snapshot(self, *tables, database_error=None):
        values = iter(tables)

        def locked(state):
            if database_error:
                raise AssertionError(database_error)

        def captured(pid, uid, executable, argv):
            return quiescence.capture_quiescence(pid, uid, executable, argv, argv_reader=lambda pid: ARGS,
                                                 process_reader=lambda: copy.deepcopy(next(values)))

        def read_state(*args):
            self.reads.append(args)
            return {'nativeWorkIdle': True, 'counts': {}}, None, None, {'tables': {}}
        with patch.object(update, '_service', return_value=self.service), \
                patch.object(update, 'assert_database_attached'), patch.object(update, 'assert_database_locked', side_effect=locked), \
                patch.object(update, '_read_state', side_effect=read_state), \
                patch.object(update, 'listeners', return_value=[]), \
                patch.object(update, 'read_processes', return_value={}), \
                patch.object(update, 'capture_quiescence', side_effect=captured):
            return update.snapshot_since('identity', {'counts': {}})

    def test_a_steady_service_snapshots(self):
        proof, _, _ = self.snapshot(table(), table(), table(), table())
        self.assertEqual(proof['servicePid'], 100)
        self.assertEqual(proof['processQuiescence']['root']['pid'], 100)
        self.assertEqual(len(self.reads), 1)

    def test_a_service_stopped_during_the_read_refuses_with_a_retryable_restart(self):
        # 2026-10-28: the check before the read passed; launchd booted the service out mid-read.
        with self.assertRaises(AssertionError) as caught:
            self.snapshot(table(), table(), table(root=None))
        self.assertEqual(str(caught.exception), update.SERVICE_RESTARTED)
        self.assertEqual(len(self.reads), 1)

    def test_a_service_restarted_under_a_new_pid_during_the_read_refuses(self):
        # KeepAlive respawned it: the rows were read from the old process, so no proof is returned.
        with self.assertRaises(AssertionError) as caught:
            self.snapshot(table(), table(), table(root=300), table(root=300))
        self.assertEqual(str(caught.exception), update.SERVICE_RESTARTED)

    def test_a_service_already_gone_before_the_read_refuses_without_reading(self):
        with self.assertRaises(AssertionError) as caught:
            self.snapshot(table(root=None))
        self.assertEqual(str(caught.exception), update.SERVICE_RESTARTED)
        self.assertEqual(self.reads, [])

    def test_a_service_gone_before_the_lock_check_is_a_restart_not_lost_locks(self):
        # Unloaded between _service and the lock check: nothing holds the locks because nothing runs.
        for reason in (LOCKS_LOST, DETACHED_DATABASE):
            with self.subTest(reason=reason[:40]), self.assertRaises(AssertionError) as caught:
                self.snapshot(table(root=None), database_error=reason)
            self.assertEqual(str(caught.exception), update.SERVICE_RESTARTED)
            self.assertEqual(self.reads, [])

    def test_a_running_service_that_lost_its_locks_still_needs_a_restart(self):
        for reason in (LOCKS_LOST, DETACHED_DATABASE):
            with self.subTest(reason=reason[:40]), self.assertRaises(AssertionError) as caught:
                self.snapshot(table(), table(), database_error=reason)
            self.assertEqual(str(caught.exception), reason)
            self.assertEqual(update.refusal_line('identity', caught.exception).split()[:2], ['REFUSAL', 'restart-needed'])
        self.assertEqual(self.reads, [])

    def test_lost_locks_under_a_foreign_or_busy_service_stay_lost_locks(self):
        # Only a missing process becomes a restart; any other identity failure keeps the database refusal.
        for tables in ((table(uid=502),), (table(), table(started='Fri Oct 9 09:00:00 2026'))):
            with self.subTest(tables=len(tables)), self.assertRaises(AssertionError) as caught:
                self.snapshot(*tables, database_error=LOCKS_LOST)
            self.assertEqual(str(caught.exception), LOCKS_LOST)

    def test_a_foreign_uid_service_after_the_read_still_refuses_as_changed(self):
        with self.assertRaisesRegex(AssertionError, '^%s$' % quiescence.SERVICE_CHANGED):
            self.snapshot(table(), table(), table(uid=502))

    def test_a_replaced_service_after_the_read_still_refuses_as_changed(self):
        with self.assertRaisesRegex(AssertionError, 'Owned process identities changed during inventory'):
            self.snapshot(table(), table(), table(), table(started='Fri Oct 9 09:00:00 2026'))


class Agent:
    """The attributes refusal_proof reads; its module resolves to update_agent (recovery._ua)."""
    __module__ = 'update_agent'

    def __init__(self, home):
        self.home, self.updates, self.identity = home, home / 'updates', 'm4'


class Classification(unittest.TestCase):
    def receipt(self, error):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        agent = Agent(pathlib.Path(temp.name).resolve())
        path = agent.updates / 'receipts' / 'update-1.0.112-20261028T212657095653Z.json'
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({'identity': 'm4', 'phase': 'preflight', 'result': 'update-failed',
                                    'error': 'AssertionError: ' + error, 'pointers': 'unchanged'}))
        return agent, path

    def test_an_automatic_install_records_a_retry_for_the_restart_refusal(self):
        # The automatic pass (may_retry=False) retries only what refusal_proof accepts: a prefix match.
        agent, path = self.receipt(update.SERVICE_RESTARTED)
        with patch.object(update_agent_recovery, 'installation_fingerprint', return_value='same'):
            self.assertIsNotNone(update_agent_recovery.refusal_proof(agent, str(path), 'same'))
            self.assertIsNone(update_agent_recovery.refusal_proof(agent, str(path), 'changed'))

    def test_the_automatic_path_still_refuses_to_retry_a_changed_service(self):
        for error in (quiescence.SERVICE_CHANGED, LOCKS_LOST):
            agent, path = self.receipt(error)
            with self.subTest(error=error[:40]), \
                    patch.object(update_agent_recovery, 'installation_fingerprint', return_value='same'):
                self.assertIsNone(update_agent_recovery.refusal_proof(agent, str(path), 'same'))

    def test_install_now_retries_the_restart_refusal(self):
        # update_agent_recovery.refused_before_restart matches these phrases in the receipt's error.
        self.assertTrue(any(phrase in 'AssertionError: ' + update.SERVICE_RESTARTED
                            for phrase in update_agent.RETRYABLE_REFUSALS + update_agent.PROCESS_REFUSALS))
        self.assertNotIn('descendants', update.SERVICE_RESTARTED)

    def test_an_exited_or_restarted_service_is_a_busy_snapshot_refusal(self):
        for message in (update.SERVICE_RESTARTED, quiescence.SERVICE_EXITED, quiescence.SERVICE_CHANGED):
            with self.subTest(message=message):
                self.assertEqual(update.refusal_line('identity', AssertionError(message)), 'REFUSAL busy AssertionError')


if __name__ == '__main__':
    unittest.main()
