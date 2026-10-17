#!/usr/bin/env python3
"""release_tools.py in temporary folders: workspace packages, SHA256SUMS, the Google pair file,
the previous release, release notes and the public notes check. release.sh --self-test runs it.

Run: python3 -B scripts/release/test-release-tools.py
"""
import contextlib
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import release_tools  # noqa: E402

GIT = ['git', '-c', 'user.name=Release Test', '-c', 'user.email=release-test@example.invalid',
       '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main']
GIT_ENV = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1')


def cli(*argv, stdin=''):
    out, err = io.StringIO(), io.StringIO()
    previous = sys.stdin
    sys.stdin = io.StringIO(stdin)
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = release_tools.main(list(argv))
    finally:
        sys.stdin = previous
    return code, out.getvalue(), err.getvalue()


class Temporary(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def package(self, directory, test=True, name=None):
        path = self.root / directory
        path.mkdir(parents=True, exist_ok=True)
        scripts = {'test': 'vp test run'} if test else {'build': 'vp build'}
        (path / 'package.json').write_text(json.dumps({'name': name or directory, 'scripts': scripts}))


class Packages(Temporary):
    def test_every_tested_package_but_the_root_and_the_server(self):
        (self.root / 'pnpm-workspace.yaml').write_text(
            'packages:\n  - "apps/*"\n  - packages/*\n  - scripts\n\ncatalog:\n  x: 1\n')
        self.package('.', name='monorepo')
        for directory in ('apps/server', 'apps/web', 'packages/shared', 'scripts'):
            self.package(directory)
        self.package('packages/untested', test=False)
        self.package('apps/web/node_modules/dep')
        self.assertEqual([entry[0] for entry in release_tools.packages(self.root)],
                         ['apps/web', 'packages/shared', 'scripts'])
        (self.root / 'apps/server/package.json').write_text('{"name": "server", "scripts": {}}')
        with self.assertRaises(release_tools.ToolError):
            release_tools.packages(self.root)


class Sums(Temporary):
    def test_written_appended_verified_and_tampering_caught(self):
        for name in ('a.zip', 'b.tar.gz', 'plan.json'):
            (self.root / name).write_text('content of %s' % name)
        sums = self.root / 'SHA256SUMS'
        self.assertEqual(cli('sums', '--dir', str(self.root), '--out', str(sums), 'a.zip', 'b.tar.gz')[0], 0)
        self.assertEqual(cli('sums', '--dir', str(self.root), '--out', str(sums), '--append', 'plan.json')[0], 0)
        self.assertEqual([line.split()[1] for line in sums.read_text().splitlines()], ['a.zip', 'b.tar.gz', 'plan.json'])
        self.assertEqual(cli('verify-sums', '--dir', str(self.root), 'a.zip', 'plan.json')[0], 0)
        self.assertEqual(cli('sums', '--dir', str(self.root), '--out', str(sums), '--append', 'a.zip')[0], 1)
        (self.root / 'a.zip').write_text('changed')
        code, _out, err = cli('verify-sums', '--dir', str(self.root), 'a.zip')
        self.assertEqual(code, 1)
        self.assertIn('does not match', err)
        self.assertEqual(cli('verify-sums', '--dir', str(self.root), 'missing.zip')[0], 1)


class PreviousWithoutPlanInSums(Temporary):
    """The prev stage: 1.0.38 shipped a SHA256SUMS without studio-update.json."""

    def release(self, plan_listed, plan_digest='right', sums_digest='right'):
        (self.root / 'studio-update.json').write_text('{"version": "1.0.38"}\n')
        (self.root / 'deployment-helpers-manifest.json').write_text('{"files": []}\n')
        names = ['deployment-helpers-manifest.json'] + (['studio-update.json'] if plan_listed else [])
        self.assertEqual(cli('sums', '--dir', str(self.root), '--out', str(self.root / 'SHA256SUMS'), *names)[0], 0)
        assets = []
        for name in ('SHA256SUMS', 'studio-update.json', 'deployment-helpers-manifest.json'):
            kind = {'SHA256SUMS': sums_digest, 'studio-update.json': plan_digest}.get(name, 'right')
            digest = {'right': 'sha256:' + release_tools.sha256(self.root / name), 'wrong': 'sha256:' + '0' * 64,
                      'none': None}[kind]
            assets.append({'name': name, 'digest': digest})
        (self.root / 'assets.json').write_text(json.dumps(assets))

    def verify(self):
        return cli('verify-sums', '--dir', str(self.root), '--digests', str(self.root / 'assets.json'),
                   'studio-update.json', 'deployment-helpers-manifest.json')

    def test_listed_plan_passes_with_or_without_digests(self):
        self.release(plan_listed=True)
        self.assertEqual(self.verify()[:2], (0, ''))
        self.release(plan_listed=True, plan_digest='none', sums_digest='none')
        self.assertEqual(self.verify()[:2], (0, ''))

    def test_unlisted_plan_is_accepted_only_on_its_github_digest(self):
        self.release(plan_listed=False)
        code, out, _err = self.verify()
        self.assertEqual(code, 0)
        self.assertIn('studio-update.json is not listed in SHA256SUMS; it matches the sha256 digest', out)

    def test_unlisted_plan_without_a_digest_is_refused(self):
        self.release(plan_listed=False, plan_digest='none')
        code, _out, err = self.verify()
        self.assertEqual(code, 1)
        self.assertIn('studio-update.json is not listed in SHA256SUMS and GitHub records no digest', err)
        # Without --digests the old rule stands: not listed is not verified.
        self.assertEqual(cli('verify-sums', '--dir', str(self.root), 'studio-update.json')[0], 1)

    def test_a_digest_that_disagrees_is_refused_even_when_listed(self):
        self.release(plan_listed=False, plan_digest='wrong')
        self.assertIn('studio-update.json does not match the digest', self.verify()[2])
        self.release(plan_listed=True, plan_digest='wrong')
        self.assertIn('studio-update.json does not match the digest', self.verify()[2])
        self.release(plan_listed=True, sums_digest='wrong')
        code, _out, err = self.verify()
        self.assertEqual(code, 1)
        self.assertIn('SHA256SUMS does not match the digest', err)

    def test_unreadable_asset_list_is_refused(self):
        self.release(plan_listed=False)
        (self.root / 'assets.json').write_text('')
        self.assertEqual(self.verify()[0], 1)
        (self.root / 'assets.json').write_text('{"message": "Not Found"}')
        self.assertEqual(self.verify()[0], 1)


class GooglePair(Temporary):
    SECRET = 'value-that-must-not-print'

    def test_check_and_copy_never_print_values(self):
        source = self.root / 'source.env'
        source.write_text('OTHER=1\nexport STUDIO_GOOGLE_OAUTH_CLIENT_ID="id-%s"\n'
                          'STUDIO_GOOGLE_OAUTH_CLIENT_SECRET=%s\n' % (self.SECRET, self.SECRET))
        target = self.root / 'private' / 'google.env'
        code, out, err = cli('google-env', 'copy', str(source), str(target))
        self.assertEqual(code, 0)
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertNotIn('OTHER', target.read_text())
        self.assertEqual(cli('google-env', 'check', str(target))[0], 0)
        self.assertEqual(cli('google-env', 'copy', str(source), str(target))[0], 1)  # never overwrites
        os.chmod(str(target), 0o644)
        failures = [cli('google-env', 'check', str(target))]
        os.chmod(str(target), 0o600)
        with open(str(target), 'a') as handle:
            handle.write('EXTRA=1\n')
        failures.append(cli('google-env', 'check', str(target)))
        target.write_text('STUDIO_GOOGLE_OAUTH_CLIENT_ID=x\nSTUDIO_GOOGLE_OAUTH_CLIENT_SECRET=""\n')
        failures.append(cli('google-env', 'check', str(target)))
        failures.append(cli('google-env', 'check', str(self.root / 'absent.env')))
        for code, out, err in failures:
            self.assertEqual(code, 1)
            self.assertNotIn(self.SECRET, out + err)
        self.assertNotIn(self.SECRET, out + err)


class Versions(unittest.TestCase):
    def test_previous_is_the_newest_published_release_below(self):
        releases = json.dumps([{'tagName': 'v1.0.36', 'isDraft': False}, {'tagName': 'v1.0.40', 'isDraft': True},
                               {'tagName': 'v1.0.9', 'isDraft': False}, {'tagName': 'v1.0.38', 'isDraft': False},
                               {'tagName': 'desktop-v2', 'isDraft': False}])
        self.assertEqual(cli('previous', '--version', '1.0.40', stdin=releases)[:2], (0, '1.0.38\n'))
        self.assertEqual(cli('previous', '--version', '1.0.37', stdin=releases)[:2], (0, '1.0.36\n'))
        self.assertEqual(cli('previous', '--version', '1.0.1', stdin=releases)[0], 1)
        self.assertEqual(cli('newer', '1.0.10', '1.0.9')[0], 0)
        self.assertEqual(cli('newer', '1.0.9', '1.0.9')[0], 1)
        self.assertEqual(cli('newer', '1.0', '1.0.9')[0], 1)


class Notes(Temporary):
    def test_subjects_since_the_previous_release_without_the_bump(self):
        repo = self.root / 'repo'
        subprocess.run(GIT + ['init', '-q', str(repo)], check=True, env=GIT_ENV)

        def commit(subject):
            (repo / 'file.txt').write_text(subject)
            subprocess.run(GIT + ['-C', str(repo), 'add', '-A'], check=True, env=GIT_ENV)
            subprocess.run(GIT + ['-C', str(repo), 'commit', '-q', '-m', subject], check=True, env=GIT_ENV)
            return subprocess.run(['git', '-C', str(repo), 'rev-parse', 'HEAD'], check=True, capture_output=True,
                                  text=True, env=GIT_ENV).stdout.strip()

        base = commit('Previous release')
        commit('Show usage per project (#250)')
        head = commit('Prepare SpecWithCode 1.2.0 release')
        text = release_tools.notes(repo, head, '1.2.0', base)
        self.assertIn('- Show usage per project\n', text)
        self.assertNotIn('Prepare SpecWithCode', text)
        self.assertNotIn('Previous release', text)
        self.assertIn('is not in this history', release_tools.notes(repo, head, '1.2.0', 'f' * 40))


class PublicNotes(Temporary):
    def test_private_names_are_replaced_and_private_shapes_refused(self):
        rules = self.root / 'rules.json'
        rules.write_text(json.dumps({'replace': [['Internal Name', 'Public Name']], 'deny': ['never-ship-this']}))
        text = release_tools.public_notes('See anton-abyzov/specwithcode#12 and Internal Name.\n', str(rules))
        self.assertEqual(text, 'See anton-abyzov/specwithcode#12 and Public Name.\n')
        # The branch shape is assembled so this file passes the public mirror's own deny check.
        for leak in ('never-ship-this', 'a path /Users/someone/x', 'host 192.168.1.20', 'on Pats-MacBook-Pro',
                     'branch ' + 'codex' + '/0912-thing'):
            with self.assertRaises(release_tools.ToolError):
                release_tools.public_notes('Note: %s\n' % leak, str(rules))


if __name__ == '__main__':
    unittest.main()
