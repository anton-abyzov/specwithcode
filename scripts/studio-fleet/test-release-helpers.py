#!/usr/bin/env python3
"""make_helpers, remote_update and make_update_plan --previous-plan, in temporary folders only.

make_helpers runs against a scratch git repository; remote_update runs against a synthetic
database in a temporary home, with a stand-in update.py inside a helpers archive that records
how it was called. No live Studio database, service or host is touched.

Run: cd scripts/studio-fleet && python3 -B test-release-helpers.py
"""
import contextlib
import hashlib
import io
import json
import os
import pathlib
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import make_helpers  # noqa: E402
import make_update_plan  # noqa: E402
import remote_update  # noqa: E402
import update_agent  # noqa: E402

GIT = ['git', '-c', 'user.name=Release Test', '-c', 'user.email=release-test@example.invalid',
       '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main']
GIT_ENV = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1')
A, B, C = 'a' * 40, 'b' * 40, 'c' * 40


def git(repo, *args):
    return subprocess.run(GIT + ['-C', str(repo)] + list(args), check=True, capture_output=True, text=True,
                          env=GIT_ENV).stdout.strip()


def scratch_repo(root):
    repo = root / 'repo'
    for path in make_helpers.SOURCE_PATHS + ('scripts/studio-fleet/install.py', 'scripts/studio-fleet/network-transition.py',
                                             'scripts/studio-fleet/update.py', 'apps/server/unrelated.ts'):
        target = repo / path
        if path == 'scripts/studio-fleet':
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text('content of %s\n' % path)
    (repo / 'scripts/studio-fleet/update.py').chmod(0o755)
    git(root, 'init', '-q', str(repo))
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'fixture')
    return repo


class MakeHelpers(unittest.TestCase):
    def test_archive_and_manifest_satisfy_the_agent_and_repeat_byte_for_byte(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            repo = scratch_repo(root)
            out = root / 'assets'
            out.mkdir()
            sha = git(repo, 'rev-parse', 'HEAD')
            manifest = make_helpers.build(repo, out, '1.2.3')
            archive = out / ('studio-1.2.3-deployment-helpers-%s.tar.gz' % sha[:12])
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            self.assertEqual(manifest['archiveSha256'], digest)
            self.assertEqual(json.loads((out / make_helpers.MANIFEST).read_text()), manifest)
            entries = update_agent.validate_manifest(manifest, archive.name, digest)
            self.assertEqual(entries['scripts/studio-fleet/update.py']['mode'], 0o755)
            self.assertNotIn('apps/server/unrelated.ts', entries)
            self.assertEqual((manifest['sourceCommit'], manifest['runtimeSourceCommit']), (sha, sha))
            with tarfile.open(str(archive)) as bundle:
                names = set(bundle.getnames())
            self.assertIn(archive.name[:-len('.tar.gz')] + '/scripts/studio-fleet/update.py', names)
            make_helpers.build(repo, out, '1.2.3')
            self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), digest)

    def test_missing_entrypoint_or_bad_version_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            repo = scratch_repo(root)
            (root / 'out').mkdir()
            with self.assertRaises(make_helpers.HelpersError):
                make_helpers.build(repo, root / 'out', '1.2')
            git(repo, 'rm', '-q', 'scripts/studio-fleet/install.py')
            git(repo, 'commit', '-q', '-m', 'drop install')
            with self.assertRaises(make_helpers.HelpersError) as caught:
                make_helpers.build(repo, root / 'out', '1.2.3')
            self.assertIn('install.py', str(caught.exception))

    def test_previous_manifest_paths_are_compared(self):
        with tempfile.TemporaryDirectory() as temporary:
            previous = pathlib.Path(temporary) / 'previous.json'
            previous.write_text(json.dumps({'sourcePaths': list(make_helpers.SOURCE_PATHS[1:]) + ['scripts/old.py']}))
            self.assertEqual(make_helpers.path_changes(previous), ['+scripts/studio-fleet', '-scripts/old.py'])


class PreviousPlan(unittest.TestCase):
    def test_sources_come_from_the_previous_plan_and_the_command_line(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            previous = root / 'previous.json'
            previous.write_text(json.dumps({'sourceCommit': B, 'service': {'upgrades': [{'fromSourceCommits': [A, B]}]}}))
            sums = root / 'SHA256SUMS'
            sums.write_text('%s  runtime.tar.gz\n%s  helpers-root.tar.gz\n' % ('1' * 64, '2' * 64))
            output = root / 'studio-update.json'
            argv = ['--version', '1.2.3', '--source-commit', 'd' * 40, '--sha256sums', str(sums),
                    '--runtime', 'runtime.tar.gz', '--helpers', 'helpers-root.tar.gz', '--output', str(output),
                    '--arg=--allow-existing-browser-heartbeat']
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(make_update_plan.main(argv + ['--previous-plan', str(previous), '--from-source', C]), 0)
            plan = json.loads(output.read_text())
            update_agent.validate_plan(plan, '1.2.3')
            self.assertEqual(plan['service']['upgrades'][0]['fromSourceCommits'], [B, A, C])
            with contextlib.redirect_stderr(io.StringIO()) as errors:
                self.assertEqual(make_update_plan.main(argv), 2)
            self.assertIn('--previous-plan', errors.getvalue())
            previous.write_text(json.dumps({'sourceCommit': 'not-a-commit', 'service': {'upgrades': []}}))
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(make_update_plan.main(argv + ['--previous-plan', str(previous)]), 2)


class UploadedPlanInSums(unittest.TestCase):
    """1.0.38's plan was uploaded with --upload, which left it out of the release's SHA256SUMS."""

    def test_upload_lists_the_plan_in_sha256sums_and_uploads_both(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            calls = root / 'gh-calls.jsonl'
            gh = root / 'gh'
            gh.write_text('#!%s\nimport json, sys\nopen(%r, "a").write(json.dumps(sys.argv[1:]) + "\\n")\n'
                          % (sys.executable, str(calls)))
            gh.chmod(0o755)
            sums = root / 'SHA256SUMS'
            # A stale plan line from an earlier run is replaced, not repeated.
            sums.write_text('%s  runtime.tar.gz\n%s  helpers-root.tar.gz\n%s *studio-update.json\n'
                            % ('1' * 64, '2' * 64, '3' * 64))
            output = root / 'studio-update.json'
            argv = ['--version', '1.2.3', '--source-commit', 'd' * 40, '--sha256sums', str(sums),
                    '--runtime', 'runtime.tar.gz', '--helpers', 'helpers-root.tar.gz', '--output', str(output),
                    '--from-source', A, '--upload', 'v1.2.3', '--repo', 'owner/repo']
            original = make_update_plan.find_gh
            make_update_plan.find_gh = lambda: str(gh)
            try:
                for _ in range(2):
                    with contextlib.redirect_stdout(io.StringIO()):
                        self.assertEqual(make_update_plan.main(argv), 0)
                listed = update_agent.parse_sums(sums.read_bytes())
                self.assertEqual(listed, {'runtime.tar.gz': '1' * 64, 'helpers-root.tar.gz': '2' * 64,
                                          'studio-update.json': hashlib.sha256(output.read_bytes()).hexdigest()})
                uploads = [json.loads(line) for line in calls.read_text().splitlines()]
                self.assertEqual(len(uploads), 2)
                self.assertEqual(uploads[0], ['release', 'upload', 'v1.2.3', str(output.resolve()),
                                              str(sums.resolve()), '--repo', 'owner/repo', '--clobber'])
                # The uploaded name must be SHA256SUMS; refused before anything is written or run.
                other = root / 'sums.txt'
                other.write_bytes(sums.read_bytes())
                output.unlink()
                index = argv.index('--sha256sums') + 1
                with contextlib.redirect_stderr(io.StringIO()) as errors:
                    self.assertEqual(make_update_plan.main(argv[:index] + [str(other)] + argv[index + 1:]), 2)
                self.assertIn('must be named SHA256SUMS', errors.getvalue())
                self.assertFalse(output.exists())
                self.assertEqual(len(calls.read_text().splitlines()), 2)
            finally:
                make_update_plan.find_gh = original


FAKE_UPDATE = r'''
import json, pathlib, sys
log = pathlib.Path(__file__).resolve().parents[3] / 'calls.jsonl'
with log.open('a') as handle:
    handle.write(json.dumps(sys.argv[1:]) + '\n')
if '--snapshot' in sys.argv:
    pathlib.Path(sys.argv[sys.argv.index('--snapshot') + 1]).write_text('{}')
    print('snapshot written')
    sys.exit(0)
print('applied')
sys.exit(int(open(pathlib.Path(__file__).with_name('apply-exit')).read()))
'''


class RemoteUpdate(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.home = pathlib.Path(self.temporary.name)
        state = self.home / '.specwithcode' / 'm9' / 'userdata'
        state.mkdir(parents=True)
        database = sqlite3.connect(str(state / 'statev2.sqlite'))
        database.execute('PRAGMA journal_mode=WAL')
        database.execute('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)')
        database.executemany('INSERT INTO t(v) VALUES (?)', [('row %d' % i,) for i in range(50)])
        database.commit()
        database.close()
        self.staging = self.home / '.specwithcode' / 'release-staging' / '1.2.3'
        self.staging.mkdir(parents=True)
        self.runtime = 'studio-1.2.3-%s.tar.gz' % ('e' * 12)
        self.helpers = 'studio-1.2.3-deployment-helpers-%s.tar.gz' % ('e' * 12)
        (self.staging / self.runtime).write_bytes(b'runtime bytes')
        self.pack({'scripts/studio-fleet/update.py': FAKE_UPDATE, 'scripts/studio-fleet/apply-exit': '0'})

    def tearDown(self):
        self.temporary.cleanup()

    def pack(self, files, extra=None):
        root = self.helpers[:-len('.tar.gz')]
        with tarfile.open(str(self.staging / self.helpers), 'w:gz') as bundle:
            for name, text in files.items():
                data = text.encode()
                info = tarfile.TarInfo(root + '/' + name)
                info.size, info.mode = len(data), 0o644
                bundle.addfile(info, io.BytesIO(data))
            if extra:
                bundle.addfile(extra)
        self.sums()

    def sums(self):
        lines = ['%s  %s' % (hashlib.sha256((self.staging / name).read_bytes()).hexdigest(), name)
                 for name in (self.runtime, self.helpers)]
        (self.staging / 'SHA256SUMS').write_text('\n'.join(lines) + '\n')

    def run_update(self):
        lines = []
        code = remote_update.update(self.home, 'm9', '1.2.3', self.runtime, self.helpers, python=sys.executable,
                                    say=lines.append)
        calls = [json.loads(line) for line in (self.staging / 'helpers' / 'calls.jsonl').read_text().splitlines()]
        return code, calls, lines

    def test_snapshot_then_apply_with_a_checked_backup(self):
        code, calls, lines = self.run_update()
        self.assertEqual(code, 0)
        self.assertEqual(calls[0][:3], ['--identity', 'm9', '--snapshot'])
        apply = calls[1]
        self.assertEqual(apply[apply.index('--prestate') + 1], calls[0][3])
        self.assertEqual(apply[apply.index('--archive') + 1], str(self.staging / self.runtime))
        self.assertEqual(apply[apply.index('--sha256') + 1],
                         hashlib.sha256((self.staging / self.runtime).read_bytes()).hexdigest())
        self.assertEqual(apply[-1], '--allow-existing-browser-heartbeat')
        backups = list((self.home / '.specwithcode' / 'backups').glob('pre-1.2.3-*'))
        self.assertEqual(len(backups), 1)
        copy = sqlite3.connect(str(backups[0] / 'statev2.sqlite'))
        self.assertEqual(copy.execute('SELECT count(*) FROM t').fetchone()[0], 50)
        copy.close()
        self.assertTrue(any('apply exit 0' in line for line in lines))

    def test_apply_exit_code_is_returned(self):
        self.pack({'scripts/studio-fleet/update.py': FAKE_UPDATE, 'scripts/studio-fleet/apply-exit': '3'})
        code, calls, _lines = self.run_update()
        self.assertEqual((code, len(calls)), (3, 2))

    def test_tampered_or_unsafe_staging_runs_nothing(self):
        (self.staging / self.runtime).write_bytes(b'changed runtime')
        with self.assertRaises(remote_update.UpdateError) as caught:
            remote_update.update(self.home, 'm9', '1.2.3', self.runtime, self.helpers, python=sys.executable,
                                 say=lambda _line: None)
        self.assertIn('does not match', str(caught.exception))
        (self.staging / self.runtime).write_bytes(b'runtime bytes')
        link = tarfile.TarInfo(self.helpers[:-len('.tar.gz')] + '/escape')
        link.type, link.linkname = tarfile.SYMTYPE, '/etc/passwd'
        self.pack({'scripts/studio-fleet/update.py': FAKE_UPDATE}, extra=link)
        with self.assertRaises(remote_update.UpdateError) as caught:
            remote_update.update(self.home, 'm9', '1.2.3', self.runtime, self.helpers, python=sys.executable,
                                 say=lambda _line: None)
        self.assertIn('Unsafe', str(caught.exception))
        self.assertFalse((self.home / '.specwithcode' / 'backups').exists())
        with self.assertRaises(remote_update.UpdateError):
            remote_update.update(self.home, 'm9', '1.2.3', self.runtime, self.helpers, extra_args=('--force',))


if __name__ == '__main__':
    unittest.main()
