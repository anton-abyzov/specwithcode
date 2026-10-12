#!/usr/bin/env python3
"""Clean launcher toolchain and real Git-hook regression in owned temporary homes."""
import os
import pathlib
import shlex
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import launcher
from launcher import legacy_runtime_path, runtime_path, migrate_runtime_path, render_cli


class LauncherToolchains(unittest.TestCase):
    def prefix(self, home, node, path):
        return ['/usr/bin/env', '-i', 'HOME=' + str(home), 'PATH=' + path,
                'STUDIO_MODE=web', str(node), str(home / 'release/bin.mjs')]

    def test_migrates_only_path_and_is_idempotent_with_spaces(self):
        home = pathlib.Path('/Users/owned fixture'); node = home / 'node22/bin/node'
        original = self.prefix(home, node, legacy_runtime_path(home, node))
        migrated = migrate_runtime_path(original, home, node)
        self.assertEqual([part for part in migrated if not part.startswith('PATH=')],
                         [part for part in original if not part.startswith('PATH=')])
        self.assertEqual(migrate_runtime_path(migrated, home, node), migrated)
        self.assertEqual(shlex.split(' '.join(shlex.quote(part) for part in migrated)), migrated)
        self.assertIn('/opt/homebrew/bin', runtime_path(home, node).split(':'))
        self.assertEqual(original[3], 'PATH=' + legacy_runtime_path(home, node))

    def test_missing_duplicate_custom_relative_and_empty_paths_are_rejected(self):
        home = pathlib.Path('/Users/owned'); node = home / 'node22/bin/node'
        original = self.prefix(home, node, legacy_runtime_path(home, node))
        cases = [original[:3] + original[4:], original[:4] + [original[3]] + original[4:]]
        cases += [self.prefix(home, node, value) for value in ['/custom/bin:/usr/bin', 'bin:/usr/bin', '/usr/bin::/bin', '']]
        for prefix in cases:
            with self.subTest(prefix=prefix), self.assertRaises(AssertionError):
                migrate_runtime_path(prefix, home, node)

    def test_rejects_unsafe_home_or_node_path_delimiters(self):
        for home, node in [(pathlib.Path('relative'), pathlib.Path('/node')),
                           (pathlib.Path('/Users/bad:home'), pathlib.Path('/node')),
                           (pathlib.Path('/Users/owned'), pathlib.Path('/bad\nnode'))]:
            with self.subTest(home=home, node=node), self.assertRaises(AssertionError):
                runtime_path(home, node)

    def test_no_parent_credentials_or_path_are_inherited(self):
        home = pathlib.Path('/Users/owned'); node = home / 'node22/bin/node'
        with patch.dict(os.environ, {'PATH': '/foreign/secret-path', 'OPENAI_API_KEY': 'fixture-private-key'}):
            script = render_cli(migrate_runtime_path(self.prefix(home, node, legacy_runtime_path(home, node)), home, node))
        self.assertNotIn('/foreign/secret-path', script)
        self.assertNotIn('fixture-private-key', script)
        self.assertIn('/usr/bin/env -i', script)

    def test_real_worktree_hook_fails_on_legacy_path_then_runs_through_clean_cli(self):
        with tempfile.TemporaryDirectory(prefix='studio-hook-fixture-') as temporary:
            home = pathlib.Path(temporary).resolve(); repo = home / 'repo'; repo.mkdir()
            node = home / 'node22/bin/node'; node.parent.mkdir(parents=True)
            node.write_text('#!/bin/sh\nexec /bin/sh "$@"\n'); node.chmod(0o700)
            entry = home / 'release/bin.mjs'; entry.parent.mkdir()
            entry.write_text('#!/bin/sh\nexec /usr/bin/git "$@"\n')
            lfs = home / '.local/bin/git-lfs'; lfs.parent.mkdir(parents=True)
            lfs.write_text('#!/bin/sh\nprintf "hook-ran\\n" >> "$HOME/hook-ran"\n'); lfs.chmod(0o700)
            hooks = home / 'hooks'; hooks.mkdir(); hook = hooks / 'post-checkout'
            hook.write_text('#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || { printf "git-lfs missing\\n" >&2; exit 2; }\ngit lfs post-checkout "$@"\n'); hook.chmod(0o700)
            original_hook = hook.read_bytes()
            env = {'HOME': str(home), 'PATH': '/usr/bin:/bin', 'LANG': 'C'}
            for args in [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Owned fixture'],
                         ['config', 'user.email', 'fixture@example.invalid'], ['commit', '-q', '--allow-empty', '-m', 'Owned fixture'],
                         ['config', 'core.hooksPath', str(hooks)]]:
                subprocess.run(['/usr/bin/git', *args], cwd=repo, env=env, check=True, capture_output=True)
            prefix = self.prefix(home, node, legacy_runtime_path(home, node))
            cli = home / 'owned-cli'; cli.write_text(render_cli(prefix)); cli.chmod(0o700)
            old = subprocess.run([str(cli), 'worktree', 'add', '-b', 'legacy', str(home / 'legacy')], cwd=repo, env=env, capture_output=True)
            self.assertNotEqual(old.returncode, 0)
            self.assertIn(b'git-lfs missing', old.stderr)
            self.assertTrue((home / 'legacy/.git').is_file())  # Git created it before its hook failed.
            cli.write_text(render_cli(migrate_runtime_path(prefix, home, node)))
            new = subprocess.run([str(cli), 'worktree', 'add', '-b', 'fixed', str(home / 'fixed')], cwd=repo, env=env, capture_output=True)
            self.assertEqual(new.returncode, 0, new.stderr.decode())
            self.assertTrue((home / 'fixed/.git').is_file())
            self.assertEqual((home / 'hook-ran').read_text(), 'hook-ran\n')
            self.assertEqual(hook.read_bytes(), original_hook)


class LauncherNames(unittest.TestCase):
    def test_both_launcher_names_reach_the_cli_as_the_name_typed(self):
        with tempfile.TemporaryDirectory(prefix='studio-cli-name-') as temporary:
            home = pathlib.Path(temporary).resolve()
            node = home / 'node22/bin/node'; node.parent.mkdir(parents=True)
            node.write_text('#!/bin/sh\nexec /bin/sh "$@"\n'); node.chmod(0o700)
            entry = home / '.local/share/specweave-studio/releases/abc/bin.mjs'; entry.parent.mkdir(parents=True)
            entry.write_text('#!/bin/sh\nprintf "%s|%s\\n" "${STUDIO_CLI_NAME-unset}" "$*"\n')
            prefix = ['/usr/bin/env', '-i', 'HOME=' + str(home), 'PATH=' + runtime_path(home, node), str(node), str(entry)]
            text = render_cli(prefix)
            bin_dir = home / '.local/bin'; bin_dir.mkdir(parents=True)
            for name in ['specweave-studio', 'specwithcode']:
                (bin_dir / name).write_text(text); (bin_dir / name).chmod(0o700)
            env = {'HOME': str(home), 'PATH': '/usr/bin:/bin', 'STUDIO_CLI_NAME': 'inherited-and-ignored'}
            for name in ['specweave-studio', 'specwithcode']:
                with self.subTest(name=name):
                    out = subprocess.run([str(bin_dir / name), '--version'], env=env, capture_output=True, text=True, check=True)
                    self.assertEqual(out.stdout, name + '|--version\n')
                    deliberate = subprocess.run([str(bin_dir / name), 'x'], env={**env, 'STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD': 'true'},
                                                capture_output=True, text=True, check=True)
                    self.assertEqual(deliberate.stdout, name + '|x\n')

    def test_every_wrapper_format_a_release_wrote_is_recognised_for_this_home_only(self):
        home = pathlib.Path('/Users/owned fixture'); node = home / 'node22/bin/node'
        prefix = ['/usr/bin/env', '-i', 'HOME=' + str(home), 'PATH=' + runtime_path(home, node), 'STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false',
                  str(node), str(home / '.local/share/specweave-studio/releases/0123456789abcdef0123/bin.mjs')]
        for render in [launcher.render_cli, launcher.render_unnamed_cli, launcher.render_legacy_cli]:
            with self.subTest(render=render.__name__):
                self.assertTrue(launcher.is_studio_wrapper(render(prefix).encode(), home))
                self.assertFalse(launcher.is_studio_wrapper(render(prefix).encode(), pathlib.Path('/Users/someone else')))
                self.assertFalse(launcher.is_studio_wrapper((render(prefix) + 'echo extra\n').encode(), home))
        other = prefix[:-1] + ['/opt/tool/releases/x/bin.mjs']
        self.assertFalse(launcher.is_studio_wrapper(launcher.render_unnamed_cli(other).encode(), home))
        self.assertFalse(launcher.is_studio_wrapper(b'#!/bin/sh\necho another tool\n', home))
        self.assertFalse(launcher.is_studio_wrapper(b'\xff\xfe', home))


class SwapCliAlias(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='studio-alias-swap-')
        self.dir = pathlib.Path(self.temp.name).resolve(); self.alias = self.dir / 'specwithcode'
        self.owned = {b'owned-old', b'owned-new'}

    def tearDown(self):
        self.temp.cleanup()

    def leftovers(self):
        return sorted(path.name for path in self.dir.iterdir() if path.name.startswith('.'))

    def test_creates_replaces_and_removes_only_its_own_text(self):
        self.assertEqual(launcher.swap_cli_alias(self.alias, b'owned-new', self.owned), ('created', None))
        self.assertEqual(self.alias.read_bytes(), b'owned-new'); self.assertEqual(self.alias.stat().st_mode & 0o777, 0o700)
        self.alias.write_bytes(b'owned-old')
        self.assertEqual(launcher.swap_cli_alias(self.alias, b'owned-new', self.owned), ('replaced', b'owned-old'))
        self.assertEqual(launcher.swap_cli_alias(self.alias, None, self.owned), ('removed', b'owned-new'))
        self.assertFalse(self.alias.exists())
        self.assertEqual(launcher.swap_cli_alias(self.alias, None, self.owned), ('absent', None))
        self.assertEqual(launcher.swap_cli_alias(self.alias, b'owned-old', self.owned, create=False), ('absent', None))
        self.assertFalse(self.alias.exists()); self.assertEqual(self.leftovers(), [])

    def test_a_failed_staging_write_leaves_no_staged_file(self):
        self.alias.write_bytes(b'owned-old')
        with patch.object(launcher.os, 'chmod', side_effect=OSError(28, 'No space left on device')):
            with self.assertRaises(OSError):
                launcher.swap_cli_alias(self.alias, b'owned-new', self.owned)
        self.assertEqual(self.alias.read_bytes(), b'owned-old'); self.assertEqual(self.leftovers(), [])

    def test_a_foreign_file_or_link_is_put_back_as_the_same_entry(self):
        target = self.dir / 'target'; target.write_text('another tool')
        for kind in ['file', 'link']:
            with self.subTest(kind=kind):
                if self.alias.is_symlink() or self.alias.exists(): self.alias.unlink()
                if kind == 'file': self.alias.write_text('another tool')
                else: self.alias.symlink_to(target)
                inode = os.lstat(self.alias).st_ino
                self.assertEqual(launcher.swap_cli_alias(self.alias, b'owned-new', self.owned), ('foreign', None))
                self.assertEqual(launcher.swap_cli_alias(self.alias, None, self.owned), ('foreign', None))
                self.assertEqual(os.lstat(self.alias).st_ino, inode); self.assertEqual(self.alias.is_symlink(), kind == 'link')
                self.assertEqual(target.read_text(), 'another tool'); self.assertEqual(self.leftovers(), [])

    def test_ownership_is_decided_on_the_entry_actually_replaced(self):
        # An earlier look saw our text; another tool replaces it just before the swap.
        self.alias.write_bytes(b'owned-old')
        real_rename = os.rename
        def raced(source, destination):
            if source == str(self.alias):
                os.unlink(source); pathlib.Path(source).write_text('another tool')
            return real_rename(source, destination)
        with patch.object(launcher.os, 'rename', side_effect=raced):
            self.assertEqual(launcher.swap_cli_alias(self.alias, b'owned-new', self.owned), ('foreign', None))
        self.assertEqual(self.alias.read_text(), 'another tool'); self.assertEqual(self.leftovers(), [])

    def test_a_name_taken_while_ours_is_aside_keeps_the_newcomer(self):
        self.alias.write_bytes(b'owned-old')
        real_link = os.link; calls = []
        def raced(source, destination, **kwargs):
            calls.append(source)
            if len(calls) == 2: pathlib.Path(destination).write_text('newcomer')
            return real_link(source, destination, **kwargs)
        with patch.object(launcher.os, 'link', side_effect=raced):
            self.assertEqual(launcher.swap_cli_alias(self.alias, b'owned-new', self.owned), ('foreign', b'owned-old'))
        self.assertEqual(self.alias.read_text(), 'newcomer'); self.assertEqual(self.leftovers(), [])

    def test_a_directory_is_never_moved(self):
        self.alias.mkdir(); (self.alias / 'kept').write_text('x')
        self.assertEqual(launcher.swap_cli_alias(self.alias, b'owned-new', self.owned), ('foreign', None))
        self.assertEqual((self.alias / 'kept').read_text(), 'x'); self.assertEqual(self.leftovers(), [])

    def test_a_failure_midway_puts_the_previous_launcher_back(self):
        self.alias.write_bytes(b'owned-old')
        real_link = os.link; calls = []
        def failing(source, destination, **kwargs):
            calls.append(source)
            if len(calls) == 2: raise OSError(28, 'No space left on device')
            return real_link(source, destination, **kwargs)
        with patch.object(launcher.os, 'link', side_effect=failing), self.assertRaises(OSError):
            launcher.swap_cli_alias(self.alias, b'owned-new', self.owned)
        self.assertEqual(self.alias.read_bytes(), b'owned-old'); self.assertEqual(self.leftovers(), [])

    def test_a_replaced_launcher_is_reported_even_if_the_old_copy_cannot_be_deleted(self):
        self.alias.write_bytes(b'owned-old')
        real_unlink = os.unlink
        def failing(path, *args, **kwargs):
            if '.studio-old-' in str(path): raise OSError(1, 'Operation not permitted')
            return real_unlink(path, *args, **kwargs)
        with patch.object(launcher.os, 'unlink', side_effect=failing):
            self.assertEqual(launcher.swap_cli_alias(self.alias, b'owned-new', self.owned), ('replaced', b'owned-old'))
        self.assertEqual(self.alias.read_bytes(), b'owned-new')

    def test_a_foreign_entry_that_cannot_go_back_is_reported_with_its_path(self):
        self.alias.write_text('another tool')
        real_link = os.link
        def raced(source, destination, **kwargs):
            if '.studio-old-' in str(source): pathlib.Path(destination).write_text('newcomer')
            return real_link(source, destination, **kwargs)
        report = {}
        with patch.object(launcher.os, 'link', side_effect=raced):
            self.assertEqual(launcher.swap_cli_alias(self.alias, b'owned-new', self.owned, report=report), ('foreign-kept-aside', None))
        self.assertEqual(pathlib.Path(report['keptAside']).read_text(), 'another tool')
        self.assertEqual(self.alias.read_text(), 'newcomer')


if __name__ == '__main__':
    unittest.main()
