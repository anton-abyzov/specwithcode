#!/usr/bin/env python3
"""r2_publish.py candidate publish and retention (increment 1239, AC-17): verified assets go to
candidate/<v>/, are downloaded again and matched before candidate.json is written, a mismatch leaves
no prefix and no pointer, and pruning follows staging_retention.py's rule (older than the previous
release goes) without touching the current candidate, a version a stable pointer names, newer
prefixes or anything under stable/. Also the R2 route: the AWS CLI's s3api against the account's
R2 endpoint, credentials only in its environment.

A folder store and a stub CLI runner stand in for R2. Nothing reaches a real bucket.

Run: python3 -B scripts/release/test-candidate-retention.py
"""
import contextlib
import hashlib
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import r2_publish  # noqa: E402


def assets(directory, version, extra=b''):
    """A small release folder: SHA256SUMS lists every file, the plan included."""
    directory = pathlib.Path(directory)
    directory.mkdir(parents=True)
    files = {'studio-%s-abc.tar.gz' % version: b'runtime ' + version.encode() + extra,
             'SpecWithCode-%s-arm64.dmg' % version: b'dmg ' + version.encode(),
             r2_publish.PLAN: json.dumps({'version': version}).encode()}
    for name, data in files.items():
        (directory / name).write_bytes(data)
    (directory / r2_publish.SUMS).write_text(''.join(
        '%s  %s\n' % (hashlib.sha256(data).hexdigest(), name) for name, data in sorted(files.items())))
    return directory


class Case(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.work = pathlib.Path(folder.name)
        self.store = r2_publish.LocalStore(self.work / 'bucket')

    def publish(self, version, **options):
        return r2_publish.publish_candidate(self.store, version, assets(self.work / ('in-' + version), version),
                                            **options)

    def versions(self, prefix):
        return sorted({key.split('/')[1] for key in self.store.list(prefix)},
                      key=lambda name: r2_publish.version_tuple(name) or (1 << 30,))

    def pointer(self, key):
        raw = self.store.get_bytes(key)
        return json.loads(raw) if raw else None


class Publish(Case):
    def test_assets_are_uploaded_checked_and_then_pointed_at(self):
        report = self.publish('1.0.190', notes='Release notes', source_commit='a' * 40)
        self.assertEqual(report['result'], 'candidate-published')
        pointer = self.pointer(r2_publish.CANDIDATE)
        self.assertEqual((pointer['version'], pointer['prefix'], pointer['tag']), ('1.0.190', 'candidate/1.0.190/', 'v1.0.190'))
        self.assertEqual(pointer['notes'], 'Release notes')
        names = [asset['name'] for asset in pointer['assets']]
        self.assertEqual(names[-1], r2_publish.SUMS)
        for asset in pointer['assets']:
            data = self.store.get_bytes('candidate/1.0.190/' + asset['name'])
            self.assertEqual((len(data), hashlib.sha256(data).hexdigest()), (asset['size'], asset['sha256']))
        self.assertTrue(r2_publish.valid_pointer(pointer, 'candidate'))

    def test_check_names_a_complete_candidate_only(self):
        self.publish('1.0.190')
        self.assertEqual(r2_publish.check(self.store, 'candidate', '1.0.190')['result'], 'ready')
        with self.assertRaisesRegex(r2_publish.PublishError, 'names 1.0.190, not 1.0.191'):
            r2_publish.check(self.store, 'candidate', '1.0.191')
        with self.assertRaisesRegex(r2_publish.PublishError, 'names None, not 1.0.190'):
            r2_publish.check(self.store, 'stable', '1.0.190')
        self.store.delete(next(iter(self.store.list('candidate/1.0.190/'))))
        with self.assertRaisesRegex(r2_publish.PublishError, 'candidate/1.0.190/ is incomplete'):
            r2_publish.check(self.store, 'candidate', '1.0.190')

    def test_a_mismatch_after_upload_leaves_no_prefix_and_no_pointer(self):
        real = self.store.put_file

        def corrupting(key, path, content_type=None):
            real(key, path, content_type)
            if key.endswith('.dmg'):
                self.store.path(key).write_bytes(b'flipped in transit')
        with mock.patch.object(self.store, 'put_file', corrupting):
            with self.assertRaisesRegex(r2_publish.PublishError, 'does not match its sha256 after the upload'):
                self.publish('1.0.190')
        self.assertEqual(self.store.list('candidate/'), {})
        self.assertIsNone(self.pointer(r2_publish.CANDIDATE))

    def test_a_file_that_does_not_match_sha256sums_is_never_uploaded(self):
        directory = assets(self.work / 'bad', '1.0.190')
        (directory / r2_publish.PLAN).write_text('{"changed": true}')
        with self.assertRaisesRegex(r2_publish.PublishError, 'does not match SHA256SUMS'):
            r2_publish.publish_candidate(self.store, '1.0.190', directory)
        self.assertEqual(self.store.list(''), {})

    def test_sums_must_list_the_plan(self):
        directory = assets(self.work / 'noplan', '1.0.190')
        sums = directory / r2_publish.SUMS
        sums.write_text(''.join(line + '\n' for line in sums.read_text().splitlines() if r2_publish.PLAN not in line))
        with self.assertRaisesRegex(r2_publish.PublishError, 'does not list studio-update.json'):
            r2_publish.publish_candidate(self.store, '1.0.190', directory)

    def test_a_candidate_must_be_newer_than_stable(self):
        self.publish('1.0.190')
        r2_publish.promote(self.store, '1.0.190')
        with self.assertRaisesRegex(r2_publish.PublishError, 'not newer than the stable release 1.0.190'):
            self.publish('1.0.189')

    def test_a_malformed_pointer_is_never_written_over(self):
        self.store.put_bytes(r2_publish.CANDIDATE, b'{"broken": true}')
        with self.assertRaisesRegex(r2_publish.PublishError, 'candidate.json is malformed'):
            self.publish('1.0.190')
        self.assertEqual(self.store.list('candidate/'), {})

    def test_republishing_the_same_assets_checks_the_live_prefix_and_uploads_nothing(self):
        self.publish('1.0.190')
        before = (self.store.get_bytes(r2_publish.CANDIDATE), self.store.list('candidate/'))
        with mock.patch.object(self.store, 'put_file', side_effect=AssertionError('uploaded')), \
                mock.patch.object(self.store, 'delete', side_effect=AssertionError('deleted')):
            report = r2_publish.publish_candidate(self.store, '1.0.190', assets(self.work / 'again', '1.0.190'))
        self.assertEqual(report['result'], 'already-candidate')
        self.assertEqual((self.store.get_bytes(r2_publish.CANDIDATE), self.store.list('candidate/')), before)

    def test_republishing_other_assets_under_a_live_version_is_refused(self):
        self.publish('1.0.190')
        before = {key: self.store.get_bytes(key) for key in self.store.list('')}
        with mock.patch.object(self.store, 'put_file', side_effect=AssertionError('uploaded')):
            with self.assertRaisesRegex(r2_publish.PublishError, 'already names 1.0.190 with other assets'):
                r2_publish.publish_candidate(self.store, '1.0.190', assets(self.work / 'changed', '1.0.190', b'fix'))
        self.assertEqual({key: self.store.get_bytes(key) for key in self.store.list('')}, before)

    def test_a_damaged_live_prefix_is_reported_not_written_over(self):
        self.publish('1.0.190')
        dmg = 'candidate/1.0.190/SpecWithCode-1.0.190-arm64.dmg'
        self.store.path(dmg).write_bytes(b'dmg 1.0.19X')  # Same size, other bytes.
        with self.assertRaisesRegex(r2_publish.PublishError, 'no longer matches it'):
            r2_publish.publish_candidate(self.store, '1.0.190', assets(self.work / 'again', '1.0.190'))
        self.assertEqual(self.store.get_bytes(dmg), b'dmg 1.0.19X')
        self.assertEqual(self.pointer(r2_publish.CANDIDATE)['version'], '1.0.190')

    def test_a_failed_upload_drops_its_own_partial_prefix_only(self):
        self.publish('1.0.190')
        real, calls = self.store.put_file, []

        def failing(key, path, content_type=None):
            calls.append(key)
            if len(calls) == 2:
                raise OSError('connection reset')
            real(key, path, content_type)
        with mock.patch.object(self.store, 'put_file', failing), self.assertRaisesRegex(OSError, 'connection reset'):
            self.publish('1.0.191')
        self.assertEqual(self.versions('candidate/'), ['1.0.190'])
        self.assertEqual(self.pointer(r2_publish.CANDIDATE)['version'], '1.0.190')
        self.assertTrue(r2_publish.present(self.store, self.pointer(r2_publish.CANDIDATE)))

    def test_a_failed_upload_never_drops_a_prefix_a_pointer_names(self):
        # Another run wrote candidate.json for 1.0.191 while this one was uploading it.
        other = r2_publish.LocalStore(self.work / 'other')
        r2_publish.publish_candidate(other, '1.0.191', assets(self.work / 'other-in', '1.0.191', b' other build'))
        real = self.store.put_file

        def raced(key, path, content_type=None):
            real(key, path, content_type)
            if key.endswith(r2_publish.SUMS):  # The other run's objects and pointer land last.
                for name in other.list(''):
                    self.store.put_bytes(name, other.get_bytes(name))
        with mock.patch.object(self.store, 'put_file', raced):
            with self.assertRaisesRegex(r2_publish.PublishError, 'after the upload'):
                self.publish('1.0.191')
        self.assertEqual(self.pointer(r2_publish.CANDIDATE)['version'], '1.0.191')
        self.assertTrue(r2_publish.present(self.store, self.pointer(r2_publish.CANDIDATE)))

    def test_a_retention_failure_after_the_pointer_is_a_warning_not_a_failed_publish(self):
        for version in ('1.0.188', '1.0.189', '1.0.190'):
            self.publish(version)
        directory = assets(self.work / 'in-1.0.191', '1.0.191')
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(r2_publish.LocalStore, 'delete', side_effect=OSError('delete refused')), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = r2_publish.main(['--store', 'file://' + str(self.store.root), 'publish-candidate',
                                    '--version', '1.0.191', '--dir', str(directory)])
        self.assertEqual(code, 0, err.getvalue())
        report = json.loads(out.getvalue())
        self.assertEqual((report['result'], report['pruned']), ('candidate-published', []))
        self.assertIn('delete refused', report['pruneError'])
        self.assertIn('warning: retention failed', err.getvalue())
        self.assertEqual(self.pointer(r2_publish.CANDIDATE)['version'], '1.0.191')
        self.assertEqual(r2_publish.publish_candidate(self.store, '1.0.191', directory)['pruned'], ['1.0.189'])


class Retention(Case):
    def test_old_candidates_go_and_named_ones_stay(self):
        pruned = {}
        for version in ('1.0.180', '1.0.181', '1.0.182'):
            pruned[version] = self.publish(version)['pruned']
        r2_publish.promote(self.store, '1.0.182')  # stable.json -> 1.0.182 (no previous yet).
        for version in ('1.0.183', '1.0.184'):
            pruned[version] = self.publish(version)['pruned']
        r2_publish.promote(self.store, '1.0.184')  # stable.prev.json -> 1.0.182.
        stable_before = self.store.list('stable/')
        pointers_before = {key: self.store.get_bytes(key) for key in (r2_publish.STABLE, r2_publish.PREVIOUS)}
        # A newer upload that never got its pointer (a run stopped mid-publish) stays too.
        self.store.put_bytes('candidate/1.0.199/partial.bin', b'x')
        self.store.put_bytes('candidate/notes/readme.txt', b'not a version')
        for version in ('1.0.185', '1.0.186'):
            pruned[version] = self.publish(version)['pruned']
        # Current 1.0.186, previous 1.0.185, stable 1.0.184, stable.prev 1.0.182, newer 1.0.199.
        self.assertEqual(self.versions('candidate/'), ['1.0.182', '1.0.184', '1.0.185', '1.0.186', '1.0.199', 'notes'])
        self.assertEqual(pruned, {'1.0.180': [], '1.0.181': [], '1.0.182': ['1.0.180'], '1.0.183': ['1.0.181'],
                                  '1.0.184': [], '1.0.185': ['1.0.183'], '1.0.186': []})
        self.assertEqual(self.store.list('stable/'), stable_before)
        self.assertEqual({key: self.store.get_bytes(key) for key in pointers_before}, pointers_before)
        self.assertEqual(self.pointer(r2_publish.CANDIDATE)['version'], '1.0.186')

    def test_prune_is_a_dry_run_unless_applied(self):
        for version in ('1.0.180', '1.0.181', '1.0.182'):
            self.publish(version)
        self.store.put_bytes('candidate/1.0.170/old.bin', b'x')
        before = self.store.list('candidate/')
        self.assertEqual(r2_publish.prune(self.store), ['1.0.170'])
        self.assertEqual(self.store.list('candidate/'), before)
        self.assertEqual(r2_publish.prune(self.store, apply=True), ['1.0.170'])
        self.assertEqual(self.versions('candidate/'), ['1.0.181', '1.0.182'])

    def test_no_candidate_pointer_prunes_nothing(self):
        self.store.put_bytes('candidate/1.0.170/old.bin', b'x')
        self.store.put_bytes('candidate/1.0.171/old.bin', b'x')
        self.assertEqual(r2_publish.prune(self.store, apply=True), [])
        self.assertEqual(self.versions('candidate/'), ['1.0.170', '1.0.171'])

    def test_the_cli_reports_json(self):
        assets(self.work / 'cli', '1.0.190')
        store = 'file://' + str(self.work / 'bucket')
        out = subprocess.run([sys.executable, '-B', str(HERE / 'r2_publish.py'), '--store', store, 'publish-candidate',
                              '--version', '1.0.190', '--dir', str(self.work / 'cli')],
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(json.loads(out.stdout)['result'], 'candidate-published')
        out = subprocess.run([sys.executable, '-B', str(HERE / 'r2_publish.py'), '--store', store, 'promote',
                              '--version', '1.0.191'], capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 1)
        self.assertEqual(json.loads(out.stdout)['result'], 'failed')


class R2Route(unittest.TestCase):
    ENV = {'CLOUDFLARE_R2_ACCOUNT_ID': 'acct123', 'CLOUDFLARE_R2_ACCESS_KEY_ID': 'key-id-value',
           'CLOUDFLARE_R2_SECRET_ACCESS_KEY': 'secret-value', 'AWS_PROFILE': 'personal', 'PATH': '/usr/bin'}

    def test_s3api_against_the_account_endpoint_with_credentials_only_in_its_environment(self):
        calls = []

        def run(command, **kwargs):
            calls.append((command, kwargs))
            stdout = json.dumps({'Contents': [{'Key': 'candidate/1.0.1/a', 'Size': 3}]}) \
                if 'list-objects-v2' in command else '{}'
            return subprocess.CompletedProcess(command, 0, stdout, '')
        store = r2_publish.R2Store('studio-releases', self.ENV, run=run)
        store.put_bytes(r2_publish.STABLE, b'{}', 'application/json')
        self.assertEqual(store.list('candidate/'), {'candidate/1.0.1/a': 3})
        store.copy('candidate/1.0.1/a', 'stable/1.0.1/a')
        put, listed, copied = (call[0] for call in calls)
        self.assertEqual(put[:4], ['aws', '--endpoint-url', 'https://acct123.r2.cloudflarestorage.com', 's3api'])
        self.assertIn('put-object', put)
        self.assertIn('no-cache, max-age=0', put)  # Pointers are never cached at the edge.
        self.assertEqual(copied[copied.index('--copy-source') + 1], 'studio-releases/candidate/1.0.1/a')
        for command, kwargs in calls:
            self.assertFalse(any('secret-value' in part or 'key-id-value' in part for part in command))
            self.assertEqual(kwargs['env']['AWS_SECRET_ACCESS_KEY'], 'secret-value')
            self.assertNotIn('AWS_PROFILE', kwargs['env'])

    def test_missing_credentials_are_named_not_printed(self):
        with self.assertRaisesRegex(r2_publish.PublishError, 'missing: CLOUDFLARE_R2_SECRET_ACCESS_KEY'):
            r2_publish.R2Store('studio-releases', {'CLOUDFLARE_R2_ACCOUNT_ID': 'a', 'CLOUDFLARE_R2_ACCESS_KEY_ID': 'b'})

    def test_a_missing_object_reads_as_none(self):
        def run(command, **kwargs):
            return subprocess.CompletedProcess(command, 254, '', 'An error occurred (NoSuchKey) when calling GetObject')
        self.assertIsNone(r2_publish.R2Store('studio-releases', self.ENV, run=run).get_bytes(r2_publish.STABLE))

    def test_store_specs(self):
        self.assertIsInstance(r2_publish.open_store('r2://studio-releases', self.ENV), r2_publish.R2Store)
        self.assertEqual(r2_publish.open_store(None, dict(self.ENV, RELEASE_R2_BUCKET='other-bucket')).bucket,
                         'other-bucket')
        for bad in ('s3://x', 'file://relative/path', 'r2://bucket/prefix'):
            with self.assertRaises(r2_publish.PublishError):
                r2_publish.open_store(bad, self.ENV)
        with self.assertRaises(r2_publish.PublishError):
            r2_publish.check_key('candidate/../stable.json')


if __name__ == '__main__':
    unittest.main()
