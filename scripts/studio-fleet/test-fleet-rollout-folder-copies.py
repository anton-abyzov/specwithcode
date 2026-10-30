#!/usr/bin/env python3
"""fleet_rollout's drain of M4 and folder copies: the forced drain stops no copy, and from its hold the
copy's other side gets 503s until it gives up, so while M4's service reports a copy the rollout neither
drains nor asks, and waits; a drain that found copies drains again only once the service's own count
shows none; a worker is not asked while M4 copies; --ignore-folder-copies installs over them. Drives
the fake fleet in rollout_test_fakes.py.

Run: cd scripts/studio-fleet && python3 -B test-fleet-rollout-folder-copies.py
"""
import pathlib
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import fleet_rollout  # noqa: E402
from rollout_test_fakes import HELD, NEW, Clock, FakeHold, Fleet, kinds  # noqa: E402


class FolderCopiesOnM4(unittest.TestCase):
    def run_rollout(self, fleet, clock, hold, lines=None, **options):
        options.setdefault('poll', 15)
        say = lines.append if lines is not None else (lambda _line: None)
        return fleet_rollout.rollout(NEW, fleet.hosts(), clock=clock, sleep=clock.sleep, say=say, hold=hold,
                                     **options)

    def test_a_folder_copy_on_m4_keeps_the_drain_and_the_request_back_until_it_ends(self):
        """2026-10-29: the forced drain stops no copy, and from its hold the copy's other side got
        503s until it gave up; the forced request then restarted M4. The rollout waits instead."""
        clock = Clock()
        fleet = Fleet(clock, polls={'m4': 2})
        hold = FakeHold(fleet)
        hold.copies = 2
        real = fleet.host('m4')

        def m4(argv):
            if argv[0] == 'status' and len(fleet.calls('m4', 'status')) == 4:
                hold.copies = 0  # The copies finished.
            return real(argv)
        hosts = fleet.hosts()
        hosts['m4'] = m4
        lines = []
        result = fleet_rollout.rollout(NEW, hosts, only='m4', clock=clock, sleep=clock.sleep, say=lines.append,
                                       hold=hold, poll=15)
        self.assertEqual(result['m4']['result'], 'installed')
        # Neither a check nor a drain while copying: the agent offers the release already.
        self.assertEqual(kinds(fleet), ['hold', 'request'])
        waiting = [line for line in lines if 'waiting for 2 folder copies' in line]
        self.assertEqual(len(waiting), 1, lines)
        self.assertNotIn('does not offer', ' '.join(lines))

    def test_a_copy_that_began_during_the_drain_releases_the_hold_and_waits(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m4': 2})
        hold = FakeHold(fleet, reply=dict(HELD, folderCopies=1))
        real_prepare = hold.prepare

        def prepare():
            reply = real_prepare()
            hold.reply = dict(HELD)  # The next drain finds it gone.
            return reply
        hold.prepare = prepare
        lines = []
        result = self.run_rollout(fleet, clock, hold, lines, only='m4')
        self.assertEqual(result['m4']['result'], 'installed')
        # The service's own count, which stops nothing, shows it gone before the next drain.
        self.assertEqual(kinds(fleet), ['hold', 'release', 'count', 'hold', 'request'])
        self.assertTrue(any('began during the drain' in line for line in lines))

    def test_ignore_folder_copies_drains_and_installs_over_them(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m4': 2})
        hold = FakeHold(fleet, reply=dict(HELD, folderCopies=1))
        hold.copies = 1
        hold.ignore_folder_copies = True
        self.assertEqual(self.run_rollout(fleet, clock, hold, only='m4')['m4']['result'], 'installed')
        self.assertEqual(kinds(fleet), ['hold', 'request'])

    def test_a_copy_that_outlasts_the_deadline_is_named(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m4': 2})
        hold = FakeHold(fleet)
        hold.copies = 1
        with self.assertRaises(fleet_rollout.RolloutError) as caught:
            self.run_rollout(fleet, clock, hold, only='m4', local_deadline=40 * 60, poll=30)
        self.assertIn('still waiting for a folder copy here', str(caught.exception))
        self.assertEqual(kinds(fleet), [])
        self.assertEqual(fleet.asked, {})

    def test_the_forced_request_still_waits_for_copies_unless_ignored(self):
        for ignore in (False, True):
            with self.subTest(ignore=ignore):
                clock = Clock()
                fleet = Fleet(clock, polls={'m4': 2})
                hold = FakeHold(fleet)
                hold.ignore_folder_copies = ignore
                self.run_rollout(fleet, clock, hold, only='m4')
                self.assertEqual('--waits-for-folder-copies' in fleet.asked['m4'], not ignore)

    def test_a_drain_that_found_copies_never_drains_again_until_the_service_counts_none(self):
        """Its heartbeat could not be written (a full disk), so it reads as no copy: each 5 s poll
        drained again and stopped running work until the copy ended."""
        clock = Clock()
        fleet = Fleet(clock, polls={'m4': 2})
        hold = FakeHold(fleet, reply=dict(HELD, folderCopies=1))
        hold.counted = 1
        real_count = hold.counted_copies

        def count():
            copies = real_count()
            if len([entry for entry in kinds(fleet) if entry == 'count']) == 3:
                hold.counted, hold.reply = 0, dict(HELD)  # The copy ended.
            return copies
        hold.counted_copies = count
        self.assertEqual(self.run_rollout(fleet, clock, hold, only='m4')['m4']['result'], 'installed')
        self.assertEqual(kinds(fleet), ['hold', 'release', 'count', 'count', 'count', 'count', 'hold', 'request'])

    def roll_workers(self, copies, **options):
        clock = Clock()
        fleet = Fleet(clock)
        fleet.version['m4'] = NEW
        lines = []
        result = fleet_rollout.rollout(NEW, fleet.hosts(), only='workers', clock=clock, sleep=clock.sleep,
                                       say=lines.append, poll=15, local_copies=lambda: copies[0], **options)
        return fleet, result, lines

    def test_no_worker_is_asked_while_m4_copies_a_folder(self):
        """An older worker counts no copy of its own: asked now, its agent would restart it in the middle
        of one with M4. The Connect route refuses this (runFleetUpdate); the SSH route waits."""
        copies, polls = [1], [0]

        def local():
            polls[0] += 1
            if polls[0] == 8:
                copies[0] = 0  # The copy ended.
            return copies[0]
        clock = Clock()
        fleet = Fleet(clock)
        fleet.version['m4'] = NEW
        lines = []
        result = fleet_rollout.rollout(NEW, fleet.hosts(), only='workers', clock=clock, sleep=clock.sleep,
                                       say=lines.append, poll=15, local_copies=local)
        self.assertEqual({name: result[name]['result'] for name in ('m1', 'm3')},
                         {'m1': 'installed', 'm3': 'installed'})
        for name in ('m1', 'm3'):
            self.assertEqual(kinds(fleet, name), ['request'])
            self.assertEqual(len([line for line in lines if line.startswith(name + ': waiting for a folder copy on M4')]),
                             1, lines)
        self.assertGreaterEqual(polls[0], 8)

    def test_ignore_folder_copies_asks_the_workers_at_once(self):
        fleet, result, _lines = self.roll_workers([1], ignore_folder_copies=True)
        self.assertEqual(result['m1']['result'], 'installed')
        self.assertEqual(kinds(fleet, 'm1'), ['request'])
        self.assertEqual(fleet.calls('m1', 'status')[1][3][0], 'status')  # Asked before its first poll.


if __name__ == '__main__':
    unittest.main()
