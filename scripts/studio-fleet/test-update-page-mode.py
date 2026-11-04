#!/usr/bin/env python3
"""Page-mode prepare/stop/clone/restart/readiness and full fallback, on synthetic services."""
import datetime
import json
import random
import re
import sqlite3
import subprocess
import tempfile
import time
import state_backup
import importlib.util
import pathlib
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import additive_migrations
import database_continuity as continuity
import kept_lines
import update_apply
import update_compare
import update_read

spec = importlib.util.spec_from_file_location('page_apply_fixture', pathlib.Path(__file__).with_name('test-after-proof.py'))
f = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f)
START, END = '2026-10-22T14:00:00Z', '2026-10-22T14:06:00Z'


MIGRATED_THROUGH_71 = (
    ('CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, created_at TEXT, name TEXT)', []),
    ("INSERT INTO effect_sql_migrations VALUES (71, 'now', 'HotReadPartialIndexes')", []))
# Before 069, the one migration left that the page proof refuses (072 is a declared rebuild).
MIGRATED_THROUGH_68 = (
    ('CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, created_at TEXT, name TEXT)', []),
    ("INSERT INTO effect_sql_migrations VALUES (68, 'now', 'ActiveTurnItemIndexes')", []))


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

    def migrated(self, migrations):
        """1.0.177/1.0.178 on M4: the new service runs migrations 070 and 071 as it starts."""
        self.flow = f.Update(self, written=[
            ('CREATE TABLE "effect_sql_migrations" (migration_id integer PRIMARY KEY NOT NULL, '
             'created_at datetime NOT NULL DEFAULT current_timestamp, name VARCHAR(255) NOT NULL)', []),
            ("INSERT INTO effect_sql_migrations(migration_id, name) VALUES (69, 'AuthSessionProofKeyThumbprint')", [])])
        self.addCleanup(self.flow.kept.clear)
        mode = update_apply.PageMode.prepare(self.n, 'm4', self.expected, True, migrations=migrations)
        before, auth, _ = mode.snapshot()
        self.flow.mark();self.flow.stop();self.flow.clone()
        mode.stopped(self.flow.held, before, auth, START, 'browser-cookie')
        new = self.flow.restart(writes=False);self.pid = 101
        statements = []
        for number in (70, 71):
            name, objects = additive_migrations.DECLARED[number]
            statements += [(sql, []) for _, _, _, sql in objects if sql is not None]
            statements.append(('INSERT INTO effect_sql_migrations(migration_id, name) VALUES (?, ?)', [number, name]))
        new.commit(*statements)
        for batch in f.startup_writes(random.Random(7)):
            new.commit(*batch)
        return mode, mode.after(self.flow.held, START, 'browser-cookie')

    def test_additive_migrations_keep_the_page_proof_when_migrations_are_allowed(self):
        mode, after = self.migrated(True)
        self.assertIsNotNone(after, mode.fallback_reason)
        self.assertEqual(mode.verdict['schemaDelta']['migrations'], [70, 71])
        self.assertEqual(mode.verdict['appendedRows']['orchestration_events'], 30)

    def test_declared_rebuild_072_keeps_the_page_proof(self):
        """M1 1.0.179 and ministorm 1.0.180 onwards: the new service runs 072's own SQL (rebuild of
        orchestration_v2_thread_history_compactions) on a database that ran 070 and 071."""
        source = sorted((pathlib.Path(__file__).resolve().parents[2] / 'apps/server/src/persistence/Migrations')
                        .glob('072_RetentionHorizon.ts'))[0].read_text()
        self.flow = f.Update(self, written=[
            ('CREATE TABLE "effect_sql_migrations" (migration_id integer PRIMARY KEY NOT NULL, '
             'created_at datetime NOT NULL DEFAULT current_timestamp, name VARCHAR(255) NOT NULL)', [])] + [
            (sql, []) for number in (70, 71) for _, _, _, sql in additive_migrations.DECLARED[number][1] if sql is not None] + [
            ("INSERT INTO effect_sql_migrations(migration_id, name) VALUES (70, 'ThreadHistoryCompactions'), (71, 'HotReadPartialIndexes')", [])] + [
            ('INSERT INTO orchestration_v2_thread_history_compactions VALUES (?, ?, ?, ?, NULL)',
             ['thread-%d' % index, 'deleted', index, 'now']) for index in range(40)])
        self.addCleanup(self.flow.kept.clear)
        mode = update_apply.PageMode.prepare(self.n, 'm4', self.expected, True, migrations=True)
        before, auth, _ = mode.snapshot()
        self.assertEqual(mode.assert_fallback_room(), [])  # 072 pending asks no full-read room.
        self.flow.mark();self.flow.stop();self.flow.clone()
        mode.stopped(self.flow.held, before, auth, START, 'browser-cookie')
        new = self.flow.restart(writes=False);self.pid = 101
        new.commit(*[(sql, []) for sql in re.findall(r'sql`(.*?)`', source, re.S)],
                   ("INSERT INTO effect_sql_migrations(migration_id, name) VALUES (72, 'RetentionHorizon')", []))
        for batch in f.startup_writes(random.Random(7)):
            new.commit(*batch)
        after = mode.after(self.flow.held, START, 'browser-cookie')
        self.assertIsNotNone(after, mode.fallback_reason)
        self.assertEqual(mode.verdict['schemaDelta']['migrations'], [72])
        self.assertEqual(mode.verdict['schemaDelta']['rebuiltRows'], 40)

    def test_additive_migrations_without_permission_take_the_full_read(self):
        mode, after = self.migrated(False)
        self.assertIsNone(after)
        self.assertEqual(mode.fallback_reason, 'Refused:schema')

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

    def test_fallback_room_counts_only_migrations_the_database_has_not_run(self):
        mode, _, _ = self.prepare()
        self.assertIsNone(mode.live_migration)  # No migrations table: nothing to place it by, nothing counted.
        with patch.object(kept_lines, 'available_disk', return_value=1):
            self.assertEqual(mode.assert_fallback_room(), [])
        self.flow.old.commit(*MIGRATED_THROUGH_68)
        with patch.object(kept_lines, 'available_disk', return_value=1):
            mode.read()
            self.assertEqual(mode.live_migration, 68)
            with self.assertRaisesRegex(AssertionError, 'migration 069'): mode.assert_fallback_room()
            self.flow.old.commit(("INSERT INTO effect_sql_migrations VALUES (69, 'now', 'AuthSessionProofKeyThumbprint')", []))
            mode.read()
            self.assertEqual(mode.assert_fallback_room(), [])  # Already migrated: the page proof applies.
            # 072 still to run asks no room: its declared rebuild keeps the page proof.
            self.flow.old.commit(("INSERT INTO effect_sql_migrations VALUES (71, 'now', 'HotReadPartialIndexes')", []))
            mode.read()
            self.assertEqual(mode.live_migration, 71)
            self.assertEqual(mode.assert_fallback_room(), [])

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

    def test_full_read_failure_keeps_the_page_fallback_reason(self):
        """M4 1.0.184: the full read after the page proof refused ran out of scratch room, and the
        receipt lost why the page proof refused (pageFallback was written only after that read)."""
        seen = []
        def no_room(held, before):
            # What the update agent polls while the full read runs: the reason is already there,
            # so a helper killed during that read (no failure handler) still left it.
            seen.append(json.loads(self.h.output.read_text()))
            raise continuity.SpillFailed('Cannot capture table orchestration_events within the memory budget: '
                                         '[Errno 28] Scratch volume is below its floor')
        with patch.object(self.update.after_proof, 'mark', return_value=None), \
             patch.object(update_apply.PageMode, 'full_baseline', side_effect=no_room), \
             self.assertRaisesRegex(continuity.SpillFailed, 'below its floor'):
            self.run_apply()
        self.assertEqual(seen[0]['phase'], 'restart-requested')
        self.assertIn('stopped-full-only', seen[0]['pageFallback'])
        result = json.loads(self.h.output.read_text())
        self.assertEqual(result['result'], 'update-failed')
        self.assertIn('stopped-full-only', result['pageFallback'])

    def test_full_read_migration_without_room_refuses_before_stop(self):
        """A release that runs a migration the page proof refuses needs the full read's room; without
        it the update refuses with the old service still running, not after the restart."""
        self.old.commit(*MIGRATED_THROUGH_68)  # 069 still to run.
        with patch.object(kept_lines, 'available_disk', return_value=12 * 10 ** 9), \
             patch.object(update_apply, 'largest_table_bytes', return_value=11_500_000_000), \
             self.assertRaisesRegex(AssertionError, r'full database read that migration 069 needs.*needs (\d+\.\d) GB, 12.0 GB free') as caught:
            self.run_apply()
        reserve = self.update.backup_space_needed(self.h.own, self.h.home, self.update._clonefile())[0]
        self.assertIn('needs %.1f GB' % ((int(update_apply.FULL_READ_LINE_FACTOR * 11_500_000_000) + kept_lines.DISK_FLOOR_MARGIN + reserve) / 1e9), str(caught.exception))
        self.assertEqual(self.h.stops, [])
        self.assertEqual(self.h.restart_calls, [])
        # Refused before phase 'prepared' (before staging, pointers and the gate): main() leaves the
        # preflight receipt, which never overwrites a receipt _apply wrote.
        self.update.write_preflight_failure(self.h.output, 'm4', caught.exception)
        receipt = json.loads(self.h.output.read_text())
        self.assertEqual((receipt['phase'], receipt['pointers']), ('preflight', 'unchanged'))
        self.assertIn('pageFallback', receipt['error'])
        self.assertEqual({path: path.read_bytes() for path in self.h.original}, self.h.original)

    def test_full_read_migration_with_room_is_named_in_the_receipt(self):
        self.old.commit(*MIGRATED_THROUGH_68)
        with patch.object(kept_lines, 'available_disk', return_value=60 * 10 ** 9):
            self.run_apply()
        result = json.loads(self.h.output.read_text())
        self.assertEqual(result['phase'], 'verified')
        self.assertEqual(result['fullReadMigrations'], [69])

    def test_database_that_already_ran_every_full_read_migration_is_not_checked(self):
        self.old.commit(*MIGRATED_THROUGH_68, ("INSERT INTO effect_sql_migrations VALUES (69, 'now', 'AuthSessionProofKeyThumbprint')", []))
        with patch.object(kept_lines, 'available_disk', return_value=1):
            self.run_apply()
        result = json.loads(self.h.output.read_text())
        self.assertEqual(result['phase'], 'verified')
        self.assertNotIn('fullReadMigrations', result)

    def test_actual_apply_cancelled_during_staging_does_not_stop(self):
        self.h.on_stage = lambda: (self.h.own / 'updates/config.json').write_text('{}')
        with self.assertRaisesRegex(AssertionError, self.update.HOLD_REFUSAL): self.run_apply()
        self.assertEqual(self.h.stops, [])
        self.assertEqual(self.h.restart_calls, [])


class FallbackRoom(unittest.TestCase):
    """fallback_room sizes the full read's sorted runs by the largest table, not the whole file."""
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = pathlib.Path(folder.name)
        self.database = self.folder / 'userdata' / 'statev2.sqlite'
        self.database.parent.mkdir()
        (self.folder / 'updates').mkdir()
        db = sqlite3.connect(str(self.database), isolation_level=None)
        db.executescript('''PRAGMA journal_mode=WAL;
            CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, stream TEXT, body TEXT);
            CREATE INDEX events_stream ON orchestration_events(stream);
            CREATE TABLE small(id TEXT PRIMARY KEY, body TEXT);
            CREATE TABLE medium(id INTEGER PRIMARY KEY, body TEXT);
            CREATE TABLE keyed(key TEXT PRIMARY KEY, body TEXT) WITHOUT ROWID;
            CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, created_at TEXT, name TEXT);
            INSERT INTO effect_sql_migrations VALUES (71, 'now', 'HotReadPartialIndexes');''')
        rng = random.Random(4)
        db.execute('BEGIN')
        for number in range(6000):
            # JSON payloads, mostly in-page, some with overflow pages, as M4's events are.
            size = 9000 if number % 50 == 0 else 300
            body = json.dumps({'type': 'turn.item', 'threadId': 't-%d' % (number % 40),
                               'payload': {'text': ''.join(rng.choice('abcdef ') for _ in range(size))}})
            db.execute('INSERT INTO orchestration_events(stream, body) VALUES (?, ?)', ('t-%d' % (number % 40), body))
        for number in range(1500):
            db.execute('INSERT INTO medium(body) VALUES (?)', ('m' * 200,))
        db.execute("INSERT INTO small VALUES ('a', 'one')")
        for number in range(30):  # A WITHOUT ROWID table (an index b-tree) with overflow pages.
            db.execute('INSERT INTO keyed VALUES (?, ?)', ('k%d' % number, 'k' * 6000))
        db.execute('COMMIT')
        db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        self.db = db
        self.addCleanup(db.close)

    def btree_bytes(self, name):
        return self.db.execute('SELECT sum(pgsize) FROM dbstat WHERE name=?', (name,)).fetchone()[0]

    def test_estimate_covers_the_largest_table_and_is_below_the_file(self):
        estimate = update_apply.largest_table_bytes(self.database)
        size = self.database.stat().st_size
        try:
            events = self.btree_bytes('orchestration_events')
        except sqlite3.OperationalError:
            self.skipTest('SQLite without dbstat')
        self.assertGreaterEqual(estimate, events)
        self.assertLess(estimate, size)  # The index, the other tables: not counted.
        # Every leaf read (under OVERFLOW_SAMPLE): leaf overflow is exact. Only the overflow of the
        # WITHOUT ROWID table's interior keys (a few pages) is unexplained, counted to the largest.
        self.assertLessEqual(estimate, events + 8 * 4096)

    def test_unreadable_tree_counts_the_whole_file(self):
        with patch.object(update_apply._Pages, 'tree', side_effect=ValueError('not-a-tree-page')):
            self.assertEqual(update_apply.largest_table_bytes(self.database), self.database.stat().st_size)

    def test_peak_scratch_of_the_real_spill_stays_within_the_estimate(self):
        """The full read's real runs for the largest table, spilled run by run: the most scratch
        they hold at once stays at or below FULL_READ_LINE_FACTOR times the estimate, for JSON
        payloads like M4's events (20 GB of lines for an 11.5 GB b-tree). Not a bound for every
        table (BLOBs are hex), which is why SortedRuns._check_room stays the hard guard."""
        estimate = update_apply.largest_table_bytes(self.database)
        scratch = self.folder / 'updates'
        peak = [0]
        check = continuity.SortedRuns._check_room
        def measured(folder, size):
            held = sum(path.stat().st_size for path in scratch.rglob('*') if path.is_file())
            peak[0] = max(peak[0], held + size)
            return check(folder, size)
        with patch.object(continuity, 'SPILL_RUN_CHARS', 64 << 10), \
             patch.object(continuity.SortedRuns, '_check_room', staticmethod(measured)):
            continuity.spilled_table(self.db.execute('SELECT rowid, * FROM orchestration_events'), 3000, scratch)
        self.assertGreater(peak[0], 0)
        self.assertLessEqual(peak[0], update_apply.FULL_READ_LINE_FACTOR * estimate)

    def room(self, free, reserve=0, freed=0, live=68):
        with patch.object(kept_lines, 'available_disk', return_value=free):
            return update_apply.fallback_room(self.database, live, reserve, freed)

    def test_boundary_with_the_real_floor(self):
        need = (int(update_apply.FULL_READ_LINE_FACTOR * update_apply.largest_table_bytes(self.database))
                + kept_lines.DISK_FLOOR_MARGIN + 3 * 10 ** 9)
        self.assertEqual(self.room(need, reserve=3 * 10 ** 9), [69])
        with self.assertRaisesRegex(AssertionError, 'migration 069'):
            self.room(need - 1, reserve=3 * 10 ** 9)
        self.assertEqual(self.room(need - 10 ** 9, reserve=3 * 10 ** 9, freed=10 ** 9), [69])  # Kept lines let go first.
        self.assertEqual(self.room(1, live=71), [])  # 072 pending: a declared rebuild, no full read.
        with self.assertRaisesRegex(AssertionError, 'GB free'):
            self.room(None)  # Cannot tell: refused.

    def test_m4_sized_database_is_judged_by_its_largest_table(self):
        """M4, 1.0.184: a 22.4 GB file whose largest table is 11.5 GB. The whole-file floor (2 x 22.4
        GB + 4 GiB, 49 GB) refused anything below it; the table's runs and the margin need about
        30 GB, 34 GB with the backup's reserve: still more than M4's 18 GB, so it refuses there. (That
        was 072; it is now a declared rebuild, and the room is asked only for a FULL_READ migration.)"""
        reserve = 4 * 10 ** 9
        with patch.object(update_apply, 'largest_table_bytes', return_value=11_500_000_000):
            need = int(update_apply.FULL_READ_LINE_FACTOR * 11_500_000_000) + kept_lines.DISK_FLOOR_MARGIN + reserve
            self.assertLess(need, kept_lines.disk_floor(22_400_000_000))
            self.assertEqual(self.room(need, reserve=reserve), [69])
            self.assertEqual(self.room(40 * 10 ** 9, reserve=reserve), [69])
            with self.assertRaisesRegex(AssertionError, 'needs 34.2 GB, 18.0 GB free'):
                self.room(18 * 10 ** 9, reserve=reserve)

    def test_runs_held_in_memory_check_memory_before_the_stop(self):
        with patch.object(kept_lines, 'spill_folder', return_value=None), \
             patch.object(kept_lines, 'memory_room', return_value=False) as room, \
             self.assertRaisesRegex(AssertionError, 'Not enough memory .*migration 069'):
            update_apply.fallback_room(self.database, 68)
        room.assert_called_once_with(int(update_apply.FULL_READ_LINE_FACTOR * update_apply.largest_table_bytes(self.database)))
        with patch.object(kept_lines, 'spill_folder', return_value=None), patch.object(kept_lines, 'memory_room', return_value=True):
            self.assertEqual(update_apply.fallback_room(self.database, 68), [69])

    def test_live_migration_reads_the_newest_row_or_none(self):
        self.assertEqual(update_apply.live_migration(self.database), 71)
        self.assertIsNone(update_apply.live_migration(self.folder / 'missing.sqlite'))


if __name__ == '__main__': unittest.main()
