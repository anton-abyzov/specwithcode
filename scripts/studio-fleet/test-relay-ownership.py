"""Fixture-only runtime ownership and quiescence contract; no live service reads."""
import copy
import ctypes
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import quiescence as q
import relay_ownership as r

REALPATH = os.path.realpath  # Captured before setUp replaces it with an identity stub.

spec = importlib.util.spec_from_file_location('relay_fixture', Path(__file__).with_name('test-quiescence.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class Ownership(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='relay-ownership-')
        self.addCleanup(self.tmp.cleanup)
        self.home = str(Path(self.tmp.name).resolve())
        (Path(self.home) / 'userdata').mkdir(mode=0o700)
        self.file = Path(self.home) / 'userdata' / r.NAME
        self.exe = '/opt/homebrew/bin/cloudflared'
        self.uid = os.getuid()
        self.identities = {
            100: {'pid': 100, 'parent': 1, 'uid': self.uid, 'birth': [100000, 1], 'executable': fixture.NODE},
            400: {'pid': 400, 'parent': 100, 'uid': self.uid, 'birth': [100001, 2], 'executable': self.exe},
        }
        for value in self.identities.values():
            value.update(ttyDevice=r.NODEV, ttyFlags=0, ttyProcessGroup=0)
        self.argv = [self.exe] + r.ARGS
        self.patch(patch.object(r, 'kernel_identity', side_effect=lambda pid: copy.deepcopy(self.identities[pid])))
        self.patch(patch.object(r, 'kernel_argv', side_effect=lambda pid: list(self.argv)))
        self.patch(patch.object(r.os, 'getppid', return_value=100))
        self.patch(patch.object(r.os.path, 'realpath', side_effect=lambda path, **kw: str(path)))
        self.publish()

    def patch(self, target):
        value = target.start()
        self.addCleanup(target.stop)
        return value

    def publish(self, generation='one'):
        r.publish(self.home, 100, 400, self.exe, generation)

    def descendants(self):
        return [{'pid': 400, 'parent': 100, 'uid': self.uid, 'startedAt': fixture.START, 'executable': self.exe}]

    def proved(self, values=None):
        return r.recorded_pid(self.home, 100, self.uid, values or self.descendants())

    def rewrite(self, mutate):
        record = json.loads(self.file.read_text())
        mutate(record)
        self.file.write_text(json.dumps(record))

    def test_published_receipt_is_private_exact_and_contains_no_token(self):
        self.assertEqual(self.proved(), 400)
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o600)
        value = self.file.read_text()
        self.assertNotIn('token', value.lower())
        self.assertEqual(json.loads(value)['child']['birth'], [100001, 2])

    def test_missing_or_forged_path_does_not_exempt_direct_child(self):
        self.rewrite(lambda v: v['child'].update(executable='/tmp/cloudflared'))
        self.assertIsNone(self.proved())
        self.file.unlink()
        self.assertIsNone(self.proved())

    def test_same_pid_same_second_different_birth_is_refused(self):
        for pid in (100, 400):
            with self.subTest(pid=pid):
                self.identities[pid]['birth'][1] += 1
                self.assertIsNone(self.proved())
                self.identities[pid]['birth'][1] -= 1

    def test_direct_service_child_with_a_controlling_terminal_is_not_infrastructure(self):
        for pid in (100, 400):
            for field, value in [('ttyDevice', 123), ('ttyFlags', 0x40), ('ttyFlags', 0x80), ('ttyProcessGroup', 400)]:
                with self.subTest(pid=pid, field=field, value=value):
                    old = self.identities[pid][field]
                    self.identities[pid][field] = value
                    self.assertIsNone(self.proved())
                    with self.assertRaises(AssertionError):
                        self.publish()
                    self.identities[pid][field] = old

    def test_record_schema_owner_home_argv_and_generation_are_strict(self):
        cases = [lambda v: v.update(version=True), lambda v: v.update(version=2),
                 lambda v: v.update(home='/different'), lambda v: v.update(generation=''),
                 lambda v: v['child'].update(uid=0), lambda v: v['child'].update(parent=1),
                 lambda v: v['service'].update(pid=999), lambda v: v['argv'].append('--url'),
                 lambda v: v.update(extra=True), lambda v: v['child'].update(birth=[True, 2])]
        original = self.file.read_bytes()
        for change in cases:
            with self.subTest(change=change):
                self.file.write_bytes(original)
                self.rewrite(change)
                self.assertIsNone(self.proved())

    def test_user_pty_descendant_uid_and_kernel_argv_refuse(self):
        for field, value in [('parent', 200), ('uid', self.uid + 1), ('executable', '/tmp/cloudflared')]:
            values = self.descendants()
            values[0][field] = value
            self.assertIsNone(self.proved(values))
        nested = self.descendants() + [{'pid': 401, 'parent': 400}]
        self.assertIsNone(self.proved(nested))
        self.argv.append('--metrics')
        self.assertIsNone(self.proved())

    def test_receipt_replacement_during_kernel_inventory_refuses(self):
        calls = 0
        def changed(pid):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.rewrite(lambda v: v.update(generation='replaced'))
            return copy.deepcopy(self.identities[pid])
        with patch.object(r, 'kernel_identity', side_effect=changed):
            self.assertIsNone(self.proved())

    def test_kernel_change_between_reads_refuses(self):
        calls = 0
        def changed(pid):
            nonlocal calls
            calls += 1
            value = copy.deepcopy(self.identities[pid])
            if calls == 4:
                value['birth'][1] += 1
            return value
        with patch.object(r, 'kernel_identity', side_effect=changed):
            self.assertIsNone(self.proved())

    def test_symlink_hardlink_public_and_malformed_receipts_refuse(self):
        original = self.file.read_bytes()
        self.file.chmod(0o644)
        self.assertIsNone(self.proved())
        self.file.chmod(0o600)
        other = self.file.with_name('other')
        os.link(self.file, other)
        self.assertIsNone(self.proved())
        self.file.unlink()
        self.file.symlink_to(other)
        self.assertIsNone(self.proved())
        self.file.unlink()
        self.file.write_bytes(b'{')
        self.file.chmod(0o600)
        self.assertIsNone(self.proved())
        self.file.write_bytes(original)
        self.assertEqual(self.proved(), 400)

    def test_only_matching_service_generation_clears_record(self):
        self.publish('two')
        with self.assertRaises(AssertionError):
            r.clear(self.home, 100, 400, 'one')
        self.assertEqual(self.proved(), 400)
        self.identities[100]['birth'][1] += 1
        with self.assertRaises(AssertionError):
            r.clear(self.home, 100, 400, 'two')
        self.identities[100]['birth'][1] -= 1
        r.clear(self.home, 100, 400, 'two')
        self.assertFalse(self.file.exists())

    def test_publisher_requires_the_service_as_its_actual_parent(self):
        with patch.object(r.os, 'getppid', return_value=200):
            with self.assertRaises(AssertionError):
                self.publish()

    def test_write_contention_refuses_without_waiting_or_replacing_current_generation(self):
        lock = os.open(str(Path(self.home) / 'userdata' / '.relay-process.lock'), os.O_RDWR)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.publish('two')
            with self.assertRaises(BlockingIOError):
                r.clear(self.home, 100, 400, 'one')
            self.assertEqual(json.loads(self.file.read_text())['generation'], 'one')
        finally:
            os.close(lock)

    def test_user_writable_or_symlink_state_directory_cannot_supply_proof(self):
        state = self.file.parent
        state.chmod(0o777)
        self.assertIsNone(self.proved())
        state.chmod(0o700)
        moved = state.with_name('other-state')
        state.rename(moved)
        state.symlink_to(moved)
        self.assertIsNone(self.proved())

    def test_reap_does_not_signal_recorded_relay_or_unrelated_daemon(self):
        values = fixture.fixture()
        values[400] = self.descendants()[0]
        values[110] = fixture.process(110, 100, '/bin/zsh')
        values[500] = fixture.process(500, 1, self.exe)
        table = fixture.Table(values, lambda tab, pid, number: tab.values.pop(pid, None))
        arguments = lambda pid: self.argv if pid == 400 else fixture.ARGS
        with patch.object(q, 'studio_home_of', return_value=self.home):
            q.reap_descendants(100, self.uid, fixture.NODE, fixture.ARGS,
                process_reader=table.read, argv_reader=arguments, executable_reader=table.executable,
                signaler=table.signal, clock=lambda: table.now, sleeper=table.sleep)
        self.assertEqual([pid for pid, _ in table.signals], [110])
        self.assertIn(400, table.values)
        self.assertIn(500, table.values)

    def test_actual_quiescence_accepts_only_recorded_fallback_and_never_signals_it(self):
        values = fixture.fixture()
        values[400] = self.descendants()[0]
        arguments = lambda pid: self.argv if pid == 400 else fixture.ARGS
        with patch.object(q, 'studio_home_of', return_value=self.home):
            proof = q.capture_quiescence(100, self.uid, fixture.NODE, fixture.ARGS,
                process_reader=lambda: copy.deepcopy(values), argv_reader=arguments,
                executable_reader=lambda pid: values[pid]['executable'])
            table = fixture.Table(values)
            q.assert_quiescence(proof, fixture.NODE, fixture.ARGS, process_reader=table.read,
                argv_reader=arguments, executable_reader=table.executable,
                signaler=table.signal, clock=lambda: table.now, sleeper=table.sleep)
            self.assertEqual(table.signals, [])
            self.assertEqual(q.managed_tunnel_pids(values, 100, self.home, self.descendants()), {400})
            self.file.unlink()
            with self.assertRaisesRegex(AssertionError, 'unexpected'):
                q.capture_quiescence(100, self.uid, fixture.NODE, fixture.ARGS,
                    process_reader=lambda: copy.deepcopy(values), argv_reader=arguments,
                    executable_reader=lambda pid: values[pid]['executable'])

    def test_homebrew_symlink_listed_by_ps_and_resolved_by_kernel_is_admitted(self):
        # Homebrew: ps lists argv[0], the /opt/homebrew/bin symlink; proc_pidpath reports
        # the resolved Cellar file. Real symlinks and the real realpath, no identity stub.
        links = tempfile.TemporaryDirectory(prefix='relay-homebrew-')
        self.addCleanup(links.cleanup)
        root = Path(REALPATH(links.name))  # Path.resolve uses the stubbed realpath.
        target = root / 'Cellar' / 'cloudflared' / '2026.10.0' / 'bin' / 'cloudflared'
        target.parent.mkdir(parents=True)
        target.write_text('')
        link = root / 'bin' / 'cloudflared'
        link.parent.mkdir()
        link.symlink_to(target)
        self.exe = str(link)
        self.argv = [self.exe] + r.ARGS
        self.identities[400]['executable'] = str(target)
        self.file.unlink()
        values = fixture.fixture()
        values[400] = self.descendants()[0]
        self.assertEqual(values[400]['executable'], str(link))
        arguments = lambda pid: self.argv if pid == 400 else fixture.ARGS
        kernel = lambda pid: str(target) if pid == 400 else values[pid]['executable']
        with patch.object(r.os.path, 'realpath', REALPATH):
            self.publish()
            self.assertEqual(json.loads(self.file.read_text())['child']['executable'], str(target))
            self.assertEqual(self.proved(), 400)
            with patch.object(q, 'studio_home_of', return_value=self.home):
                proof, _, others = q._capture(100, self.uid, fixture.NODE, fixture.ARGS,
                    lambda: copy.deepcopy(values), arguments, kernel)
                self.assertEqual(others, [])
                self.assertEqual(proof['descendantCount'], 1)
                table = fixture.Table(values)
                q.assert_quiescence(proof, fixture.NODE, fixture.ARGS, process_reader=table.read,
                    argv_reader=arguments, executable_reader=kernel,
                    signaler=table.signal, clock=lambda: table.now, sleeper=table.sleep)
                self.assertEqual(table.signals, [])
                # Still fail closed: a kernel file that is not the listed symlink's target refuses.
                with self.assertRaisesRegex(AssertionError, 'unexpected'):
                    q._capture(100, self.uid, fixture.NODE, fixture.ARGS, lambda: copy.deepcopy(values),
                        arguments, lambda pid: '/tmp/cloudflared' if pid == 400 else values[pid]['executable'])
                # And a listed symlink resolving elsewhere never proves the recorded child.
                link.unlink()
                link.symlink_to(root / 'other-cloudflared')
                self.assertIsNone(self.proved())
                with self.assertRaisesRegex(AssertionError, 'unexpected'):
                    q._capture(100, self.uid, fixture.NODE, fixture.ARGS,
                        lambda: copy.deepcopy(values), arguments, kernel)


class KernelDecoder(unittest.TestCase):
    def test_bsdinfo_rejects_each_controlling_terminal_indicator(self):
        class Library:
            tty = r.NODEV
            group = 0
            flags = 0
            def proc_pidinfo(self, pid, flavor, arg, address, size):
                info = ctypes.cast(address, ctypes.POINTER(r.BsdInfo)).contents
                info.pid, info.parent, info.uid = pid, 100, 501
                info.seconds, info.micros = 1000, 21
                info.tdev, info.tpgid, info.flags = self.tty, self.group, self.flags
                return ctypes.sizeof(r.BsdInfo)
            def proc_pidpath(self, pid, buffer, size):
                buffer.value = b'/opt/homebrew/bin/cloudflared'
                return len(buffer.value)
        library = Library()
        with patch.object(r.sys, 'platform', 'darwin'), patch.object(r.ctypes, 'CDLL', return_value=library):
            self.assertEqual(r.kernel_identity(400)['birth'], [1000, 21])
            for field, value in [('tty', 123), ('group', 400), ('flags', 0x40), ('flags', 0x80)]:
                original = getattr(library, field)
                setattr(library, field, value)
                with self.subTest(field=field), self.assertRaises(AssertionError):
                    r.kernel_identity(400)
                setattr(library, field, original)


if __name__ == '__main__':
    unittest.main()
