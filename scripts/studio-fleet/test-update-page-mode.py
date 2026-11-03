#!/usr/bin/env python3
"""Page-mode prepare/stop/clone/restart/readiness and full fallback, on synthetic services."""
import datetime
import json
import random
import sqlite3
import subprocess
import time
import state_backup
import importlib.util
import pathlib
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import database_continuity as continuity
import kept_lines
import update_apply
import update_compare
import update_read

spec = importlib.util.spec_from_file_location('page_apply_fixture', pathlib.Path(__file__).with_name('test-after-proof.py'))
f = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f)
START, END = '2026-10-22T14:00:00Z', '2026-10-22T14:06:00Z'


class Clock(datetime.datetime):
    @classmethod
    def now(cls, tz=None): return cls.fromisoformat(END.replace('Z', '+00:00'))


class Pipeline(unittest.TestCase):
    def setUp(self):
        for target, name, value in ((kept_lines, 'available_memory', 1 << 50),):
            p = patch.object(target, name, return_value=value);p.start();self.addCleanup(p.stop)
        p = patch.object(update_apply.datetime, 'datetime', Clock);p.start();self.addCleanup(p.stop)
        self.flow = f.Update(self)
        self.addCleanup(self.flow.kept.clear)
        self.pid = 100
        self.calls = 0
        def snapshot(identity, include_auth, reads=None, passing=None):
            self.calls += 1
            rows, auth, carried, capture = reads
            return {'rows': rows, 'databaseCapture': capture, 'servicePid': self.pid, 'observedAt': END}, auth, carried
        self.n = SimpleNamespace(_service=lambda identity: {'own': self.flow.state.parent}, _snapshot=snapshot,
                                 assert_held=lambda service, request: None, same_guarded_rows=update_compare.same_guarded_rows)
        self.expected = {'snapshotMode': 'held-service', 'servicePid': 100, 'installRequestedAt': START}

    def prepare(self, heartbeat=True):
        mode = update_apply.PageMode.prepare(self.n, 'm4', self.expected, heartbeat)
        self.assertIsNotNone(mode)
        before, auth, _ = mode.snapshot()
        self.assertNotIn('databaseCapture', before)
        self.assertNotIn('orchestration_events', before['rows']['hashes'])
        self.assertIn('projectIds', before['rows'])
        return mode, before, auth

    def restart(self, mode, before, auth, writes=True):
        self.flow.mark();self.flow.stop();self.flow.clone()
        mode.stopped(self.flow.held, before, auth, START, 'browser-cookie')
        self.flow.restart(writes=writes);self.pid = 101
        return mode.after(self.flow.held, START, 'browser-cookie')

    def test_complete_pipeline_decodes_only_changes_and_keeps_metadata_checks(self):
        mode, before, auth = self.prepare()
        after, current, carried = self.restart(mode, before, auth)
        witness = mode.validate_auth(before['rows'], after['rows'], auth, current, START, END, 'browser-cookie')
        self.assertEqual(witness['changedRows'], 1)
        self.assertEqual(mode.verdict['appendedRows']['orchestration_events'], 30)
        self.assertLess(mode.verdict['decodedRows'], 1000)
        self.assertGreaterEqual(self.calls, 2)
        receipt = {'rowsByteIdentical': True}
        mode.receipt(receipt)
        self.assertNotIn('rowsByteIdentical', receipt)
        self.assertEqual(receipt['rowPreservation'], 'verified-stopped-clone-pages')

    def grow_auth(self, sessions, links):
        """M4 after the October 31 Connect storm: old rows only, none of them in use."""
        db = sqlite3.connect('file:%s?mode=ro' % self.flow.database, uri=True)
        names = [row[1] for row in db.execute('PRAGMA table_info(auth_sessions)')]
        columns = [row[1] for row in db.execute('PRAGMA table_info(auth_pairing_links)')]
        db.close()
        select = ', '.join("'grown-' || value" if name == 'session_id' else name for name in names)
        counting = 'WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < ?) '
        self.flow.old.commit(
            ('INSERT INTO auth_sessions(' + ', '.join(names) + ') ' + counting + 'SELECT ' + select +
             ' FROM n, (SELECT * FROM auth_sessions LIMIT 1)', [sessions]),
            ('INSERT INTO auth_pairing_links(' + ', '.join(columns) + ') ' + counting + 'SELECT ' +
             ', '.join("'link-' || value" for _ in columns) + ' FROM n', [links]))

    def test_large_auth_tables_keep_the_page_path(self):
        self.grow_auth(48000, 55000)
        report = {}
        started = time.monotonic()
        mode = update_apply.PageMode.prepare(self.n, 'm4', self.expected, True, report=report)
        self.assertIsNotNone(mode, report)
        before, auth, _ = mode.snapshot()
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(report, {})
        self.assertEqual(before['rows']['counts']['auth_pairing_links'], 55001)
        after, _, _ = self.restart(mode, before, auth)
        self.assertIsNone(mode.fallback_reason)
        self.assertIsNotNone(mode.verdict)
        self.assertEqual(after['rows']['counts']['auth_pairing_links'], 55001)

    def test_a_refused_page_mode_says_why(self):
        report = {}
        with patch.object(update_apply, 'AUTHORITY_ROW_BUDGET', 0):
            self.assertIsNone(update_apply.PageMode.prepare(self.n, 'm4', self.expected, True, report=report))
        self.assertEqual(report['pageModeRefused'], 'AssertionError:Authority capture budget exceeded')

    def test_write_during_verification_retries_instead_of_full_fallback(self):
        mode, before, auth = self.prepare()
        self.flow.mark();self.flow.stop();self.flow.clone()
        mode.stopped(self.flow.held, before, auth, START, 'browser-cookie')
        self.flow.restart();self.pid = 101
        snapshot = mode.snapshot
        calls = []
        def snapshot_then_heartbeat(passing=None):
            calls.append(1)
            value = snapshot(passing=passing)
            if len(calls) == 1:  # A reconnect heartbeat lands after the proof, before the watermark check.
                self.flow.new.heartbeat('session-1', '2026-10-22T14:05:30Z')
            return value
        mode.snapshot = snapshot_then_heartbeat
        with patch.object(update_apply, 'PAGE_VERIFY_QUIET_SECONDS', 0.05):
            after, current, carried = mode.after(self.flow.held, START, 'browser-cookie')
        self.assertEqual(mode.after_attempts, 2)
        self.assertIsNotNone(mode.verdict)
        self.assertIsNone(mode.fallback_reason)

    def restart_with_snapshot(self, wrap, **patches):
        mode, before, auth = self.prepare()
        self.flow.mark();self.flow.stop();self.flow.clone()
        mode.stopped(self.flow.held, before, auth, START, 'browser-cookie')
        self.flow.restart();self.pid = 101
        mode.snapshot = wrap(mode.snapshot)
        with patch.object(update_apply, 'PAGE_VERIFY_DESCENDANT_POLL_SECONDS', 0.01), \
             patch.object(update_apply, 'PAGE_VERIFY_QUIET_SECONDS', 0.05):
            with patch.multiple(update_apply, **{'PAGE_VERIFY_DESCENDANT_SECONDS': 30, **patches}):
                return mode, mode.after(self.flow.held, START, 'browser-cookie')

    def refusing(self, error, times, calls, then=None):
        def wrap(snapshot):
            def refused_first(passing=None):
                calls.append(1)
                if len(calls) <= times:
                    raise error
                if then: then(len(calls))
                return snapshot(passing=passing)
            return refused_first
        return wrap

    def passing_child(self, error):
        calls = []
        mode, value = self.restart_with_snapshot(self.refusing(error, 3, calls))
        self.assertIsNotNone(value)
        self.assertEqual(len(calls), 4)
        self.assertEqual(mode.after_attempts, 1)  # Not proved again, only the process check.
        self.assertEqual(mode.child_waits, 3)
        self.assertIsNotNone(mode.verdict)
        self.assertIsNone(mode.fallback_reason)
        receipt = {}
        mode.receipt(receipt)
        self.assertEqual(receipt['pageChildWaits'], 3)

    def test_a_passing_child_keeps_the_page_proof(self):
        self.passing_child(AssertionError('Owned service has unexpected descendants'))

    def test_a_child_exiting_during_the_inventory_keeps_the_page_proof(self):
        self.passing_child(AssertionError('Owned process identities changed during inventory'))

    def test_an_inventory_timeout_keeps_the_page_proof(self):
        self.passing_child(subprocess.TimeoutExpired('ps', 1))

    def test_a_child_that_stays_still_takes_the_full_read(self):
        calls = []
        mode, value = self.restart_with_snapshot(
            self.refusing(AssertionError('Owned service has unexpected descendants'), 10**6, calls),
            PAGE_VERIFY_DESCENDANT_SECONDS=0.05)
        self.assertIsNone(value)
        self.assertIsNone(mode.verdict)
        self.assertEqual(mode.fallback_reason, 'AssertionError:Owned service has unexpected descendants')
        self.assertGreater(len(calls), 1)

    def test_a_timeout_that_never_ends_takes_the_full_read(self):
        calls = []
        mode, value = self.restart_with_snapshot(
            self.refusing(subprocess.TimeoutExpired('ps', 1), 10**6, calls), PAGE_VERIFY_DESCENDANT_SECONDS=0.05)
        self.assertIsNone(value)
        self.assertTrue(mode.fallback_reason.startswith('TimeoutExpired:'))

    def test_other_refusals_are_not_waited_on(self):
        calls = []
        mode, value = self.restart_with_snapshot(self.refusing(AssertionError('A protected Studio file is missing or is a link'), 10**6, calls))
        self.assertIsNone(value)
        self.assertEqual(len(calls), 1)
        self.assertEqual(mode.child_waits, 0)

    def test_a_write_while_waiting_on_a_child_proves_again(self):
        calls = []
        def write(count):
            if count == 3: self.flow.new.heartbeat('session-1', '2026-10-22T14:05:30Z')
        mode, value = self.restart_with_snapshot(
            self.refusing(AssertionError('Owned service has unexpected descendants'), 2, calls, then=write))
        self.assertIsNotNone(value)
        self.assertEqual(mode.after_attempts, 2)  # The watermark moved during the wait, so that proof is discarded.
        self.assertIsNotNone(mode.verdict)

    def child(self, pid, name='git', started='Tue Nov 3 19:30:00 2026'):
        return {'pid': pid, 'parent': 101, 'uid': 501, 'startedAt': started, 'executable': '/usr/bin/' + name}

    def with_children(self, children_per_call, alive, holders=()):
        """Each capture sets aside its call's children; `alive(pids_seen, poll)` lists who still runs."""
        captures, polls, held_asked = [], [], []
        def wrap(snapshot):
            def capture(passing=None):
                captures.append(1)
                children = children_per_call(len(captures))
                if passing is not None:
                    passing.extend(children)
                return snapshot(passing=passing)
            return capture
        def processes():
            polls.append(1)
            return {item['pid']: item for item in alive(len(polls))}
        def database_holders(state, pids):
            held_asked.append(sorted(pids))
            return set(pids) & set(holders)
        def setup(mode):
            mode.process_reader, mode.database_holders = processes, database_holders
            return wrap(mode.snapshot)
        return setup, captures, polls, held_asked

    def restart_with_children(self, setup, **patches):
        mode, before, auth = self.prepare()
        self.flow.mark();self.flow.stop();self.flow.clone()
        mode.stopped(self.flow.held, before, auth, START, 'browser-cookie')
        self.flow.restart();self.pid = 101
        mode.snapshot = setup(mode)
        with patch.object(update_apply, 'PAGE_VERIFY_DESCENDANT_POLL_SECONDS', 0.01), \
             patch.object(update_apply, 'PAGE_VERIFY_QUIET_SECONDS', 0.05), \
             patch.multiple(update_apply, **{'PAGE_VERIFY_DESCENDANT_SECONDS': 30, **patches}):
            return mode, mode.after(self.flow.held, START, 'browser-cookie')

    def test_a_child_that_exits_within_the_grace_keeps_the_page_proof(self):
        git = self.child(4123)
        setup, captures, polls, held = self.with_children(lambda call: [git], lambda poll: [git] if poll < 3 else [])
        mode, value = self.restart_with_children(setup)
        self.assertIsNotNone(value)
        self.assertIsNone(mode.fallback_reason)
        self.assertIsNotNone(mode.verdict)
        self.assertEqual((len(captures), len(polls), mode.child_waits), (1, 3, 2))
        self.assertEqual(held, [[4123]])  # Asked whether it holds the database before waiting on it.

    def test_children_starting_on_every_capture_no_longer_force_the_full_read(self):
        """M4 after a restart: a new git or ps is always running, so no capture is ever empty."""
        setup, captures, polls, _ = self.with_children(
            lambda call: [self.child(5000 + call, 'ps')], lambda poll: [])
        mode, value = self.restart_with_children(setup)
        self.assertIsNotNone(value)
        self.assertIsNone(mode.fallback_reason)
        self.assertEqual(len(captures), 1)

    def test_a_pid_reused_by_a_new_process_counts_as_exited(self):
        git = self.child(4123)
        setup, _, _, _ = self.with_children(lambda call: [git], lambda poll: [dict(git, startedAt='Tue Nov 3 19:31:00 2026')])
        mode, value = self.restart_with_children(setup)
        self.assertIsNotNone(value)

    def test_an_unreaped_child_counts_as_exited(self):
        git = self.child(4123)
        setup, _, _, _ = self.with_children(lambda call: [git], lambda poll: [dict(git, executable='<defunct>')])
        mode, value = self.restart_with_children(setup)
        self.assertIsNotNone(value)

    def test_a_child_that_stays_takes_the_full_read_and_names_itself(self):
        claude = self.child(4200, 'claude')
        setup, _, _, _ = self.with_children(lambda call: [claude], lambda poll: [claude])
        mode, value = self.restart_with_children(setup, PAGE_VERIFY_DESCENDANT_SECONDS=0.05)
        self.assertIsNone(value)
        self.assertIsNone(mode.verdict)
        self.assertEqual(mode.fallback_reason,
                         'AssertionError:Owned service has unexpected descendants [pid 4200 claude (parent 101)]')
        receipt = {}
        mode.report(receipt)
        self.assertEqual(receipt['pageFallback'], mode.fallback_reason)
        self.assertIn('pid 4200 claude', receipt['pageChildRefusals'][0])

    def test_a_child_holding_the_database_refuses_at_once(self):
        tool = self.child(4300, 'sqlite3')
        setup, captures, polls, _ = self.with_children(lambda call: [tool], lambda poll: [tool], holders=[4300])
        mode, value = self.restart_with_children(setup)
        self.assertIsNone(value)
        self.assertEqual((len(captures), len(polls)), (1, 0))
        self.assertEqual(mode.fallback_reason, 'AssertionError:' + update_apply.DATABASE_HELD_BY_CHILD
                         + ' [pid 4300 sqlite3 (parent 101)]')

    def test_a_write_while_a_child_exits_proves_again(self):
        git = self.child(4123)
        def alive(poll):
            if poll == 1: self.flow.new.heartbeat('session-1', '2026-10-22T14:05:30Z')
            return [git] if poll == 1 else []
        setup, captures, _, _ = self.with_children(lambda call: [git] if call == 1 else [], alive)
        mode, value = self.restart_with_children(setup)
        self.assertIsNotNone(value)
        self.assertEqual(mode.after_attempts, 2)  # The wait saw a write: that proof is discarded, not kept.

    def test_every_waited_refusal_is_kept_with_its_processes(self):
        calls = []
        error = update_apply.quiescence.UnexpectedDescendants([self.child(4400, 'gh')])
        mode, value = self.restart_with_snapshot(self.refusing(error, 2, calls))
        self.assertIsNotNone(value)
        receipt = {}
        mode.report(receipt)
        self.assertEqual(receipt['pageChildRefusals'],
                         ['AssertionError:Owned service has unexpected descendants [pid 4400 gh (parent 101)]'] * 2)
        self.assertNotIn('pageFallback', receipt)

    def test_a_kernel_read_of_an_exited_child_is_waited_on(self):
        self.passing_child(AssertionError('Process executable unavailable'))

    def test_no_heartbeat_opt_in_declines_page_verdict(self):
        mode, before, auth = self.prepare(heartbeat=False)
        self.assertIsNone(self.restart(mode, before, auth))
        self.assertIsNone(mode.verdict)
        self.assertIn('not authorized', mode.fallback_reason)

    def test_authority_changed_before_stop_refuses_before_activation(self):
        mode, before, auth = self.prepare()
        self.flow.old.commit(("UPDATE scheduled_tasks SET cron='changed'", []))
        with self.assertRaisesRegex(AssertionError, 'Authority changed'):
            self.restart(mode, before, auth, writes=False)
        self.assertIsNone(self.flow.new)

    def test_deleted_thread_before_stop_refuses(self):
        mode, before, auth = self.prepare()
        self.flow.old.commit(("DELETE FROM projection_threads WHERE thread_id='t-1'", []),
                             ("DELETE FROM orchestration_v2_projection_threads WHERE thread_id='t-1'", []))
        with self.assertRaisesRegex(AssertionError, 'Authority changed'):
            self.restart(mode, before, auth, writes=False)

    def test_schema_fallback_reads_stopped_clone_not_mutated_live_baseline(self):
        mode, before, auth = self.prepare()
        self.restart(mode, before, auth, writes=False)
        self.flow.new.commit(('CREATE TABLE newly_migrated(id INTEGER)', []))
        mode.verdict = None
        self.assertIsNone(mode.after(self.flow.held, START, 'browser-cookie'))
        baseline, original = mode.full_baseline(self.flow.held, before)
        current = update_read._read_state(self.flow.state, True, baseline['rows'], True)
        self.assertNotIn('newly_migrated', baseline['databaseCapture']['schema']['columns'])
        self.assertIn('newly_migrated', current[3]['schema']['columns'])
        with self.assertRaises(AssertionError):
            continuity.assert_database_continuity(baseline['databaseCapture']['summary'], current[3]['summary'])

    def test_old_log_rewrite_refuses_both_page_and_full_fallback(self):
        mode, before, auth = self.prepare()
        self.restart(mode, before, auth, writes=False)
        self.flow.new.commit(("UPDATE orchestration_events SET payload_json='changed' WHERE sequence=1", []))
        mode.verdict = None
        self.assertIsNone(mode.after(self.flow.held, START, 'browser-cookie'))
        baseline, _ = mode.full_baseline(self.flow.held, before)
        current = update_read._read_state(self.flow.state, True, baseline['rows'], True)
        self.assertFalse(update_compare.same_guarded_rows(baseline['rows'], current[0], current[2]))

    def test_old_pid_never_leaves_a_valid_verdict_for_retry(self):
        mode, before, auth = self.prepare()
        self.restart(mode, before, auth, writes=False)
        mode.verdict = None;self.pid = 100
        self.assertIsNone(mode.after(self.flow.held, START, 'browser-cookie'))
        self.assertIsNone(mode.verdict)

    def test_unheld_admission_keeps_full_protocol(self):
        self.assertIsNone(update_apply.PageMode.prepare(self.n, 'm4', {}, True))




class ApplyBranches(unittest.TestCase):
    """Run the actual _apply policy; replace only OS service transport/metadata with the existing fixture."""
    def setUp(self):
        spec = importlib.util.spec_from_file_location('apply_page_os', pathlib.Path(__file__).with_name('test-update.py'))
        module = importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        self.h = h = module.ApplyRecovery('runTest');h.setUp();self.addCleanup(h.tearDown)
        self.update = module.update
        f.build(h.own / 'userdata', events=30, items=30)
        self.old = f.Writer(h.own / 'userdata/statev2.sqlite');self.addCleanup(self.old.close)
        self.old.heartbeat()
        h.real_db = h.capture_database = True
        now = datetime.datetime.now(datetime.timezone.utc)
        request = now.isoformat()
        runtime = {'pid': 100, 'startedAt': (now - datetime.timedelta(minutes=5)).isoformat(), 'host': '127.0.0.1', 'port': 8319}
        (h.own / 'userdata/server-runtime.json').write_text(json.dumps(runtime))
        updates = h.own / 'updates';updates.mkdir(exist_ok=True)
        (updates / 'hold.json').write_text(json.dumps({'schemaVersion': 1, 'pid': 100,
            'startedAt': (now-datetime.timedelta(seconds=1)).isoformat(), 'expiresAt': (now+datetime.timedelta(minutes=5)).isoformat()}))
        (updates / 'config.json').write_text(json.dumps({'installMode': 'force', 'installRequestedAt': request}))
        h.before.update(snapshotMode='held-service', installRequestedAt=request, rows={'nativeWorkIdle': True, 'counts': {}})
        self.service = {'own': h.own, 'home': h.home, 'runtime': runtime}
        def stopped(pid, *, port=8319):
            h.stops.append(pid)
            if pid == 100: self.old.close()
        h.wait_for_stopped = stopped
        def backup(own, commit):
            self.assertFalse(h.loaded)
            target = h.home / 'backups/pre-test';target.mkdir(parents=True)
            with patch.object(state_backup, 'backup_folder', return_value=target):
                path, method = state_backup.clone_state(own, commit, self.update._clonefile())
            self.assertEqual(method, 'clone');h.backups.append(commit)
            return path
        h.backup_state = backup
        def restarted():
            self.new = f.Writer(h.own / 'userdata/statev2.sqlite');self.addCleanup(self.new.close)
            self.new.commit(f.event(random.Random(9), 'apply-new-event', 't-1', 1000))
        h.on_restart = restarted
        def metadata(identity, include_auth, since=None, widen_from=None, reads=None, passing=None):
            self.assertIsNotNone(reads, 'Page mode should supply its measured authority snapshot')
            value = h.snapshot(identity)
            value['rows'], auth, carried, value['databaseCapture'] = reads
            value.setdefault('observedAt', datetime.datetime.now(datetime.timezone.utc).isoformat())
            return value, auth, carried
        self.metadata = metadata

    def run_apply(self):
        with patch.object(self.update, '_service', return_value=self.service), patch.object(self.update, '_snapshot', side_effect=self.metadata):
            self.h.execute()

    def test_actual_apply_publishes_explicit_page_receipt(self):
        self.run_apply()
        result = json.loads(self.h.output.read_text())
        self.assertEqual(result['phase'], 'verified')
        self.assertEqual(result['rowPreservation'], 'verified-stopped-clone-pages')
        self.assertEqual(result['databasePageProof']['appendedRows']['orchestration_events'], 1)
        self.assertNotIn('databaseCapture', result['before'])
        self.assertNotIn('rowsByteIdentical', result)
        self.assertEqual(self.h.restores, [])

    def test_actual_apply_failure_after_activation_keeps_new_database(self):
        self.h.after_mutation = lambda after: after['fileHashes'].__setitem__('environment', 'changed')
        original_snapshot = self.h.snapshot
        def no_rollback_scan(identity):
            if self.h.output.exists() and json.loads(self.h.output.read_text()).get('result') == 'update-failed':
                self.fail('Failure refusal must not scan history before retaining the activated database')
            return original_snapshot(identity)
        with patch.object(self.h, 'snapshot', side_effect=no_rollback_scan), self.assertRaisesRegex(AssertionError, 'Environment identity changed'):
            self.run_apply()
        result = json.loads(self.h.output.read_text())
        self.assertEqual(result['result'], 'update-failed')
        self.assertIn('postactivation writes cannot be discarded', result['rollbackError'])
        self.assertEqual(self.h.restores, [])
        self.assertEqual(self.h.stops, [100])
        self.assertIsNone(self.new.process.poll())

    def test_actual_apply_without_page_baseline_runs_full_clone_fallback(self):
        with patch.object(self.update.after_proof, 'mark', return_value=None): self.run_apply()
        result = json.loads(self.h.output.read_text())
        self.assertEqual(result['phase'], 'verified')
        self.assertIn('databaseCapture', result['before'])
        self.assertIn('stopped-full-only', result['pageFallback'])
        self.assertNotIn('databasePageProof', result)

    def test_actual_apply_cancelled_during_staging_does_not_stop(self):
        self.h.on_stage = lambda: (self.h.own / 'updates/config.json').write_text('{}')
        with self.assertRaisesRegex(AssertionError, self.update.HOLD_REFUSAL): self.run_apply()
        self.assertEqual(self.h.stops, [])
        self.assertEqual(self.h.restart_calls, [])


if __name__ == '__main__': unittest.main()
