#!/usr/bin/env python3
"""Meaningful integrity regressions; all writes use owned temporary fake homes."""
import hashlib
import io
import json
import os
import pathlib
import shlex
import subprocess
import sys
import tarfile
import tempfile
import unittest
from launcher import runtime_path

NODE = pathlib.Path(os.environ['STUDIO_TEST_NODE']).resolve(strict=True)
INSTALL = pathlib.Path(__file__).with_name('install.py')

class InstallerIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='studio-installer-test-')
        self.root = pathlib.Path(self.temp.name).resolve()
        self.home = self.root / 'home'
        self.home.mkdir()
        self.archive = self.root / 'studio.tar.gz'

    def tearDown(self):
        self.temp.cleanup()

    def bundle(self, extra=None, cli_bytes=b'// owned fixture\n', version='0.1.0', metadata=None, package_version=None):
        files = {'bin.mjs': cli_bytes, 'LICENSE': b'MIT fixture\n',
                 'UPSTREAM.md': b'Provenance fixture\n', 'third-party-licenses.json': b'{}\n',
                 'client/third-party-licenses.json': b'{}\n'}
        if version != '0.1.0':
            files['package.json'] = json.dumps({'name': 'specweave-studio', 'version': package_version or version}).encode()
        manifest = {'product': 'SpecWeave Studio', 'version': version, 'sourceCommit': 'fixture',
                    'resourceTelemetry': 'unavailable', 'files': [
                        {'path': name, 'type': 'file', 'sha256': hashlib.sha256(data).hexdigest()}
                        for name, data in files.items()]}
        if version != '0.1.0':
            manifest.update(schemaVersion=1, sourceCommit='a' * 40, lockSha256='b' * 64, runtime='Node22.20.0', noAuthOrUserStores=True)
        if metadata:
            manifest.update(metadata)
        files['studio-manifest.json'] = json.dumps(manifest).encode()
        with tarfile.open(str(self.archive), 'w:gz') as tar:
            for name, data in files.items():
                info = tarfile.TarInfo('./' + name)
                info.size = len(data)
                info.mode = 0o600
                tar.addfile(info, io.BytesIO(data))
            if extra:
                extra(tar)
        return hashlib.sha256(self.archive.read_bytes()).hexdigest()

    def install(self, digest, extra_args=(), mock_service=False):
        env = {'HOME': str(self.home), 'PATH': '/usr/bin:/bin', 'LANG': 'en_US.UTF-8'}
        # Service-path fixtures may write a fake plist, but never contact launchd.
        runner = '''import runpy,subprocess,sys,os,pwd,types
account = pwd.getpwuid(os.getuid())
pwd.getpwuid = lambda uid: types.SimpleNamespace(pw_name=account.pw_name, pw_dir=os.environ["HOME"])
original = subprocess.run
def run(command, *args, **kwargs):
    if command[0] == '/bin/launchctl':
        print('MOCK_LAUNCHCTL:' + command[1], file=sys.stderr)
        return subprocess.CompletedProcess(command, 1 if command[1] == 'print' else 0)
    return original(command, *args, **kwargs)
subprocess.run = run
install = sys.argv[1]
sys.path.insert(0, str(__import__('pathlib').Path(install).parent))
sys.argv = sys.argv[1:]
runpy.run_path(install, run_name='__main__')
'''
        prefix = [sys.executable, '-B', '-c', runner] if mock_service else [sys.executable, '-B']
        return subprocess.run([*prefix, str(INSTALL), '--archive', str(self.archive),
                               '--sha256', digest, '--node', str(NODE), '--identity', 'm4' if mock_service else 'stage',
                               '--port', '19320', *extra_args], capture_output=True, text=True, env=env)

    def inventory(self, root):
        result = {}
        for path in root.rglob('*'):
            name = str(path.relative_to(root))
            if path.is_symlink():
                result[name] = ('symlink', os.readlink(str(path)))
            elif path.is_file():
                result[name] = ('file', hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mode & 0o777)
            else:
                result[name] = ('directory', path.stat().st_mode & 0o777)
        return result

    def redirected_destination(self, relative, destination, digest, flags, dangling=False):
        with tempfile.TemporaryDirectory(prefix='destination-', dir=str(self.root)) as name:
            fixture = pathlib.Path(name)
            previous_home = self.home
            self.home = fixture / 'home'
            self.home.mkdir()
            try:
                target = self.home / destination if destination.startswith('.') or destination == 'real-parent' else fixture / destination
                if not dangling:
                    target.mkdir(parents=True)
                    (target / 'original.txt').write_text('preserved fixture')
                link = self.home / relative
                link.parent.mkdir(parents=True, exist_ok=True)
                link.symlink_to(target, target_is_directory=True)
                before = self.inventory(fixture)
                result = self.install(digest, flags, mock_service='--service' in flags)
                self.assertNotEqual(result.returncode, 0, 'A redirected installer destination was accepted')
                self.assertEqual(self.inventory(fixture), before, 'Installer mutated state or a redirected destination before rejecting')
                self.assertNotIn('MOCK_LAUNCHCTL:', result.stderr, 'Destination validation must precede service operations')
            finally:
                self.home = previous_home

    def assert_rejected(self, result):
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.home / '.specweave-studio/stage').exists())
        self.assertFalse((self.root / 'outside').exists())

    def test_02_installs_matching_provenance_and_preserves_version(self):
        result = self.install(self.bundle(version='0.2.0'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['version'], '0.2.0')

    def test_011_installs_matching_provenance_and_preserves_version(self):
        result = self.install(self.bundle(version='0.1.1'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['version'], '0.1.1')

    def test_stable_1_0_installs_matching_provenance_and_preserves_version(self):
        result = self.install(self.bundle(version='1.0.0'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['version'], '1.0.0')

    def test_02_invalid_identity_is_rejected_before_any_write(self):
        cases = [('unknown-version', '0.3.0', None, None),
                 ('unknown-major', '2.0.0', None, None),
                 ('patch-source', '0.1.1', {'sourceCommit': 'unverified'}, None),
                 ('package-version', '0.2.0', None, '0.1.0'),
                 ('source', '0.2.0', {'sourceCommit': 'unverified'}, None),
                 ('lock', '0.2.0', {'lockSha256': 'unverified'}, None),
                 ('user-stores', '0.2.0', {'noAuthOrUserStores': False}, None),
                 ('runtime', '0.2.0', {'runtime': 'Node24'}, None)]
        for name, version, metadata, package in cases:
            with self.subTest(case=name):
                before = self.inventory(self.home)
                result = self.install(self.bundle(version=version, metadata=metadata, package_version=package))
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.inventory(self.home), before)

    def test_wrong_archive_digest_creates_no_installation(self):
        self.bundle()
        self.assert_rejected(self.install('0' * 64))
        self.assertFalse((self.home / '.local').exists())

    def test_composed_link_cannot_escape_during_extraction(self):
        def extra(tar):
            for name, target in [('b', '.'), ('a', 'b/../outside')]:
                info = tarfile.TarInfo('./' + name)
                info.type = tarfile.SYMTYPE
                info.linkname = target
                tar.addfile(info)
        self.assert_rejected(self.install(self.bundle(extra)))

    def test_absolute_link_is_rejected_before_extraction(self):
        def extra(tar):
            info = tarfile.TarInfo('./absolute-link')
            info.type = tarfile.SYMTYPE
            info.linkname = str(self.root / 'outside')
            tar.addfile(info)
        self.assert_rejected(self.install(self.bundle(extra)))

    def test_unindexed_extra_file_is_rejected(self):
        def extra(tar):
            info = tarfile.TarInfo('./unindexed-code.mjs')
            info.size = 1
            tar.addfile(info, io.BytesIO(b'x'))
        rejected = self.install(self.bundle(extra))
        self.assert_rejected(rejected)
        self.assertIn('Unindexed archive member', rejected.stderr)

    def test_file_below_a_link_is_rejected_before_extraction(self):
        def extra(tar):
            info = tarfile.TarInfo('./link')
            info.type = tarfile.SYMTYPE
            info.linkname = '.'
            tar.addfile(info)
            info = tarfile.TarInfo('./link/payload')
            info.size = 1
            tar.addfile(info, io.BytesIO(b'x'))
        self.assert_rejected(self.install(self.bundle(extra)))

    def test_duplicate_tar_entries_are_rejected(self):
        def extra(tar):
            info = tarfile.TarInfo('./bin.mjs')
            info.size = 1
            tar.addfile(info, io.BytesIO(b'x'))
        self.assert_rejected(self.install(self.bundle(extra)))

    def test_manifest_reuse_is_anchored_to_verified_archive(self):
        digest = self.bundle()
        result = self.install(digest)
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        own = self.home / '.specweave-studio/stage'
        own.rename(own.with_name('preserved-first-install'))
        release = pathlib.Path(receipt['release'])
        (release / 'bin.mjs').write_text('// altered bytes\n')
        manifest = json.loads((release / 'studio-manifest.json').read_text())
        manifest['files'][0]['sha256'] = hashlib.sha256((release / 'bin.mjs').read_bytes()).hexdigest()
        (release / 'studio-manifest.json').write_text(json.dumps(manifest))
        rejected = self.install(digest)
        self.assert_rejected(rejected)
        self.assertIn('Existing manifest differs', rejected.stderr)

    def test_reused_release_rejects_unindexed_extra_files(self):
        digest = self.bundle()
        result = self.install(digest)
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        own = self.home / '.specweave-studio/stage'
        own.rename(own.with_name('preserved-first-install'))
        (pathlib.Path(receipt['release']) / 'unindexed-code.mjs').write_text('// unexpected\n')
        rejected = self.install(digest)
        self.assert_rejected(rejected)
        self.assertIn('Unindexed existing release file', rejected.stderr)

    def test_symlinked_studio_roots_do_not_write_native_store(self):
        digest = self.bundle()
        protected = self.home / '.codex'
        protected.mkdir()
        original = protected / 'original.txt'
        original.write_text('preserved fixture')
        for relative in ['.specweave-studio', '.local/share/specweave-studio', '.local/share/specweave-studio/releases']:
            with self.subTest(root=relative):
                link = self.home / relative
                link.parent.mkdir(parents=True, exist_ok=True)
                link.symlink_to(protected, target_is_directory=True)
                result = self.install(digest)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('symlink ancestor', result.stderr)
                self.assertEqual(original.read_text(), 'preserved fixture')
                self.assertEqual(sorted(path.name for path in protected.iterdir()), ['original.txt'])
                link.unlink()

    def test_cli_parent_redirects_are_rejected_before_any_write(self):
        digest = self.bundle()
        for target in ['.codex', '.claude', 'outside', 'real-parent']:
            with self.subTest(target=target):
                self.redirected_destination('.local/bin', target, digest, ('--install-cli',))

    def test_library_and_launchagents_redirects_are_rejected_before_any_write(self):
        digest = self.bundle()
        for relative in ['Library', 'Library/LaunchAgents']:
            for target in ['.codex', '.claude', 'outside', 'real-parent']:
                with self.subTest(parent=relative, target=target):
                    self.redirected_destination(relative, target, digest, ('--service', '--install-cli'))

    def test_dangling_destination_links_are_rejected_before_any_write(self):
        digest = self.bundle()
        for relative, flags in [('.local/bin', ('--install-cli',)), ('Library', ('--service',)),
                                ('Library/LaunchAgents', ('--service',))]:
            with self.subTest(parent=relative):
                self.redirected_destination(relative, 'missing-target', digest, flags, dangling=True)

    def test_destination_file_aliases_are_rejected_before_any_write(self):
        digest = self.bundle()
        for relative, flags in [('.local/bin/specweave-studio', ('--install-cli',)),
                                ('.local/bin/specwithcode', ('--install-cli',)),
                                ('Library/LaunchAgents/com.specweave.studio.m4.plist', ('--service',))]:
            with self.subTest(destination=relative):
                self.redirected_destination(relative, '.codex', digest, flags)

    def test_non_directory_destination_parents_are_rejected_before_any_write(self):
        digest = self.bundle()
        for relative, flags in [('.local/bin', ('--install-cli',)), ('Library', ('--service',)),
                                ('Library/LaunchAgents', ('--service',))]:
            with self.subTest(parent=relative):
                with tempfile.TemporaryDirectory(prefix='parent-file-', dir=str(self.root)) as name:
                    fixture = pathlib.Path(name)
                    previous_home = self.home
                    self.home = fixture / 'home'
                    self.home.mkdir()
                    try:
                        path = self.home / relative
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_text('preserved parent file')
                        before = self.inventory(fixture)
                        result = self.install(digest, flags, mock_service='--service' in flags)
                        self.assertNotEqual(result.returncode, 0)
                        self.assertEqual(self.inventory(fixture), before)
                        self.assertNotIn('MOCK_LAUNCHCTL:', result.stderr)
                    finally:
                        self.home = previous_home

    def test_real_cli_and_launchagents_directories_accept_isolated_install(self):
        (self.home / '.local/bin').mkdir(parents=True)
        (self.home / 'Library/LaunchAgents').mkdir(parents=True)
        result = self.install(self.bundle(), ('--install-cli', '--service'), mock_service=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertTrue((self.home / '.local/bin/specweave-studio').is_file())
        self.assertTrue((self.home / 'Library/LaunchAgents/com.specweave.studio.m4.plist').is_file())
        self.assertTrue((self.home / '.specweave-studio/m4/installation.json').is_file())
        self.assertEqual(receipt['service']['domain'], 'gui/' + str(os.getuid()))
        self.assertEqual(result.stderr.count('MOCK_LAUNCHCTL:bootstrap'), 1)

    def test_fresh_install_uses_isolated_settings_and_clean_launcher(self):
        result = self.install(self.bundle())
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        own = self.home / '.specweave-studio/stage'
        settings = json.loads((own / 'userdata/settings.json').read_text())
        self.assertEqual(settings['defaultThreadEnvMode'], 'worktree')
        self.assertEqual(settings['defaultRuntimeMode'], 'approval-required')
        launcher = (own / 'launch.sh').read_text()
        path_tokens = [part for part in shlex.split(launcher.splitlines()[4]) if part.startswith('PATH=')]
        self.assertEqual(path_tokens, ['PATH=' + runtime_path(self.home.resolve(), NODE)])
        self.assertIn('/usr/bin/env -i', launcher)
        self.assertIn('STUDIO_LOG_LEVEL=Warn', launcher)
        self.assertIn('STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false', launcher)
        self.assertEqual(receipt['startup'], {'autoBootstrapProjectFromCwd': False, 'presentation': 'overview'})
        self.assertEqual((own / 'userdata/settings.json').stat().st_mode & 0o777, 0o600)
        self.assertFalse(receipt['nativeCredentialStoresCopied'])
        self.assertFalse(receipt['originalServicesChanged'])
        self.assertEqual(self.install(receipt['archiveSha256']).returncode, 1)

    def test_service_only_false_does_not_override_cli_project_or_deliberate_environment(self):
        cli = b'console.log(JSON.stringify({bootstrap:process.env.STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD??null,args:process.argv.slice(2)}));\n'
        result = self.install(self.bundle(cli_bytes=cli), ('--install-cli',))
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        launcher = (self.home / '.specweave-studio/stage/launch.sh').read_text()
        self.assertIn('STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false', launcher)
        wrapper = receipt['cliWrapper']
        for deliberate in [None, 'true', 'false']:
            env = {'PATH': '/usr/bin:/bin'}
            if deliberate is not None:
                env['STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD'] = deliberate
            call = subprocess.run([wrapper, 'start', '/explicit/project'], env=env, capture_output=True, text=True)
            self.assertEqual(call.returncode, 0, call.stderr)
            self.assertEqual(json.loads(call.stdout), {'bootstrap': deliberate, 'args': ['start', '/explicit/project']})
        rejected = subprocess.run([wrapper, 'start'], env={'STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD': 'false;unsafe'}, capture_output=True)
        self.assertEqual(rejected.returncode, 2)

    def test_cli_install_creates_specwithcode_launcher_with_the_same_wrapper(self):
        cli = b'console.log(JSON.stringify(process.argv.slice(2)));\n'
        result = self.install(self.bundle(cli_bytes=cli), ('--install-cli',))
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        wrapper = self.home / '.local/bin/specweave-studio'
        alias = self.home / '.local/bin/specwithcode'
        # The receipt keeps the identity wrapper; the alias carries the same bytes.
        self.assertEqual(receipt['cliWrapper'], str(wrapper.resolve()))
        self.assertTrue(alias.is_file() and not alias.is_symlink())
        self.assertEqual(alias.read_bytes(), wrapper.read_bytes())
        self.assertEqual(alias.stat().st_mode & 0o777, 0o700)
        call = subprocess.run([str(alias), 'skills', '--json'], env={'PATH': '/usr/bin:/bin'}, capture_output=True, text=True)
        self.assertEqual(call.returncode, 0, call.stderr)
        self.assertEqual(json.loads(call.stdout), ['skills', '--json'])

    def test_install_without_cli_creates_no_launchers(self):
        result = self.install(self.bundle())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.home / '.local/bin/specweave-studio').exists())
        self.assertFalse((self.home / '.local/bin/specwithcode').exists())

    def test_existing_specwithcode_file_is_rejected_before_any_write(self):
        digest = self.bundle()
        alias = self.home / '.local/bin/specwithcode'
        alias.parent.mkdir(parents=True)
        alias.write_text('#!/bin/sh\necho another tool\n')
        before = self.inventory(self.home)
        result = self.install(digest, ('--install-cli',))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('CLI alias already exists', result.stderr)
        self.assertEqual(self.inventory(self.home), before)

    def test_failed_alias_create_removes_the_first_launcher(self):
        # The alias appears between the existence checks and the write.
        # functools.partial is not a descriptor, so Python 3.9's pathlib accessor, which
        # stores os.open as a class attribute, keeps calling it unbound.
        runner = """import functools,os,runpy,sys
real_open = os.open
def racing_open(path, flags, *args, **kwargs):
    if str(path).endswith('/.local/bin/specwithcode'):
        with open(path, 'w') as handle:
            handle.write('appeared meanwhile')
    return real_open(path, flags, *args, **kwargs)
os.open = functools.partial(racing_open)
install = sys.argv[1]
sys.path.insert(0, os.path.dirname(install))
sys.argv = sys.argv[1:]
runpy.run_path(install, run_name='__main__')
"""
        env = {'HOME': str(self.home), 'PATH': '/usr/bin:/bin', 'LANG': 'en_US.UTF-8'}
        result = subprocess.run([sys.executable, '-B', '-c', runner, str(INSTALL), '--archive', str(self.archive),
                                 '--sha256', self.bundle(), '--node', str(NODE), '--identity', 'stage',
                                 '--port', '19320', '--install-cli'], capture_output=True, text=True, env=env)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('FileExistsError', result.stderr)
        self.assertFalse((self.home / '.local/bin/specweave-studio').exists())
        self.assertEqual((self.home / '.local/bin/specwithcode').read_text(), 'appeared meanwhile')

if __name__ == '__main__':
    unittest.main()
