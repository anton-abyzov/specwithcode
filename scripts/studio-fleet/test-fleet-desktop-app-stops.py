#!/usr/bin/env python3
"""A worker desktop-app update whose ssh session drops, or that is stopped by a signal: desktop_app_update_remote.sh
runs for real against test-fleet-desktop-app.py's fake worker Mac.

Run: cd scripts/studio-fleet && python3 -B test-fleet-desktop-app-stops.py
"""
import importlib.util
import os
import pathlib
import shutil
import signal
import subprocess
import time
import unittest

HERE = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('desktop_app_tests_for_stops', str(HERE / 'test-fleet-desktop-app.py'))
desktop_tests = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(desktop_tests)
SCRIPT, REPO, OLD, NEW = desktop_tests.SCRIPT, desktop_tests.REPO, desktop_tests.OLD, desktop_tests.NEW
make_app, bundle_version = desktop_tests.make_app, desktop_tests.bundle_version


class StoppedRuns(desktop_tests.Machine):
    def dropped_after(self, prefix):
        """Runs an update of the running app whose ssh session drops once the line starting with `prefix` is out,
        and checks that the run still swaps, reopens the app and leaves no lock behind. bash 3.2 kept each line
        that could not be written in the shell's buffer, and every later $(...) carried it out: the app's pids,
        the zip's sha256 and the lock's holder read wrong."""
        make_app(self.app, OLD)
        self.serve()
        app = self.start()
        env = self.env(SWC_SHIPIT_GRACE='1')  # Output goes on after the reader is gone.
        env.update({'V': NEW, 'SHA': self.served, 'REPO': REPO, 'DRY_RUN': '0'})
        with open(str(self.root / 'stderr'), 'w') as stderr:
            script = subprocess.Popen(['/bin/bash', str(SCRIPT)], env=env, stdout=subprocess.PIPE, stderr=stderr,
                                      text=True)
            self.processes.append(script)
            for line in script.stdout:
                if line.startswith(prefix):
                    break
            script.stdout.close()  # The ssh session drops here.
            self.assertEqual(script.wait(timeout=60), 0)
        self.assertEqual((self.root / 'stderr').read_text(), '')
        self.assertIsNotNone(app.poll())
        self.assertEqual(bundle_version(self.app), NEW)
        self.assertEqual(self.log('open'), [str(self.app)])
        self.assertEqual(self.trash(), [OLD])
        self.assertEqual(self.leftovers(), [])
        self.assertEqual([path.name for path in self.cache.iterdir() if path.name.startswith('.lock')], [])

    def test_a_session_dropped_after_the_quit_still_swaps_and_reopens_the_app(self):
        self.dropped_after('quitting the app')  # With the app quit and nothing swapped yet.

    def spawn(self, own_group=False, **extra):
        """Starts an update of the app with its lines on a pipe; in a process group of its own with `own_group`, where
        a signal to the group reaches the run and every command it runs, as Ctrl-C at its terminal does."""
        env = self.env(**dict({'SWC_SHIPIT_GRACE': '1'}, **extra))  # Still waiting after the quit when a signal lands.
        env.update({'V': NEW, 'SHA': self.served, 'REPO': REPO, 'DRY_RUN': '0'})
        stderr = open(str(self.root / 'stderr'), 'w')
        self.addCleanup(stderr.close)
        # A run started in the background inherits SIGINT ignored, which bash then cannot trap.
        script = subprocess.Popen(['/bin/bash', str(SCRIPT)], env=env, stdout=subprocess.PIPE, stderr=stderr, text=True,
                                  start_new_session=own_group,
                                  preexec_fn=lambda: signal.signal(signal.SIGINT, signal.SIG_DFL))
        self.processes.append(script)
        return script

    def held(self):
        path = self.fake / 'held'
        return len(path.read_text().split()) if path.exists() else 0

    def signal_held(self, script, stub, signum, group=False):
        """Holds the run in its next call of `stub` (from now on, unless $FAKE/hold names it already), sends it `signum`
        there (to its process group with `group`), and lets it go on. bash 3.2 drops a SIGINT that lands just after
        it reaped a command that ended by itself, which is when a line the run printed is out; one that lands while
        it waits on a command is taken once that ends."""
        before = self.held()
        if not (self.fake / 'hold').exists():
            (self.fake / 'hold').write_text(stub + '\n')
        deadline = time.time() + 30
        while self.held() == before:
            self.assertIsNone(script.poll(), 'the run ended before it called %s' % stub)
            self.assertLess(time.time(), deadline, 'the run never called %s' % stub)
            time.sleep(0.01)
        if group:
            os.killpg(script.pid, signum)
        else:
            script.send_signal(signum)
        (self.fake / 'hold').unlink()

    def finished(self, script, lines=()):
        """The run's exit code and all its lines, once it has ended."""
        lines = list(lines) + script.stdout.read().splitlines()
        code = script.wait(timeout=60)
        self.assertEqual((self.root / 'stderr').read_text(), '')
        return code, lines

    def signalled_after(self, prefix, signum, again=None, hold='pgrep', **app):
        """Runs an update of the running app (`app`: start's options) and sends the run alone `signum` once the line
        starting with `prefix` is out, as `kill <pid>` does, in the next call of the `hold` stub after it (`trash`: the
        previous app's only one), and once more `again` seconds later; returns its exit code and lines, and the app."""
        make_app(self.app, OLD)
        self.serve()
        running = self.start(**app)
        if hold == 'trash':  # Called right after the line: held from the start.
            (self.fake / 'hold').write_text('trash\n')
        script = self.spawn()
        lines = []
        for line in script.stdout:
            lines.append(line.rstrip('\n'))
            if line.startswith(prefix):
                self.signal_held(script, hold, signum)
                break
        if again is not None:
            time.sleep(again)
            script.send_signal(signum)
        code, lines = self.finished(script, lines)
        return code, lines, running

    def test_a_run_stopped_after_the_quit_opens_the_app_again_once_it_has_gone(self):
        # Without its own traps bash 3.2 ran the EXIT trap with the status of the wait it was in, 0, so the stop read
        # as a success and left the app closed.
        # An app that takes a second to quit is waited for, also through another stop meanwhile, and opened once it
        # has gone: an open sent while it quits only brings that instance forward, and then it is gone.
        for signum, want, quit_after, again in ((signal.SIGTERM, 143, 0, None), (signal.SIGINT, 130, 0, None),
                                                (signal.SIGTERM, 143, 1, None), (signal.SIGTERM, 143, 1, 0.4)):
            with self.subTest(signal=signal.Signals(signum).name, quit_after=quit_after, again=again):
                shutil.rmtree(str(self.app), ignore_errors=True)  # Each subtest updates an app of its own.
                if (self.fake / 'open.log').exists():
                    (self.fake / 'open.log').unlink()
                code, lines, app = self.signalled_after('quitting the app', signum, again, quit_after=quit_after)
                self.assertEqual(code, want, lines)
                self.assertEqual(self.failure(want, lines), 'FAIL stopped by %s' % signal.Signals(signum).name)
                self.assertIsNotNone(app.poll())
                self.assertEqual(self.log('open'), [str(self.app)])
                # The stub open starts nothing (SWC_LAUNCH_WAIT=0): no process ran as the run opened the app.
                self.assertIn('asked macOS to open the app again, as it was running before; no process yet', lines)
                self.assertEqual(bundle_version(self.app), OLD)
                self.assertEqual(self.leftovers(), [])
                self.assertEqual([path.name for path in self.cache.iterdir() if path.name.startswith('.lock')], [])

    def test_a_hangup_does_not_stop_a_run(self):
        # A run started from a terminal gets SIGHUP when its session drops: it goes on as one whose output went, also
        # after the swap's renames, which ignore it for a while.
        for prefix in ('quitting the app', 'swapped '):
            with self.subTest(prefix=prefix):
                shutil.rmtree(str(self.app), ignore_errors=True)
                shutil.rmtree(str(self.fake / 'Trash'), ignore_errors=True)
                if (self.fake / 'open.log').exists():
                    (self.fake / 'open.log').unlink()
                code, lines, app = self.signalled_after(prefix, signal.SIGHUP)
                self.assertEqual(code, 0, lines)
                self.assertEqual(self.result(lines), {'before': OLD, 'after': NEW, 'how': 'swapped', 'relaunched': 'yes'})
                self.assertEqual(self.log('open'), [str(self.app)])
                self.assertEqual(self.trash(), [OLD])

    def test_a_run_stopped_after_the_swap_says_so_and_opens_the_app_again(self):
        # Once the swapped-in app passed its checks a stop counts again, here while the previous app goes to the Trash.
        # That command's output is dropped by its own redirection: one on the call would stay on the run as the stop
        # ends it there, and its FAIL line and the reopen's line would go nowhere.
        for signum, want in ((signal.SIGTERM, 143), (signal.SIGINT, 130)):
            with self.subTest(signal=signal.Signals(signum).name):
                shutil.rmtree(str(self.app), ignore_errors=True)
                shutil.rmtree(str(self.fake / 'Trash'), ignore_errors=True)
                if (self.fake / 'open.log').exists():
                    (self.fake / 'open.log').unlink()
                code, lines, app = self.signalled_after('swapped ', signum, hold='trash')
                self.assertEqual(code, want, lines)
                self.assertEqual(self.failure(want, lines), 'FAIL stopped by %s' % signal.Signals(signum).name)
                self.assertIn('asked macOS to open the app again, as it was running before; no process yet', lines)
                self.assertEqual(self.log('open'), [str(self.app)])
                self.assertEqual(bundle_version(self.app), NEW)
                deadline = time.time() + 30
                while self.trash() != [OLD]:  # The trash the stop let go of finishes by itself.
                    self.assertLess(time.time(), deadline, 'the previous app never went to the Trash')
                    time.sleep(0.05)
                self.assertEqual(self.leftovers(), [])
                self.assertEqual([path.name for path in self.cache.iterdir() if path.name.startswith('.lock')], [])

    def test_a_stop_during_the_swap_is_ignored_and_the_update_goes_on(self):
        # From the first rename until the app renamed in passed its checks, a stop is ignored, by those commands too:
        # kill, and Ctrl-C at the run's terminal, which reaches the check that runs then.
        make_app(self.app, OLD)
        self.serve()
        app = self.start()
        stub = self.bin / 'codesign-held'
        stub.write_text('#!/bin/bash\n' + r'''
# Holds the first check of the app at its place, the swapped-in one, until the test lets it go.
if [ "${@: -1}" = "$SWC_APP_DIR/SpecWithCode.app" ] && [ ! -e "$FAKE/codesign.held" ]; then
  : > "$FAKE/codesign.held"
  while [ ! -e "$FAKE/codesign.go" ]; do sleep 0.01; done
fi
exec "$(dirname "$0")/codesign" "$@"
''')
        stub.chmod(0o755)
        script = self.spawn(own_group=True, SWC_CODESIGN=str(stub))
        deadline = time.time() + 30
        while not (self.fake / 'codesign.held').exists():
            self.assertIsNone(script.poll(), 'the run ended before it checked the swapped-in app')
            self.assertLess(time.time(), deadline, 'the run never checked the swapped-in app')
            time.sleep(0.01)
        script.send_signal(signal.SIGTERM)
        os.killpg(script.pid, signal.SIGINT)
        (self.fake / 'codesign.go').write_text('')
        code, lines = self.finished(script)
        self.assertEqual(code, 0, lines)
        self.assertEqual(self.result(lines), {'before': OLD, 'after': NEW, 'how': 'swapped', 'relaunched': 'yes'})
        self.assertIsNotNone(app.poll())
        self.assertEqual(self.log('open'), [str(self.app)])
        self.assertEqual(self.trash(), [OLD])

    def test_another_stop_while_the_run_waits_for_the_app_to_go_does_not_end_the_wait(self):
        # Ctrl-C at the run's terminal reaches every command it runs. A second one, pressed as the stopped run waits for
        # the quitting app, landed in the wait's pgrep, whose end read as an app that had gone: the reopen was skipped
        # while the app still ran, and once it quit it stayed closed.
        make_app(self.app, OLD)
        self.serve()
        # Generous quit margin: both signals must land in pgrep waits while
        # the app is still quitting, and a loaded runner can take seconds to
        # schedule the held stub between the two. The run's quit deadline
        # rises with it so the wait itself does not expire first.
        app = self.start(quit_after=10)
        script = self.spawn(own_group=True, SWC_QUIT_WAIT='30')
        lines = []
        for line in script.stdout:
            lines.append(line.rstrip('\n'))
            if line.startswith('quitting the app'):
                self.signal_held(script, 'pgrep', signal.SIGINT, group=True)  # In the quit's wait.
                self.signal_held(script, 'pgrep', signal.SIGINT, group=True)  # In the stopped run's wait.
                break
        code, lines = self.finished(script, lines)
        self.assertEqual(code, 130, lines)
        self.assertEqual(self.failure(130, lines), 'FAIL stopped by SIGINT')
        self.assertIsNotNone(app.poll())
        self.assertEqual(self.log('open'), [str(self.app)])
        self.assertEqual(bundle_version(self.app), OLD)
        self.assertEqual(self.leftovers(), [])

    def test_a_run_stopped_while_the_apps_own_updater_runs_leaves_the_app_closed(self):
        # The app's own updater (ShipIt, waiting for the app to quit) installs once it has: a run stopped as it quits
        # the app, or as it waits for that updater, does not open the app in the middle of that install.
        shipit = self.app / 'Contents/Frameworks/Squirrel.framework/Resources/ShipIt'
        for prefix in ('quitting the app', 'waiting for its own updater'):
            with self.subTest(prefix=prefix):
                shutil.rmtree(str(self.app), ignore_errors=True)
                updater = self.start('ShipIt', shipit)
                code, lines, app = self.signalled_after(prefix, signal.SIGTERM)
                self.assertEqual(code, 143, lines)
                self.assertEqual(self.failure(143, lines), 'FAIL stopped by SIGTERM')
                self.assertIn('WARNING: left the app closed while its own updater (ShipIt, pid %d) runs; open it on '
                              'that Mac once that has finished' % updater.pid, lines)
                self.assertIsNotNone(app.poll())
                self.assertEqual(self.log('open'), [])
                self.assertEqual(bundle_version(self.app), OLD)
                self.assertEqual(self.leftovers(), [])
                updater.kill()
                updater.wait()

    def test_a_session_dropped_before_the_download_still_checks_it_and_swaps(self):
        self.dropped_after('installed app:')

    def test_a_session_dropped_after_the_download_still_quits_the_app_and_swaps(self):
        self.dropped_after('downloaded the release zip')

    def test_a_session_dropped_after_the_unpack_still_quits_the_app_and_swaps(self):
        self.dropped_after('unpacked ')


if __name__ == '__main__':
    unittest.main()
