#!/usr/bin/env python3
"""linux_rollout.py: the best-effort Linux worker update release.sh runs after the Macs.

A fake SSH (the `run` the Worker calls) answers status, preview and update from a scripted
worker, so nothing leaves this machine. Also runs the remote shell script itself against a
temporary unit file, and checks the inventory reader.

Run: cd scripts/studio-fleet && python3 -B test-linux-rollout.py
"""
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import fleet_hosts  # noqa: E402
import linux_rollout  # noqa: E402

STUDIO_HOME = '/home/u/.specwithcode/lx1'
NEW = '1.0.95'


def binary(version):
    return '%s/runtime/versions/%s/specweave-studio' % (STUDIO_HOME, version)


class FakeWorker(object):
    """Answers the remote actions like a Linux worker whose service runs `version` healthy.

    `query_ok=False` is a session that cannot reach the user manager; `active` is systemd's
    ActiveState; `running` (default `version`) is what the live server runs, `selected` the
    launcher's activeVersion, `pending` an update trial in progress. An update moves the unit, the
    selection and the live server to the new version and leaves it active, unless `switch` is
    false (the unit moves, the server keeps running the old version) or `starts` is false (it
    stays down). `busy_at_restart` is work that arrived after the preview: --if-idle then refuses
    to restart, as `specweave-studio update --if-idle` does.
    """

    def __init__(self, version='1.0.94', active='active', idle=True, preview_rc=0, update_rc=0,
                 switch_after_update=True, blockers=None, query_ok=True, load='loaded', running=None,
                 selected=None, pending=False, starts=True, busy_at_restart=False, update_error=None,
                 folder_copies=None):
        self.unit = version
        self.running = version if running is None else running
        self.selected = version if selected is None else selected
        self.active, self.idle, self.query_ok, self.load, self.pending = active, idle, query_ok, load, pending
        self.preview_rc, self.update_rc, self.switch, self.starts = preview_rc, update_rc, switch_after_update, starts
        self.busy_at_restart, self.update_error = busy_at_restart, update_error
        self.blockers = blockers or []
        self.folder_copies = folder_copies
        self.calls = []
        self.restarted = False

    def __call__(self, argv, input=None, capture_output=None, text=None, timeout=None):
        assert input == linux_rollout.REMOTE
        remote = argv[-1]
        assert remote.startswith('sh -s -- '), remote
        words = remote.split()[3:]
        action = words[2]
        self.calls.append((action, words, timeout))
        if action == 'status':
            out = 'bin=%s\n' % (binary(self.unit) if self.unit else '')
            if self.query_ok:
                out += 'query=ok\nLoadState=%s\nActiveState=%s\nControlGroup=/user.slice/studio.service\n' % (
                    self.load, self.active)
            else:
                out += 'query=failed\n'
            live = self.running if self.active == 'active' else None
            out += 'running=%s\nselected=%s\nupdate=%s\n' % (
                live or '', self.selected or '', 'pending' if self.pending else 'done')
            return subprocess.CompletedProcess(argv, 0, out, '')
        if action == 'preview':
            if self.preview_rc:
                return subprocess.CompletedProcess(argv, self.preview_rc, '', 'Unknown subcommand prepare-update')
            reply = {'idle': self.idle, 'blockers': self.blockers, 'held': False, 'stoppedThreads': 0}
            if self.folder_copies is not None:
                reply['folderCopies'] = self.folder_copies
            return subprocess.CompletedProcess(argv, 0, json.dumps(reply) + '\n', '')
        if action in ('update', 'update-if-idle'):
            if self.update_error:
                return subprocess.CompletedProcess(argv, 1, '', self.update_error)
            if self.update_rc:
                return subprocess.CompletedProcess(argv, self.update_rc, '', 'download failed: 404')
            target = words[3]
            self.unit = target
            if action == 'update-if-idle' and self.busy_at_restart:
                return subprocess.CompletedProcess(argv, 1, '', (
                    'specweave-studio@%s is installed, but the background service was not restarted: '
                    'it is still running 1 run. It keeps running %s.' % (target, self.running)))
            self.restarted = True
            if self.switch:
                self.selected = self.running = target
            self.active = 'active' if self.starts else 'failed'
            return subprocess.CompletedProcess(argv, 0, 'Background service restarted on %s\n' % target, '')
        raise AssertionError(action)

    def actions(self):
        return [call[0] for call in self.calls]


class Clock(object):
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


ENTRY = {'os': 'linux', 'host': 'lx1', 'sshConfig': True, 'studioHome': STUDIO_HOME}


def roll(fake, local_copies=None):
    lines, clock = [], Clock()
    worker = linux_rollout.Worker('lx1', ENTRY, run=fake)
    result = linux_rollout.roll_worker(worker, NEW, lines.append, sleep=clock.sleep, clock=clock,
                                       local_copies=local_copies)
    return result, lines


class RollWorker(unittest.TestCase):
    def test_idle_worker_is_updated_with_a_hold_and_verified(self):
        fake = FakeWorker()
        result, lines = roll(fake)
        self.assertEqual(result['result'], 'installed')
        self.assertEqual(result['from'], '1.0.94')
        self.assertEqual(fake.actions(), ['status', 'preview', 'update-if-idle', 'status'])
        update = [call for call in fake.calls if call[0] == 'update-if-idle'][0]
        self.assertEqual(update[1], [STUDIO_HOME, 'studio.service', 'update-if-idle', NEW])
        self.assertEqual(update[2], linux_rollout.UPDATE_TIMEOUT)

    def test_busy_worker_is_skipped_and_never_restarted(self):
        fake = FakeWorker(idle=False, blockers=[{'kind': 'run', 'count': 1, 'threadTitle': 'Fix tests'}])
        result, lines = roll(fake)
        self.assertEqual(result['result'], 'skipped-busy')
        self.assertNotIn('update-if-idle', fake.actions())
        self.assertNotIn('update', fake.actions())
        self.assertTrue(any('WARNING' in line and '1 run (Fix tests)' in line for line in lines), lines)

    def test_a_worker_copying_a_folder_is_skipped_and_names_the_copy(self):
        # 2026-10-29: ministorm restarted mid-copy and the copy failed; nothing else ran there.
        fake = FakeWorker(idle=False, folder_copies=1)
        result, lines = roll(fake)
        self.assertEqual(result['result'], 'skipped-busy')
        self.assertFalse(fake.restarted)
        self.assertIn('1 folder copy', result['reason'])
        self.assertTrue(any('WARNING' in line and '1 folder copy' in line for line in lines), lines)

    def test_an_older_worker_is_skipped_while_this_machine_copies_a_folder(self):
        # Its idle answer has no folderCopies and its --if-idle hold would not wait for a copy with M4.
        fake = FakeWorker()
        result, lines = roll(fake, local_copies=lambda: 1)
        self.assertEqual(result['result'], 'skipped-busy')
        self.assertFalse(fake.restarted)
        self.assertEqual(fake.actions(), ['status', 'preview'])
        self.assertIn('too old to count folder copies', result['reason'])
        # One that counts its own copies (none here) is updated: a copy with M4 would be its own.
        fake = FakeWorker(folder_copies=0)
        self.assertEqual(roll(fake, local_copies=lambda: 1)[0]['result'], 'installed')
        # With no copy here an older worker is updated as before.
        self.assertEqual(roll(FakeWorker(), local_copies=lambda: 0)[0]['result'], 'installed')

    def test_work_arriving_after_the_preview_is_not_interrupted(self):
        fake = FakeWorker(busy_at_restart=True)
        result, lines = roll(fake)
        self.assertEqual(result['result'], 'skipped-busy')
        self.assertFalse(fake.restarted)
        self.assertEqual(fake.actions(), ['status', 'preview', 'update-if-idle'])
        self.assertIn('was not restarted', result['reason'])

    def test_a_cli_without_if_idle_skips_instead_of_restarting(self):
        fake = FakeWorker(update_error='Unrecognized flag: --if-idle')
        result, _lines = roll(fake)
        self.assertEqual(result['result'], 'skipped')
        self.assertIn('predates update --if-idle', result['reason'])
        self.assertFalse(fake.restarted)

    def test_unanswered_preview_skips(self):
        fake = FakeWorker(preview_rc=1)
        result, _lines = roll(fake)
        self.assertEqual(result['result'], 'skipped')
        self.assertEqual(fake.actions(), ['status', 'preview'])

    def test_a_failed_bus_query_skips_even_with_work_running(self):
        # An SSH session without the user bus: systemd cannot be asked. The busy service must not
        # be taken for a stopped one.
        fake = FakeWorker(query_ok=False, idle=False, blockers=[{'kind': 'run', 'count': 1}])
        result, lines = roll(fake)
        self.assertEqual(result['result'], 'skipped')
        self.assertEqual(fake.actions(), ['status'])
        self.assertFalse(fake.restarted)
        self.assertIn('systemd could not be asked', result['reason'])

    def test_uncertain_states_skip(self):
        for active in ('activating', 'deactivating', 'reloading', 'unknown'):
            fake = FakeWorker(active=active)
            result, _lines = roll(fake)
            self.assertEqual(result['result'], 'skipped', active)
            self.assertEqual(fake.actions(), ['status'], active)
        fake = FakeWorker(load='not-found', active='inactive')
        result, _lines = roll(fake)
        self.assertEqual(result['result'], 'skipped')
        self.assertEqual(fake.actions(), ['status'])

    def test_stopped_service_is_updated_without_preview(self):
        for active in ('inactive', 'failed'):
            fake = FakeWorker(active=active)
            result, _lines = roll(fake)
            self.assertEqual(result['result'], 'installed', active)
            self.assertEqual(fake.actions(), ['status', 'update', 'status'], active)

    def test_already_running_the_version_or_newer_changes_nothing(self):
        for version, expected in ((NEW, 'already-installed'), ('1.0.96', 'newer')):
            fake = FakeWorker(version=version)
            result, _lines = roll(fake)
            self.assertEqual(result['result'], expected)
            self.assertEqual(fake.actions(), ['status'])

    def test_a_target_unit_that_failed_to_start_is_retried_not_accepted(self):
        # An earlier update wrote the target unit, then the service failed to start.
        fake = FakeWorker(version=NEW, active='failed')
        result, _lines = roll(fake)
        self.assertEqual(fake.actions(), ['status', 'update', 'status'])
        self.assertEqual(result['result'], 'installed')
        # And when it fails to start again, the worker stays incomplete.
        fake = FakeWorker(version=NEW, active='failed', starts=False)
        result, _lines = roll(fake)
        self.assertEqual(result['result'], 'failed')

    def test_a_target_unit_running_another_version_is_not_accepted(self):
        # The unit names the target, but the launcher selected (rolled back to) the old runtime.
        fake = FakeWorker(version=NEW, running='1.0.94', selected='1.0.94', switch_after_update=False)
        result, _lines = roll(fake)
        self.assertEqual(result['from'], '1.0.94')
        self.assertEqual(result['result'], 'failed')
        self.assertIn('server runs 1.0.94', result['reason'])

    def test_a_pending_trial_or_unreadable_server_is_not_accepted(self):
        for fake in (FakeWorker(version=NEW, pending=True, switch_after_update=False),
                     FakeWorker(version=NEW, running='', switch_after_update=False)):
            fake.running = fake.running or None
            result, _lines = roll(fake)
            self.assertNotIn(result['result'], linux_rollout.OK_RESULTS)

    def test_failed_update_is_reported_not_raised(self):
        fake = FakeWorker(update_rc=1)
        result, lines = roll(fake)
        self.assertEqual(result['result'], 'failed')
        self.assertIn('download failed: 404', result['reason'])

    def test_server_not_switched_fails_after_the_verify_window(self):
        fake = FakeWorker(switch_after_update=False)
        result, _lines = roll(fake)
        self.assertEqual(result['result'], 'failed')
        self.assertGreater(fake.actions().count('status'), 2)

    def test_unreachable_worker_fails(self):
        def run(argv, **kwargs):
            raise subprocess.TimeoutExpired(argv, kwargs.get('timeout'))
        result, _lines = roll(run)
        self.assertEqual(result['result'], 'failed')


class Main(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.dir = pathlib.Path(folder.name)
        self.inventory = self.dir / 'hosts.json'
        patcher = mock.patch.dict(os.environ, {fleet_hosts.ENV: str(self.inventory)})
        patcher.start()
        self.addCleanup(patcher.stop)

    def write(self, hosts):
        self.inventory.write_text(json.dumps(hosts))

    def main(self, argv, run=None, app=None):
        out = io.StringIO()
        self.apps = []
        answer = app or {'result': 'already-current', 'before': NEW, 'after': NEW, 'relaunched': 'no'}

        class Desktop(object):
            def __init__(desktop, version):
                desktop.version = version

            def __call__(desktop, identity, ssh, say):
                self.apps.append((desktop.version, identity, ssh))
                if isinstance(answer, Exception):
                    raise answer
                return answer
        code = linux_rollout.main(argv, home=self.dir, run=run or FakeWorker(), sleep=lambda s: None, stdout=out,
                                  desktop_app=Desktop)
        return code, out.getvalue()

    def test_no_linux_workers_is_success(self):
        self.write({'m1': {'host': 'a', 'user': 'u'}, 'm3': {'host': 'b', 'user': 'u'}})
        code, out = self.main(['--version', NEW])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.splitlines()[-1])['hosts'], [])

    def test_dry_run_prints_commands_and_contacts_nothing(self):
        self.write({'lx1': dict(ENTRY), 'lx2': {'os': 'linux', 'host': 'h2', 'user': 'u', 'studioHome': '/srv/s'}})

        def run(argv, **kwargs):
            raise AssertionError('contacted a host')
        code, out = self.main(['--version', NEW, '--dry-run'], run=run)
        self.assertEqual(code, 0)
        plan = json.loads(out)
        self.assertEqual(plan['order'], ['lx1', 'lx2'])
        self.assertEqual(plan['commands']['lx1']['update'][-1],
                         'sh -s -- %s studio.service update %s' % (STUDIO_HOME, NEW))
        self.assertEqual(plan['commands']['lx1']['update-if-idle'][-1],
                         'sh -s -- %s studio.service update-if-idle %s' % (STUDIO_HOME, NEW))
        self.assertIn('u@h2', plan['commands']['lx2']['status'])
        self.assertIn('IdentitiesOnly=yes', plan['commands']['lx2']['status'])

    def test_a_skipped_worker_exits_1_with_a_retry_line(self):
        self.write({'lx1': dict(ENTRY)})
        code, out = self.main(['--version', NEW], run=FakeWorker(idle=False))
        self.assertEqual(code, 1)
        self.assertIn('linux_rollout.py --version %s --host lx1' % NEW, out)
        self.assertEqual(json.loads(out.splitlines()[-1])['result'], 'incomplete')

    def test_installed_exits_0(self):
        self.write({'lx1': dict(ENTRY)})
        code, out = self.main(['--version', NEW])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.splitlines()[-1])['hosts'][0]['result'], 'installed')

    def test_the_desktop_app_follows_a_service_on_the_version(self):
        self.write({'lx1': dict(ENTRY)})
        app = {'result': 'helper', 'before': '1.0.94', 'after': NEW, 'relaunched': 'yes'}
        code, out = self.main(['--version', NEW], app=app)
        self.assertEqual(code, 0)
        self.assertEqual([(version, identity) for version, identity, _ssh in self.apps], [(NEW, 'lx1')])
        self.assertEqual(json.loads(out.splitlines()[-1])['hosts'][0]['desktopApp'], app)

    def test_a_desktop_app_that_cannot_update_makes_the_run_incomplete(self):
        self.write({'lx1': dict(ENTRY)})
        from desktop_app_rollout import DesktopAppError
        code, out = self.main(['--version', NEW], app=DesktopAppError('the signed update helper is missing'))
        self.assertEqual(code, 1)
        summary = json.loads(out.splitlines()[-1])
        self.assertEqual(summary['result'], 'incomplete')
        self.assertEqual(summary['hosts'][0]['result'], 'installed')
        self.assertEqual(summary['hosts'][0]['desktopApp'],
                         {'result': 'failed', 'reason': 'the signed update helper is missing'})
        self.assertIn('desktop app not updated to %s: the signed update helper is missing' % NEW, out)
        self.assertIn('--host lx1', out)

    def test_a_skipped_service_leaves_its_desktop_app_alone(self):
        self.write({'lx1': dict(ENTRY)})
        code, out = self.main(['--version', NEW], run=FakeWorker(idle=False))
        self.assertEqual(code, 1)
        self.assertEqual(self.apps, [])

    def test_no_desktop_apps_skips_the_step(self):
        self.write({'lx1': dict(ENTRY)})
        code, out = self.main(['--version', NEW, '--no-desktop-apps'])
        self.assertEqual(code, 0)
        self.assertEqual(self.apps, [])
        self.assertNotIn('desktopApp', json.loads(out.splitlines()[-1])['hosts'][0])

    def test_bad_inventory_entries_are_refused(self):
        for entry in ({'os': 'linux', 'host': 'h', 'studioHome': '/s'},  # no user, no sshConfig
                      {'os': 'linux', 'host': 'h', 'sshConfig': True, 'studioHome': 'relative'},
                      {'os': 'linux', 'host': 'h; rm -rf /', 'sshConfig': True, 'studioHome': '/s'},
                      {'os': 'linux', 'host': 'h', 'sshConfig': True, 'studioHome': '/s', 'unit': ['x']},
                      # The CLI's update only rewrites studio.service.
                      {'os': 'linux', 'host': 'h', 'sshConfig': True, 'studioHome': '/s', 'unit': 'worker.service'}):
            self.write({'lx1': entry})
            code, out = self.main(['--version', NEW])
            self.assertEqual(code, 1, entry)
            self.assertEqual(json.loads(out.splitlines()[-1])['result'], 'failed')

    def test_mac_rollout_ignores_linux_entries(self):
        self.write({'m1': {'host': 'a', 'user': 'u'}, 'm3': {'host': 'b', 'user': 'u'}, 'lx1': dict(ENTRY)})
        self.assertEqual([plan[0] for plan in fleet_hosts.worker_plans()], ['m1', 'm3'])


class RemoteScript(unittest.TestCase):
    """The shell the worker runs, against a temporary unit file and a stub binary."""

    def test_status_preview_and_update_commands(self):
        with tempfile.TemporaryDirectory() as folder:
            home = pathlib.Path(folder)
            studio = home / 'studio'
            stub = studio / 'runtime/versions/1.0.94/specweave-studio'
            stub.parent.mkdir(parents=True)
            stub.write_text('#!/bin/sh\necho "args=$* home=$STUDIO_HOME self=${STUDIO_ENABLE_SELF_UPDATE:-}"\n')
            stub.chmod(0o700)
            unit = home / '.config/systemd/user/studio.service'
            unit.parent.mkdir(parents=True)
            unit.write_text('[Service]\nExecStart=%s __service-launcher\n' % stub)
            env = {'HOME': str(home), 'PATH': '/usr/bin:/bin', 'XDG_CONFIG_HOME': str(home / 'elsewhere')}  # ignored, like bootService

            def sh(*args):
                result = subprocess.run(['/bin/sh', '-s', '--', str(studio), 'studio.service'] + list(args),
                                        input=linux_rollout.REMOTE, capture_output=True, text=True, env=env,
                                        timeout=30)
                return result.returncode, result.stdout

            code, out = sh('status')
            self.assertEqual(code, 0)
            self.assertIn('bin=%s\n' % stub, out)
            code, out = sh('preview')
            self.assertEqual(out.strip(), 'args=service prepare-update --base-dir %s --json home=%s self=' % (studio, studio))
            code, out = sh('update', NEW)
            self.assertEqual(out.strip(), 'args=update %s --yes home=%s self=true' % (NEW, studio))
            code, out = sh('update-if-idle', NEW)
            self.assertEqual(out.strip(), 'args=update %s --yes --if-idle home=%s self=true' % (NEW, studio))
            unit.write_text('[Service]\nExecStart=/nowhere/other-binary\n')
            code, _out = sh('update', NEW)
            self.assertEqual(code, 3)

    def remote(self, home, studio, args, systemctl, extra_env=None):
        bin_dir = home / 'fake-bin'
        bin_dir.mkdir(exist_ok=True)
        stub = bin_dir / 'systemctl'
        stub.write_text(systemctl)
        stub.chmod(0o700)
        env = {'HOME': str(home), 'PATH': '%s:/usr/bin:/bin' % bin_dir}
        env.update(extra_env or {})
        result = subprocess.run(['/bin/sh', '-s', '--', str(studio), 'studio.service'] + list(args),
                                input=linux_rollout.REMOTE, capture_output=True, text=True, env=env, timeout=30)
        return dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)

    def test_status_restores_the_user_bus_and_keeps_a_failed_query(self):
        with tempfile.TemporaryDirectory() as folder:
            home = pathlib.Path(folder)
            studio = home / 'studio'
            log = home / 'systemctl.log'
            # Records the bus it was given; fails like a session that cannot reach the user manager.
            fields = self.remote(home, studio, ['status'], (
                '#!/bin/sh\nprintf "%%s|%%s\\n" "$XDG_RUNTIME_DIR" "$DBUS_SESSION_BUS_ADDRESS" >> %s\n'
                'echo "Failed to connect to bus" >&2\nexit 1\n') % log)
            uid = os.getuid()
            self.assertEqual(log.read_text().strip(), '/run/user/%d|unix:path=/run/user/%d/bus' % (uid, uid))
            self.assertEqual(fields['query'], 'failed')
            self.assertNotIn('ActiveState', fields)
            # A session that has the bus keeps it.
            log.unlink()
            fields = self.remote(home, studio, ['status'], (
                '#!/bin/sh\nprintf "%%s|%%s\\n" "$XDG_RUNTIME_DIR" "$DBUS_SESSION_BUS_ADDRESS" >> %s\n'
                'printf "LoadState=loaded\\nActiveState=inactive\\nControlGroup=\\n"\n') % log,
                {'XDG_RUNTIME_DIR': '/run/user/7', 'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/x'})
            self.assertEqual(log.read_text().strip(), '/run/user/7|unix:path=/x')
            self.assertEqual((fields['query'], fields['LoadState'], fields['ActiveState']), ('ok', 'loaded', 'inactive'))
            self.assertEqual(fields['running'], '')

    @unittest.skipUnless(pathlib.Path('/proc/self/cgroup').exists(), 'reads /proc, as on a Linux worker')
    def test_status_reads_the_version_the_live_server_runs(self):
        with tempfile.TemporaryDirectory() as folder:
            home = pathlib.Path(folder)
            studio = home / 'studio'
            (studio / 'userdata').mkdir(parents=True)
            (studio / 'runtime').mkdir(parents=True)
            context = json.dumps({'protocol': 1, 'childVersion': '1.0.94'})
            server = subprocess.Popen(['sleep', '30'], env={'PATH': '/usr/bin:/bin',
                                                            'STUDIO_SERVICE_LAUNCHER_CONTEXT': context})
            self.addCleanup(server.kill)
            cgroup = pathlib.Path('/proc/%d/cgroup' % server.pid).read_text().splitlines()[-1].split(':', 2)[2]
            (studio / 'userdata/server-runtime.json').write_text(json.dumps({'version': 1, 'pid': server.pid}))
            (studio / 'runtime/service-state.json').write_text(json.dumps({'activeVersion': '1.0.94'}, indent=2))
            systemctl = '#!/bin/sh\nprintf "LoadState=loaded\\nActiveState=active\\nControlGroup=%s\\n"\n' % cgroup
            fields = self.remote(home, studio, ['status'], systemctl)
            self.assertEqual((fields['running'], fields['selected']), ('1.0.94', '1.0.94'))
            # A process outside the unit's cgroup is not the service's server.
            fields = self.remote(home, studio, ['status'], systemctl.replace(cgroup, '/elsewhere.service'))
            self.assertEqual(fields['running'], '')



OLD_APP, NEW_APP = '1.0.267', '1.0.268'
DEB = b'deb bytes for ' + NEW_APP.encode()
DEB_SHA = __import__('hashlib').sha256(DEB).hexdigest()


def tool(path, body):
    path.write_text('#!/bin/sh\n' + body)
    path.chmod(0o755)
    return str(path)


@unittest.skipUnless(sys.platform.startswith('linux'), 'reads /proc, as on a Linux worker')
class LinuxDesktopScript(unittest.TestCase):
    """desktop_app_update_linux.sh against fake dpkg, polkit, pkexec, systemd-run and helper tools."""

    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        d = self.dir = pathlib.Path(folder.name)
        (d / 'bin').mkdir()
        self.state = d / 'installed'
        self.state.write_text(OLD_APP)
        self.log = d / 'log'
        self.log.write_text('')
        self.pids = d / 'pids'
        self.pids.write_text('')
        (d / 'release.deb').write_bytes(DEB)
        policy = d / 'update.policy'
        policy.write_text('<policyconfig/>')
        keyring = d / 'key.gpg'
        keyring.write_text('key')
        b = d / 'bin'
        self.env = {
            'PATH': '%s:/usr/bin:/bin' % b, 'HOME': str(d), 'XDG_RUNTIME_DIR': str(d), 'SWC_POLL': '1',
            'SWC_QUIT_WAIT': '5', 'SWC_INSTALL_WAIT': '5', 'SWC_CACHE_DIR': str(d / 'cache'), 'SWC_ARCH': 'amd64',
            'SWC_APP_EXE': '/opt/SpecWithCode/specweave-studio-desktop', 'SWC_POLICY': str(policy),
            'SWC_KEYRING': str(keyring), 'LOG': str(self.log), 'STATE': str(self.state),
            'SWC_DPKG_QUERY': tool(b / 'dpkg-query', '[ -s "$STATE" ] || exit 1\ncat "$STATE"\n'),
            # --compare-versions A ge B, as dpkg orders these plain versions.
            'SWC_DPKG': tool(b / 'dpkg', '[ "$1" = --print-architecture ] && { echo amd64; exit 0; }\n'
                                         '[ "$(printf "%s\\n%s\\n" "$2" "$4" | sort -V | head -n 1)" = "$4" ]\n'),
            'SWC_PGREP': tool(b / 'pgrep', 'case "$*" in *update-helper*) exit 1 ;; esac\ncat "%s"\n' % self.pids),
            'SWC_PKCHECK': tool(b / 'pkcheck', 'echo "pkcheck $*" >> "$LOG"\nexit "${PKCHECK_RC:-0}"\n'),
            # systemd-run turns $$ into $, as the real one expands its arguments.
            'SWC_SYSTEMD_RUN': tool(b / 'systemd-run', 'echo "systemd-run $*" >> "$LOG"\n'
                                    'while [ "$1" != -- ]; do shift; done; shift\n'
                                    'case "$1" in /opt/*) exit 0 ;; esac\n'
                                    'if [ "$1" = /bin/sh ]; then exec /bin/sh -c "$(printf %s "$3" | sed "s/\\$\\$/\\$/g")"; fi\n'
                                    'exec "$@"\n'),
            'SWC_PKEXEC': tool(b / 'pkexec', '[ "$1" = --disable-internal-agent ] && shift\nexec "$@"\n'),
            'SWC_HELPER': tool(b / 'update-helper', 'echo "helper $*" >> "$LOG"\nrc=${HELPER_RC:-0}\n'
                                                    '[ "$rc" = 0 ] && [ -z "${HELPER_NOOP:-}" ] && echo %s > "$STATE"\n'
                                                    '[ "$rc" = 0 ] || echo "SpecWithCode update refused: apt-get could not install" >&2\n'
                                                    'exit "$rc"\n' % NEW_APP),
            'SWC_GPGV': tool(b / 'gpgv', 'exit "${GPGV_RC:-0}"\n'),
            'SWC_CURL': tool(b / 'curl', 'while [ "$1" != -o ]; do shift; done\necho "curl $3" >> "$LOG"\n'
                                         'case "$3" in *.asc) echo sig > "$2" ;; *) cat "%s" > "$2" ;; esac\n'
                                         % (d / 'release.deb')),
        }

    def run_script(self, sha=DEB_SHA, **extra):
        env = dict(self.env, V=NEW_APP, SHA_AMD64=sha, SHA_ARM64='0' * 64, **extra)
        result = subprocess.run(['sh', '-s'], input=(HERE / 'desktop_app_update_linux.sh').read_text(), env=env,
                                capture_output=True, text=True, timeout=60)
        lines = result.stdout.splitlines()
        return result.returncode, lines[-1] if lines else '', self.log.read_text()

    def app(self):
        process = subprocess.Popen(['sleep', '60'])
        self.addCleanup(process.kill)
        self.pids.write_text('%d\n' % process.pid)
        return process

    def test_no_studio_package_is_nothing_to_do(self):
        self.state.write_text('')
        code, last, log = self.run_script()
        self.assertEqual((code, last), (0, 'RESULT before=none after=none how=no-desktop-app relaunched=no'))
        self.assertEqual(log, '')

    def test_already_on_the_version_or_newer_changes_nothing(self):
        for installed in (NEW_APP, '1.0.300'):
            self.state.write_text(installed)
            code, last, log = self.run_script()
            self.assertEqual(code, 0)
            self.assertIn('how=already-current', last)
            self.assertIn('after=%s' % installed, last)
            self.assertNotIn('helper', log)

    def test_a_missing_helper_is_named_before_anything_is_downloaded(self):
        code, last, log = self.run_script(SWC_HELPER=str(self.dir / 'nope'))
        self.assertEqual(code, 7)
        self.assertTrue(last.startswith('FAIL the signed update helper %s is missing' % (self.dir / 'nope')), last)
        self.assertNotIn('curl', log)

    def test_polkit_wanting_a_password_is_named_and_nothing_is_quit(self):
        app = self.app()
        code, last, log = self.run_script(PKCHECK_RC='1')
        self.assertEqual(code, 7)
        self.assertIn('polkit does not allow com.specwithcode.studio.update without a password', last)
        self.assertIsNone(app.poll())
        self.assertNotIn('curl', log)
        # pkcheck asks about a shell in the user's manager, never this SSH session.
        self.assertRegex(log, r'pkcheck --action-id com.specwithcode.studio.update --process [0-9]+')

    def test_installs_through_the_helper_and_reads_the_version_back(self):
        code, last, log = self.run_script()
        self.assertEqual((code, last), (0, 'RESULT before=%s after=%s how=helper relaunched=no' % (OLD_APP, NEW_APP)))
        deb = self.dir / 'cache' / ('SpecWithCode-%s-amd64.deb' % NEW_APP)
        self.assertIn('helper %s %s.asc' % (deb, deb), log)
        self.assertFalse(deb.exists())  # The cache is emptied once the version is read back.

    def test_a_running_app_is_quit_installed_under_and_reopened(self):
        app = self.app()
        code, last, log = self.run_script()
        self.assertEqual(code, 0)
        self.assertEqual(last, 'RESULT before=%s after=%s how=helper relaunched=yes' % (OLD_APP, NEW_APP))
        self.assertIsNotNone(app.poll())
        self.assertIn('systemd-run --user --quiet --collect -- /opt/SpecWithCode/specweave-studio-desktop', log)

    def test_a_dry_run_checks_everything_and_changes_nothing(self):
        app = self.app()
        code, last, log = self.run_script(DRY_RUN='1')
        self.assertEqual((code, last), (0, 'RESULT before=%s after=%s how=dry-run relaunched=no' % (OLD_APP, OLD_APP)))
        self.assertIsNone(app.poll())
        self.assertIn('curl', log)
        self.assertNotIn('helper', log)
        self.assertEqual(self.state.read_text().strip(), OLD_APP)

    def test_a_wrong_sha256_or_signature_installs_nothing(self):
        app = self.app()
        for extra, reason in (({'sha': 'f' * 64}, "the downloaded .deb's sha256 is %s" % DEB_SHA),
                              ({'GPGV_RC': '1'}, 'signature does not verify')):
            code, last, log = self.run_script(**extra)
            self.assertEqual(code, 3)
            self.assertIn(reason, last)
            self.assertNotIn('helper', log)
            self.assertIsNone(app.poll())

    def test_a_refused_install_or_wrong_read_back_fails_and_reopens_the_app(self):
        for extra, reason in (({'HELPER_RC': '67'}, 'the update helper refused'),
                              ({'HELPER_NOOP': '1'}, 'dpkg reads back %s after the install, not %s' % (OLD_APP, NEW_APP))):
            self.log.write_text('')
            self.app()
            code, last, log = self.run_script(**extra)
            self.assertEqual(code, 5, last)
            self.assertIn(reason, last)
            self.assertIn('/opt/SpecWithCode/specweave-studio-desktop', log)

    def test_rollout_reads_the_result_and_refuses_a_wrong_version(self):
        import desktop_app_rollout
        said = []
        desktop = desktop_app_rollout.LinuxDesktopApp(NEW_APP, repo='o/r', sums=lambda: ({'amd64': DEB_SHA}, 'sums'),
                                                      env=dict(self.env), timeout=60)
        result = desktop('lx1', ['/bin/sh', '-c'], said.append)
        self.assertEqual(result, {'result': 'helper', 'before': OLD_APP, 'after': NEW_APP, 'relaunched': 'no'})
        self.assertIn('lx1: desktop app %s -> %s: installed through the signed update helper' % (OLD_APP, NEW_APP),
                      said)
        self.state.write_text(OLD_APP)
        desktop.env = dict(self.env, SWC_HELPER=str(self.dir / 'nope'))
        with self.assertRaises(desktop_app_rollout.DesktopAppError) as caught:
            desktop('lx1', ['/bin/sh', '-c'], said.append)
        self.assertIn('the signed update helper', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
