#!/usr/bin/env python3
"""A protected-row refusal names what changed: the proof key, and for counts each table with its
before and after count, never a row, identifier or hash. M4's 1.0.361 receipt said only
"Refused:auth-heartbeat:Protected rows or counts changed", and the full read then failed."""
import importlib.util
import json
import pathlib
import unittest
from unittest.mock import patch

import auth_heartbeat
import database_continuity as continuity
import update_apply

HASH_A, HASH_B = 'a' * 64, 'b' * 64


def proof(count=2, invariant=HASH_A, threads=('t-1',), other=HASH_A):
    return {'nativeWorkIdle': True, 'authSessionsInvariantSha256': invariant,
            'counts': {'auth_sessions': count, 'projection_threads': 1}, 'threadIds': list(threads),
            'hashes': {'auth_sessions': HASH_A, 'scheduled_tasks': other}}


class ProofDifference(unittest.TestCase):
    def refusal(self, before, after):
        with self.assertRaises(AssertionError) as caught:
            auth_heartbeat.assert_only_auth_hash_changed(before, after)
        return str(caught.exception)

    def test_count_change_names_the_table_and_both_counts(self):
        message = self.refusal(proof(count=2), proof(count=3, invariant=HASH_B))
        self.assertEqual(message, 'Protected rows or counts changed: authSessionsInvariantSha256; '
                                  'counts auth_sessions 2 -> 3')

    def test_invariant_change_alone_names_the_key_without_its_value(self):
        message = self.refusal(proof(), proof(invariant=HASH_B))
        self.assertEqual(message, 'Protected rows or counts changed: authSessionsInvariantSha256')
        self.assertNotIn(HASH_A, message)
        self.assertNotIn(HASH_B, message)

    def test_identifier_lists_give_lengths_never_members(self):
        self.assertEqual(self.refusal(proof(), proof(threads=('t-1', 'secret-thread'))),
                         'Protected rows or counts changed: threadIds 1 -> 2')
        message = self.refusal(proof(), proof(threads=('secret-thread',)))
        self.assertEqual(message, 'Protected rows or counts changed: threadIds members')
        self.assertNotIn('secret', message)

    def test_a_table_only_one_side_counts(self):
        after = proof()
        after['counts']['auth_sessions_extra'] = 4
        self.assertEqual(self.refusal(proof(), after),
                         'Protected rows or counts changed: counts auth_sessions_extra none -> 4')

    def test_other_protected_table_is_named_without_its_hash(self):
        message = self.refusal(proof(), proof(other=HASH_B))
        self.assertEqual(message, 'Other protected table changed: scheduled_tasks')

    def test_prefixes_the_agent_and_receipts_match_are_kept(self):
        message = self.refusal(proof(count=2), proof(count=3))
        self.assertTrue(message.startswith('Protected rows or counts changed'))

    def test_unchanged_proof_still_passes(self):
        auth_heartbeat.assert_only_auth_hash_changed(proof(), proof())

    def test_page_fallback_keeps_the_whole_detail(self):
        error = update_apply.page_continuity.Refused(
            'auth-heartbeat:' + self.refusal(proof(count=2), proof(count=3, invariant=HASH_B)))
        self.assertEqual(update_apply._why(error), 'Refused:auth-heartbeat:Protected rows or counts changed: '
                                                   'authSessionsInvariantSha256; counts auth_sessions 2 -> 3')


spec = importlib.util.spec_from_file_location('page_mode_cases', pathlib.Path(__file__).with_name('test-update-page-mode.py'))
page_mode = importlib.util.module_from_spec(spec)
spec.loader.exec_module(page_mode)


class ReceiptAfterFullReadFails(unittest.TestCase):
    """The real apply: a session row goes away during the owned restart, the page proof refuses,
    and the full read runs out of scratch room as on M4. The receipt still says what changed."""
    setUp = page_mode.ApplyBranches.setUp
    run_apply = page_mode.ApplyBranches.run_apply

    def test_receipt_names_the_count_when_the_full_read_fails(self):
        restarted = self.h.on_restart

        def restart_and_drop_a_session():
            restarted()
            self.new.commit(("DELETE FROM auth_sessions WHERE session_id='session-0'", []))
        self.h.on_restart = restart_and_drop_a_session

        def no_room(held, before):
            raise continuity.SpillFailed('Cannot capture table orchestration_events within the memory budget: '
                                         '[Errno 28] Scratch volume is below its floor')
        with patch.object(update_apply.PageMode, 'full_baseline', side_effect=no_room), \
             self.assertRaisesRegex(continuity.SpillFailed, 'below its floor'):
            self.run_apply()
        result = json.loads(self.h.output.read_text())
        self.assertEqual(result['result'], 'update-failed')
        self.assertRegex(result['pageFallback'], r'^Refused:auth-heartbeat:Protected rows or counts changed: '
                                                 r'authSessionsInvariantSha256; counts auth_sessions (\d+) -> (\d+)$')
        before, after = map(int, result['pageFallback'].rsplit(' ', 3)[1::2])
        self.assertEqual(before - after, 1)
        self.assertNotIn('session-0', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
