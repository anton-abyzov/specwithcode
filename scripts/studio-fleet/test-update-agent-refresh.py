#!/usr/bin/env python3
"""Update agent tests for keeping every Mac's agent current: each copy of the agent ships the
release it belongs to, install_launch_agent never puts an older copy over a newer recorded agent,
and update_request.refresh_agent installs a release's agent after every verified install
(update.py) and before every fleet request. Reuses test-update-agent.py's temporary homes.

Run: cd scripts/studio-fleet && python3 -B test-update-agent-refresh.py
Nothing here touches a real Studio home or launchd: launchctl is a stub and no test runs a real
installer.
"""
import contextlib
import fcntl
import hashlib
import importlib.util
import inspect
import io
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import fleet_rollout  # noqa: E402
import update_agent  # noqa: E402
import update_request  # noqa: E402


def _tests(name, path):
    spec = importlib.util.spec_from_file_location(name, str(HERE / path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


AgentCase = _tests('agent_tests_for_refresh', 'test-update-agent.py').AgentCase
rollout_tests = _tests('rollout_tests_for_refresh', 'test-fleet-rollout.py')
LABEL = 'com.specweave.studio.m4.updater'
# The modules install_launch_agent copies from their own paths (managed_updates.py and
# migrate_home.py from the agent's folder): a test points each at the copy it installs.
MODULES = ('update_agent', 'update_agent_reap', 'update_agent_cache', 'update_request', 'update_agent_recovery',
           'installation_descriptor', 'studio_paths', 'update_agent_run')


def sha256(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def write_record(folder, version, files=None):
    record = {'schemaVersion': 1, 'version': version}
    if files is not None:
        record['files'] = files
    (pathlib.Path(folder) / update_request.AGENT_RECORD).write_text(json.dumps(record))


class RecordedInstall(AgentCase):
    """install_launch_agent records the release it installed and never installs an older copy."""

    def setUp(self):
        super().setUp()
        self.updater = self.home / '.specwithcode/install/updater'
        self.calls = []
        for patcher in (mock.patch.object(update_agent, 'launchctl', self.launchctl),
                        mock.patch.object(update_agent, 'current_uid', return_value=501)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def launchctl(self, args, output=None):
        self.calls.append(list(args))
        return 0

    def copy(self, version, mark=None):
        """A copy of the agent as a release ships it, with its record unless `version` is None.
        `mark` changes every file, so the installed files show which copy won."""
        folder = pathlib.Path(tempfile.mkdtemp(dir=str(self.home)))
        for name in update_request.AGENT_FILES:
            shutil.copyfile(str(HERE / name), str(folder / name))
            if mark:
                with open(str(folder / name), 'a') as handle:
                    handle.write('# %s\n' % mark)
        if version is not None:
            write_record(folder, version)
        return folder

    def install(self, folder=None, busy=False):
        """install_launch_agent run as the copy in `folder` (the checkout's when None), while a
        pass holds the agent lock when `busy`."""
        self.log = ''
        with contextlib.ExitStack() as stack:
            for module in MODULES:
                stack.enter_context(mock.patch.object(sys.modules[module], '__file__', str((folder or HERE) / (module + '.py'))))
            if busy:
                self.updates.mkdir(mode=0o700, exist_ok=True)
                holder = os.open(str(self.updates / 'agent.lock'), os.O_RDWR | os.O_CREAT, 0o600)
                stack.callback(os.close, holder)
                fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.run_agent('--install-launch-agent'), 0, self.log)
        return json.loads(self.log.strip().splitlines()[-1])

    def installed(self):
        return {name: (self.updater / name).read_bytes() for name in update_request.AGENT_FILES}

    def record(self):
        return json.loads((self.updater / update_request.AGENT_RECORD).read_text())

    def test_a_release_copy_installs_and_records_its_release_and_files(self):
        folder = self.copy('1.0.70', mark='1.0.70')
        self.assertEqual(self.install(folder)['result'], 'installed')
        self.assertEqual(self.installed(), {name: (folder / name).read_bytes() for name in update_request.AGENT_FILES})
        self.assertEqual(self.record(), {'schemaVersion': 1, 'version': '1.0.70', 'files': {
            name: sha256(self.updater / name) for name in update_request.AGENT_FILES}})
        self.assertEqual(stat.S_IMODE((self.updater / update_request.AGENT_RECORD).stat().st_mode), 0o600)
        self.assertEqual(update_request.agent_release(self.updater, installed=True), '1.0.70')
        record = self.record()
        self.assertEqual(self.install(folder)['result'], 'unchanged')
        self.assertEqual(self.record(), record)

    def test_an_older_copy_never_replaces_a_newer_agent(self):
        self.install(self.copy('1.0.80', mark='1.0.80'))
        before, record = self.installed(), self.record()
        self.assertEqual(self.install(self.copy('1.0.70', mark='1.0.70'))['result'], 'unchanged')
        self.assertEqual(self.install(self.copy('1.0.70', mark='1.0.70'), busy=True),
                         {'result': 'busy', 'written': False, 'label': LABEL})
        self.assertEqual(self.installed(), before)
        self.assertEqual(self.record(), record)

    def test_a_newer_copy_replaces_an_older_agent_even_while_a_pass_runs(self):
        for busy in (False, True):
            self.install(self.copy('1.0.60', mark='1.0.60'))
            del self.calls[:]
            newer = self.copy('1.0.70', mark='1.0.70-%s' % busy)
            reply = self.install(newer, busy=busy)
            self.assertEqual(reply, {'result': 'busy', 'written': True, 'label': LABEL} if busy else
                             {'result': 'installed', 'label': LABEL})
            self.assertEqual(self.installed(), {name: (newer / name).read_bytes() for name in update_request.AGENT_FILES})
            self.assertEqual(update_request.agent_release(self.updater, installed=True), '1.0.70')
            if busy:
                self.assertEqual(self.calls, [])  # No bootout: it would stop the pass.

    def test_a_change_to_the_cache_module_alone_counts_as_written(self):
        # A running pass imported the old module, so a request waits for that pass as for any change.
        for busy, older, newer in ((True, '1.0.60', '1.0.70'), (False, '1.0.80', '1.0.90')):
            self.install(self.copy(older, mark=older))
            copy = self.copy(newer, mark=older)
            with open(str(copy / 'update_agent_cache.py'), 'a') as handle:
                handle.write('# only %s changed this\n' % newer)
            self.assertEqual(self.install(copy, busy=busy), {'result': 'busy', 'written': True, 'label': LABEL} if busy
                             else {'result': 'installed', 'label': LABEL})
            self.assertEqual(self.installed(), {name: (copy / name).read_bytes() for name in update_request.AGENT_FILES})

    def test_a_mix_of_two_copies_is_never_recorded(self):
        # Two installers at once: the other one wrote a module after this one, which records.
        mine, other = self.copy('1.0.70', mark='1.0.70'), self.copy('1.0.71', mark='1.0.71')
        self.install(mine)
        shutil.copyfile(str(other / 'update_request.py'), str(self.updater / 'update_request.py'))
        self.assertIsNone(update_request.record_agent(mine, self.updater))
        self.assertFalse((self.updater / update_request.AGENT_RECORD).exists())
        self.assertIsNone(update_request.agent_release(self.updater, installed=True))

    def test_an_agent_changed_since_its_record_is_replaced(self):
        # An older desktop app writes no record: its copy over a recorded agent leaves a record that
        # no longer holds, and any release then replaces that agent.
        for name in ('update_agent.py', 'update_request.py', 'update_agent_cache.py'):
            self.install(self.copy('1.0.80', mark='1.0.80'))
            (self.updater / name).write_bytes(b'# an older desktop copy\n')
            self.assertIsNone(update_request.agent_release(self.updater, installed=True), name)
            older = self.copy('1.0.70', mark='1.0.70')
            self.assertEqual(self.install(older)['result'], 'installed', name)
            self.assertEqual(self.installed(), {name: (older / name).read_bytes() for name in update_request.AGENT_FILES})
            self.assertEqual(self.record()['version'], '1.0.70')
            (self.updater / 'update_agent.py').unlink()  # Starts the next round from a missing agent.

    def test_a_copy_of_no_release_installs_and_drops_the_record(self):
        self.assertFalse((HERE / update_request.AGENT_RECORD).exists())
        self.install(self.copy('1.0.80', mark='1.0.80'))
        self.assertEqual(self.install()['result'], 'installed')  # The checkout's own copy.
        self.assertEqual(self.installed(), {name: (HERE / name).read_bytes() for name in update_request.AGENT_FILES})
        self.assertFalse((self.updater / update_request.AGENT_RECORD).exists())
        self.assertEqual(self.install(self.copy('1.0.60', mark='1.0.60'))['result'], 'installed')
        self.assertEqual(self.record()['version'], '1.0.60')

    def test_a_record_may_list_files_a_newer_release_added(self):
        self.install(self.copy('1.0.80', mark='1.0.80'))
        added = self.updater / 'update_agent_later.py'
        added.write_bytes(b'# a module 1.0.80 added\n')
        record = self.record()
        record['files']['update_agent_later.py'] = sha256(added)
        write_record(self.updater, '1.0.80', record['files'])
        before = self.installed()
        self.assertEqual(self.install(self.copy('1.0.70', mark='1.0.70'))['result'], 'unchanged')
        self.assertEqual(self.installed(), before)
        added.write_bytes(b'# changed since\n')
        self.assertEqual(self.install(self.copy('1.0.70', mark='1.0.70'))['result'], 'installed')
        self.assertEqual(self.record()['version'], '1.0.70')

    def test_records_that_cannot_be_trusted_name_no_release(self):
        self.install(self.copy('1.0.80'))
        good, path = self.record(), self.updater / update_request.AGENT_RECORD
        files = good['files']
        outside, hidden = self.updater.parent / 'outside.py', self.updater / '.hidden.py'
        for extra in (outside, hidden):
            extra.write_bytes(b'# present, but never part of an agent\n')
        for bad in (dict(good, schemaVersion=2), dict(good, version='v1.0.80'), dict(good, version='1.0.80-dev.1'),
                    dict(good, version=None), dict(good, files=None), dict(good, files=sorted(files)),
                    dict(good, files={name: files[name] for name in files if name != 'update_agent.py'}),
                    dict(good, files=dict(files, **{'../outside.py': sha256(outside)})),
                    dict(good, files=dict(files, **{str(outside): sha256(outside)})),
                    dict(good, files=dict(files, **{'install/../outside.py': sha256(outside)})),
                    dict(good, files=dict(files, **{'.hidden.py': sha256(hidden)})),
                    dict(good, files=dict(files, update_agent_later=files['update_agent.py'])),
                    dict(good, files=dict(files, **{'update_agent.py': None}))):
            path.write_text(json.dumps(bad))
            self.assertIsNone(update_request.agent_release(self.updater, installed=True), bad)
        for text in ('{', '[]', ''):
            path.write_text(text)
            self.assertIsNone(update_request.agent_release(self.updater, installed=True), text)
        path.unlink()
        path.symlink_to(self.copy('1.0.80') / update_request.AGENT_RECORD)
        self.assertIsNone(update_request.agent_release(self.updater))
        path.unlink()
        path.write_text(json.dumps(good))
        self.assertEqual(update_request.agent_release(self.updater, installed=True), '1.0.80')
        # A release's own copy lists no files; only the installed agent's record must.
        self.assertEqual(update_request.agent_release(self.copy('1.0.70')), '1.0.70')
        self.assertIsNone(update_request.agent_release(self.copy('1.0.70'), installed=True))
        self.assertIsNone(update_request.agent_release(self.copy(None)))


class Refresh(unittest.TestCase):
    """refresh_agent runs a release's installer unless the Mac's agent is as new, and never raises."""
    RELEASE = 'e' * 20

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = pathlib.Path(temporary.name).resolve()
        self.install = self.home / '.specwithcode' / 'install'
        self.updater = self.install / 'updater'
        self.release = self.install / 'releases' / self.RELEASE
        self.shipped = self.release / 'studio-updater'
        for folder in (self.updater, self.shipped):
            folder.mkdir(parents=True)
            (folder / 'update_agent.py').write_bytes(b'# an agent\n')
        write_record(self.shipped, '1.0.70')
        self.plist = self.home / 'Library' / 'LaunchAgents' / (LABEL + '.plist')
        self.plist.parent.mkdir(parents=True)
        self.plist.write_bytes(b'<plist/>\n')
        self.runs = []
        self.reply = (0, '{"result": "installed", "label": "%s"}\n' % LABEL)

    def fake_run(self, command, **options):
        self.runs.append((command, options))
        code, stdout = self.reply
        return types.SimpleNamespace(returncode=code, stdout=stdout.encode())

    def refresh(self, release=None, run=None, wait=0):
        return update_request.refresh_agent(self.home, 'm4', release or self.release, run=run or self.fake_run, wait=wait)

    def record_installed(self, version):
        write_record(self.updater, version, {'update_agent.py': sha256(self.updater / 'update_agent.py')})

    def test_an_older_or_unrecorded_agent_gets_the_release_installer(self):
        for installed in (None, '1.0.60', '1.0.69'):
            if installed:
                self.record_installed(installed)
            del self.runs[:]
            self.assertEqual(self.refresh(), 'installed', installed)
            self.assertEqual(self.runs, [(['/usr/bin/python3', '-B', str(self.shipped / 'update_agent.py'), '--identity', 'm4',
                                           '--install-launch-agent', '--home', str(self.home)],
                                          {'stdin': subprocess.DEVNULL, 'stdout': subprocess.PIPE,
                                           'stderr': subprocess.DEVNULL, 'timeout': 60})])
        for line, word in (('{"result": "unchanged", "label": "%s"}' % LABEL, 'unchanged'),
                           ('{"result": "busy", "written": true, "label": "%s"}' % LABEL, 'busy')):
            self.reply = (0, 'update-agent m4: a note\n%s\n\n' % line)
            self.assertEqual(self.refresh(), word)

    def test_the_real_home_needs_no_home_argument(self):
        with mock.patch.object(update_request.pathlib.Path, 'home', return_value=self.home):
            self.assertEqual(self.refresh(), 'installed')
        self.assertEqual(self.runs[0][0][-1], '--install-launch-agent')

    def test_an_agent_changed_since_a_newer_record_gets_the_release_installer(self):
        # An older desktop app copied its agent over the one 1.0.80 recorded: it names no release now.
        self.record_installed('1.0.80')
        (self.updater / 'update_agent.py').write_bytes(b'# an older desktop copy\n')
        self.assertEqual(self.refresh(), 'installed')
        self.assertEqual(len(self.runs), 1)

    def test_a_pass_of_the_old_agent_gets_time_to_end_before_a_request(self):
        # The pass would take on a request written meanwhile with the agent it started with.
        waits, ended = [], [True]

        def wait_for_pass(home, identity, until):
            waits.append((home, identity, until))
            return ended[0]
        self.reply = (0, '{"result": "busy", "written": true, "label": "%s"}\n' % LABEL)
        with mock.patch.object(update_request, 'wait_for_pass', wait_for_pass):
            self.assertEqual(self.refresh(), 'busy')  # update.py's: its own pass holds the lock.
            self.assertEqual(waits, [])
            before = time.monotonic()
            self.assertEqual(self.refresh(wait=60), 'installed')
            after = time.monotonic()
            self.assertEqual(waits[0][:2], (self.home, 'm4'))
            self.assertTrue(before + 60 <= waits[0][2] <= after + 60, (before, waits[0][2], after))
            ended[0] = False
            self.assertEqual(self.refresh(wait=60), 'busy')
            del waits[:]
            for line in ('{"result": "busy", "written": false, "label": "%s"}' % LABEL, '{"result": "busy"}'):
                self.reply = (0, line + '\n')  # Nothing written: the pass runs the same agent.
                self.assertEqual(self.refresh(wait=60), 'unchanged', line)
            self.assertEqual(waits, [])

    def test_an_identity_without_its_launch_agent_gets_none(self):
        # The agent's files serve every identity of the OS user, but each has its own launchd job: an
        # identity whose job was never installed or was removed (--uninstall-launch-agent) gets none.
        self.assertEqual(update_request.refresh_agent(self.home, 'm1', self.release, run=self.fake_run), 'absent')
        self.plist.unlink()
        self.assertEqual(self.refresh(), 'absent')
        self.plist.mkdir()
        self.assertEqual(self.refresh(), 'absent')
        self.assertEqual(self.runs, [])

    def test_an_agent_of_that_release_or_a_newer_one_is_current(self):
        for installed in ('1.0.70', '1.0.71', '1.1.0', '2.0.0'):
            self.record_installed(installed)
            self.assertEqual(self.refresh(), 'current', installed)
        self.assertEqual(self.runs, [])

    def test_nothing_is_refreshed_without_an_installed_agent_or_a_recorded_release(self):
        # 1.0.66 and older ship no record: their installer has no guard against an older agent.
        (self.shipped / update_request.AGENT_RECORD).unlink()
        self.assertEqual(self.refresh(), 'absent')
        for version in ('1.0.70-dev.20261021', 'latest'):
            write_record(self.shipped, version)
            self.assertEqual(self.refresh(), 'absent', version)
        write_record(self.shipped, '1.0.70')
        elsewhere = self.home / 'elsewhere' / self.RELEASE
        shutil.copytree(str(self.release), str(elsewhere))
        self.assertEqual(self.refresh(elsewhere), 'absent')
        link = self.install / 'releases' / 'link'
        link.symlink_to(self.release)
        self.assertEqual(self.refresh(link), 'absent')
        self.assertEqual(self.refresh(self.install / 'releases' / 'missing'), 'absent')
        (self.updater / 'update_agent.py').unlink()  # Never sets up an agent where none is installed.
        self.assertEqual(self.refresh(), 'absent')
        self.assertEqual(self.runs, [])

    def test_installer_failures_are_reported_and_never_raised(self):
        for reply, word in (((update_request.DISABLED_EXIT, '{"result": "disabled"}\n'), 'disabled'),
                            ((1, ''), 'failed'), ((1, '{"result": "installed"}\n'), 'failed'), ((0, ''), 'failed'),
                            ((0, 'not json\n'), 'failed'), ((0, '{"result": "disabled"}\n'), 'failed'),
                            ((0, '["installed"]\n'), 'failed'), ((0, '{"result": "installed"}\nlater\n'), 'failed')):
            self.reply = reply
            self.assertEqual(self.refresh(), word, reply)
        for error in (subprocess.TimeoutExpired(['python3'], 60), OSError(2, 'No such file'), ValueError('bad')):
            def fail(command, error=error, **options):
                raise error
            self.assertEqual(self.refresh(run=fail), 'failed', error)

    def test_the_release_the_service_runs_comes_from_its_installation(self):
        own = self.home / '.specwithcode' / 'm4'
        self.assertEqual(update_request.refresh_installed_agent(self.home, 'm4', run=self.fake_run), 'absent')
        own.mkdir(parents=True)
        for release, word in ((str(self.release), 'installed'), ('releases/' + self.RELEASE, 'absent'), (None, 'absent')):
            (own / 'installation.json').write_text(json.dumps({'identity': 'm4', 'version': '1.0.66', 'release': release}))
            self.assertEqual(update_request.refresh_installed_agent(self.home, 'm4', run=self.fake_run), word, release)
        self.assertEqual(len(self.runs), 1)
        (own / 'installation.json').write_text('{')
        self.assertEqual(update_request.refresh_installed_agent(self.home, 'm4', run=self.fake_run), 'failed')
        self.assertEqual(update_request.refresh_installed_agent(self.home, '../m4', run=self.fake_run), 'failed')


class WaitForPass(unittest.TestCase):
    """A request or check sees a running pass by the agent's lock, held only for the test."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = pathlib.Path(temporary.name).resolve()
        updates = self.home / '.specwithcode' / 'm4' / 'updates'
        updates.mkdir(parents=True)
        self.lock = updates / 'agent.lock'
        self.now, self.sleeps = 0, []

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds

    def hold(self, path=None):
        """Holds the lock the way a pass does; the descriptor is closed by the caller."""
        holder = os.open(str(path or self.lock), os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return holder

    def wait(self, until=5, sleep=None):
        return update_request.wait_for_pass(self.home, 'm4', until, clock=self.clock, sleep=sleep or self.sleep)

    def test_no_pass_needs_no_wait_and_creates_no_lock(self):
        self.assertTrue(self.wait())
        self.assertFalse(os.path.lexists(str(self.lock)))
        self.lock.write_bytes(b'')
        self.assertTrue(self.wait())
        self.assertEqual(self.sleeps, [])
        os.close(self.hold())  # The probe did not keep it.

    def test_a_running_pass_is_waited_for_until_it_ends_or_time_runs_out(self):
        holder = self.hold()
        self.assertFalse(self.wait(until=5))
        self.assertEqual((self.sleeps, self.now), ([1] * 5, 5))
        self.now, self.sleeps = 0, []

        def sleep(seconds):
            self.sleep(seconds)
            if len(self.sleeps) == 2:
                os.close(holder)  # The pass ends.
        self.assertTrue(self.wait(until=5, sleep=sleep))
        self.assertEqual(self.sleeps, [1, 1])
        os.close(self.hold())

    def test_a_linked_lock_is_no_pass(self):
        target = self.home / 'elsewhere.lock'
        holder = self.hold(target)
        self.addCleanup(os.close, holder)
        self.lock.symlink_to(target)
        self.assertFalse(update_request.pass_running(self.home, 'm4'))


class RequestRefreshesTheAgent(unittest.TestCase):
    """update_request.py request installs the agent of the release the Mac runs before it asks."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = pathlib.Path(temporary.name).resolve()
        self.own = self.home / '.specwithcode' / 'm9'
        (self.own / 'updates').mkdir(parents=True)
        (self.own / 'installation.json').write_text(json.dumps({'identity': 'm9', 'version': '1.0.66'}))
        self.config = self.own / 'updates' / 'config.json'
        self.refreshed = []

    def refresh(self, home, identity, run=None, wait=0):
        self.refreshed.append((home, identity, wait, self.config.exists()))
        return 'installed'

    def cli(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch.object(update_request, 'refresh_installed_agent', self.refresh), \
                mock.patch.object(update_request.pathlib.Path, 'home', return_value=self.home):
            code = update_request.main(list(argv))
        return code, json.loads(out.getvalue().strip().splitlines()[-1])

    def test_a_request_or_check_installs_the_release_agent_first_and_reports_it(self):
        wait = update_request.AGENT_PASS_WAIT
        code, reply = self.cli('request', '--identity', 'm9', '--version', '1.0.67')
        self.assertEqual((code, reply['result'], reply['agent']), (0, 'requested', 'installed'))
        self.assertEqual(self.refreshed, [(self.home, 'm9', wait, False)])  # Before the request is written.
        code, reply = self.cli('request', '--identity', 'm9', '--version', '1.0.66')
        self.assertEqual((code, reply['result'], reply['agent']), (0, 'already-installed', 'installed'))
        self.assertEqual(self.refreshed[1], (self.home, 'm9', 0, True))  # It writes nothing to wait for.
        code, reply = self.cli('request', '--identity', 'm9', '--version', '1.0.65')
        self.assertEqual((code, len(self.refreshed)), (1, 2))  # Refused before any refresh.
        self.assertIn('newer than 1.0.65', reply['error'])
        self.config.unlink()
        code, reply = self.cli('check', '--identity', 'm9')
        self.assertEqual((code, reply['result'], reply['agent']), (0, 'check-requested', 'installed'))
        self.assertEqual(self.refreshed[2], (self.home, 'm9', wait, False))

    def test_a_forced_request_never_waits(self):
        # It follows M4's drain, whose hold lets go when no request arrives within a minute.
        code, reply = self.cli('request', '--identity', 'm9', '--version', '1.0.67', '--force', '--hold-minutes', '5')
        self.assertEqual((code, reply['result'], reply['agent']), (0, 'requested', 'installed'))
        self.assertEqual(self.refreshed, [(self.home, 'm9', 0, False)])

    def test_the_rollout_gives_requests_and_checks_time_for_the_wait(self):
        # The wait, ready_to_kick's two launchctl reads, the kickstart and SSH, before the call times out.
        launchctl = inspect.signature(update_request.launchctl_run).parameters['timeout'].default
        self.assertLessEqual(update_request.AGENT_PASS_WAIT + 2 * launchctl + 15 + 10, fleet_rollout.REQUEST_TIMEOUT)
        timeouts = []

        def run(command, **options):
            timeouts.append(options['timeout'])
            return types.SimpleNamespace(returncode=0, stdout='{"identity": "m1"}\n', stderr='')
        host = fleet_rollout.Host('m1', ['/usr/bin/python3', '-B', '-'])
        with mock.patch.object(fleet_rollout.subprocess, 'run', run):
            for command in ('status', 'cancel', 'request', 'check'):
                host([command, '--identity', 'm1'])
        self.assertEqual(timeouts, [fleet_rollout.CALL_TIMEOUT] * 2 + [fleet_rollout.REQUEST_TIMEOUT] * 2)

    def test_a_test_home_never_installs_an_agent(self):
        code, reply = self.cli('request', '--identity', 'm9', '--version', '1.0.67', '--home', str(self.home))
        self.assertEqual((code, reply['result'], reply['agent'], self.refreshed), (0, 'requested', 'absent', []))
        code, reply = self.cli('check', '--identity', 'm9', '--home', str(self.home))
        self.assertEqual((code, reply['result'], reply['agent'], self.refreshed), (0, 'check-requested', 'absent', []))


class RolloutSaysWhatTheAgentDid(unittest.TestCase):
    def hosts(self, fleet, words, command='request'):
        """The fleet's hosts, each `command` reply naming what the refresh did on that host."""
        hosts = fleet.hosts()
        for identity, real in list(hosts.items()):
            def call(argv, real=real, word=words.get(identity)):
                reply = real(argv)
                if argv[0] == command and word:
                    reply['agent'] = word
                return reply
            hosts[identity] = call
        return hosts

    def test_each_host_names_an_agent_it_installed_or_could_not(self):
        clock = rollout_tests.Clock()
        fleet = rollout_tests.Fleet(clock, polls={'m4': 0, 'm1': 0, 'm3': 0})
        hosts = self.hosts(fleet, {'m4': 'installed', 'm1': 'failed', 'm3': 'current'})
        lines = []
        results = fleet_rollout.rollout(rollout_tests.NEW, hosts, clock=clock, sleep=clock.sleep, say=lines.append)
        self.assertEqual(sorted(results), ['m1', 'm3', 'm4'])
        self.assertIn('m4: ' + fleet_rollout.AGENT_NOTES['installed'], lines)
        self.assertIn('m1: ' + fleet_rollout.AGENT_NOTES['failed'], lines)
        self.assertEqual([line for line in lines if line.startswith('m3: ') and 'update agent' in line], [])
        self.assertEqual(sorted(fleet_rollout.AGENT_NOTES), ['busy', 'disabled', 'failed', 'installed'])

    def test_a_check_names_it_too(self):
        clock = rollout_tests.Clock()
        fleet = rollout_tests.Fleet(clock, polls={'m4': 10 ** 6})
        fleet.status['m4'], fleet.message['m4'] = 'up-to-date', None
        fleet.downloaded['m4'] = fleet.available['m4'] = None  # Not offered: M4 is only asked to check.
        lines = []
        with self.assertRaises(fleet_rollout.RolloutError):
            fleet_rollout.rollout(rollout_tests.NEW, self.hosts(fleet, {'m4': 'busy'}, 'check'), only='m4', clock=clock,
                                  sleep=clock.sleep, say=lines.append, hold=rollout_tests.FakeHold(fleet),
                                  local_deadline=10 * 60, poll=30)
        self.assertEqual(rollout_tests.kinds(fleet), ['check'])
        # A pass never takes on a check written during it, as it may a request.
        self.assertIn('m4: ' + fleet_rollout.CHECK_BUSY, lines)
        self.assertNotIn('m4: ' + fleet_rollout.AGENT_NOTES['busy'], lines)

    def test_a_worker_that_stops_on_an_unexpected_error_fails_the_rollout(self):
        # Before, the worker's thread died with a traceback and the rollout reported the hosts left.
        clock = rollout_tests.Clock()
        fleet = rollout_tests.Fleet(clock, polls={'m4': 0, 'm1': 0, 'm3': 0})
        hosts, real = fleet.hosts(), fleet.host('m1')

        def m1(argv):
            if argv[0] == 'request':
                raise TypeError('a bug')
            return real(argv)
        hosts['m1'] = m1
        with self.assertRaises(fleet_rollout.RolloutError) as caught:
            fleet_rollout.rollout(rollout_tests.NEW, hosts, clock=clock, sleep=clock.sleep, say=rollout_tests.quiet)
        self.assertEqual(str(caught.exception), 'm1 stopped on an unexpected TypeError: a bug')
        self.assertEqual(fleet.version['m3'], rollout_tests.NEW)  # The other worker went on.


class BuildsRecordTheirAgent(unittest.TestCase):
    def test_every_installer_copy_is_one_the_builds_ship(self):
        build = (HERE.parent / 'lib/studio-service-updater.ts').read_text()
        shipped = re.search(r'MAC_SERVICE_UPDATER_FILES = \[([^\]]*)\]', build).group(1)
        self.assertEqual(sorted(re.findall(r'"([a-z_]+\.py)"', shipped)), sorted(update_request.AGENT_FILES))

    def test_the_runtime_and_desktop_builds_write_the_record_beside_the_agent(self):
        bundle = (HERE / 'bundle.mjs').read_text()
        # Formatting may wrap the call or choose either quote style; the record's
        # path, JSON schema/version and inclusion before hashing are the contract.
        record = re.search(
            r"writeFileSync\(\s*join\(updater,\s*(['\"])agent-release\.json\1\),\s*"
            r"JSON\.stringify\(\{\s*schemaVersion:\s*1,\s*version\s*\}\)\s*\+\s*(['\"])\\n\2,?\s*\);",
            bundle,
        )
        self.assertIsNotNone(record, 'the runtime build must write its versioned agent record')
        written = record.start()
        self.assertLess(bundle.index('cpSync(source, join(updater, file));'), written)
        self.assertLess(written, bundle.index('indexTree(output);'))  # In the archive's hashed inventory.
        desktop = (HERE.parent / 'build-desktop-artifact.ts').read_text()
        written = desktop.index('path.join(updaterDir, "agent-release.json"),\n      `{"schemaVersion": 1, "version": "${appVersion}"}\\n`,')
        self.assertLess(desktop.index('for (const file of MAC_SERVICE_UPDATER_FILES) {'), written)
        self.assertEqual(update_request.AGENT_RECORD, 'agent-release.json')


if __name__ == '__main__':
    unittest.main()
