#!/usr/bin/env python3
"""Stopped-clone page verdict against synthetic WAL services; never a live user database."""
import importlib.util
import pathlib
import random
import os
import struct
import unittest
from unittest.mock import patch

import page_continuity as proof
import kept_lines

spec = importlib.util.spec_from_file_location('page_fixture', pathlib.Path(__file__).with_name('test-after-proof.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class Preservation(unittest.TestCase):
    def setUp(self):
        p = patch.object(kept_lines, 'available_memory', return_value=1 << 50)
        p.start()
        self.addCleanup(p.stop)

    def flow(self, writes=False, **shape):
        flow = fixture.Update(self, **shape)
        flow.around_restart(writes=writes)
        self.addCleanup(flow.kept.clear)
        return flow

    def prove(self, flow):
        return proof.prove(flow.state, flow.held, '2026-10-22T14:00:00Z', '2026-10-22T14:06:00Z')

    def test_unchanged_history_is_not_decoded(self):
        flow = self.flow()
        result = self.prove(flow)
        self.assertTrue(result['preserved'])
        self.assertEqual(result['decodedRows'], 0)
        self.assertEqual(result['proofKind'], 'stopped-clone-pages-v1')

    def test_restart_append_projection_cursor_auth(self):
        flow = self.flow(writes=True)
        result = self.prove(flow)
        self.assertEqual(result['appendedRows']['orchestration_events'], 30)
        self.assertEqual(result['appendedRows']['orchestration_command_receipts'], 10)
        self.assertEqual(result['authHeartbeat']['changedRows'], 1)
        self.assertLess(result['decodedRows'], 1000)

    def test_old_log_edit_refused(self):
        flow = self.flow()
        flow.new.commit(("UPDATE orchestration_events SET payload_json='changed' WHERE sequence=1", []))
        with self.assertRaises(proof.Refused): self.prove(flow)

    def test_old_log_delete_refused(self):
        flow = self.flow()
        flow.new.commit(('DELETE FROM orchestration_events WHERE sequence=1', []))
        with self.assertRaises(proof.Refused): self.prove(flow)

    def test_projection_without_event_refused(self):
        flow = self.flow()
        flow.new.commit(("UPDATE orchestration_v2_projection_threads SET title='changed' WHERE thread_id='t-1'", []))
        with self.assertRaisesRegex(proof.Refused, 'projection-without-event'): self.prove(flow)

    def test_authority_edit_refused(self):
        flow = self.flow()
        flow.new.commit(("UPDATE scheduled_tasks SET cron='new'", []))
        with self.assertRaisesRegex(proof.Refused, 'authority-table-changed'): self.prove(flow)

    def test_schema_change_refused(self):
        flow = self.flow()
        flow.new.commit(('CREATE TABLE surprise (id INTEGER)', []))
        with self.assertRaisesRegex(proof.Refused, 'schema'): self.prove(flow)

    def test_auth_change_refused(self):
        flow = self.flow()
        flow.new.commit(("UPDATE auth_sessions SET subject='stranger'", []))
        with self.assertRaisesRegex(proof.Refused, 'auth-heartbeat'): self.prove(flow)

    def test_blob_change_in_old_log_refused(self):
        flow = self.flow()
        flow.new.commit(("UPDATE orchestration_events SET payload_json=CAST(payload_json AS BLOB) WHERE sequence=1", []))
        with self.assertRaises(proof.Refused): self.prove(flow)

    def test_deleted_thread_with_new_event_refused(self):
        flow = self.flow(writes=True)
        flow.new.commit(("DELETE FROM orchestration_v2_projection_threads WHERE thread_id='t-1'", []))
        with self.assertRaisesRegex(proof.Refused, 'identity-removed'): self.prove(flow)

    def test_unknown_without_rowid_change_refused(self):
        flow = self.flow()
        flow.new.commit(("UPDATE pull_request_files_viewed SET viewed_at='changed'", []))
        with self.assertRaisesRegex(proof.Refused, 'without-rowid'): self.prove(flow)

    def test_corrupt_wal_frame_header_cannot_hide_edit(self):
        flow = self.flow()
        flow.new.commit(("UPDATE orchestration_events SET payload_json='changed' WHERE sequence=1", []))
        wal = str(flow.database) + '-wal'
        with open(wal, 'r+b') as handle:
            header = handle.read(32)
            size = struct.unpack_from('>I', header, 8)[0]
            length = os.fstat(handle.fileno()).st_size
            offset = 32 + ((length - 32) // (24 + size) - 1) * (24 + size)
            handle.seek(offset)
            handle.write(struct.pack('>I', 1))
            handle.flush()
        with self.assertRaisesRegex(proof.Refused, 'wal-checksum'): self.prove(flow)

    def test_clone_mutation_during_proof_refused(self):
        flow = self.flow()
        assemble = proof.PageProof.assemble
        def changed(instance, touched):
            result = assemble(instance, touched)
            os.utime(flow.held['clone'], None)
            return result
        with patch.object(proof.PageProof, 'assemble', changed):
            with self.assertRaisesRegex(proof.Refused, 'clone-changed'): self.prove(flow)

    def test_duplicate_sequence_counter_refused(self):
        flow = self.flow(writes=True)
        flow.new.commit(("INSERT INTO sqlite_sequence(name,seq) VALUES ('orchestration_events',1)", []))
        with self.assertRaisesRegex(proof.Refused, 'duplicate-sequence'): self.prove(flow)

    def test_legacy_auth_hash_collision_does_not_preserve_subject(self):
        flow = fixture.Update(self, written=[("UPDATE auth_sessions SET subject='6162'", [])])
        self.addCleanup(flow.kept.clear)
        flow.around_restart(writes=False)
        flow.new.commit(("UPDATE auth_sessions SET subject=x'6162'", []))
        with self.assertRaisesRegex(proof.Refused, 'auth-heartbeat'): self.prove(flow)

    def test_legacy_auth_hash_collision_does_not_preserve_app_version(self):
        flow = fixture.Update(self, written=[("UPDATE auth_sessions SET client_app_version='6162'", [])])
        self.addCleanup(flow.kept.clear)
        flow.around_restart(writes=False)
        flow.new.commit(("UPDATE auth_sessions SET client_app_version=x'6162'", []))
        with self.assertRaisesRegex(proof.Refused, 'typed-collision'): self.prove(flow)

    def test_stopped_clone_is_baseline_not_old_read(self):
        flow = fixture.Update(self)
        self.addCleanup(flow.kept.clear)
        flow.old.commit(("UPDATE scheduled_tasks SET cron='legitimate-before-stop'", []))
        flow.mark(reread=True)
        flow.stop()
        flow.clone()
        flow.restart(writes=False)
        self.assertTrue(self.prove(flow)['preserved'])

    def test_changed_rows_budget_refuses(self):
        flow = self.flow(writes=True)
        with patch.object(proof, 'MAX_CHANGED_ROWS', 1), self.assertRaisesRegex(proof.Refused, 'budget'):
            self.prove(flow)

    def test_unavailable_snapshot_refuses(self):
        flow = self.flow()
        with patch.object(proof.read_cache.Snapshot, 'open', side_effect=proof.read_cache.Unavailable('test')):
            with self.assertRaisesRegex(proof.Refused, 'test'): self.prove(flow)


if __name__ == '__main__': unittest.main()
