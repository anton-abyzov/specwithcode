#!/usr/bin/env python3
"""A bounded-read refusal must not enter a legacy unbounded retry."""
import pathlib
import unittest
from unittest.mock import patch

import database_continuity as continuity
import kept_lines
import live_database
import read_cache
import update_read


class FakeDb:
    in_transaction = True

    def execute(self, *args):
        return []

    def close(self):
        pass


class FakeSnapshot:
    def __init__(self, *args):
        self.db = FakeDb()

    def open(self):
        pass

    def close(self):
        pass


class FakeCache:
    def __init__(self, *args):
        self.reuse = {}

    def select(self, *args):
        pass


class SpillFailurePropagation(unittest.TestCase):
    def test_a_spill_refusal_never_retries_with_the_legacy_reader(self):
        for route in ('update_read', 'read_cache'):
            with self.subTest(route=route):
                calls = []
                failure = continuity.SpillFailed('table events could not be captured')

                def refuse(*args, **kwargs):
                    calls.append(kwargs.get('once', False))
                    raise failure

                with patch.object(update_read, '_read_tables', side_effect=refuse), \
                        patch.object(update_read, 'assert_idle'), \
                        patch.object(update_read, 'virtual_tables', return_value=False), \
                        patch.object(kept_lines, 'spill_folder', return_value=pathlib.Path('/fake/updates')), \
                        patch.object(kept_lines, 'active', return_value=None), \
                        patch.object(kept_lines, 'make_room'), \
                        patch.object(live_database, 'connect', return_value=FakeDb()), \
                        patch.object(continuity, 'schema', return_value={}):
                    with self.assertRaises(continuity.SpillFailed) as caught:
                        if route == 'update_read':
                            with patch.object(read_cache, 'read', return_value=None):
                                update_read._read_state(pathlib.Path('/fake'), False, include_database=True)
                        else:
                            with patch.object(read_cache, 'Snapshot', FakeSnapshot), patch.object(read_cache, 'Cache', FakeCache):
                                read_cache.read(pathlib.Path('/fake'), False, None)
                self.assertIs(caught.exception, failure)
                self.assertEqual(calls, [True])


if __name__ == '__main__':
    unittest.main()
