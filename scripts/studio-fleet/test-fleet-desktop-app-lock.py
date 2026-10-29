#!/usr/bin/env python3
"""The worker desktop-app update's lock: one run at a time, judged by its record, taken over only from a run that
is gone. desktop_app_update_remote.sh runs for real against test-fleet-desktop-app.py's fake worker Mac.

Run: cd scripts/studio-fleet && python3 -B test-fleet-desktop-app-lock.py
"""
import importlib.util
import os
import pathlib
import resource
import shutil
import signal
import subprocess
import time
import unittest

HERE = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('desktop_app_tests_for_lock', str(HERE / 'test-fleet-desktop-app.py'))
desktop_tests = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(desktop_tests)
SCRIPT, REPO, OLD, NEW = desktop_tests.SCRIPT, desktop_tests.REPO, desktop_tests.OLD, desktop_tests.NEW
make_app, bundle_version, started = desktop_tests.make_app, desktop_tests.bundle_version, desktop_tests.started


class UpdateLock(desktop_tests.Machine):
    def test_another_update_running_holds_the_lock(self):
        make_app(self.app, OLD)
        self.serve()
        holder = self.start('nothing')
        (self.cache / '.lock').mkdir(parents=True)
        (self.cache / '.lock' / 'pid').write_text('%d\n%s\n' % (holder.pid, started(holder.pid)))
        code, lines = self.run_script()
        self.assertIn('another update of this app runs (pid %d)' % holder.pid, self.failure(code, lines))
        self.assertEqual(code, 4)
        self.assertEqual(bundle_version(self.app), OLD)
        holder.kill()
        holder.wait()
        code, lines = self.run_script()  # A lock whose process is gone is taken over.
        self.assertEqual((code, self.result(lines)['how']), (0, 'swapped'))
        self.assertIn('took over the update lock of a run that is gone', lines)
        self.assertFalse((self.cache / '.lock').exists())

    def test_a_lock_whose_pid_now_names_another_process_is_taken_over_and_the_swap_repaired(self):
        # A run stopped between its renames by a power loss: no app in place, the previous one aside, and its lock
        # naming a pid that another process has by the next run. A record without the start time is not trusted.
        other = self.start('nothing')
        self.serve()
        for record in ('%d\n' % other.pid, '%d\nThu Jan 1 00:00:00 1970\n' % other.pid):
            with self.subTest(record=record):
                for path in list(self.apps.iterdir()):
                    os.rename(str(path), str(self.root / ('gone-%f' % time.time())))
                make_app(self.old, OLD)
                (self.cache / '.lock').mkdir(parents=True, exist_ok=True)
                (self.cache / '.lock' / 'pid').write_text(record)
                long_ago = time.time() - 3600  # Left by a power loss, long before this run.
                os.utime(str(self.cache / '.lock'), (long_ago, long_ago))
                code, lines = self.run_script()
                self.assertEqual(code, 0, lines)
                self.assertIn('took over the update lock of a run that is gone', lines)
                self.assertIn('put the previous app back from %s: an earlier run stopped between its renames' % self.old,
                              lines)
                self.assertEqual(bundle_version(self.app), NEW)
                self.assertFalse((self.cache / '.lock').exists())
        self.assertIsNone(other.poll())

    def test_the_lock_names_the_run_by_pid_and_start_time(self):
        make_app(self.app, OLD)
        self.serve()
        app = self.start(ignore_term=True)  # Holds the run in its quit, with the lock taken.
        env = self.env(SWC_QUIT_WAIT='30')
        env.update({'V': NEW, 'SHA': self.served, 'REPO': REPO, 'DRY_RUN': '0'})
        script = subprocess.Popen(['/bin/bash', str(SCRIPT)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  text=True)
        self.processes.append(script)
        for line in script.stdout:
            if line.startswith('quitting the app'):
                break
        record = (self.cache / '.lock' / 'pid').read_text()
        self.assertEqual(record, '%d\n%s\n' % (script.pid, started(script.pid)))
        code, lines = self.run_script()  # A second run meanwhile.
        self.assertEqual(code, 4, lines)
        self.assertIn('another update of this app runs (pid %d); let it finish' % script.pid, self.failure(code, lines))
        app.kill()
        script.communicate(timeout=60)
        self.assertEqual(script.returncode, 0)

    def test_a_lock_still_being_made_holds_and_one_left_without_its_record_is_taken_over(self):
        # A run between its mkdir and its record holds the lock; one that stopped there is gone after 10 seconds.
        make_app(self.app, OLD)
        self.serve()
        lock = self.cache / '.lock'
        lock.mkdir(parents=True)
        code, lines = self.run_script()
        self.assertEqual(code, 4, lines)
        self.assertIn('another update of this app is starting; let it finish', self.failure(code, lines))
        self.assertTrue(lock.is_dir())
        self.assertEqual(bundle_version(self.app), OLD)
        code, lines = self.run_script(dry=True)
        self.assertEqual(code, 0, lines)
        self.assertIn('another update of this app is starting', lines)
        made = time.time() - 60
        os.utime(str(lock), (made, made))
        code, lines = self.run_script()
        self.assertEqual((code, self.result(lines)['how']), (0, 'swapped'))
        self.assertIn('took over the update lock of a run that is gone', lines)
        self.assertFalse(lock.exists())

    def test_a_lock_whose_record_is_half_written_holds_as_one_starting(self):
        # The record is two writes: a run that reads only its pid line meanwhile must not take the lock of the
        # live run writing it for a gone run's; one left that way for long is a run that stopped there.
        make_app(self.app, OLD)
        self.serve()
        holder = self.start('nothing')
        lock = self.cache / '.lock'
        lock.mkdir(parents=True)
        (lock / 'pid').write_text('%d\n' % holder.pid)
        code, lines = self.run_script()
        self.assertEqual(code, 4, lines)
        self.assertIn('another update of this app is starting; let it finish', self.failure(code, lines))
        self.assertEqual((lock / 'pid').read_text(), '%d\n' % holder.pid)
        self.assertEqual(bundle_version(self.app), OLD)
        long_ago = time.time() - 60
        os.utime(str(lock), (long_ago, long_ago))
        code, lines = self.run_script()
        self.assertEqual((code, self.result(lines)['how']), (0, 'swapped'))
        self.assertIn('took over the update lock of a run that is gone', lines)
        self.assertFalse(lock.exists())

    def test_a_run_leaves_a_lock_that_names_another_run(self):
        make_app(self.app, OLD)
        self.serve()
        app = self.start(ignore_term=True)  # Holds the run in its quit, with the lock taken.
        env = self.env(SWC_QUIT_WAIT='30')
        env.update({'V': NEW, 'SHA': self.served, 'REPO': REPO, 'DRY_RUN': '0'})
        script = subprocess.Popen(['/bin/bash', str(SCRIPT)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  text=True)
        self.processes.append(script)
        for line in script.stdout:
            if line.startswith('quitting the app'):
                break
        other = self.start('nothing')
        record = '%d\n%s\n' % (other.pid, started(other.pid))
        (self.cache / '.lock' / 'pid').write_text(record)  # Another run took the lock over meanwhile.
        app.kill()
        script.communicate(timeout=60)
        self.assertEqual(script.returncode, 0)
        self.assertEqual((self.cache / '.lock' / 'pid').read_text(), record)

    def run_held_in_quit(self, meanwhile):
        """Runs an update the app holds up in its quit, with the lock taken, calls meanwhile(), then lets the
        app go; returns the run's exit code and output lines."""
        make_app(self.app, OLD)
        self.serve()
        app = self.start(ignore_term=True)
        env = self.env(SWC_QUIT_WAIT='30')
        env.update({'V': NEW, 'SHA': self.served, 'REPO': REPO, 'DRY_RUN': '0'})
        script = subprocess.Popen(['/bin/bash', str(SCRIPT)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  text=True)
        self.processes.append(script)
        lines = []
        for line in script.stdout:
            lines.append(line.rstrip('\n'))
            if line.startswith('quitting the app'):
                break
        meanwhile()
        app.kill()
        out, err = script.communicate(timeout=60)
        self.assertEqual(err, '')
        return script.returncode, lines + out.splitlines()

    def test_a_run_removes_its_own_lock_left_without_its_record(self):
        # Its record failed to write (a full disk, say) or went: the lock is still the folder this run made.
        code, lines = self.run_held_in_quit((self.cache / '.lock' / 'pid').unlink)
        self.assertEqual((code, self.result(lines)['how']), (0, 'swapped'))
        self.assertFalse((self.cache / '.lock').exists())
        code, lines = self.run_script()  # The next run finds no lock in its way.
        self.assertEqual((code, self.result(lines)['how']), (0, 'already-current'))

    def test_a_run_removes_its_own_lock_left_without_its_record_for_long(self):
        # Without its record for longer than a starting run takes, the lock reads as nobody's: still this run's.
        lock = self.cache / '.lock'

        def record_gone_long_ago():
            (lock / 'pid').unlink()
            long_ago = time.time() - 60
            os.utime(str(lock), (long_ago, long_ago))
        code, lines = self.run_held_in_quit(record_gone_long_ago)
        self.assertEqual((code, self.result(lines)['how']), (0, 'swapped'))
        self.assertFalse(lock.exists())

    def test_a_run_leaves_the_lock_another_run_made_in_place_of_its_own(self):
        # Its lock went as it quit the app and another run made one, its record not written yet: that run's.
        lock = self.cache / '.lock'

        def made_again():
            shutil.rmtree(str(lock))
            lock.mkdir()
        code, lines = self.run_held_in_quit(made_again)
        self.assertEqual((code, self.result(lines)['how']), (0, 'swapped'))
        self.assertTrue(lock.is_dir())

    def mv_refusing_the_lock(self):
        """A PATH whose mv cannot rename the update lock, as on a full volume; every other rename goes through."""
        shims = self.root / 'shims'
        shims.mkdir()
        mv = shims / 'mv'
        mv.write_text('#!/bin/bash\n' + r'''
for arg in "$@"; do
  case "$arg" in */.lock) exit 1 ;; esac
done
exec /bin/mv "$@"
''')
        mv.chmod(0o755)
        return str(shims) + ':/usr/bin:/bin:/usr/sbin:/sbin'

    def test_a_run_removes_its_own_lock_when_the_volume_will_not_rename_it(self):
        make_app(self.app, OLD)
        self.serve()
        code, lines = self.run_script(PATH=self.mv_refusing_the_lock())
        self.assertEqual((code, self.result(lines)['how']), (0, 'swapped'))
        self.assertEqual([path.name for path in self.cache.iterdir() if path.name.startswith('.lock')], [])

    def test_a_run_takes_over_a_gone_runs_lock_when_the_volume_will_not_rename_it(self):
        make_app(self.app, OLD)
        self.serve()
        lock = self.cache / '.lock'
        gone = subprocess.Popen(['/bin/sleep', '120'])
        left = '%d\n%s\n' % (gone.pid, started(gone.pid))  # The record of a run that is gone.
        gone.kill()
        gone.wait()
        lock.mkdir(parents=True)
        (lock / 'pid').write_text(left)
        code, lines = self.run_script(PATH=self.mv_refusing_the_lock())
        self.assertEqual((code, self.result(lines)['how']), (0, 'swapped'), lines)
        self.assertIn('took over the update lock of a run that is gone', lines)
        self.assertEqual([path.name for path in self.cache.iterdir() if path.name.startswith('.lock')], [])

    def test_a_run_removing_a_lock_in_place_leaves_it_to_the_run_whose_record_lands_in_it(self):
        # Another run made the lock and wrote its record as this one removed it in place: rm cannot remove the
        # folder, and this run stops on the lock, now that run's, instead of failing on the rm.
        make_app(self.app, OLD)
        self.serve()
        lock = self.cache / '.lock'
        gone = subprocess.Popen(['/bin/sleep', '120'])
        left = '%d\n%s\n' % (gone.pid, started(gone.pid))  # The record of a run that is gone.
        gone.kill()
        gone.wait()
        lock.mkdir(parents=True)
        (lock / 'pid').write_text(left)
        other = self.start('nothing')
        theirs = '%d\n%s\n' % (other.pid, started(other.pid))
        (self.fake / 'theirs').write_text(theirs)
        path = self.mv_refusing_the_lock()
        rm = self.root / 'shims' / 'rm'
        rm.write_text('#!/bin/bash\n' + r'''
for arg in "$@"; do
  if [ "$arg" = "$SWC_CACHE_DIR/.lock" ]; then
    /bin/cp "$FAKE/theirs" "$arg/pid"
    exit 1
  fi
done
exec /bin/rm "$@"
''')
        rm.chmod(0o755)
        code, lines = self.run_script(PATH=path)
        self.assertIn('another update of this app took the lock first', self.failure(code, lines))
        self.assertEqual(code, 4)
        self.assertEqual((lock / 'pid').read_text(), theirs)
        self.assertEqual(bundle_version(self.app), OLD)

    def stat_that_takes_the_new_lock(self, then):
        """An SWC_STAT that, once this run made its lock and read its inode, does `then` to the lock (as
        another run would) before this run writes its record."""
        stub = self.bin / 'stat-then'
        stub.write_text('#!/bin/bash\n' + r'''
if [ "$2" = %i ] && [ "$3" = "$SWC_CACHE_DIR/.lock" ] && [ ! -e "$FAKE/stat-then.done" ]; then
  /usr/bin/stat "$@"
  rc=$?
  : > "$FAKE/stat-then.done"
  ''' + then + r'''
  exit $rc
fi
exec /usr/bin/stat "$@"
''')
        stub.chmod(0o755)
        return str(stub)

    def test_a_run_whose_lock_went_before_its_record_stops_on_the_lock(self):
        # Another run that judged a gone run's lock removed this run's new lock instead, between this run's
        # mkdir and its record: this run stops as one whose lock was taken over, not as a failed command.
        make_app(self.app, OLD)
        self.serve()
        stat = self.stat_that_takes_the_new_lock('/bin/mv "$3" "$3-other-run"')
        code, lines = self.run_script(SWC_STAT=stat)
        self.assertIn('took the lock over as this one did', self.failure(code, lines))
        self.assertEqual(code, 4)
        self.assertFalse((self.cache / '.lock').exists())
        self.assertTrue((self.cache / '.lock-other-run').is_dir())  # The other run's to remove.
        self.assertEqual(bundle_version(self.app), OLD)

    def test_a_run_that_cannot_write_its_record_stops_and_removes_its_lock(self):
        # Its lock stands but takes no record (no room, say): the run stops before it changes anything.
        make_app(self.app, OLD)
        self.serve()
        stat = self.stat_that_takes_the_new_lock('/bin/mkdir "$3/pid"')  # A record that cannot be written.
        code, lines = self.run_script(SWC_STAT=stat)
        self.assertIn("could not write this run's record", self.failure(code, lines))
        self.assertEqual(code, 5)
        self.assertEqual([path.name for path in self.cache.iterdir() if path.name.startswith('.lock')], [])
        self.assertEqual(bundle_version(self.app), OLD)

    def test_a_run_whose_record_the_disk_refuses_stops_for_no_room_and_prints_none_of_it(self):
        # The lock's folder fits and its record's file opens, but its data does not (a full volume): bash 3.2
        # kept the record in its buffer, the inode check after it read the record too, and the run stopped as
        # one whose lock another run took over, printing its record.
        make_app(self.app, OLD)
        self.serve()
        env = self.env()
        env.update({'V': NEW, 'SHA': self.served, 'REPO': REPO, 'DRY_RUN': '0'})

        def no_room_for_data():
            signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
            resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))  # Every write into a file fails, as on a full volume.
        result = subprocess.run(['/bin/bash', str(SCRIPT)], env=env, capture_output=True, text=True, timeout=120,
                                preexec_fn=no_room_for_data)
        lines = result.stdout.splitlines()
        self.assertEqual(lines, [self.failure(result.returncode, lines)])
        self.assertIn("could not write this run's record", lines[-1])
        self.assertEqual(result.returncode, 5)
        self.assertEqual([path.name for path in self.cache.iterdir() if path.name.startswith('.lock')], [])
        self.assertEqual(bundle_version(self.app), OLD)

    def refusing_mkdir(self):
        """A PATH whose mkdir refuses the folder $REFUSE names with $MKDIR_ERROR, as a full volume or a locked folder
        refuses it."""
        shims = self.root / 'shims'
        shims.mkdir()
        mkdir = shims / 'mkdir'
        mkdir.write_text('#!/bin/bash\n' + r'''
for arg in "$@"; do
  [ "$arg" != "$REFUSE" ] || { echo "mkdir: $arg: $MKDIR_ERROR" >&2; exit 1; }
done
exec /bin/mkdir "$@"
''')
        mkdir.chmod(0o755)
        return str(shims) + ':/usr/bin:/bin:/usr/sbin:/sbin'

    def test_a_run_that_cannot_make_its_lock_says_why(self):
        make_app(self.app, OLD)
        self.serve()
        path = self.refusing_mkdir()
        # The cache folder first, while the worker has none (its first run, or its backups were removed).
        self.assertFalse(self.cache.exists())
        for folder, made in ((self.cache, 'the update cache'), (self.cache / '.lock', 'the update lock')):
            # No room is exit 5 and says so; any other reason is mkdir's own, with exit 1.
            for error, want, hint in (('No space left on device', 5, '; is the disk full?'),
                                      ('Disc quota exceeded', 5, '; is the disk full?'), ('Permission denied', 1, '')):
                with self.subTest(folder=folder.name, error=error):
                    code, lines = self.run_script(PATH=path, REFUSE=str(folder), MKDIR_ERROR=error)
                    self.assertIn('could not make %s (mkdir: %s: %s%s)' % (made, folder, error, hint),
                                  self.failure(code, lines))
                    self.assertEqual(code, want)
                    self.assertEqual(bundle_version(self.app), OLD)
                    self.assertFalse((self.cache / '.lock').exists())

    def test_a_run_whose_lock_another_run_made_meanwhile_stops_on_the_lock_also_once_it_went(self):
        # Three runs judged the same lock gone: one made its own, and a third moved that aside again before this one,
        # whose mkdir found it, looked. One of the others goes on; this one stops on the lock, not on the disk.
        make_app(self.app, OLD)
        self.serve()
        code, lines = self.run_script(PATH=self.refusing_mkdir(), REFUSE=str(self.cache / '.lock'),
                                      MKDIR_ERROR='File exists')
        self.assertEqual(code, 4, lines)
        self.assertEqual(self.failure(4, lines), 'FAIL another update of this app took the lock first; let it finish')
        self.assertEqual(bundle_version(self.app), OLD)

    def test_a_file_or_link_in_place_of_the_lock_is_refused_and_left_alone(self):
        # Only a folder is a lock: anything else there is neither waited on as a run starting nor taken over, and
        # removed, as one whose run is gone. The dry run says that a real run stops on it.
        make_app(self.app, OLD)
        self.serve()
        lock = self.cache / '.lock'
        elsewhere = self.root / 'elsewhere'
        elsewhere.mkdir()
        self.cache.mkdir()
        for kind in ('new file', 'old file', 'link', 'dangling link'):
            with self.subTest(kind=kind):
                if kind == 'link':
                    lock.symlink_to(elsewhere)
                elif kind == 'dangling link':
                    lock.symlink_to(self.root / 'nowhere')
                else:
                    lock.write_text('not a lock\n')
                    if kind == 'old file':
                        os.utime(str(lock), (time.time() - 60, time.time() - 60))
                code, lines = self.run_script(dry=True)
                self.assertEqual(code, 0, lines)
                self.assertIn('%s is not a folder: a real run stops on it (exit 1) and leaves it there' % lock, lines)
                self.assertFalse(any('another update of this app' in line for line in lines), lines)
                self.assertEqual(self.result(lines)['how'], 'dry-run')
                code, lines = self.run_script()
                self.assertEqual(code, 1, lines)
                self.assertEqual(self.failure(1, lines),
                                 'FAIL could not make the update lock (mkdir: %s: File exists)' % lock)
                self.assertEqual(bundle_version(self.app), OLD)
                if kind == 'link':
                    self.assertTrue(lock.is_symlink() and elsewhere.is_dir())
                elif kind == 'dangling link':
                    self.assertTrue(lock.is_symlink() and not lock.exists())
                else:
                    self.assertEqual(lock.read_text(), 'not a lock\n')
                lock.unlink()
                self.assertEqual([path.name for path in self.cache.iterdir() if path.name.startswith('.lock')], [])

    def test_a_lock_its_run_releases_as_this_one_looks_at_what_stands_there_is_taken(self):
        # What stands at the lock's path is read with one lstat: a lock its run releases just then is gone, so free to
        # take, and never a path that exists without being a folder (two reads judged it a file in the way, exit 1).
        make_app(self.app, OLD)
        self.serve()
        lock = self.cache / '.lock'
        holder = self.start('nothing')
        lock.mkdir(parents=True)
        (lock / 'pid').write_text('%d\n%s\n' % (holder.pid, started(holder.pid)))
        stub = self.bin / 'stat-released'
        stub.write_text('#!/bin/bash\n' + r'''
# The holder releases its lock (moved aside, then removed) as this run reads what stands at its path.
if [ "$2" = %HT ] && [ "$3" = "$SWC_CACHE_DIR/.lock" ] && [ ! -e "$FAKE/released" ]; then
  : > "$FAKE/released"
  /bin/mv "$3" "$3-gone-holder" && /bin/rm -rf "$3-gone-holder"
fi
exec /usr/bin/stat "$@"
''')
        stub.chmod(0o755)
        code, lines = self.run_script(SWC_STAT=str(stub))
        self.assertEqual((code, self.result(lines)['how']), (0, 'swapped'), lines)
        self.assertTrue((self.fake / 'released').exists())
        self.assertNotIn('took over the update lock of a run that is gone', lines)
        self.assertEqual(bundle_version(self.app), NEW)
        self.assertEqual([path.name for path in self.cache.iterdir() if path.name.startswith('.lock')], [])

    def test_a_run_removes_the_folder_a_run_stopped_in_its_release_left_aside(self):
        # A run killed between release_lock's rename and its rm: only a run with that pid would remove the folder.
        make_app(self.app, OLD)
        self.serve()
        aside = self.cache / '.lock-gone-424242'
        aside.mkdir(parents=True)
        (aside / 'pid').write_text('424242\nThu Jan 1 00:00:00 1970\n')
        code, lines = self.run_script()
        self.assertEqual((code, self.result(lines)['how']), (0, 'swapped'))
        self.assertEqual([path.name for path in self.cache.iterdir() if path.name.startswith('.lock')], [])

    def test_a_run_takes_over_only_the_lock_it_judged_gone(self):
        # Another run took the same stale lock over while this one judged it: this one stops and leaves it.
        make_app(self.app, OLD)
        self.serve()
        lock = self.cache / '.lock'
        gone = subprocess.Popen(['/bin/sleep', '120'])
        left = '%d\n%s\n' % (gone.pid, started(gone.pid))  # The record of a run that is gone.
        gone.kill()
        gone.wait()
        lock.mkdir(parents=True)
        (lock / 'pid').write_text(left)
        other = self.start('nothing')
        theirs = '%d\n%s\n' % (other.pid, started(other.pid))
        # ps, asked for the gone run's start time, first lets the other run take the lock over.
        (self.fake / 'takeover').write_text('%d\n%s\n%s' % (gone.pid, lock, theirs))
        stub = self.bin / 'ps-takeover'
        stub.write_text('#!/bin/bash\n' + r'''
pid="${@: -1}"
if [ -f "$FAKE/takeover" ] && [ "$pid" = "$(sed -n 1p "$FAKE/takeover")" ]; then
  lock="$(sed -n 2p "$FAKE/takeover")"
  record="$(sed -n '3,4p' "$FAKE/takeover")"
  rm -f "$FAKE/takeover"
  rm -rf "$lock" && mkdir "$lock" && printf '%s\n' "$record" > "$lock/pid"
fi
exec "$(dirname "$0")/ps" "$@"
''')
        stub.chmod(0o755)
        code, lines = self.run_script(SWC_PS=str(stub))
        self.assertEqual(code, 4, lines)
        self.assertEqual(self.failure(code, lines),
                         'FAIL another update of this app took the lock first; let it finish')
        self.assertFalse((self.fake / 'takeover').exists())
        self.assertEqual((lock / 'pid').read_text(), theirs)
        self.assertEqual(bundle_version(self.app), OLD)

    def test_a_lock_its_run_releases_while_this_one_judges_it_is_taken(self):
        # The run holding the lock finishes while this one judges it: the lock is free, so this run takes it.
        make_app(self.app, OLD)
        self.serve()
        lock = self.cache / '.lock'
        holder = self.start('nothing')
        lock.mkdir(parents=True)
        (lock / 'pid').write_text('%d\n%s\n' % (holder.pid, started(holder.pid)))
        # ps, asked for the holder's start time, first lets the holder finish: its lock goes, then the holder.
        (self.fake / 'release').write_text('%d\n%s\n' % (holder.pid, lock))
        stub = self.bin / 'ps-release'
        stub.write_text('#!/bin/bash\n' + r'''
pid="${@: -1}"
if [ -f "$FAKE/release" ] && [ "$pid" = "$(sed -n 1p "$FAKE/release")" ]; then
  lock="$(sed -n 2p "$FAKE/release")"
  rm -f "$FAKE/release"
  rm -rf "$lock"
  kill "$pid"
  n=0
  while kill -0 "$pid" 2> /dev/null && [ "$n" -lt 200 ]; do
    sleep 0.05
    n=$((n + 1))
  done
fi
exec "$(dirname "$0")/ps" "$@"
''')
        stub.chmod(0o755)
        code, lines = self.run_script(SWC_PS=str(stub))
        self.assertEqual((code, self.result(lines)['how']), (0, 'swapped'), lines)
        self.assertFalse((self.fake / 'release').exists())
        self.assertIsNotNone(holder.poll())
        self.assertNotIn('took over the update lock of a run that is gone', lines)
        self.assertEqual(bundle_version(self.app), NEW)
        self.assertFalse(lock.exists())

    def test_a_lock_made_after_the_judged_one_went_is_left_to_its_run(self):
        # The lock went before this run read which lock it judges, and another run made one before this run
        # took it: this run never judged that lock, so it stops and leaves it.
        make_app(self.app, OLD)
        self.serve()
        lock = self.cache / '.lock'
        holder = self.start('nothing')
        lock.mkdir(parents=True)
        (lock / 'pid').write_text('%d\n%s\n' % (holder.pid, started(holder.pid)))
        other = self.start('nothing')
        theirs = '%d\n%s\n' % (other.pid, started(other.pid))
        (self.fake / 'made').write_text('%s\n%s' % (lock, theirs))
        stub = self.bin / 'stat-made'
        stub.write_text('#!/bin/bash\n' + r'''
# The first read of the lock's inode finds it gone; the next finds another run's lock in its place.
if [ "$2" = %i ] && [ "$3" = "$(sed -n 1p "$FAKE/made")" ]; then
  if [ ! -f "$FAKE/made.gone" ]; then
    touch "$FAKE/made.gone"
    rm -rf "$3"
    exit 1
  elif [ ! -f "$FAKE/made.taken" ]; then
    touch "$FAKE/made.taken"
    mkdir "$3" && sed -n '2,3p' "$FAKE/made" > "$3/pid"
  fi
fi
exec /usr/bin/stat "$@"
''')
        stub.chmod(0o755)
        code, lines = self.run_script(SWC_STAT=str(stub))
        self.assertEqual(code, 4, lines)
        self.assertEqual(self.failure(code, lines), 'FAIL another update of this app took the lock first; let it finish')
        self.assertTrue((self.fake / 'made.taken').exists())
        self.assertEqual((lock / 'pid').read_text(), theirs)
        self.assertEqual(bundle_version(self.app), OLD)

    def test_a_run_judging_a_lock_its_run_releases_never_sees_it_without_its_record(self):
        # The run holding the lock removes it as another run judges it: the other run sees the whole lock or none,
        # never a folder whose record went first, which it would take for a run that is starting.
        make_app(self.app, OLD)
        self.serve()
        lock = self.cache / '.lock'
        shims = self.root / 'shims'
        shims.mkdir()
        rm = shims / 'rm'
        rm.write_text('#!/bin/bash\n' + r'''
# A slow rm: removes a lock folder's record, then waits for the test before it removes the rest.
for arg in "$@"; do
  if [ -d "$arg" ] && [ -f "$arg/pid" ]; then
    /bin/rm -f "$arg/pid"
    : > "$FAKE/rm.paused"
    n=0
    while [ ! -f "$FAKE/rm.go" ] && [ "$n" -lt 600 ]; do
      sleep 0.05
      n=$((n + 1))
    done
  fi
done
exec /bin/rm "$@"
''')
        rm.chmod(0o755)
        env = self.env(PATH=str(shims) + ':/usr/bin:/bin:/usr/sbin:/sbin')
        env.update({'V': NEW, 'SHA': self.served, 'REPO': REPO, 'DRY_RUN': '0'})
        script = subprocess.Popen(['/bin/bash', str(SCRIPT)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  text=True)
        self.processes.append(script)
        deadline = time.time() + 60
        while not (self.fake / 'rm.paused').exists():
            self.assertLess(time.time(), deadline, 'the run never released its lock')
            self.assertIsNone(script.poll(), 'the run ended before it released its lock')
            time.sleep(0.02)
        self.assertFalse(lock.exists())
        code, lines = self.run_script()  # Another run as the first one releases its lock.
        self.assertEqual((code, self.result(lines)['how']), (0, 'already-current'), lines)
        (self.fake / 'rm.go').write_text('')
        out, err = script.communicate(timeout=60)
        self.assertEqual((script.returncode, err), (0, ''), out)
        self.assertEqual(self.result(out.splitlines())['how'], 'swapped')
        self.assertEqual([path.name for path in self.cache.iterdir() if path.name.startswith('.lock')], [])

    def test_of_two_runs_that_take_the_lock_only_the_one_whose_record_stands_goes_on(self):
        # Two runs judged the same lock gone, or made it one after the other: each waits, then reads the record
        # again. The run whose record was replaced stops before it changes anything and leaves the lock alone.
        make_app(self.app, OLD)
        self.serve()
        lock = self.cache / '.lock'
        gone = subprocess.Popen(['/bin/sleep', '120'])
        left = '%d\n%s\n' % (gone.pid, started(gone.pid))  # The record of a run that is gone.
        gone.kill()
        gone.wait()
        other = self.start('nothing')
        theirs = '%d\n%s\n' % (other.pid, started(other.pid))

        shims = self.root / 'shims'
        shims.mkdir()
        pause = shims / 'sleep'
        pause.write_text('#!/bin/bash\n' + r'''
# The run's wait after it writes its record (its only sleep of SWC_LOCK_WAIT seconds) ends once the test has
# written the other run's record, however slow the host: a slow host must not let the run read its own record.
# It ends too once the run is gone, as a failed check kills it.
if [ "$1" = "$SWC_LOCK_WAIT" ]; then
  : > "$FAKE/lock.waiting"
  n=0
  while [ ! -f "$FAKE/lock.go" ] && [ "$n" -lt 1200 ] && kill -0 "$PPID" 2> /dev/null; do
    /bin/sleep 0.05
    n=$((n + 1))
  done
  exit 0
fi
exec /bin/sleep "$@"
''')
        pause.chmod(0o755)

        for stale in (True, False):
            with self.subTest(stale=stale):
                script = None
                try:
                    if stale:
                        lock.mkdir(parents=True)
                        (lock / 'pid').write_text(left)
                    env = self.env(SWC_LOCK_WAIT='3', PATH=str(shims) + ':/usr/bin:/bin:/usr/sbin:/sbin')
                    env.update({'V': NEW, 'SHA': self.served, 'REPO': REPO, 'DRY_RUN': '0'})
                    script = subprocess.Popen(['/bin/bash', str(SCRIPT)], env=env, stdout=subprocess.PIPE,
                                              stderr=subprocess.PIPE, text=True)
                    self.processes.append(script)
                    deadline = time.time() + 60
                    while not (self.fake / 'lock.waiting').exists():
                        self.assertLess(time.time(), deadline, 'the run never waited after writing its record')
                        self.assertIsNone(script.poll(), 'the run ended before it waited')
                        time.sleep(0.02)
                    self.assertEqual((lock / 'pid').read_text().split('\n')[0], str(script.pid))
                    (lock / 'pid').write_text(theirs)  # The other run's record, written as this run waits.
                    (self.fake / 'lock.go').write_text('')
                    out, err = script.communicate(timeout=60)
                    self.assertEqual(err, '')
                    lines = out.splitlines()
                    self.assertEqual(script.returncode, 4, lines)
                    self.assertEqual(self.failure(4, lines),
                                     'FAIL another update of this app took the lock over as this one did; let it finish')
                    self.assertEqual('took over the update lock of a run that is gone' in lines, stale)
                    self.assertEqual((lock / 'pid').read_text(), theirs)
                    self.assertEqual(bundle_version(self.app), OLD)
                    self.assertEqual(self.leftovers(), [])
                finally:  # A failed check leaves neither this run waiting nor its lock and marks to the next subtest.
                    if script is not None and script.poll() is None:
                        script.kill()
                        script.wait()  # Reaped: its sleep shim, which holds its pipes, then sees it gone.
                        script.communicate()
                    shutil.rmtree(str(lock), ignore_errors=True)
                    for mark in ('lock.waiting', 'lock.go'):
                        if (self.fake / mark).exists():
                            (self.fake / mark).unlink()


if __name__ == '__main__':
    unittest.main()
