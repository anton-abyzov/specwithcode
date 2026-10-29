#!/usr/bin/env python3
"""The worker desktop-app step: desktop_app_update_remote.sh against fake app bundles, and fleet_rollout's use of it.

The remote script runs for real with /bin/bash in a temporary folder: stub codesign, spctl, PlistBuddy,
curl, open, pgrep, ps, trash and osascript, and the real ditto, unzip, df and shasum. A running app (or
ShipIt) is a sleep this test starts and stops by its own pid, matched by the stub pgrep and ps (which
reads start times from the real /bin/ps); nothing outside the temporary folder is read as an app, quit,
renamed or opened. fleet_rollout runs against
test-fleet-rollout.py's fake fleet, and no host or network is contacted.

Run: cd scripts/studio-fleet && python3 -B test-fleet-desktop-app.py
"""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import plistlib
import re
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock
import urllib.error

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import desktop_app_rollout  # noqa: E402
import fleet_rollout  # noqa: E402

_spec = importlib.util.spec_from_file_location('rollout_tests_for_desktop', str(HERE / 'test-fleet-rollout.py'))
rollout_tests = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rollout_tests)
Clock, Fleet, OLD, NEW = rollout_tests.Clock, rollout_tests.Fleet, rollout_tests.OLD, rollout_tests.NEW

SCRIPT = HERE / 'desktop_app_update_remote.sh'
REQUIREMENT = re.search(r"^RELEASE_REQUIREMENT='(.*)'$", SCRIPT.read_text(), re.M).group(1)
NEWER = '1.0.42'
REPO = 'anton-abyzov/specwithcode'

STUBS = {
    # curl ... -o OUT URL: serves $FAKE/served.zip; $FAKE/curl.fail makes the download fail.
    'curl': r'''
args=("$@"); out=""
for ((i = 0; i < $#; i++)); do if [ "${args[$i]}" = "-o" ]; then out="${args[$((i + 1))]}"; fi; done
printf '%s\n' "${@: -1}" >> "$FAKE/curl.log"
[ ! -e "$FAKE/curl.fail" ] || exit 22
cp "$FAKE/served.zip" "$out"
''',
    'PlistBuddy': r'''
plist="${@: -1}"
version="$(sed -n '/<key>CFBundleShortVersionString<\/key>/{n;s/.*<string>\(.*\)<\/string>.*/\1/p;}' "$plist" 2> /dev/null)"
[ -n "$version" ] || { echo 'Print: Entry, ":CFBundleShortVersionString", Does Not Exist' >&2; exit 1; }
printf '%s\n' "$version"
''',
    # A fake bundle says how it is signed in Contents/_fake; a path listed in $FAKE/codesign-fails fails.
    'codesign': r'''
printf '%s\n' "$*" >> "$FAKE/codesign.log"
bundle="${@: -1}"
sig="$(cat "$bundle/Contents/_fake/signature" 2> /dev/null)"
req="$(cat "$bundle/Contents/_fake/requirement" 2> /dev/null)"
if [ -f "$FAKE/codesign-fails" ] && grep -qxF "$bundle" "$FAKE/codesign-fails"; then sig=bad; fi
case "$1" in
  -d) [ -d "$bundle" ] || exit 1; echo "Executable=$bundle/Contents/MacOS/SpecWithCode" >&2
      [ -z "$req" ] || echo "designated => $req"; exit 0 ;;
  --verify)
    for arg in "$@"; do
      case "$arg" in -R=*) [ "$sig" = ok ] && [ "${arg#-R=}" = "$req" ]; exit $? ;; esac
    done
    [ "$sig" = ok ]; exit $? ;;
esac
exit 2
''',
    'spctl': r'''
printf '%s\n' "$*" >> "$FAKE/spctl.log"
bundle="${@: -1}"
[ "$(cat "$bundle/Contents/_fake/gatekeeper" 2> /dev/null)" = ok ] || { echo "$bundle: rejected" >&2; exit 3; }
echo "$bundle: accepted"
''',
    # pgrep -x NAME: the live pids listed in $FAKE/pids/NAME.
    'pgrep': r'''
name="${@: -1}"; found=1
[ -f "$FAKE/pids/$name" ] || exit 1
while read -r pid; do
  if [ -n "$pid" ] && kill -0 "$pid" 2> /dev/null; then echo "$pid"; found=0; fi
done < "$FAKE/pids/$name"
exit $found
''',
    # ps -o comm= -p PID: $FAKE/comm/PID, for a live pid; ps -o lstart= -p PID: its real start time.
    'ps': r'''
pid="${@: -1}"
case "$*" in *lstart=*) exec /bin/ps -o lstart= -p "$pid" ;; esac
kill -0 "$pid" 2> /dev/null && [ -f "$FAKE/comm/$pid" ] && cat "$FAKE/comm/$pid"
exit 0
''',
    'open': r'''
printf '%s\n' "$*" >> "$FAKE/open.log"
''',
    # trash PATH: moves it into $FAKE/Trash, as /usr/bin/trash moves it into ~/.Trash.
    'trash': r'''
printf '%s\n' "$*" >> "$FAKE/trash.log"
[ ! -e "$FAKE/trash.fail" ] || exit 1
mkdir -p "$FAKE/Trash"
mv "$1" "$FAKE/Trash/$(ls "$FAKE/Trash" | wc -l | tr -d ' ')-$(basename "$1")"
''',
    # Finder's delete: moves the POSIX file into $FAKE/Trash unless $FAKE/finder.fail exists.
    'osascript': r'''
printf '%s\n' "$*" >> "$FAKE/osascript.log"
[ ! -e "$FAKE/finder.fail" ] || exit 1
target="$(printf '%s' "$2" | sed -n 's/.*POSIX file "\(.*\)"$/\1/p')"
mkdir -p "$FAKE/Trash"
mv "$target" "$FAKE/Trash/$(ls "$FAKE/Trash" | wc -l | tr -d ' ')-$(basename "$target")"
''',
    'df-full': r'''
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
echo "/dev/fake 1000000 999000 1000 99% /"
''',
}


def make_app(path, version, signature='ok', requirement=REQUIREMENT, gatekeeper='ok'):
    """A fake SpecWithCode.app: a real Info.plist, and how it is signed in Contents/_fake for the stubs."""
    contents = pathlib.Path(path) / 'Contents'
    (contents / 'MacOS').mkdir(parents=True)
    (contents / '_fake').mkdir()
    with open(str(contents / 'Info.plist'), 'wb') as handle:
        plistlib.dump({'CFBundleIdentifier': 'com.specweave.studio', 'CFBundleShortVersionString': version}, handle)
    (contents / 'MacOS' / 'SpecWithCode').write_text('binary ' + version)
    (contents / '_fake' / 'signature').write_text(signature)
    (contents / '_fake' / 'requirement').write_text(requirement)
    (contents / '_fake' / 'gatekeeper').write_text(gatekeeper)
    return pathlib.Path(path)


def bundle_version(path):
    try:
        with open(str(pathlib.Path(path) / 'Contents' / 'Info.plist'), 'rb') as handle:
            return plistlib.load(handle).get('CFBundleShortVersionString')
    except OSError:
        return None


def sha256(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def started(pid):
    """When the process started, as the script's lock records it: ps's lstart in single-spaced words."""
    out = subprocess.run(['/bin/ps', '-o', 'lstart=', '-p', str(pid)], capture_output=True, text=True).stdout
    return ' '.join(out.split())


class Machine(unittest.TestCase):
    """A fake worker Mac in a temporary folder."""

    def setUp(self):
        if sys.platform != 'darwin' or not os.path.exists('/usr/bin/ditto'):
            self.skipTest('the remote script unpacks with macOS ditto')
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = pathlib.Path(folder.name).resolve()
        self.apps = self.root / 'Applications'
        self.app = self.apps / 'SpecWithCode.app'
        self.old = self.apps / 'SpecWithCode.app.release-old'
        self.fake = self.root / 'fake'
        self.cache = self.root / 'cache'
        self.home = self.root / 'home'
        self.bin = self.root / 'bin'
        for folder_path in (self.apps, self.fake / 'pids', self.fake / 'comm', self.home, self.bin):
            folder_path.mkdir(parents=True)
        for name, body in STUBS.items():
            path = self.bin / name
            path.write_text('#!/bin/bash\n' + body.lstrip('\n'))
            path.chmod(0o755)
        self.processes = []
        self.addCleanup(self.stop_processes)
        self.served = None

    def stop_processes(self):
        for process in self.processes:  # Only the processes this test started, by their own pids.
            if process.poll() is None:
                process.kill()
            process.wait()
            if process.stdout:
                process.stdout.close()

    def env(self, **extra):
        env = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(self.home), 'FAKE': str(self.fake),
               'SWC_APP_DIR': str(self.apps), 'SWC_CACHE_DIR': str(self.cache), 'SWC_POLL': '0.1',
               'SWC_QUIT_WAIT': '5', 'SWC_SHIPIT_GRACE': '0', 'SWC_SHIPIT_WAIT': '5', 'SWC_LAUNCH_WAIT': '0',
               'SWC_LOCK_WAIT': '0'}
        for tool in ('curl', 'PlistBuddy', 'codesign', 'spctl', 'pgrep', 'ps', 'open', 'trash', 'osascript'):
            env['SWC_' + tool.upper()] = str(self.bin / tool)
        env.update(extra)
        return env

    def serve(self, version=NEW, folder='SpecWithCode.app', **marks):
        """Puts the release zip the stub curl serves in place; returns its sha256."""
        release = self.root / ('release-%d' % len(list(self.root.glob('release-*'))))
        make_app(release / folder, version, **marks)
        zip_path = self.fake / 'served.zip'
        subprocess.run(['/usr/bin/ditto', '-c', '-k', '--keepParent', str(release / folder), str(zip_path)], check=True)
        self.served = sha256(zip_path)
        return self.served

    def run_script(self, version=NEW, sha=None, dry=False, repo=REPO, **extra):
        env = self.env(**extra)
        env.update({'V': version, 'SHA': sha if sha is not None else self.served, 'REPO': repo,
                    'DRY_RUN': '1' if dry else '0'})
        result = subprocess.run(['/bin/bash', str(SCRIPT)], env=env, capture_output=True, text=True, timeout=120)
        lines = result.stdout.splitlines()
        self.assertEqual(result.stderr, '', result.stderr)
        return result.returncode, lines

    def result(self, lines):
        self.assertTrue(lines and lines[-1].startswith('RESULT '), lines)
        return desktop_app_rollout.parse_result(lines[-1])

    def failure(self, code, lines):
        self.assertNotEqual(code, 0, lines)
        self.assertTrue(lines and lines[-1].startswith('FAIL '), lines)
        return lines[-1]

    def start(self, name='SpecWithCode', path=None, ignore_term=False):
        """A process the stub pgrep and ps report as `name` running from `path` (default: the app)."""
        if ignore_term:
            process = subprocess.Popen([sys.executable, '-c', 'import signal, time; signal.signal(signal.SIGTERM, '
                                        'signal.SIG_IGN); print("ready", flush=True); time.sleep(120)'],
                                       stdout=subprocess.PIPE)
            process.stdout.readline()
        else:
            process = subprocess.Popen(['/bin/sleep', '120'])
        self.processes.append(process)
        threading.Thread(target=process.wait, daemon=True).start()  # Reaped as soon as it is stopped.
        path = path or self.app / 'Contents' / 'MacOS' / 'SpecWithCode'
        (self.fake / 'comm' / str(process.pid)).write_text(str(path))
        with open(str(self.fake / 'pids' / name), 'a') as handle:
            handle.write('%d\n' % process.pid)
        return process

    def log(self, name):
        path = self.fake / (name + '.log')
        return path.read_text().splitlines() if path.exists() else []

    def trash(self):
        folder = self.fake / 'Trash'
        return sorted(bundle_version(path) for path in folder.iterdir()) if folder.exists() else []

    def leftovers(self):
        """Anything beside the app: an unpack folder or a previous app."""
        return sorted(path.name for path in self.apps.iterdir() if path.name != 'SpecWithCode.app')

    def snapshot(self, *folders):
        files = {}
        for folder in folders:
            for path in sorted(folder.rglob('*')):
                files[str(path)] = path.read_bytes() if path.is_file() else None
        return files


class RemoteScript(Machine):
    def test_already_current_changes_nothing_and_downloads_nothing(self):
        make_app(self.app, NEW)
        self.serve()
        before = self.snapshot(self.apps)
        code, lines = self.run_script()
        self.assertEqual(code, 0, lines)
        self.assertEqual(self.result(lines), {'before': NEW, 'after': NEW, 'how': 'already-current', 'relaunched': 'no'})
        self.assertEqual(self.snapshot(self.apps), before)
        self.assertEqual(self.log('curl'), [])
        self.assertEqual(self.log('open'), [])

    def test_swap_when_not_running_leaves_it_closed_and_trashes_the_previous_app(self):
        make_app(self.app, OLD)
        self.serve()
        code, lines = self.run_script()
        self.assertEqual(code, 0, lines)
        self.assertEqual(self.result(lines), {'before': OLD, 'after': NEW, 'how': 'swapped', 'relaunched': 'no'})
        self.assertEqual(bundle_version(self.app), NEW)
        self.assertEqual(self.trash(), [OLD])
        self.assertEqual(self.leftovers(), [])
        self.assertEqual(self.log('open'), [])
        self.assertIn('the app was not running before; left closed', lines)
        self.assertEqual(self.log('curl'), ['https://github.com/%s/releases/download/v%s/SpecWithCode-%s-arm64.zip'
                                            % (REPO, NEW, NEW)])
        self.assertEqual(sorted(path.name for path in self.cache.iterdir()), [])  # The download is not kept.
        # Checked beside the app first, then again where it landed: signature, requirement, Gatekeeper.
        fresh = str(self.apps / ('.SpecWithCode.app-%s-unpack' % NEW) / 'SpecWithCode.app')
        self.assertIn('--verify --deep --strict ' + fresh, self.log('codesign'))
        self.assertIn('--verify -R=%s %s' % (REQUIREMENT, fresh), self.log('codesign'))
        self.assertIn('-a -t exec ' + fresh, self.log('spctl'))
        self.assertIn('-a -t exec ' + str(self.app), self.log('spctl'))

    def test_swap_when_running_quits_it_and_reopens_it(self):
        make_app(self.app, OLD)
        self.serve()
        app = self.start()
        code, lines = self.run_script()
        self.assertEqual(code, 0, lines)
        self.assertEqual(self.result(lines), {'before': OLD, 'after': NEW, 'how': 'swapped', 'relaunched': 'yes'})
        self.assertIsNotNone(app.poll())
        self.assertEqual(self.log('open'), [str(self.app)])
        self.assertEqual(self.trash(), [OLD])
        self.assertIn('quitting the app (TERM to pid %d)' % app.pid, lines)

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

    def test_a_session_dropped_before_the_download_still_checks_it_and_swaps(self):
        self.dropped_after('installed app:')

    def test_a_session_dropped_after_the_download_still_quits_the_app_and_swaps(self):
        self.dropped_after('downloaded the release zip')

    def test_a_session_dropped_after_the_unpack_still_quits_the_app_and_swaps(self):
        self.dropped_after('unpacked ')

    def shipit_on_quit(self, app, staged, waiting=False, relaunch=False):
        """Squirrel's ShipIt, run from the app's own framework: once the app quits, it swaps in `staged`. Squirrel.Mac
        starts it as soon as the app has staged an update (`waiting`: it runs before the quit, waiting for it), and
        with launchAfterInstallation it opens the app again (`relaunch`; the new process goes in self.relaunched)."""
        path = self.app / 'Contents/Frameworks/Squirrel.framework/Resources/ShipIt'
        runner = self.start('ShipIt', path) if waiting else None
        self.relaunched = []

        def shipit():
            nonlocal runner
            app.wait()
            runner = runner or self.start('ShipIt', path)
            time.sleep(1 if relaunch else 0.5)  # The script sees the quit before anything opens the app again.
            os.rename(str(self.app), str(self.fake / 'shipit-previous.app'))
            os.rename(str(staged), str(self.app))
            if relaunch:
                self.relaunched.append(self.start())
            runner.kill()

        thread = threading.Thread(target=shipit, daemon=True)
        thread.start()
        return thread

    def test_shipit_installs_on_quit_and_nothing_is_swapped(self):
        make_app(self.app, OLD)
        staged = make_app(self.fake / 'staged' / 'SpecWithCode.app', NEW)
        self.serve()
        thread = self.shipit_on_quit(self.start(), staged)
        code, lines = self.run_script(SWC_SHIPIT_GRACE='3')
        thread.join(10)
        self.assertEqual(code, 0, lines)
        self.assertEqual(self.result(lines), {'before': OLD, 'after': NEW, 'how': 'updater-on-quit', 'relaunched': 'yes'})
        self.assertTrue(any(line.startswith('waiting for its own updater (ShipIt, pid') for line in lines), lines)
        self.assertEqual(self.trash(), [])
        self.assertEqual(self.leftovers(), [])
        self.assertEqual(self.log('open'), [str(self.app)])

    def test_what_shipit_installed_is_replaced_by_the_checked_copy_when_it_fails_a_check(self):
        make_app(self.app, OLD)
        staged = make_app(self.fake / 'staged' / 'SpecWithCode.app', NEW, gatekeeper='rejected')
        self.serve()
        thread = self.shipit_on_quit(self.start(), staged)
        code, lines = self.run_script(SWC_SHIPIT_GRACE='3')
        thread.join(10)
        self.assertEqual(code, 0, lines)
        self.assertEqual(self.result(lines), {'before': OLD, 'after': NEW, 'how': 'swapped', 'relaunched': 'yes'})
        self.assertIn('the %s its own updater installed is not accepted by Gatekeeper (spctl -a -t exec); swapping in '
                      'the checked copy instead' % NEW, lines)
        self.assertEqual((self.app / 'Contents' / '_fake' / 'gatekeeper').read_text(), 'ok')
        self.assertEqual(self.trash(), [NEW])  # What ShipIt installed.
        self.assertEqual(self.leftovers(), [])
        self.assertEqual(self.log('open'), [str(self.app)])

    def test_a_shipit_waiting_for_the_running_app_to_quit_installs_on_the_quit(self):
        """Squirrel.Mac starts ShipIt once the app has staged an update, and ShipIt then waits for the app to quit."""
        make_app(self.app, OLD)
        staged = make_app(self.fake / 'staged' / 'SpecWithCode.app', NEW)
        self.serve()
        thread = self.shipit_on_quit(self.start(), staged, waiting=True)
        code, lines = self.run_script(SWC_SHIPIT_GRACE='3')
        thread.join(10)
        self.assertEqual(code, 0, lines)
        self.assertEqual(self.result(lines), {'before': OLD, 'after': NEW, 'how': 'updater-on-quit', 'relaunched': 'yes'})
        self.assertTrue(any(re.match(r'its own updater \(ShipIt, pid \d+\) waits for the app to quit', line)
                            for line in lines), lines)
        self.assertEqual(self.trash(), [])
        self.assertEqual(self.leftovers(), [])
        self.assertEqual(self.log('open'), [str(self.app)])

    def test_a_swap_its_own_update_left_stops_the_update_before_the_app_is_quit(self):
        make_app(self.app, OLD)
        make_app(self.apps / 'SpecWithCode.app.studio-update-old', OLD)  # Left by an unsigned build's swap.sh.
        self.serve()
        app = self.start()
        code, lines = self.run_script(SWC_SHIPIT_WAIT='1')
        self.assertEqual(code, 4, lines)
        self.assertIn('its own update swap (%s.studio-update-old exists) still runs' % self.app, self.failure(code, lines))
        self.assertIsNone(app.poll())
        self.assertEqual(self.log('curl'), [])
        self.assertEqual(self.log('open'), [])

    def test_an_app_started_again_during_the_update_is_never_swapped_out(self):
        make_app(self.app, OLD)
        staged = make_app(self.fake / 'staged' / 'SpecWithCode.app', NEW, gatekeeper='rejected')
        self.serve()
        thread = self.shipit_on_quit(self.start(), staged, waiting=True, relaunch=True)
        code, lines = self.run_script(SWC_SHIPIT_GRACE='3')
        thread.join(10)
        self.assertEqual(code, 4, lines)
        self.assertIn('the app started again during the update; nothing was changed', self.failure(code, lines))
        self.assertEqual((self.app / 'Contents' / '_fake' / 'gatekeeper').read_text(), 'rejected')  # ShipIt's copy.
        self.assertEqual(len(self.relaunched), 1)
        self.assertIsNone(self.relaunched[0].poll())
        self.assertEqual(self.trash(), [])
        self.assertEqual(self.leftovers(), [])
        self.assertEqual(self.log('open'), [])

    def test_another_copy_of_the_app_and_another_apps_shipit_are_left_alone(self):
        make_app(self.app, OLD)
        self.serve()
        copy = self.start(path=self.root / 'dev' / 'SpecWithCode.app' / 'Contents' / 'MacOS' / 'SpecWithCode')
        other = self.start('ShipIt', self.root / 'Other.app' / 'Contents/Frameworks/Squirrel.framework/Resources/ShipIt')
        code, lines = self.run_script()
        self.assertEqual(code, 0, lines)
        self.assertEqual(self.result(lines), {'before': OLD, 'after': NEW, 'how': 'swapped', 'relaunched': 'no'})
        self.assertIn('the app is not running', lines)
        self.assertFalse(any('ShipIt' in line for line in lines), lines)
        self.assertIsNone(copy.poll())
        self.assertIsNone(other.poll())
        self.assertEqual(self.log('open'), [])

    def test_an_installed_copy_of_the_version_that_fails_a_check_is_replaced(self):
        make_app(self.app, NEW, requirement='cdhash H"0123"')  # Say, an ad hoc build of the version.
        self.serve()
        code, lines = self.run_script()
        self.assertEqual(code, 0, lines)
        self.assertEqual(self.result(lines), {'before': NEW, 'after': NEW, 'how': 'swapped', 'relaunched': 'no'})
        self.assertIn('the installed %s does not carry the release\'s designated requirement (it has: cdhash H"0123"), '
                      'so the release goes in over it' % NEW, lines)
        self.assertEqual((self.app / 'Contents' / '_fake' / 'requirement').read_text(), REQUIREMENT)
        self.assertEqual(self.trash(), [NEW])
        self.assertEqual(self.leftovers(), [])

    def test_a_bad_signature_requirement_or_gatekeeper_leaves_the_running_app_alone(self):
        for marks, words in (({'signature': 'bad'}, 'fails codesign --verify --deep --strict'),
                             ({'requirement': 'identifier "com.specweave.studio" and anchor apple'},
                              "does not carry the release's designated requirement"),
                             ({'gatekeeper': 'rejected'}, 'is not accepted by Gatekeeper')):
            with self.subTest(marks=marks):
                for path in list(self.apps.iterdir()):
                    os.rename(str(path), str(self.root / ('gone-%f' % time.time())))
                make_app(self.app, OLD)
                self.serve(**marks)
                app = self.start()
                before = self.snapshot(self.apps)
                code, lines = self.run_script()
                self.assertIn(words, self.failure(code, lines))
                self.assertIn('the installed app was left as it was', lines[-1])
                self.assertEqual(self.snapshot(self.apps), before)
                self.assertIsNone(app.poll())  # Checked before the app is quit: it keeps running.
                self.assertEqual(self.log('open'), [])
                app.kill()

    def test_a_zip_whose_app_is_another_version_changes_nothing(self):
        make_app(self.app, OLD)
        self.serve('1.0.39')  # Its sha256 matches; the app inside is not the release.
        app = self.start()
        before = self.snapshot(self.apps)
        code, lines = self.run_script()
        self.assertEqual(code, 5, lines)
        self.assertEqual(self.failure(code, lines), 'FAIL the unpacked %s reports version 1.0.39, not %s; the installed '
                                                    'app was left as it was' % (NEW, NEW))
        self.assertEqual(self.snapshot(self.apps), before)
        self.assertIsNone(app.poll())
        self.assertEqual(self.log('open'), [])

    def test_a_checksum_mismatch_moves_nothing(self):
        make_app(self.app, OLD)
        self.serve()
        app = self.start()
        before = self.snapshot(self.apps)
        code, lines = self.run_script(sha='0' * 64)
        self.assertIn("the downloaded zip's sha256 is %s, not %s" % (self.served, '0' * 64), self.failure(code, lines))
        self.assertEqual(self.snapshot(self.apps), before)
        self.assertEqual(list(self.cache.glob('SpecWithCode-*')), [])  # No .part is left either.
        self.assertIsNone(app.poll())
        self.assertEqual(self.log('open'), [])

    def test_a_failed_download_moves_nothing(self):
        make_app(self.app, OLD)
        self.serve()
        (self.fake / 'curl.fail').write_text('')
        before = self.snapshot(self.apps)
        code, lines = self.run_script()
        self.assertIn('could not download https://github.com/', self.failure(code, lines))
        self.assertEqual(self.snapshot(self.apps), before)

    def test_an_interrupted_swap_is_repaired_on_the_rerun(self):
        # Stopped between its renames: no app in place, the previous one aside, a partial unpack.
        make_app(self.old, OLD)
        partial = self.apps / ('.SpecWithCode.app-%s-unpack' % NEW) / 'SpecWithCode.app' / 'Contents'
        partial.mkdir(parents=True)
        self.serve()
        code, lines = self.run_script()
        self.assertEqual(code, 0, lines)
        self.assertIn('put the previous app back from %s: an earlier run stopped between its renames' % self.old, lines)
        self.assertEqual(self.result(lines)['how'], 'swapped')
        self.assertEqual(bundle_version(self.app), NEW)
        self.assertEqual(self.trash(), [OLD])
        self.assertEqual(self.leftovers(), [])

    def test_a_swap_stopped_after_the_new_app_went_in_trashes_the_previous_one(self):
        make_app(self.app, NEW)
        make_app(self.old, OLD)
        self.serve()
        code, lines = self.run_script()
        self.assertEqual(code, 0, lines)
        self.assertEqual(self.result(lines)['how'], 'already-current')
        self.assertEqual(self.trash(), [OLD])
        self.assertEqual(self.leftovers(), [])
        self.assertEqual(self.log('curl'), [])

    def test_a_previous_app_that_cannot_go_to_the_trash_is_kept_and_blocks_the_next_swap(self):
        make_app(self.app, OLD)
        self.serve()
        (self.fake / 'trash.fail').write_text('')
        (self.fake / 'finder.fail').write_text('')
        code, lines = self.run_script()
        self.assertEqual(code, 0, lines)
        self.assertIn('WARNING: could not move %s to the Trash; it stays there, and the next run tries again' % self.old,
                      lines)
        self.assertEqual((bundle_version(self.app), bundle_version(self.old)), (NEW, OLD))
        # The next release never renames onto it: it stops before touching the installed app.
        self.serve(NEWER)
        code, lines = self.run_script(NEWER)
        self.assertIn('the previous app of an earlier update is still at %s' % self.old, self.failure(code, lines))
        self.assertEqual(code, 4)
        self.assertEqual((bundle_version(self.app), bundle_version(self.old)), (NEW, OLD))
        self.assertEqual(self.leftovers(), ['SpecWithCode.app.release-old'])

    def test_a_previous_app_stuck_outside_the_trash_stops_the_run_before_the_download_and_the_quit(self):
        make_app(self.app, NEW)
        make_app(self.old, OLD)
        (self.fake / 'trash.fail').write_text('')
        (self.fake / 'finder.fail').write_text('')
        self.serve(NEWER)
        app = self.start()
        code, lines = self.run_script(NEWER)
        self.assertEqual(code, 4, lines)
        self.assertEqual(self.failure(code, lines), 'FAIL the previous app of an earlier update is still at %s (it could '
                                                    'not go to the Trash); move it to the Trash and run this again' % self.old)
        self.assertIsNone(app.poll())  # Never quit, so never reopened.
        self.assertEqual(self.log('curl'), [])
        self.assertEqual(self.log('open'), [])
        self.assertEqual((bundle_version(self.app), bundle_version(self.old)), (NEW, OLD))
        self.assertEqual(self.leftovers(), ['SpecWithCode.app.release-old'])

    def test_finder_moves_it_to_the_trash_without_the_trash_command(self):
        make_app(self.app, OLD)
        self.serve()
        code, lines = self.run_script(SWC_TRASH=str(self.root / 'no-trash-command'))
        self.assertEqual(code, 0, lines)
        self.assertIn('moved the previous app to the Trash (Finder)', lines)
        self.assertEqual(self.log('osascript'), ['-e tell application "Finder" to delete POSIX file "%s"' % self.old])
        self.assertEqual(self.trash(), [OLD])

    def test_a_failed_check_after_the_rename_puts_the_previous_app_back(self):
        make_app(self.app, OLD)
        self.serve()
        (self.fake / 'codesign-fails').write_text(str(self.app) + '\n')
        app = self.start()
        code, lines = self.run_script()
        self.assertIn('after the rename; the previous app is back in place', self.failure(code, lines))
        self.assertEqual(code, 5)  # A check failed, as before the rename; 6 is for a rename that failed.
        self.assertEqual(bundle_version(self.app), OLD)
        self.assertEqual(self.leftovers(), [])
        self.assertEqual(self.trash(), [])
        self.assertIsNotNone(app.poll())
        self.assertEqual(self.log('open'), [str(self.app)])  # It was running: the previous app is open again.

    def test_an_app_that_does_not_quit_stops_the_update(self):
        make_app(self.app, OLD)
        self.serve()
        app = self.start(ignore_term=True)
        before = self.snapshot(self.apps)
        code, lines = self.run_script(SWC_QUIT_WAIT='1')
        self.assertIn('did not quit within 1s; nothing was changed', self.failure(code, lines))
        self.assertEqual(self.snapshot(self.apps), before)
        self.assertIsNone(app.poll())
        self.assertEqual(self.log('open'), [])

    def test_an_own_update_that_keeps_running_stops_the_update(self):
        make_app(self.app, OLD)
        self.serve()
        self.start('ShipIt', self.app / 'Contents/Frameworks/Squirrel.framework/Resources/ShipIt')
        before = self.snapshot(self.apps)
        code, lines = self.run_script(SWC_SHIPIT_WAIT='1')
        self.assertIn('its own updater (ShipIt, pid', self.failure(code, lines))
        self.assertEqual(self.snapshot(self.apps), before)
        self.assertEqual(self.log('curl'), [])

    def test_a_zip_without_the_app_or_room_for_it_changes_nothing(self):
        make_app(self.app, OLD)
        self.serve(folder='Other.app')
        before = self.snapshot(self.apps)
        code, lines = self.run_script()
        self.assertIn('the release zip holds no SpecWithCode.app', self.failure(code, lines))
        self.assertEqual(self.snapshot(self.apps), before)
        self.serve()
        code, lines = self.run_script(SWC_DF=str(self.bin / 'df-full'))
        self.assertIn('MiB free beside', self.failure(code, lines))
        self.assertEqual(self.snapshot(self.apps), before)

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

    def test_a_run_that_cannot_make_its_lock_says_why(self):
        make_app(self.app, OLD)
        self.serve()
        shims = self.root / 'shims'
        shims.mkdir()
        mkdir = shims / 'mkdir'
        # Refuses the folder $REFUSE names with $MKDIR_ERROR, as a full volume or a locked folder refuses it.
        mkdir.write_text('#!/bin/bash\n' + r'''
for arg in "$@"; do
  [ "$arg" != "$REFUSE" ] || { echo "mkdir: $arg: $MKDIR_ERROR" >&2; exit 1; }
done
exec /bin/mkdir "$@"
''')
        mkdir.chmod(0o755)
        # The cache folder first, while the worker has none (its first run, or its backups were removed).
        self.assertFalse(self.cache.exists())
        for folder, made in ((self.cache, 'the update cache'), (self.cache / '.lock', 'the update lock')):
            # No room is exit 5 and says so; any other reason is mkdir's own, with exit 1.
            for error, want, hint in (('No space left on device', 5, '; is the disk full?'),
                                      ('Disc quota exceeded', 5, '; is the disk full?'), ('Permission denied', 1, '')):
                with self.subTest(folder=folder.name, error=error):
                    code, lines = self.run_script(PATH=str(shims) + ':/usr/bin:/bin:/usr/sbin:/sbin',
                                                  REFUSE=str(folder), MKDIR_ERROR=error)
                    self.assertIn('could not make %s (mkdir: %s: %s%s)' % (made, folder, error, hint),
                                  self.failure(code, lines))
                    self.assertEqual(code, want)
                    self.assertEqual(bundle_version(self.app), OLD)
                    self.assertFalse((self.cache / '.lock').exists())

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
if [ "$1" = "$SWC_LOCK_WAIT" ]; then
  : > "$FAKE/lock.waiting"
  n=0
  while [ ! -f "$FAKE/lock.go" ] && [ "$n" -lt 1200 ]; do
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
                shutil.rmtree(str(lock))
                for mark in ('lock.waiting', 'lock.go'):
                    (self.fake / mark).unlink()

    def test_dry_run_changes_nothing(self):
        make_app(self.app, OLD)
        make_app(self.old, OLD)  # A previous app left by a run cut short: reported, not trashed.
        self.serve()
        app = self.start()
        before = self.snapshot(self.apps, self.home)
        code, lines = self.run_script(dry=True)
        self.assertEqual(code, 0, lines)
        self.assertEqual(self.result(lines), {'before': OLD, 'after': OLD, 'how': 'dry-run', 'relaunched': 'no'})
        self.assertEqual(self.snapshot(self.apps, self.home), before)
        self.assertFalse(self.cache.exists())
        self.assertIsNone(app.poll())
        for tool in ('curl', 'open', 'trash', 'osascript'):
            self.assertEqual(self.log(tool), [], tool)
        for words in ('would move %s to the Trash' % self.old, 'would download https://github.com/',
                      'would quit the app (pid %d) and reopen it afterwards' % app.pid):
            self.assertTrue(any(words in line for line in lines), (words, lines))

    def test_bad_values_are_refused_before_anything_runs(self):
        make_app(self.app, OLD)
        self.serve()
        before = self.snapshot(self.apps)
        for version, sha, repo in (('1.0.41; touch pwned', None, REPO), ('1.0', None, REPO), ('01.0.41', None, REPO),
                                   ('1.0.٤١', None, REPO), ('1.0.41\n', None, REPO), (NEW, 'A' * 64, REPO),
                                   (NEW, 'abc', REPO), (NEW, None, 'owner/../x'), (NEW, None, 'owner/x;ls')):
            with self.subTest(version=version, sha=sha, repo=repo):
                code, lines = self.run_script(version, sha=sha, repo=repo)
                self.assertEqual(code, 2, lines)
                self.assertTrue(lines[-1].startswith('FAIL '), lines)
        self.assertEqual(self.snapshot(self.apps), before)
        self.assertFalse((self.root / 'pwned').exists())
        self.assertEqual(self.log('curl'), [])

    def test_the_pinned_requirement_is_the_release_requirement(self):
        """The script's requirement is mac-signature.mjs's expectedRequirement() and the documented text."""
        source = (HERE.parent / 'studio-projects' / 'mac-signature.mjs').read_text()
        bundle = re.search(r'DESKTOP_BUNDLE_ID = "([^"]+)"', source).group(1)
        team = re.search(r'RELEASE_TEAM_ID = "([^"]+)"', source).group(1)
        template = re.search(r'return `(identifier [^`]+)`;', source).group(1)
        expected = template.replace('${DESKTOP_BUNDLE_ID}', bundle).replace('${teamId}', team)
        self.assertEqual(REQUIREMENT, expected)
        self.assertIn(REQUIREMENT, (HERE.parent.parent / 'docs' / 'studio' / 'releasing.md').read_text())


class Orchestrator(Machine):
    """DesktopApps runs the real script through a local `/bin/bash -s` in place of the worker's ssh."""

    def desktop(self, sums, **options):
        options.setdefault('env', self.env())
        return desktop_app_rollout.DesktopApps(NEW, {'m1': ['/bin/bash', '-s']}, repo=REPO, sums=sums, **options)

    def staging(self, listed=None):
        """A release.sh staging folder that published candidate 'ab' * 20."""
        stage = self.root / 'staging' / NEW
        assets = stage / ('assets-' + 'ab' * 6)
        assets.mkdir(parents=True)
        (stage / 'published.sha').write_text('ab' * 20 + '\n')
        (assets / 'SHA256SUMS').write_text('%s  SpecWithCode-%s-arm64.zip\n%s  SpecWithCode-%s-arm64.zip.blockmap\n' % (
            listed or self.served, NEW, '1' * 64, NEW))
        return self.root / 'staging'

    def no_network(self, url):
        raise AssertionError('fetched %s' % url)

    def test_the_worker_app_follows_with_the_staged_sums(self):
        make_app(self.app, OLD)
        self.serve()
        root = self.staging()
        said = []
        result = self.desktop(lambda: desktop_app_rollout.expected_sha256(NEW, REPO, root, self.no_network))('m1', said.append)
        self.assertEqual(result, {'result': 'swapped', 'before': OLD, 'after': NEW, 'relaunched': 'no'})
        self.assertEqual(bundle_version(self.app), NEW)
        self.assertIn('desktop apps: SpecWithCode-%s-arm64.zip %s from %s' % (
            NEW, self.served[:12], root / NEW / ('assets-' + 'ab' * 6) / 'SHA256SUMS'), said)
        self.assertIn('m1: app: swapped %s into %s' % (NEW, self.app), said)
        self.assertEqual(said[-1], 'm1: desktop app %s -> %s: unpacked and checked beside the app, then swapped in'
                         % (OLD, NEW))

    def test_a_sha256_the_zip_does_not_match_fails_with_the_reason(self):
        make_app(self.app, OLD)
        self.serve()
        root = self.staging(listed='f' * 64)
        desktop = self.desktop(lambda: desktop_app_rollout.expected_sha256(NEW, REPO, root, self.no_network))
        with self.assertRaises(desktop_app_rollout.DesktopAppError) as caught:
            desktop('m1', lambda line: None)
        self.assertIn("the downloaded zip's sha256 is %s, not %s" % (self.served, 'f' * 64), str(caught.exception))
        self.assertEqual(bundle_version(self.app), OLD)

    def test_dry_run_reaches_the_script(self):
        make_app(self.app, OLD)
        self.serve()
        before = self.snapshot(self.apps)
        result = self.desktop(lambda: (self.served, 'test'), dry_run=True)('m1', lambda line: None)
        self.assertEqual(result, {'result': 'dry-run', 'before': OLD, 'after': OLD, 'relaunched': 'no'})
        self.assertEqual(self.snapshot(self.apps), before)

    def test_unreachable_host_timeout_and_missing_command(self):
        desktop = desktop_app_rollout.DesktopApps(NEW, {
            'm1': ['/bin/sh', '-c', 'cat > /dev/null; echo "ssh: connect to host m1.test port 22: Connection refused"'
                   ' >&2; exit 255'],
            'm3': ['/bin/sleep', '30']}, repo=REPO, sums=lambda: ('a' * 64, 'test'), timeout=1)
        with self.assertRaises(desktop_app_rollout.DesktopAppError) as caught:
            desktop('m1', lambda line: None)
        self.assertEqual(str(caught.exception),
                         'could not be reached over ssh: ssh: connect to host m1.test port 22: Connection refused')
        began = time.time()
        with self.assertRaises(desktop_app_rollout.DesktopAppError) as caught:
            desktop('m3', lambda line: None)
        self.assertLess(time.time() - began, 20)
        self.assertIn('did not finish within 1 s, so its ssh session was stopped', str(caught.exception))
        with self.assertRaises(desktop_app_rollout.DesktopAppError) as caught:
            desktop('m9', lambda line: None)
        self.assertIn('no ssh command for m9', str(caught.exception))

    def test_an_answer_that_does_not_put_the_version_in_is_refused(self):
        def answer(line, dry_run=False):
            command = ['/bin/sh', '-c', 'cat > /dev/null; printf "%s\\n" "$0"', line]
            return desktop_app_rollout.DesktopApps(NEW, {'m1': command}, repo=REPO, sums=lambda: ('a' * 64, 'test'),
                                                   dry_run=dry_run)('m1', lambda said: None)

        for line, dry_run in (('RESULT before=%s after=1.0.39 how=swapped relaunched=no' % OLD, False),
                              ('RESULT before=%s after=%s how=updater-on-quit relaunched=yes' % (OLD, OLD), False),
                              ('RESULT before=%s after=%s how=already-current relaunched=no' % (OLD, OLD), False),
                              ('RESULT before=%s after=%s how=dry-run relaunched=no' % (OLD, NEW), True),
                              ('RESULT before=%s after=%s how=renamed relaunched=no' % (OLD, NEW), False)):
            with self.subTest(line=line):
                with self.assertRaises(desktop_app_rollout.DesktopAppError) as caught:
                    answer(line, dry_run)
                self.assertEqual(str(caught.exception), 'gave an unexpected answer: ' + line)
        self.assertEqual(answer('RESULT before=%s after=%s how=swapped relaunched=no' % (OLD, NEW)),
                         {'result': 'swapped', 'before': OLD, 'after': NEW, 'relaunched': 'no'})
        self.assertEqual(answer('RESULT before=%s after=%s how=dry-run relaunched=no' % (OLD, OLD), True),
                         {'result': 'dry-run', 'before': OLD, 'after': OLD, 'relaunched': 'no'})

    def test_the_preamble_carries_only_checked_values(self):
        desktop = desktop_app_rollout.DesktopApps(NEW, {}, repo=REPO, sums=lambda: ('a' * 64, 'test'))
        program = desktop.program('a' * 64)
        self.assertTrue(program.startswith('V=%s\nSHA=%s\nREPO=%s\nDRY_RUN=0\n#!/bin/bash\n' % (NEW, 'a' * 64, REPO)))
        self.assertTrue(program.endswith('main "$@" < /dev/null\n'))
        for version in ('1.0.41;rm -rf ~', '1.0.٤١', '1.0', ' 1.0.41', '1.0.41\n', None):
            with self.subTest(version=version):
                with self.assertRaises(desktop_app_rollout.DesktopAppError):
                    desktop_app_rollout.DesktopApps(version, {}, repo=REPO)
        for repo in ('a/b c', 'a/../b', '$(id)/x', 'a'):
            with self.assertRaises(desktop_app_rollout.DesktopAppError):
                desktop_app_rollout.DesktopApps(NEW, {}, repo=repo)
        with self.assertRaises(desktop_app_rollout.DesktopAppError):
            desktop.program('A' * 64)
        # A resolver's bad answer is refused once and for both workers.
        calls = []
        bad = desktop_app_rollout.DesktopApps(NEW, {'m1': ['/bin/false']}, repo=REPO,
                                              sums=lambda: calls.append(1) or ('nope', 'test'))
        for _ in range(2):
            with self.assertRaises(desktop_app_rollout.DesktopAppError):
                bad('m1', lambda line: None)
        self.assertEqual(calls, [1])


class ExpectedSha256(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = pathlib.Path(folder.name)
        self.fetched = []

    def sums(self, text):
        def fetch(url):
            self.fetched.append(url)
            if isinstance(text, Exception):
                raise text
            return text.encode() if isinstance(text, str) else text
        return fetch

    def test_the_staging_folder_comes_first(self):
        stage = self.root / NEW
        (stage / ('assets-' + 'c' * 12)).mkdir(parents=True)
        (stage / 'published.sha').write_text('c' * 40 + '\n')
        (stage / ('assets-' + 'c' * 12) / 'SHA256SUMS').write_text('%s  SpecWithCode-%s-arm64.zip\n' % ('D' * 64, NEW))
        sha, source = desktop_app_rollout.expected_sha256(NEW, REPO, self.root, self.sums(AssertionError('no fetch')))
        self.assertEqual((sha, source), ('d' * 64, str(stage / ('assets-' + 'c' * 12) / 'SHA256SUMS')))
        self.assertEqual(self.fetched, [])

    def test_without_one_the_public_release_is_read(self):
        for published in (None, 'not-a-sha'):
            with self.subTest(published=published):
                if published:
                    (self.root / NEW).mkdir(exist_ok=True)
                    (self.root / NEW / 'published.sha').write_text(published)
                fetch = self.sums('%s *SpecWithCode-%s-arm64.zip\n\n%s  other\n' % ('e' * 64, NEW, '1' * 64))
                sha, source = desktop_app_rollout.expected_sha256(NEW, REPO, self.root, fetch)
                url = 'https://github.com/%s/releases/download/v%s/SHA256SUMS' % (REPO, NEW)
                self.assertEqual((sha, source), ('e' * 64, url))
                self.assertEqual(self.fetched[-1], url)

    def test_bad_or_missing_sums_are_refused(self):
        line = '%s  SpecWithCode-%s-arm64.zip\n' % ('e' * 64, NEW)
        for answer, words in (
                ('%s  other.zip\n' % ('e' * 64), 'does not list SpecWithCode-%s-arm64.zip' % NEW),
                (line + line, 'lists SpecWithCode-%s-arm64.zip twice' % NEW),
                ('nonsense\n', 'has a malformed line'),
                (b'\xff\xfe', 'is not UTF-8'),
                (line + ' ' * (300 << 10), 'is larger than 256 KiB'),
                (urllib.error.HTTPError('u', 404, 'Not Found', {}, None), 'v%s has no SHA256SUMS on %s' % (NEW, REPO)),
                (urllib.error.HTTPError('u', 500, 'Server Error', {}, None), '(HTTP 500)'),
                (urllib.error.URLError('down'), '(URLError)')):
            with self.subTest(words=words):
                with self.assertRaises(desktop_app_rollout.DesktopAppError) as caught:
                    desktop_app_rollout.expected_sha256(NEW, REPO, self.root, self.sums(answer))
                self.assertIn(words, str(caught.exception))

    def test_bad_values_are_refused_before_any_fetch(self):
        for version, repo in (('1.0.41/../x', REPO), (NEW, 'evil/../repo'), (NEW, 'a b/c')):
            with self.assertRaises(desktop_app_rollout.DesktopAppError):
                desktop_app_rollout.expected_sha256(version, repo, self.root, self.sums(AssertionError('no fetch')))
        self.assertEqual(self.fetched, [])

    def test_a_redirect_away_from_https_is_refused(self):
        handler = desktop_app_rollout._HttpsOnly()
        with self.assertRaises(desktop_app_rollout.DesktopAppError):
            handler.redirect_request(None, None, 302, 'Found', {}, 'http://example.test/SHA256SUMS')


class FakeDesktop(object):
    """The desktop step, recording the last status each worker's service reported before it ran."""

    def __init__(self, fleet, fail=(), crash=()):
        self.fleet, self.fail, self.crash = fleet, set(fail), set(crash)
        self.calls = []

    def __call__(self, identity, say):
        with self.fleet.lock:
            statuses = [entry[2] for entry in self.fleet.log if entry[0] == identity and entry[1] == 'status']
            self.calls.append((identity, statuses[-1] if statuses else None))
        if identity in self.crash:
            raise ValueError('boom')
        if identity in self.fail:
            raise desktop_app_rollout.DesktopAppError('the app (pid 42) did not quit within 60s; nothing was changed')
        return {'result': 'swapped', 'before': OLD, 'after': NEW, 'relaunched': 'no'}


class RolloutWithApps(unittest.TestCase):
    def roll(self, fleet, clock, desktop, **options):
        return fleet_rollout.rollout(NEW, fleet.hosts(), clock=clock, sleep=clock.sleep, say=lambda line: None,
                                     desktop=desktop, **options)

    def test_each_worker_app_follows_its_confirmed_service_and_m4_has_none(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m4': 1, 'm1': 2, 'm3': 4})
        desktop = FakeDesktop(fleet)
        results = self.roll(fleet, clock, desktop)
        self.assertEqual(sorted(desktop.calls), [('m1', NEW), ('m3', NEW)])
        for identity in ('m1', 'm3'):
            self.assertEqual(results[identity]['result'], 'installed')
            self.assertEqual(results[identity]['desktopApp']['result'], 'swapped')
        self.assertNotIn('desktopApp', results['m4'])

    def test_a_worker_already_on_the_version_still_gets_its_app(self):
        clock = Clock()
        fleet = Fleet(clock)
        fleet.version.update({'m4': NEW, 'm1': NEW, 'm3': NEW})
        desktop = FakeDesktop(fleet)
        results = self.roll(fleet, clock, desktop, only='workers')
        self.assertEqual(sorted(desktop.calls), [('m1', NEW), ('m3', NEW)])
        self.assertEqual(results['m1']['result'], 'already-installed')

    def test_only_m4_or_no_desktop_step_touches_no_app(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m4': 1})
        desktop = FakeDesktop(fleet)
        self.roll(fleet, clock, desktop, only='m4')
        self.assertEqual(desktop.calls, [])
        clock = Clock()
        results = self.roll(Fleet(clock), clock, None)
        self.assertFalse(any('desktopApp' in result for result in results.values()))

    def test_a_failed_app_fails_the_rollout_after_every_service(self):
        for fail, crash, words in ((('m1',), (), 'm1: desktop app not updated to %s: the app (pid 42) did not quit'),
                                   ((), ('m1',), 'm1: desktop app not updated to %s: stopped on an unexpected '
                                                 'ValueError: boom')):
            with self.subTest(fail=fail, crash=crash):
                clock = Clock()
                fleet = Fleet(clock, polls={'m1': 1, 'm3': 6})
                desktop = FakeDesktop(fleet, fail, crash)
                with self.assertRaises(fleet_rollout.DesktopAppsFailed) as caught:
                    self.roll(fleet, clock, desktop)
                self.assertIn(words % NEW, str(caught.exception))
                self.assertEqual(fleet.version, {'m4': NEW, 'm1': NEW, 'm3': NEW})
                results = caught.exception.results
                self.assertEqual(results['m1']['desktopApp']['result'], 'failed')
                self.assertEqual(results['m3']['desktopApp']['result'], 'swapped')

    def test_a_worker_whose_service_failed_gets_no_app_step(self):
        clock = Clock()
        fleet = Fleet(clock, polls={'m1': 1, 'm3': 1})
        fleet.available['m1'] = '9.9.9'
        desktop = FakeDesktop(fleet)
        with self.assertRaises(fleet_rollout.RolloutError) as caught:
            self.roll(fleet, clock, desktop)
        self.assertNotIsInstance(caught.exception, fleet_rollout.DesktopAppsFailed)
        self.assertIn('m1 is offered 9.9.9', str(caught.exception))
        self.assertEqual(desktop.calls, [('m3', NEW)])


class MainWithApps(unittest.TestCase):
    def setUp(self):
        # release.sh's overrides (a rehearsal exports RELEASE_PUBLIC_REPO for a scratch mirror) never decide a test.
        environment = unittest.mock.patch.dict(os.environ)
        environment.start()
        self.addCleanup(environment.stop)
        for name in ('RELEASE_PUBLIC_REPO', 'RELEASE_STAGING_ROOT'):
            os.environ.pop(name, None)
        self.saved = fleet_rollout.rollout, fleet_rollout.fleet
        self.addCleanup(self.restore)
        self.seen = []
        fleet_rollout.fleet = lambda: {'m1': fleet_rollout.Host('m1', ['ssh', 'm1', 'python'],
                                                                app_command=['ssh', 'm1', '/bin/bash -s']),
                                       'm3': fleet_rollout.Host('m3', ['ssh', 'm3', 'python'],
                                                                app_command=['ssh', 'm3', '/bin/bash -s'])}

    def restore(self):
        fleet_rollout.rollout, fleet_rollout.fleet = self.saved

    def main(self, *argv, error=None):
        def rollout(version, hosts, *args, **options):
            self.seen.append(options.get('desktop'))
            if error:
                raise error
            return {}

        fleet_rollout.rollout = rollout
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = fleet_rollout.main(['--version', NEW, '--no-hold'] + list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_the_desktop_step_is_on_for_workers_unless_turned_off(self):
        self.assertEqual(self.main('--only', 'workers')[0], 0)
        desktop = self.seen[-1]
        self.assertIsInstance(desktop, desktop_app_rollout.DesktopApps)
        self.assertEqual(desktop.commands, {'m1': ['ssh', 'm1', '/bin/bash -s'], 'm3': ['ssh', 'm3', '/bin/bash -s']})
        self.assertEqual((desktop.version, desktop.repo), (NEW, REPO))
        self.assertEqual(self.main('--only', 'workers', '--no-desktop-apps')[0], 0)
        self.assertIsNone(self.seen[-1])
        self.assertEqual(self.main('--only', 'm4')[0], 0)
        self.assertIsNone(self.seen[-1])

    def test_a_failed_app_exits_non_zero_naming_the_host(self):
        failed = fleet_rollout.DesktopAppsFailed('m3: desktop app not updated to %s: the app did not quit' % NEW,
                                                 {'m3': {'result': 'installed', 'desktopApp': {'result': 'failed'}}})
        code, out, err = self.main('--only', 'workers', error=failed)
        self.assertEqual(code, 1)
        self.assertIn('every service is on %s, but m3: desktop app not updated' % NEW, err)
        self.assertEqual(json.loads(out)['hosts']['m3']['desktopApp']['result'], 'failed')

    def test_dry_run_lists_the_app_commands_over_the_pinned_ssh(self):
        with tempfile.TemporaryDirectory() as temporary:
            inventory = pathlib.Path(temporary) / 'hosts.json'
            inventory.write_text(json.dumps({'m1': {'host': 'a.test', 'user': 'u'}, 'm3': {'host': 'b.test', 'user': 'v'}}))
            env = dict(os.environ, STUDIO_FLEET_HOSTS=str(inventory), HOME=temporary)
            env.pop('RELEASE_STAGING_ROOT', None)
            env.pop('RELEASE_PUBLIC_REPO', None)
            plans = [subprocess.run([sys.executable, '-B', str(HERE / 'fleet_rollout.py'), '--version', NEW,
                                     '--dry-run', '--only', 'workers'] + extra, capture_output=True, text=True,
                                    timeout=60, env=env) for extra in ([], ['--no-desktop-apps'])]
        for plan in plans:
            self.assertEqual(plan.returncode, 0, plan.stderr)
        plan = json.loads(plans[0].stdout)
        apps = plan['desktopApps']
        self.assertEqual(apps['sums'], 'https://github.com/%s/releases/download/v%s/SHA256SUMS' % (REPO, NEW))
        for identity, login in (('m1', 'u@a.test'), ('m3', 'v@b.test')):
            self.assertEqual(apps['commands'][identity][-2:], [login, '/bin/bash -s'])
            self.assertEqual(apps['commands'][identity][:-1], plan['commands'][identity][:-1])
        self.assertIsNone(json.loads(plans[1].stdout)['desktopApps'])


if __name__ == '__main__':
    unittest.main()
