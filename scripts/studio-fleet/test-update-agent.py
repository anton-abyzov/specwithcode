#!/usr/bin/env python3
"""Update agent tests: temporary homes, a loopback fake GitHub API and a fake helper only.

Run: cd scripts/studio-fleet && python3 -B test-update-agent.py
Nothing here touches a real Studio home, launchd, GitHub or gh.
"""
import contextlib
import datetime
import fcntl
import hashlib
import http.server
import io
import json
import os
import pathlib
import plistlib
import re
import subprocess
import sys
import tarfile
import tempfile
import time
import threading
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import update_agent  # noqa: E402
import make_update_plan  # noqa: E402

TOKEN = 'test-token-SHOULD-never-LEAK-0123456789abcdef'
OLD_COMMIT = 'a' * 40
NEW_COMMIT = 'b' * 40
OTHER_COMMIT = 'c' * 40
REPO = 'anton-abyzov/specwithcode'
ROOT = 'studio-0.2.0-deployment-helpers-b95280f5334e'

FAKE_HELPER = r'''
import argparse, datetime, json, os, pathlib, sys
home = pathlib.Path(os.environ['HOME'])
control_path = home / 'fake-control.json'
control = json.loads(control_path.read_text()) if control_path.exists() else {}
with open(str(home / 'fake-calls.jsonl'), 'a') as log:
    log.write(json.dumps({'argv': sys.argv[1:], 'cwd': os.getcwd(), 'env': sorted(os.environ),
                         'agentTimings': os.environ.get('STUDIO_UPDATE_AGENT_TIMINGS')}) + '\n')
parser = argparse.ArgumentParser()
for flag in ['--identity', '--snapshot', '--prestate', '--archive', '--sha256', '--output', '--request']:
    parser.add_argument(flag)
parser.add_argument('--allow-project-migrations', action='store_true')
parser.add_argument('--allow-existing-browser-heartbeat', action='store_true')
args = parser.parse_args()
calls = [json.loads(line)['argv'] for line in (home / 'fake-calls.jsonl').read_text().splitlines()]
snapshots = len([argv for argv in calls if '--snapshot' in argv])
applies = len([argv for argv in calls if '--prestate' in argv])
if args.snapshot:
    if control.get('snapshotSleep'):
        import time
        time.sleep(control['snapshotSleep'])
    if control.get('snapshotFail') or snapshots <= control.get('snapshotFailures', 0) \
            or snapshots in control.get('snapshotFailCalls', ()) or (control.get('snapshotFailAfterApply') and applies):
        sys.stderr.write(control.get('snapshotError', 'AssertionError: Native work is not idle') + '\n')
        sys.exit(1)
    assert not os.path.exists(args.snapshot)
    value = {'schemaVersion': 1, 'servicePid': control.get('pid', 4242),
             'rows': {'counts': control.get('counts', {'projection_threads': 3}), 'hashes': {}, 'nativeWorkIdle': True},
             'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    installed = json.loads((home / '.specwithcode' / args.identity / 'installation.json').read_text())
    value.update(identity=args.identity, serviceLabel=installed['service']['label'],
                 artifactSourceCommit=installed['sourceCommit'], archiveSha256=installed['archiveSha256'])
    pathlib.Path(args.snapshot).write_text(json.dumps(value))
    print(json.dumps({'result': 'snapshotted'}))
    sys.exit(0)
prestate = json.loads(pathlib.Path(args.prestate).read_text())
assert prestate['rows']['nativeWorkIdle'] is True
assert pathlib.Path(args.archive).is_file() and not os.path.exists(args.output)
if control.get('applySleep'):
    import time
    time.sleep(control['applySleep'])
if applies <= control.get('applyRefusals', 0) or control.get('applyFailAfterRestart'):
    receipt = {'phase': 'prepared', 'result': 'update-failed', 'pointers': 'previous-release',
               'error': 'AssertionError: Guarded prestate changed: rows'}
    receipt.update(control.get('applyRefusal', {}))
    if control.get('applyFailAfterRestart'):
        receipt.update(phase='restart-requested', restartStartedAt='2026-10-12T20:00:00+00:00', pointers='new-release')
    pathlib.Path(args.output).write_text(json.dumps(receipt))
    sys.exit(1)
if control.get('applyCrash'):
    sys.stderr.write('Traceback (most recent call last):\nAssertionError: Protected rows or counts changed\n')
    sys.exit(1)
if applies <= control.get('applyRolledBack', 0):
    # What update.py writes after the restarted release failed a check and was fully rolled back.
    receipt = {'identity': args.identity, 'phase': 'restart-requested', 'result': 'update-failed',
               'pointers': 'previous-release', 'rollback': 'restored-runtime-pointers-and-state',
               'restartStartedAt': '2026-10-15T21:32:20+00:00', 'stateDeltaRetained': False,
               'error': 'AssertionError: User settings changed or disappeared after restart: /x'}
    receipt.update(control.get('rolledBackReceipt', {}))
    pathlib.Path(args.output).write_text(json.dumps(receipt))
    sys.exit(1)
if control.get('applyFail'):
    pathlib.Path(args.output).write_text(json.dumps({'result': 'update-failed'}))
    print('helper-private-output-should-not-be-logged')
    sys.exit(1)
path = home / '.specwithcode' / args.identity / 'installation.json'
receipt = json.loads(path.read_text())
receipt['version'] = control.get('newVersion', '0.2.0')
receipt['sourceCommit'] = control.get('newCommit', 'b' * 40)
receipt['archiveSha256'] = args.sha256
receipt['release'] = str(home / '.specwithcode/install/releases' / args.sha256[:20])
path.write_text(json.dumps(receipt))
if control.get('applyFailAfterSwitch'):
    pathlib.Path(args.output).write_text(json.dumps({'result': 'update-failed', 'rollback': 'held-for-safe-review',
                                                     **control.get('switchReceipt', {})}))
    sys.exit(1)
pathlib.Path(args.output).write_text(json.dumps({'phase': 'verified', 'preservedRowsAuthAndIdentity': True,
    'originalServicesPreserved': True, 'onlyKnownOwnedServiceRestarted': True, 'cookie': 'helper-private-receipt',
    'before': prestate, 'after': dict(prestate, artifactSourceCommit=receipt['sourceCommit'], archiveSha256=args.sha256)}))
print('helper-private-output-should-not-be-logged')
'''


def sha(data):
    return hashlib.sha256(data).hexdigest()


def tar_bytes(entries):
    """entries: list of (name, bytes|None for dir, kind) where kind in file/dir/symlink."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as tar:
        for name, data, kind in entries:
            info = tarfile.TarInfo(name)
            if kind == 'dir':
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                tar.addfile(info)
            elif kind == 'symlink':
                info.type = tarfile.SYMTYPE
                info.linkname = data
                tar.addfile(info)
            else:
                info.size = len(data)
                info.mode = 0o755 if name.endswith('.py') else 0o644
                tar.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


class FakeGitHub(object):
    def __init__(self):
        self.repository = REPO
        self.releases = []
        self.blobs = {}
        self.requests = []
        self.list_status = 200
        self.lock = threading.Lock()
        self.next_id = 100
        fake = self

        class Quiet(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def send(self, code, body=b'', headers=()):
                self.send_response(code)
                for key, value in headers:
                    self.send_header(key, value)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        class Api(Quiet):
            def do_GET(self):
                with fake.lock:
                    fake.requests.append(('api', self.path, self.headers.get('Authorization'),
                                          self.headers.get('Accept')))
                if self.path == '/repos/%s/releases?per_page=30' % fake.repository:
                    if fake.list_status != 200:
                        return self.send(fake.list_status, b'{"message":"Not Found"}')
                    return self.send(200, json.dumps(fake.releases).encode(), [('Content-Type', 'application/json')])
                match = re.fullmatch(r'/repos/%s/releases/assets/(\d+)' % fake.repository, self.path)
                if match and self.headers.get('Accept') == 'application/octet-stream':
                    return self.send(302, b'', [('Location', fake.cdn_url + '/blob/' + match.group(1))])
                self.send(404)

        class Cdn(Quiet):
            def do_GET(self):
                with fake.lock:
                    fake.requests.append(('cdn', self.path, self.headers.get('Authorization'), None))
                match = re.fullmatch(r'/blob/(\d+)', self.path)
                if match and int(match.group(1)) in fake.blobs:
                    return self.send(200, fake.blobs[int(match.group(1))])
                self.send(404)

        self.api = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Api)
        self.cdn = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Cdn)
        self.api_url = 'http://127.0.0.1:%d' % self.api.server_address[1]
        self.cdn_url = 'http://127.0.0.1:%d' % self.cdn.server_address[1]
        for server in (self.api, self.cdn):
            threading.Thread(target=server.serve_forever, daemon=True).start()

    def close(self):
        for server in (self.api, self.cdn):
            server.shutdown()
            server.server_close()

    def asset(self, name, data, served=None):
        self.next_id += 1
        self.blobs[self.next_id] = data if served is None else served
        return {'id': self.next_id, 'name': name, 'size': len(data if served is None else served),
                'url': '%s/repos/%s/releases/assets/%d' % (self.api_url, REPO, self.next_id)}

    def blob_requests(self):
        return [request for request in self.requests if request[0] == 'cdn']

    def add_release(self, version='0.2.0', tag=None, prerelease=True, draft=False, include_plan=True,
                    from_sources=(OLD_COMMIT,), args=('--allow-project-migrations', '--allow-existing-browser-heartbeat'),
                    plan_mutator=None, helper_entries=None, include_manifest=True, corrupt_runtime=False,
                    manifest_mutator=None):
        runtime_name = 'specweave-studio-%s-darwin-arm64.tgz' % version
        helpers_name = ROOT + '.tar.gz'
        runtime = b'fake runtime archive ' + version.encode()
        files = {'scripts/studio-fleet/update.py': FAKE_HELPER.encode(),
                 'scripts/studio-fleet/launcher.py': b'# fake launcher\n'}
        if helper_entries is None:
            helper_entries = [(ROOT, None, 'dir')] + [(ROOT + '/' + path, data, 'file') for path, data in files.items()]
        helpers = tar_bytes(helper_entries)
        manifest = {'archive': helpers_name, 'archiveSha256': sha(helpers),
                    'files': [{'path': path, 'sha256': sha(data), 'bytes': len(data),
                               'mode': 0o755 if path.endswith('update.py') else 0o644}
                              for path, data in files.items()]}
        if manifest_mutator:
            manifest_mutator(manifest)
        manifest_bytes = json.dumps(manifest).encode()
        sums_text = ''.join('%s  %s\n' % (sha(data), name) for name, data in
                            [(runtime_name, runtime), (helpers_name, helpers), (update_agent.MANIFEST_ASSET, manifest_bytes)])
        sums = update_agent.parse_sums(sums_text.encode())
        plan = make_update_plan.build_plan(version, NEW_COMMIT, sums, runtime_name, helpers_name, ROOT,
                                           list(from_sources), list(args))
        if plan_mutator:
            plan_mutator(plan)
        assets = [self.asset(runtime_name, runtime, served=(runtime + b'tampered') if corrupt_runtime else None),
                  self.asset(helpers_name, helpers),
                  self.asset(update_agent.SUMS_ASSET, sums_text.encode())]
        if include_manifest:
            assets.append(self.asset(update_agent.MANIFEST_ASSET, manifest_bytes))
        if include_plan:
            assets.append(self.asset(update_agent.PLAN_ASSET, json.dumps(plan).encode()))
        release = {'tag_name': tag or 'v' + version, 'draft': draft, 'prerelease': prerelease,
                   'body': 'Release notes ' + 'x' * 5000, 'published_at': '2026-10-01T00:00:00Z', 'assets': assets}
        self.releases.append(release)
        return {'release': release, 'plan': plan, 'runtime': runtime_name, 'runtimeSha': sha(runtime)}


class AgentCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = pathlib.Path(temporary.name).resolve()
        owner = update_agent.installation_descriptor.pwd.getpwuid(os.getuid())
        patcher = mock.patch.object(update_agent.installation_descriptor.pwd, 'getpwuid',
                                    return_value=type('Account', (), {'pw_dir': str(self.home), 'pw_name': owner.pw_name})())
        patcher.start()
        self.addCleanup(patcher.stop)
        self.own = self.home / '.specwithcode' / 'm4'
        self.own.mkdir(parents=True)
        self.updates = self.own / 'updates'
        self.write_installation('0.1.4', OLD_COMMIT)
        self.fake = FakeGitHub()
        self.addCleanup(self.fake.close)
        environment = {key: value for key, value in os.environ.items()
                       if key not in ('GH_TOKEN', 'GITHUB_TOKEN', 'STUDIO_UPDATE_TOKEN')}
        environment.update({'STUDIO_UPDATE_API_URL': self.fake.api_url, 'STUDIO_UPDATE_TOKEN': TOKEN,
                            'STUDIO_UPDATE_HELPER_PYTHON': sys.executable})
        patcher = mock.patch.dict(os.environ, environment, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.gh = mock.patch.object(update_agent, 'find_gh_token', return_value=None)
        self.gh_mock = self.gh.start()
        self.addCleanup(self.gh.stop)
        self.addCleanup(update_agent._REDACT.clear)
        self.log = ''
        # A fake clock: retry sleeps advance it at once, so retry windows end without waiting.
        self.offset, self.sleeps, self.on_sleep = datetime.timedelta(0), [], None
        real_now = update_agent.utcnow

        def fake_sleep(seconds):
            self.sleeps.append(seconds)
            self.offset += datetime.timedelta(seconds=seconds)
            if self.on_sleep:
                self.on_sleep()
        for name, value in (('utcnow', lambda: real_now() + self.offset),
                            ('time', mock.Mock(sleep=mock.Mock(side_effect=fake_sleep)))):
            patcher = mock.patch.object(update_agent, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def write_installation(self, version, commit):
        receipt = {'schemaVersion': 1, 'identity': 'm4', 'studioHome': str(self.own),
                   'stateDir': str(self.own / 'userdata'), 'version': version, 'sourceCommit': commit,
                   'archiveSha256': 'd' * 64, 'release': str(self.home / '.specwithcode/install/releases' / ('d' * 20)), 'node': '/usr/bin/node',
                   'uid': os.getuid(), 'user': update_agent.installation_descriptor.pwd.getpwuid(os.getuid()).pw_name,
                   'cliWrapper': str(self.home / '.local/bin/specweave-studio'), 'host': '127.0.0.1',
                   'port': 8319, 'service': {'installed': True, 'label': 'com.specweave.studio.m4', 'domain': 'gui/' + str(os.getuid())}}
        (self.own / 'installation.json').write_text(json.dumps(receipt))

    def config(self, **values):
        self.updates.mkdir(mode=0o700, exist_ok=True)
        config = dict(update_agent.DEFAULT_CONFIG)
        config.update(values)
        (self.updates / 'config.json').write_text(json.dumps(config))

    def control(self, **values):
        (self.home / 'fake-control.json').write_text(json.dumps(values))

    def run_agent(self, *extra):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = update_agent.main(['--identity', 'm4', '--home', str(self.home)] + list(extra))
        self.log += out.getvalue() + err.getvalue()
        return code

    def state(self):
        return json.loads((self.updates / 'state.json').read_text())

    def calls(self):
        path = self.home / 'fake-calls.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def snapshot_calls(self):
        return [call for call in self.calls() if '--snapshot' in call['argv']]

    def apply_calls(self):
        return [call for call in self.calls() if '--prestate' in call['argv']]

    def backdate_baseline(self, minutes):
        path = self.updates / 'snapshots' / 'baseline.json'
        value = json.loads(path.read_text())
        moment = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=minutes)
        value['observedAt'] = moment.isoformat()
        path.write_text(json.dumps(value))
        return value['observedAt']

    def assert_no_token_anywhere(self):
        self.assertNotIn(TOKEN, self.log)
        for path in self.home.rglob('*'):
            if path.is_file() and not path.is_symlink():
                self.assertNotIn(TOKEN.encode(), path.read_bytes(), str(path))


class Selection(unittest.TestCase):
    def releases(self):
        return [{'tag_name': 'v0.3.0', 'draft': True, 'prerelease': False},
                {'tag_name': 'v0.2.5', 'draft': False, 'prerelease': True},
                {'tag_name': 'v0.2.1', 'draft': False, 'prerelease': False},
                {'tag_name': 'v0.9.0-beta.1', 'draft': False, 'prerelease': False},
                {'tag_name': 'nightly', 'draft': False, 'prerelease': False},
                {'tag_name': 'v1.0', 'draft': False, 'prerelease': False},
                {'tag_name': 'v0.1.3', 'draft': False, 'prerelease': False},
                'not-a-release']

    def test_plain_versions_count_on_both_tracks_whatever_the_github_flag(self):
        installed = (0, 1, 4)
        self.assertEqual(update_agent.select_release(self.releases(), 'preview', installed)['tag_name'], 'v0.2.5')
        self.assertEqual(update_agent.select_release(self.releases(), 'stable', installed)['tag_name'], 'v0.2.5')

    def test_drafts_nonsemver_and_older_versions_are_ignored(self):
        self.assertIsNone(update_agent.select_release(self.releases(), 'preview', (0, 2, 5)))
        self.assertIsNone(update_agent.select_release([{'tag_name': 'v0.1.3'}], 'preview', (0, 1, 4)))
        self.assertIsNone(update_agent.select_release([{'tag_name': 'v0.1.4'}], 'preview', (0, 1, 4)))
        self.assertIsNone(update_agent.select_release([{'tag_name': 'v0.3.0', 'draft': True}], 'preview', (0, 1, 4)))
        self.assertEqual(update_agent.select_release([{'tag_name': 'v0.10.0'}, {'tag_name': 'v0.9.9'}],
                                                     'stable', (0, 1, 4))['tag_name'], 'v0.10.0')


class PlanPolicy(unittest.TestCase):
    def plan(self, **upgrade):
        base = {'fromSourceCommits': [OLD_COMMIT], 'entrypoint': update_agent.ENTRYPOINT,
                'args': ['--allow-project-migrations']}
        base.update(upgrade)
        return {'schemaVersion': 1, 'product': 'SpecWeave Studio', 'version': '0.2.0', 'sourceCommit': NEW_COMMIT,
                'service': {'platform': 'darwin-arm64',
                            'runtime': {'asset': 'r.tgz', 'sha256': '1' * 64},
                            'helpers': {'asset': 'h.tar.gz', 'sha256': '2' * 64, 'root': 'h'},
                            'upgrades': [base]}}

    def test_valid_plan_and_coverage(self):
        plan = update_agent.validate_plan(self.plan(), '0.2.0')
        self.assertEqual(update_agent.select_upgrade(plan, OLD_COMMIT), ['--allow-project-migrations'])
        with self.assertRaises(update_agent.ManualRequired):
            update_agent.select_upgrade(plan, OTHER_COMMIT)

    def test_disallowed_args_entrypoints_and_versions_are_rejected(self):
        for plan, version in [(self.plan(args=['--allow-project-migrations', '--force']), '0.2.0'),
                              (self.plan(args=['--allow-project-migrations; rm -rf ~']), '0.2.0'),
                              (self.plan(entrypoint='scripts/studio-fleet/install.py'), '0.2.0'),
                              (self.plan(entrypoint='../update.py'), '0.2.0'),
                              (self.plan(), '0.2.1')]:
            with self.subTest(plan=plan['service']['upgrades'][0], version=version):
                with self.assertRaisesRegex(update_agent.AgentError, 'Update plan was rejected'):
                    update_agent.validate_plan(plan, version)
        plan = self.plan()
        plan['service']['helpers']['root'] = '..'
        with self.assertRaises(update_agent.AgentError):
            update_agent.validate_plan(plan, '0.2.0')


class DownloadCache(AgentCase):
    def setUp(self):
        super().setUp()
        self.config()
        self.agent = update_agent.Agent(self.home, 'm4', True, lambda line: None)
        self.destination = self.updates / 'payload.tgz'
        self.record = self.updates / '.payload.tgz.asset.json'

    def download(self, asset, limit=1024):
        return self.agent.download_asset('payload.tgz', asset, self.destination, limit)

    def test_legacy_and_malformed_cache_records_require_a_download(self):
        asset = self.fake.asset('payload.tgz', b'new bytes')
        for record in (None, b'not JSON', b'{}', b'x' * 4097):
            with self.subTest(record=record and record[:8]):
                self.destination.write_bytes(b'old bytes')
                if self.record.exists():
                    self.record.unlink()
                if record is not None:
                    self.record.write_bytes(record)
                before = len(self.fake.blob_requests())
                self.download(asset)
                self.assertEqual(self.destination.read_bytes(), b'new bytes')
                self.assertEqual(len(self.fake.blob_requests()), before + 1)
                # A completed download resumes without another request.
                self.download(asset)
                self.assertEqual(len(self.fake.blob_requests()), before + 1)

    def test_cache_is_bound_to_api_repository_and_size(self):
        asset = self.fake.asset('payload.tgz', b'first')
        self.download(asset)
        other = FakeGitHub()
        self.addCleanup(other.close)
        same_id = other.asset('payload.tgz', b'other')
        self.assertEqual(asset['id'], same_id['id'])
        with mock.patch.dict(os.environ, {'STUDIO_UPDATE_API_URL': other.api_url}):
            self.download(same_id)
            self.assertEqual(self.destination.read_bytes(), b'other')
            self.agent.config['repository'] = 'another/repository'
            with self.assertRaisesRegex(update_agent.AgentError, 'HTTP 404'):
                self.download(same_id)
            self.assertTrue(any('/repos/another/repository/' in request[1] for request in other.requests))
        self.agent.config['repository'] = REPO
        self.download(asset)
        # Even matching IDs cannot reuse bytes of a different advertised size.
        asset['size'] = len(b'extended')
        self.fake.blobs[asset['id']] = b'extended'
        self.download(asset)
        self.assertEqual(self.destination.read_bytes(), b'extended')

    def test_crash_after_payload_replace_never_leaves_the_old_binding(self):
        first = self.fake.asset('payload.tgz', b'first')
        second = self.fake.asset('payload.tgz', b'other')
        self.download(first)
        with mock.patch.object(update_agent, 'write_json', side_effect=RuntimeError('simulated crash')):
            with self.assertRaisesRegex(RuntimeError, 'simulated crash'):
                self.download(second)
        self.assertEqual(self.destination.read_bytes(), b'other')
        self.assertFalse(self.record.exists())
        before = len(self.fake.blob_requests())
        self.download(first)
        self.assertEqual(self.destination.read_bytes(), b'first')
        self.assertEqual(len(self.fake.blob_requests()), before + 1)

    def test_incomplete_replacement_keeps_old_bytes_unbound_and_retries(self):
        first = self.fake.asset('payload.tgz', b'first')
        second = self.fake.asset('payload.tgz', b'other')
        self.download(first)
        self.fake.blobs[second['id']] = b'cut'
        with self.assertRaisesRegex(update_agent.AgentError, 'incomplete'):
            self.download(second)
        self.assertEqual(self.destination.read_bytes(), b'first')
        self.assertFalse(self.record.exists())
        self.assertFalse(self.destination.with_name('payload.tgz.part').exists())
        self.fake.blobs[second['id']] = b'other'
        self.download(second)
        self.assertEqual(self.destination.read_bytes(), b'other')

    def test_cached_payload_does_not_bypass_the_current_size_limit(self):
        asset = self.fake.asset('payload.tgz', b'first')
        self.download(asset)
        with self.assertRaisesRegex(update_agent.AgentError, 'size limit'):
            self.download(asset, limit=4)
        self.assertFalse(self.record.exists())

    def test_symlinked_cache_paths_are_replaced_without_following_targets(self):
        asset = self.fake.asset('payload.tgz', b'first')
        target = self.home / 'must-not-change'
        target.write_bytes(b'keep me')
        for path in (self.record, self.destination, self.destination.with_name('payload.tgz.part')):
            with self.subTest(path=path.name):
                for leftover in (self.record, self.destination):
                    if os.path.lexists(str(leftover)):
                        leftover.unlink()
                path.symlink_to(target)
                self.download(asset)
                self.assertEqual(target.read_bytes(), b'keep me')
                self.assertFalse(path.is_symlink())
                self.assertEqual(self.destination.read_bytes(), b'first')
                self.assertTrue(self.record.is_file() and not self.record.is_symlink())
                self.assertFalse(os.path.lexists(str(self.destination.with_name('payload.tgz.part'))))

    def test_directories_in_cache_paths_are_cleared(self):
        asset = self.fake.asset('payload.tgz', b'first')
        for path in (self.record, self.destination, self.destination.with_name('payload.tgz.part')):
            with self.subTest(path=path.name):
                for leftover in (self.record, self.destination):
                    if leftover.is_file():
                        leftover.unlink()
                (path / 'nested').mkdir(parents=True)
                self.download(asset)
                self.assertEqual(self.destination.read_bytes(), b'first')
                self.assertTrue(self.record.is_file())
                self.assertFalse(os.path.lexists(str(self.destination.with_name('payload.tgz.part'))))

    def test_cache_directory_with_a_symlink_ancestor_is_refused(self):
        asset = self.fake.asset('payload.tgz', b'first')
        real = self.home / 'elsewhere'
        real.mkdir()
        link = self.updates / 'linked'
        link.symlink_to(real)
        with self.assertRaisesRegex(update_agent.AgentError, 'symlink'):
            self.agent.download_asset('payload.tgz', asset, link / 'payload.tgz', 1024)
        self.assertEqual(list(real.iterdir()), [])
        self.assertEqual(self.fake.requests, [])


class PassBehaviour(AgentCase):
    def test_config_off_is_disabled_without_network_or_gh(self):
        self.fake.add_release()
        self.config(checkAutomatically=False)
        self.assertEqual(self.run_agent(), 0)
        self.assertEqual(self.state()['status'], 'disabled')
        self.assertEqual(self.state()['installedVersion'], '0.1.4')
        self.assertEqual(self.fake.requests, [])
        self.gh_mock.assert_not_called()

    def test_missing_plan_is_manual_required(self):
        self.fake.add_release(include_plan=False)
        self.assertEqual(self.run_agent(), 0)
        state = self.state()
        self.assertEqual(state['status'], 'manual-required')
        self.assertIn('manual upgrade', state['message'])
        self.assertEqual(state['availableVersion'], '0.2.0')
        self.assertFalse((self.updates / 'helpers').exists())
        # Not due again: the next pass reuses the saved result without network.
        before = len(self.fake.requests)
        self.run_agent()
        self.assertEqual(self.state()['status'], 'manual-required')
        self.assertEqual(len(self.fake.requests), before)

    def test_uncovered_installed_commit_is_manual_required(self):
        self.fake.add_release(from_sources=(OTHER_COMMIT,))
        self.run_agent()
        state = self.state()
        self.assertEqual(state['status'], 'manual-required')
        self.assertIn('manual upgrade', state['message'])
        self.assertEqual(len(self.fake.blob_requests()), 2)  # Plan and checksum bindings; no archives.

    def test_disallowed_arg_and_entrypoint_are_rejected_before_downloading(self):
        def bad_arg(plan):
            plan['service']['upgrades'][0]['args'].append('--skip-verification')

        def bad_entry(plan):
            plan['service']['upgrades'][0]['entrypoint'] = 'scripts/studio-fleet/install.py'

        for mutator in (bad_arg, bad_entry):
            with self.subTest(mutator=mutator.__name__):
                self.fake.releases = []
                self.fake.requests = []
                if (self.updates / 'state.json').exists():
                    (self.updates / 'state.json').unlink()
                self.fake.add_release(plan_mutator=mutator)
                self.assertEqual(self.run_agent(), 1)
                state = self.state()
                self.assertEqual(state['status'], 'error')
                self.assertIn('Update plan was rejected', state['message'])
                self.assertEqual(len(self.fake.blob_requests()), 1)
                self.assertFalse((self.updates / 'helpers').exists())
                self.assertEqual(self.calls(), [])

    def test_sha_mismatch_is_rejected_and_nothing_is_extracted(self):
        self.fake.add_release(corrupt_runtime=True)
        self.assertEqual(self.run_agent(), 1)
        state = self.state()
        self.assertEqual(state['status'], 'error')
        self.assertIn('checksum', state['message'])
        self.assertIsNone(state['downloadedVersion'])
        self.assertFalse((self.updates / 'helpers' / '0.2.0').exists())
        self.assertFalse((self.updates / 'downloads' / '0.2.0' / 'verified.json').exists())
        self.assertFalse((self.updates / 'downloads' / '0.2.0' / 'specweave-studio-0.2.0-darwin-arm64.tgz').exists())
        self.assertEqual(self.calls(), [])
        # A rejected download is not retried until the next check.
        blobs = len(self.fake.blob_requests())
        self.run_agent()
        self.assertEqual(self.state()['status'], 'error')
        self.assertEqual(len(self.fake.blob_requests()), blobs)

    def test_tarball_traversal_symlink_and_unindexed_files_are_rejected(self):
        good = [(ROOT + '/scripts/studio-fleet/update.py', FAKE_HELPER.encode(), 'file'),
                (ROOT + '/scripts/studio-fleet/launcher.py', b'# fake launcher\n', 'file')]
        cases = [('traversal', good + [(ROOT + '/../../evil.py', b'owned', 'file')], False),
                 ('absolute', good + [('/tmp/evil.py', b'owned', 'file')], False),
                 ('outside-root', good + [('other/evil.py', b'owned', 'file')], False),
                 ('symlink', good + [(ROOT + '/scripts/link', '../../..', 'symlink')], False),
                 ('unindexed', good + [(ROOT + '/scripts/extra.py', b'extra', 'file')], True)]
        for name, entries, with_manifest in cases:
            with self.subTest(case=name):
                self.fake.releases = []
                for path in [self.updates / 'state.json']:
                    if path.exists():
                        path.unlink()
                if (self.updates / 'downloads').exists():
                    update_agent.remove_path(self.updates / 'downloads', self.home)
                self.fake.add_release(helper_entries=entries, include_manifest=with_manifest)
                self.assertEqual(self.run_agent(), 1)
                state = self.state()
                self.assertEqual(state['status'], 'error')
                self.assertIn('Helper archive', state['message'])
                self.assertFalse((self.updates / 'helpers' / '0.2.0').exists())
                self.assertEqual([p.name for p in (self.updates / 'helpers').iterdir()], [])
                self.assertFalse((self.home / 'evil.py').exists())
                self.assertFalse((self.updates / 'evil.py').exists())
                self.assertEqual(self.calls(), [])

    def test_manifest_hash_mismatch_is_rejected(self):
        def tamper(manifest):
            manifest['files'][0]['sha256'] = '0' * 64
        self.fake.add_release(manifest_mutator=tamper)
        self.assertEqual(self.run_agent(), 1)
        self.assertIn('does not match the manifest', self.state()['message'])
        self.assertFalse((self.updates / 'helpers' / '0.2.0').exists())

    def test_same_size_replacement_assets_download_on_the_first_fresh_check(self):
        info = self.fake.add_release()
        self.config(installAutomatically=False)
        self.assertEqual(self.run_agent(), 0)
        self.assertEqual(self.state()['status'], 'downloaded')
        assets = info['release']['assets']
        previous = {asset['name']: asset for asset in assets}
        runtime = self.fake.blobs[previous[info['runtime']]['id']]
        replacement = runtime.replace(b'fake', b'good')
        self.assertEqual(len(replacement), len(runtime))
        info['plan']['service']['runtime']['sha256'] = sha(replacement)
        sums = self.fake.blobs[previous[update_agent.SUMS_ASSET]['id']]
        sums = sums.replace(info['runtimeSha'].encode(), sha(replacement).encode())
        replacements = {info['runtime']: replacement, update_agent.SUMS_ASSET: sums,
                        update_agent.PLAN_ASSET: json.dumps(info['plan']).encode()}
        assets[:] = [self.fake.asset(asset['name'], replacements[asset['name']])
                     if asset['name'] in replacements else asset for asset in assets]
        for asset in assets:
            self.assertEqual(asset['size'], previous[asset['name']]['size'])
        before = len(self.fake.blob_requests())
        self.config(installAutomatically=False, checkRequestedAt='2026-10-12T10:00:00Z')
        self.assertEqual(self.run_agent(), 0, self.log)
        self.assertEqual(self.state()['status'], 'downloaded')
        downloaded = self.updates / 'downloads' / '0.2.0' / info['runtime']
        self.assertEqual(downloaded.read_bytes(), replacement)
        # The unchanged helper archive and manifest remain resumable.
        fetched = {request[1] for request in self.fake.blob_requests()[before:]}
        self.assertEqual(fetched, {'/blob/%d' % asset['id'] for asset in assets
                                  if asset['name'] in replacements})
        self.assertEqual(self.calls(), [])

    def test_asset_binding_does_not_bypass_checksum_verification(self):
        info = self.fake.add_release()
        self.config(installAutomatically=False)
        self.assertEqual(self.run_agent(), 0)
        directory = self.updates / 'downloads' / '0.2.0'
        runtime = directory / info['runtime']
        runtime.write_bytes(runtime.read_bytes().replace(b'fake', b'evil'))
        (directory / 'verified.json').unlink()
        before = len(self.fake.blob_requests())
        self.assertEqual(self.run_agent(), 1)
        self.assertIn('checksum', self.state()['message'])
        self.assertEqual(len(self.fake.blob_requests()), before)
        self.assertFalse(runtime.exists())
        self.assertFalse(list(directory.glob('.*.asset.json')))
        self.assertEqual(self.calls(), [])

    def test_symlinked_or_directory_cache_entries_do_not_block_a_pass(self):
        info = self.fake.add_release()
        self.config(installAutomatically=False)
        self.assertEqual(self.run_agent(), 0)
        directory = self.updates / 'downloads' / '0.2.0'
        runtime, record = directory / info['runtime'], directory / ('.%s.asset.json' % info['runtime'])
        good, target = runtime.read_bytes(), self.home / 'must-not-change'
        target.write_bytes(b'keep me')
        for corrupt in ('runtime-symlink', 'record-symlink', 'record-directory'):
            with self.subTest(corrupt=corrupt):
                (directory / 'verified.json').unlink()
                path = runtime if corrupt == 'runtime-symlink' else record
                path.unlink()
                if corrupt.endswith('symlink'):
                    path.symlink_to(target)
                else:
                    path.mkdir()
                self.assertEqual(self.run_agent(), 0, self.log)
                self.assertEqual(self.state()['status'], 'downloaded')
                self.assertEqual(runtime.read_bytes(), good)
                self.assertFalse(runtime.is_symlink() or record.is_symlink())
                self.assertTrue(record.is_file())
                self.assertEqual(target.read_bytes(), b'keep me')

    def test_runtime_changed_on_disk_before_install_is_downloaded_again(self):
        info = self.fake.add_release()
        self.config(installAutomatically=False)
        self.assertEqual(self.run_agent(), 0)
        directory = self.updates / 'downloads' / '0.2.0'
        runtime = directory / info['runtime']
        good = runtime.read_bytes()
        runtime.write_bytes(good.replace(b'fake', b'evil'))
        self.config(installAutomatically=False, installRequestedAt='2026-10-10T10:00:00Z')
        self.assertEqual(self.run_agent(), 1)
        self.assertIn('downloaded again', self.state()['message'])
        self.assertFalse(os.path.lexists(str(runtime)))
        self.assertFalse(list(directory.glob('.%s*' % info['runtime'])))
        self.assertEqual(self.apply_calls(), [])
        before = len(self.fake.blob_requests())
        self.assertEqual(self.run_agent(), 0, self.log)
        self.assertEqual(len(self.fake.blob_requests()), before + 1)
        self.assertEqual(self.state()['status'], 'installed')
        self.assertEqual(len(self.apply_calls()), 1)

    def test_download_off_reports_available(self):
        self.fake.add_release()
        self.config(downloadInBackground=False)
        self.assertEqual(self.run_agent(), 0)
        state = self.state()
        self.assertEqual(state['status'], 'available')
        self.assertEqual(state['availableVersion'], '0.2.0')
        self.assertEqual(state['availableTag'], 'v0.2.0')
        self.assertEqual(len(state['availableNotes']), 4000)
        self.assertEqual(state['availablePublishedAt'], '2026-10-01T00:00:00Z')
        self.assertIsNone(state['downloadedVersion'])
        self.assertEqual(len(self.fake.blob_requests()), 2)  # Plan and checksum bindings; no archives.

    def test_stable_channel_takes_a_plain_version_flagged_prerelease(self):
        self.fake.add_release(prerelease=True)
        self.config(channel='stable')
        self.run_agent()
        self.assertEqual(self.state()['availableVersion'], '0.2.0')

    def test_quiet_logic_baseline_reset_wait_and_apply(self):
        info = self.fake.add_release()
        self.config(quietMinutes=10)
        self.control(counts={'projection_threads': 3})
        self.assertEqual(self.run_agent(), 0)
        state = self.state()
        self.assertEqual(state['status'], 'waiting-for-quiet')
        self.assertEqual(state['downloadedVersion'], '0.2.0')
        self.assertIsNotNone(state['quietSince'])
        self.assertTrue((self.updates / 'snapshots' / 'baseline.json').is_file())
        self.assertEqual(len(self.snapshot_calls()), 1)
        call = self.snapshot_calls()[0]
        self.assertTrue(call['cwd'].endswith(ROOT + '/scripts/studio-fleet'))
        # Exactly the documented helper environment. The helper's own Python may add LC_CTYPE
        # (locale coercion) and, for the macOS system Python, __CF_USER_TEXT_ENCODING.
        self.assertEqual(set(call['env']) - {'LC_CTYPE', '__CF_USER_TEXT_ENCODING'}, {'HOME', 'LANG', 'PATH', 'STUDIO_UPDATE_APPLY_BUDGET'})
        # Changed counts reset the baseline even after the quiet period elapsed.
        self.backdate_baseline(11)
        self.control(counts={'projection_threads': 4})
        self.run_agent()
        state = self.state()
        self.assertEqual(state['status'], 'waiting-for-quiet')
        reset_since = state['quietSince']
        self.assertEqual(self.apply_calls(), [])
        self.assertLess(datetime.datetime.now(datetime.timezone.utc) - update_agent.parse_time(reset_since),
                        datetime.timedelta(minutes=1))
        # Unchanged but not yet quiet long enough: keep waiting and keep the original baseline.
        self.run_agent()
        self.assertEqual(self.state()['status'], 'waiting-for-quiet')
        self.assertEqual(self.state()['quietSince'], reset_since)
        self.assertEqual(self.apply_calls(), [])
        self.assertEqual(len(list((self.updates / 'snapshots').iterdir())), 1)
        # Unchanged for quietMinutes: apply with the newest snapshot and the plan's args.
        self.backdate_baseline(11)
        self.assertEqual(self.run_agent(), 0)
        applies = self.apply_calls()
        self.assertEqual(len(applies), 1)
        argv = applies[0]['argv']
        self.assertEqual(argv[:2], ['--identity', 'm4'])
        self.assertTrue(argv[argv.index('--archive') + 1].endswith(info['runtime']))
        self.assertEqual(argv[argv.index('--sha256') + 1], info['runtimeSha'])
        self.assertEqual(argv[-2:], ['--allow-project-migrations', '--allow-existing-browser-heartbeat'])
        prestate = json.loads(pathlib.Path(argv[argv.index('--prestate') + 1]).read_text())
        self.assertEqual(prestate['rows']['counts'], {'projection_threads': 4})
        state = self.state()
        self.assertEqual(state['status'], 'installed')
        self.assertEqual(state['installedVersion'], '0.2.0')
        self.assertEqual(state['installedSourceCommit'], NEW_COMMIT)
        self.assertEqual(state['lastInstall']['result'], 'updated')
        self.assertEqual(state['lastInstall']['version'], '0.2.0')
        self.assertTrue(pathlib.Path(state['lastInstall']['receipt']).is_file())
        self.assertIsNone(state['quietSince'])
        self.assertFalse((self.updates / 'downloads' / '0.2.0').exists())
        self.assertFalse((self.updates / 'helpers' / '0.2.0').exists())
        self.assertNotIn('helper-private', self.log)
        # The next pass settles to up-to-date.
        self.run_agent()
        self.assertEqual(self.state()['status'], 'up-to-date')
        self.assertEqual(len(self.apply_calls()), 1)
        self.assert_no_token_anywhere()

    def test_limit_checks_of_a_waiting_thread_do_not_reset_the_quiet_time(self):
        self.fake.add_release()
        self.config(quietMinutes=10)
        counts = {'projection_threads': 3, 'orchestration_v2_projection_messages': 46,
                  'orchestration_events': 2381, 'orchestration_command_receipts': 1113}
        self.control(counts=counts)
        self.run_agent()
        since = self.state()['quietSince']
        # A thread waiting on a usage limit is checked every five minutes: two more log rows, no work.
        self.backdate_baseline(11)
        backdated = json.loads((self.updates / 'snapshots' / 'baseline.json').read_text())['observedAt']
        self.assertNotEqual(backdated, since)
        self.control(counts=dict(counts, orchestration_events=2383, orchestration_command_receipts=1115))
        self.assertEqual(self.run_agent(), 0)
        self.assertEqual(len(self.apply_calls()), 1)
        self.assertEqual(self.state()['status'], 'installed')

    def test_a_new_message_still_resets_the_quiet_time(self):
        self.fake.add_release()
        self.config(quietMinutes=10)
        counts = {'projection_threads': 3, 'orchestration_v2_projection_messages': 46,
                  'orchestration_events': 2381, 'orchestration_command_receipts': 1113}
        self.control(counts=counts)
        self.run_agent()
        self.backdate_baseline(11)
        self.control(counts=dict(counts, orchestration_v2_projection_messages=47, orchestration_events=2390))
        self.run_agent()
        self.assertEqual(self.state()['status'], 'waiting-for-quiet')
        self.assertEqual(self.apply_calls(), [])

    def test_service_restart_between_snapshots_resets_the_baseline(self):
        self.fake.add_release()
        self.control(pid=1)
        self.run_agent()
        self.backdate_baseline(30)
        self.control(pid=2)
        self.run_agent()
        self.assertEqual(self.state()['status'], 'waiting-for-quiet')
        self.assertEqual(self.apply_calls(), [])

    def test_nonidle_snapshot_failure_waits_and_drops_baseline(self):
        self.fake.add_release()
        self.run_agent()
        self.assertTrue((self.updates / 'snapshots' / 'baseline.json').exists())
        self.backdate_baseline(30)
        self.control(snapshotFail=True)
        self.assertEqual(self.run_agent(), 0)
        state = self.state()
        self.assertEqual(state['status'], 'waiting-for-quiet')
        # The test home publishes no CLI credential: it waits for quiet and never pauses work.
        self.assertEqual(state['message'], 'Waiting for running tasks, queued messages and open questions to finish')
        self.assertIsNone(state['automaticPauseAt'])
        self.assertIsNone(state['quietSince'])
        self.assertEqual(list((self.updates / 'snapshots').iterdir()), [])
        self.assertEqual(self.apply_calls(), [])
        self.assertNotIn('Native work is not idle', self.log)

    def test_snapshot_refusal_names_what_is_still_running(self):
        self.fake.add_release()
        cases = (('AssertionError: Owned service has unexpected descendants',
                  'Waiting for open SpecWithCode terminals and agent processes to close'),
                 ('AssertionError: Owned service has unexpected or missing descendants',
                  'Waiting for open SpecWithCode terminals and agent processes to close'),
                 ('Traceback (most recent call last):\nOSError: database is locked', update_agent.WAITING))
        for error, message in cases:
            self.control(snapshotFail=True, snapshotError=error)
            self.assertEqual(self.run_agent(), 0)
            self.assertEqual(self.state()['status'], 'waiting-for-quiet')
            self.assertEqual(self.state()['message'], message)
            self.assertIsNone(self.state()['automaticPauseAt'])  # No CLI credential published.
            # The helper's output is read, never kept or logged.
            self.assertEqual(list((self.updates / 'snapshots').iterdir()), [])
            self.assertNotIn('descendants', self.log)
            self.assertNotIn('database is locked', self.log)

    def test_a_service_that_lost_its_database_locks_waits_for_its_restart_instead_of_failing(self):
        # M4, 2026-10-19: this was `error` every ten minutes and the update never installed.
        self.fake.add_release()
        lost = 'AssertionError: The SpecWithCode service lost its SQLite locks on its database.'
        self.control(snapshotFail=True, snapshotError=lost + '\nREFUSAL restart-needed locks-lost wait=540')
        self.assertEqual(self.run_agent(), 0)
        self.assertEqual((self.state()['status'], self.state()['message']),
                         ('waiting-for-quiet', 'Restarting SpecWithCode to recover its database'))
        self.assertNotIn('SQLite locks', self.log)
        # Update now: the helper restarted the service, and the next snapshot installs.
        self.config(installMode='force', installRequestedAt='2026-10-10T10:00:00Z',
                    installHoldUntil=update_agent.iso(update_agent.utcnow() + datetime.timedelta(minutes=15)))
        self.control(snapshotFailures=2, snapshotError=lost + '\nREFUSAL restart-needed locks-lost restarted=1')
        self.assertEqual(self.run_agent(), 0)
        self.assertEqual(self.state()['status'], 'installed')
        self.assertEqual(len(self.apply_calls()), 1)

    def test_install_request_skips_wait_once(self):
        self.fake.add_release()
        self.config(installAutomatically=False, installRequestedAt='2026-10-10T10:00:00Z', quietMinutes=60)
        # Non-idle: the request stays pending.
        self.control(snapshotFail=True)
        self.run_agent()
        self.assertEqual(self.state()['status'], 'waiting-for-quiet')
        self.assertIsNone(self.state()['handledInstallRequestAt'])
        # Idle but failing apply: one immediate attempt, then the request is honoured.
        self.control(applyFail=True)
        self.assertEqual(self.run_agent(), 1)
        state = self.state()
        self.assertEqual(state['status'], 'error')
        self.assertEqual(state['handledInstallRequestAt'], '2026-10-10T10:00:00Z')
        self.assertEqual(state['lastInstall']['result'], 'failed')
        self.assertEqual(state['installedVersion'], '0.1.4')
        self.assertEqual(len(self.apply_calls()), 1)
        self.assertNotIn('helper-private', self.log)
        # Same request again: not re-applied.
        self.run_agent()
        self.assertEqual(len(self.apply_calls()), 1)
        self.assertEqual(self.state()['status'], 'downloaded')
        # A new request installs immediately without a quiet baseline.
        self.control()
        self.config(installAutomatically=False, installRequestedAt='2026-10-10T11:00:00Z', quietMinutes=60)
        self.run_agent()
        state = self.state()
        self.assertEqual(state['status'], 'installed')
        self.assertEqual(state['handledInstallRequestAt'], '2026-10-10T11:00:00Z')
        self.assertEqual(len(self.apply_calls()), 2)

    def test_failed_automatic_install_is_not_retried_automatically(self):
        self.fake.add_release()
        self.config(quietMinutes=0)
        self.control(applyFail=True)
        self.run_agent()
        self.run_agent()
        self.assertEqual(len(self.apply_calls()), 1)
        self.assertEqual(self.state()['status'], 'error')
        self.run_agent()
        self.assertEqual(len(self.apply_calls()), 1)
        self.assertIn('Install now', self.state()['message'])

    def test_failed_current_version_stays_error_after_repeated_checks(self):
        self.fake.add_release()
        self.config(installRequestedAt='2026-10-10T10:00:00Z')
        self.control(applyFailAfterSwitch=True)
        self.assertEqual(self.run_agent(), 1)
        failed = self.state()['lastInstall']
        self.assertEqual(failed['result'], 'failed')
        self.assertEqual(self.state()['installedVersion'], '0.2.0')
        receipt = pathlib.Path(failed['receipt'])
        receipt_bytes = receipt.read_bytes()
        helper_calls = self.calls()
        # Recover the diagnostic even if an older agent already cleared it.
        state = self.state()
        state.update(status='up-to-date', message=None)
        (self.updates / 'state.json').write_text(json.dumps(state))
        for requests in ({}, {'checkRequestedAt': '2026-10-10T11:00:00Z'},
                         {'installRequestedAt': '2026-10-10T12:00:00Z'}):
            with self.subTest(requests=requests):
                self.config(**requests)
                self.assertEqual(self.run_agent(), 1)
                state = self.state()
                self.assertEqual(state['status'], 'error')
                self.assertIn('See the update receipt', state['message'])
                self.assertEqual(state['lastInstall'], failed)
                self.assertEqual(receipt.read_bytes(), receipt_bytes)
                self.assertEqual(self.calls(), helper_calls)
                self.assertIsNone(state['availableVersion'])
                self.assertIsNone(state['downloadedVersion'])
                for key, value in requests.items():
                    handled = {'checkRequestedAt': 'handledCheckRequestAt',
                               'installRequestedAt': 'handledInstallRequestAt'}[key]
                    self.assertEqual(state[handled], value)

    def test_install_that_outlives_the_timeout_and_verifies_is_not_reported_failed(self):
        self.fake.add_release()
        self.config(installRequestedAt='2026-10-10T10:00:00Z')
        real = update_agent.run_helper_process

        def slow(command, *args, **kwargs):
            outcome = real(command, *args, **kwargs)
            return 'timeout' if '--prestate' in [str(part) for part in command] and outcome == 'ok' else outcome
        with mock.patch.object(update_agent, 'run_helper_process', slow):
            self.assertEqual(self.run_agent(), 1)
        self.assertEqual(self.state()['lastInstall']['result'], 'failed')
        self.assertEqual(self.state()['installedVersion'], '0.2.0')
        # The timed-out helper left its marker; the next pass settles it as the install it was.
        self.assertEqual(self.run_agent(), 0)
        self.assertEqual((self.state()['status'], self.state()['lastInstall']['result']), ('installed', 'updated'))
        for requests in ({}, {'checkRequestedAt': '2026-10-10T11:00:00Z'}):
            with self.subTest(requests=requests):
                self.config(**requests)
                self.assertEqual(self.run_agent(), 0)
                self.assertEqual(self.state()['status'], 'up-to-date')
                self.assertIsNone(self.state()['message'])

    def test_rewriting_installation_metadata_does_not_clear_failed_update(self):
        self.fake.add_release()
        self.config(installRequestedAt='2026-10-10T10:00:00Z')
        self.control(applyFailAfterSwitch=True)
        self.assertEqual(self.run_agent(), 1)
        self.assertEqual(self.run_agent(), 1)
        failed = self.state()['lastInstall']
        receipt = pathlib.Path(failed['receipt'])
        receipt_bytes = receipt.read_bytes()
        helper_calls = self.calls()
        self.write_installation('0.2.0', NEW_COMMIT)
        later = receipt.stat().st_mtime + 5
        os.utime(str(self.own / 'installation.json'), (later, later))
        for requests in ({}, {'checkRequestedAt': '2026-10-10T11:00:00Z'}):
            with self.subTest(requests=requests):
                self.config(**requests)
                self.assertEqual(self.run_agent(), 1)
                self.assertEqual(self.state()['status'], 'error')
                self.assertIn('See the update receipt', self.state()['message'])
                self.assertEqual(self.state()['lastInstall'], failed)
                self.assertEqual(receipt.read_bytes(), receipt_bytes)
                self.assertEqual(self.calls(), helper_calls)

    def test_failed_update_needs_a_positive_completion_receipt(self):
        self.fake.add_release()
        self.config(installRequestedAt='2026-10-10T10:00:00Z')
        self.control(applyFailAfterSwitch=True)
        self.assertEqual(self.run_agent(), 1)
        failed = self.state()['lastInstall']
        receipt = pathlib.Path(failed['receipt'])
        helper_calls = self.calls()
        cases = [None, 'malformed JSON', 'null', '[]', '{}', '{"phase":"prepared"}',
                 '{"phase":"verified"}',
                 '{"phase":"verified","preservedRowsAuthAndIdentity":false,"originalServicesPreserved":true}',
                 '{"phase":"verified","preservedRowsAuthAndIdentity":true,"originalServicesPreserved":false}',
                 '{"phase":"verified","preservedRowsAuthAndIdentity":true,"originalServicesPreserved":true,"result":"update-failed"}']
        for content in cases:
            with self.subTest(receipt=content):
                if content is None:
                    receipt.unlink()
                else:
                    receipt.write_text(content)
                self.assertEqual(self.run_agent(), 1)
                self.assertEqual(self.state()['status'], 'error')
                self.assertIn('See the update receipt', self.state()['message'])
                self.assertEqual(self.state()['lastInstall'], failed)
                self.assertEqual(self.calls(), helper_calls)
                self.assertEqual(receipt.read_text() if receipt.exists() else None, content)

        # update.py writes these verification fields; result=updated is stdout only.
        verified = json.dumps({'phase': 'verified', 'preservedRowsAuthAndIdentity': True,
            'originalServicesPreserved': True, 'onlyKnownOwnedServiceRestarted': True,
            'before': {'schemaVersion': 1, 'identity': 'm4', 'serviceLabel': 'com.specweave.studio.m4',
                       'artifactSourceCommit': OLD_COMMIT},
            'after': {'schemaVersion': 1, 'identity': 'm4', 'serviceLabel': 'com.specweave.studio.m4',
                      'artifactSourceCommit': NEW_COMMIT,
                      'archiveSha256': json.loads((self.own / 'installation.json').read_text())['archiveSha256']}})
        receipt.write_text(verified)
        self.assertEqual(self.run_agent(), 0)
        self.assertEqual(self.state()['status'], 'up-to-date')
        self.assertIsNone(self.state()['message'])
        self.assertEqual(self.state()['lastInstall'], failed)
        self.assertEqual(self.calls(), helper_calls)
        self.assertEqual(receipt.read_text(), verified)

    def test_successful_install_stays_successful_if_its_receipt_is_removed(self):
        self.fake.add_release()
        self.config(installRequestedAt='2026-10-10T10:00:00Z')
        self.assertEqual(self.run_agent(), 0)
        success = self.state()['lastInstall']
        self.assertEqual(success['result'], 'updated')
        pathlib.Path(success['receipt']).unlink()
        helper_calls = self.calls()
        self.assertEqual(self.run_agent(), 0)
        self.assertEqual(self.state()['status'], 'up-to-date')
        self.assertEqual(self.state()['lastInstall'], success)
        self.assertEqual(self.calls(), helper_calls)

    def test_older_failed_install_does_not_mark_newer_install_as_failed(self):
        self.fake.add_release()
        self.config(installRequestedAt='2026-10-10T10:00:00Z')
        self.control(applyFailAfterSwitch=True)
        self.assertEqual(self.run_agent(), 1)
        failed = self.state()['lastInstall']
        self.write_installation('0.3.0', OTHER_COMMIT)
        helper_calls = self.calls()
        self.assertEqual(self.run_agent(), 0)
        self.assertEqual(self.state()['status'], 'up-to-date')
        self.assertIsNone(self.state()['message'])
        self.assertEqual(self.state()['lastInstall'], failed)
        self.assertEqual(self.calls(), helper_calls)

    def test_failed_current_version_does_not_hide_newer_available_release(self):
        self.fake.add_release()
        self.config(installRequestedAt='2026-10-10T10:00:00Z')
        self.control(applyFailAfterSwitch=True)
        self.assertEqual(self.run_agent(), 1)
        failed = self.state()['lastInstall']
        self.fake.add_release(version='0.3.0', from_sources=(NEW_COMMIT,))
        self.config(downloadInBackground=False, checkRequestedAt='2026-10-10T11:00:00Z')
        helper_calls = self.calls()
        self.assertEqual(self.run_agent(), 0)
        self.assertEqual(self.state()['status'], 'available')
        self.assertEqual(self.state()['availableVersion'], '0.3.0')
        self.assertEqual(self.state()['lastInstall'], failed)
        self.assertEqual(self.calls(), helper_calls)

    def test_check_request_is_honoured_once(self):
        self.fake.add_release()
        self.config(checkAutomatically=False, downloadInBackground=False, checkRequestedAt='2026-10-10T09:00:00Z')
        self.run_agent()
        state = self.state()
        self.assertEqual(state['status'], 'available')
        self.assertEqual(state['handledCheckRequestAt'], '2026-10-10T09:00:00Z')
        lists = [r for r in self.fake.requests if r[1].endswith('per_page=30')]
        self.assertEqual(len(lists), 1)
        self.run_agent()
        self.assertEqual(self.state()['status'], 'disabled')
        self.assertEqual(len([r for r in self.fake.requests if r[1].endswith('per_page=30')]), 1)
        # A recent automatic check is not repeated, but a new request is.
        self.config(checkAutomatically=True, downloadInBackground=False, checkRequestedAt='2026-10-10T09:00:00Z')
        self.run_agent()
        self.assertEqual(len([r for r in self.fake.requests if r[1].endswith('per_page=30')]), 1)
        self.config(checkAutomatically=True, downloadInBackground=False, checkRequestedAt='2026-10-10T09:30:00Z')
        self.run_agent()
        self.assertEqual(len([r for r in self.fake.requests if r[1].endswith('per_page=30')]), 2)

    def test_token_is_sent_only_to_api_and_never_leaks(self):
        self.fake.add_release()
        self.config(quietMinutes=0)
        self.run_agent()
        self.run_agent()
        self.assertEqual(self.state()['status'], 'installed')
        api = [r for r in self.fake.requests if r[0] == 'api']
        self.assertTrue(api and all(r[2] == 'Bearer ' + TOKEN for r in api))
        self.assertTrue(self.fake.blob_requests())
        self.assertTrue(all(r[2] is None for r in self.fake.blob_requests()))
        # A refused request with a token reports access without the token.
        self.fake.list_status = 401
        self.config(checkRequestedAt='2026-10-10T12:00:00Z')
        self.assertEqual(self.run_agent(), 1)
        self.assertIn('refused access', self.state()['message'])
        self.assert_no_token_anywhere()
        agent = update_agent.Agent(self.home, 'm4', True, lambda line: None)
        agent.config = dict(update_agent.DEFAULT_CONFIG)
        with self.assertRaises(update_agent.AgentError) as caught:
            agent.fetch_bytes(self.fake.api_url + '/repos/%s/releases?per_page=30' % REPO, 'application/json', 1000)
        self.assertNotIn(TOKEN, str(caught.exception))
        self.assertNotIn(TOKEN, repr(caught.exception.args))
        self.assertIsNone(caught.exception.__cause__)
        self.assertNotIn(TOKEN, update_agent.redact('leak ' + TOKEN))

    def test_unexpected_failure_text_is_redacted(self):
        self.fake.add_release()

        def explode(*args, **kwargs):
            raise RuntimeError('boom ' + TOKEN)
        with mock.patch.object(update_agent.Agent, 'check', explode):
            self.assertEqual(self.run_agent(), 1)
        self.assertIn('Unexpected updater failure (RuntimeError)', self.state()['message'])
        self.assert_no_token_anywhere()

    def test_no_token_private_repo_asks_for_gh_login(self):
        self.fake.repository = 'anton-abyzov/specwithcode'
        self.config(repository=self.fake.repository)
        os.environ.pop('STUDIO_UPDATE_TOKEN')
        self.fake.list_status = 404
        self.assertEqual(self.run_agent(), 1)
        state = self.state()
        self.assertEqual(state['status'], 'error')
        self.assertEqual(state['message'], update_agent.SIGN_IN)
        self.gh_mock.assert_called_once()
        self.assertTrue(all(r[2] is None for r in self.fake.requests))

    def test_lock_prevents_concurrent_passes(self):
        self.fake.add_release()
        self.updates.mkdir(mode=0o700)
        holder = os.open(str(self.updates / 'agent.lock'), os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.run_agent(), 0)
            self.assertEqual(self.log, '')
            self.assertFalse((self.updates / 'state.json').exists())
            self.assertEqual(self.fake.requests, [])
        finally:
            os.close(holder)
        self.run_agent()
        self.assertTrue((self.updates / 'state.json').exists())

    def test_symlinked_updates_folder_is_refused(self):
        outside = self.home / 'outside'
        outside.mkdir()
        self.updates.symlink_to(outside, target_is_directory=True)
        self.assertEqual(self.run_agent(), 1)
        self.assertEqual(list(outside.iterdir()), [])
        self.assertIn('symlink', self.log)

    def test_invalid_config_is_an_error_without_network(self):
        self.config(installAutomatically='yes')
        self.assertEqual(self.run_agent(), 1)
        self.assertEqual(self.state()['status'], 'error')
        self.assertEqual(self.fake.requests, [])

    def test_helper_crash_before_its_receipt_leaves_a_receipt_with_the_cause(self):
        self.fake.add_release()
        self.config(installAutomatically=False, installRequestedAt='2026-10-10T10:00:00Z', quietMinutes=60)
        self.control(applyCrash=True)
        self.assertEqual(self.run_agent(), 1)
        state = self.state()
        self.assertEqual(state['status'], 'error')
        self.assertIn('See the update receipt', state['message'])
        receipt = pathlib.Path(state['lastInstall']['receipt'])
        self.assertTrue(receipt.is_file())
        value = json.loads(receipt.read_text())
        self.assertEqual(value['result'], 'update-failed')
        self.assertEqual(value['phase'], 'preflight')
        self.assertIn('Protected rows or counts changed', value['stderrTail'])
        log = pathlib.Path(value['helperLog'])
        self.assertEqual(log, receipt.with_name(receipt.stem + '.log'))
        self.assertEqual(log.stat().st_mode & 0o777, 0o600)
        self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)
        self.assertNotIn('Protected rows', self.log)

    def test_a_disk_too_full_for_the_backup_is_the_message_not_see_the_receipt(self):
        self.fake.add_release()
        self.config(installAutomatically=False, installRequestedAt='2026-10-10T10:00:00Z', quietMinutes=60)
        refusal = 'Not enough free disk space for the pre-update backup: needs 4.6 GB, 1.2 GB free'
        self.control(applyRefusals=1, applyRefusal={'phase': 'preflight', 'pointers': 'unchanged',
                                                     'error': 'AssertionError: ' + refusal})
        self.assertEqual(self.run_agent(), 1)
        state = self.state()
        installed = json.loads((self.own / 'installation.json').read_text())['version']
        self.assertEqual((state['status'], state['message']),
                         ('error', '%s; SpecWithCode stayed on %s.' % (refusal, installed)))
        self.assertEqual(state['lastInstall']['result'], 'failed')
        self.assertEqual(len([c for c in self.calls() if '--prestate' in c['argv']]), 1)  # Not retried.

    def test_helper_output_is_kept_beside_its_own_receipt_not_in_agent_log(self):
        self.fake.add_release()
        self.config(installAutomatically=False, installRequestedAt='2026-10-10T10:00:00Z', quietMinutes=60)
        self.control(applyFail=True)
        self.run_agent()
        receipt = pathlib.Path(self.state()['lastInstall']['receipt'])
        self.assertEqual(json.loads(receipt.read_text()), {'result': 'update-failed'})
        self.assertIn('helper-private-output', receipt.with_name(receipt.stem + '.log').read_text())
        self.assertNotIn('helper-private', self.log)

    def test_interrupted_install_is_recorded_not_retried(self):
        self.fake.add_release()
        self.config(quietMinutes=0)
        self.run_agent()
        state = self.state()
        state['status'] = 'installing'
        (self.updates / 'state.json').write_text(json.dumps(state))
        (self.updates / 'install-in-progress.json').write_text(json.dumps(
            {'version': '0.2.0', 'receipt': str(self.updates / 'receipts' / 'x.json'), 'at': 'now'}))
        self.run_agent()
        self.assertEqual(self.state()['status'], 'error')
        self.assertEqual(self.state()['lastInstall']['result'], 'failed')
        self.run_agent()
        self.assertEqual(self.apply_calls(), [])

    def test_a_timed_out_install_keeps_its_marker_until_the_helper_exits(self):
        # The agent stops waiting at APPLY_TIMEOUT but never stops the helper, which may
        # still be restarting or rolling back the service: the desktop must keep off 8319.
        self.fake.add_release()
        self.config(quietMinutes=0)
        self.control(applySleep=3)
        marker = self.updates / 'install-in-progress.json'
        self.run_agent()  # Takes the quiet baseline.
        with mock.patch.object(update_agent, 'APPLY_TIMEOUT', 0.5):
            self.assertEqual(self.run_agent(), 1)
        self.assertEqual(len(self.apply_calls()), 1)
        self.assertRegex(self.state()['message'], r'is taking longer than \d+ minutes; it was left to finish')
        self.assertEqual(self.state()['status'], 'error')
        self.assertTrue(marker.exists())
        self.assertEqual(self.run_agent(), 0)  # The helper still holds the pass lock.
        self.assertTrue(marker.exists())
        deadline = time.monotonic() + 30
        while marker.exists() and time.monotonic() < deadline:
            time.sleep(0.2)
            self.run_agent()
        self.assertFalse(marker.exists())
        state = self.state()
        self.assertEqual((state['status'], state['lastInstall']['result']), ('installed', 'updated'))
        self.assertEqual(len(self.apply_calls()), 1)

    def test_leftovers_of_a_manual_install_are_cleaned_on_the_next_pass(self):
        # 0.2.0 was installed by hand after the agent's own install failed.
        self.write_installation('0.2.0', OLD_COMMIT)
        for parent in ('downloads', 'helpers'):
            for version in ('0.1.4', '0.2.0', '0.3.0'):
                folder = self.updates / parent / version
                folder.mkdir(parents=True)
                (folder / 'payload').write_text('x')
        (self.updates / 'downloads' / '.stage-abc').mkdir()
        self.config(checkAutomatically=False)
        self.assertEqual(self.run_agent(), 0)
        self.assertEqual(self.state()['status'], 'disabled')
        for parent in ('downloads', 'helpers'):
            self.assertEqual(sorted(p.name for p in (self.updates / parent).iterdir()), ['0.3.0'])

    def test_status_subcommand_prints_state(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            update_agent.main(['--identity', 'm4', '--home', str(self.home), '--status'])
        synthesized = json.loads(out.getvalue())
        self.assertEqual(synthesized['installedVersion'], '0.1.4')
        self.assertEqual(synthesized['status'], 'up-to-date')
        self.fake.add_release(include_plan=False)
        self.run_agent()
        result = subprocess.run([sys.executable, '-B', str(HERE / 'update_agent.py'), '--identity', 'm4',
                                 '--home', str(self.home), '--status'], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)['status'], 'manual-required')


class ServiceLogRotation(AgentCase):
    def test_a_pass_bounds_the_service_logs_and_keeps_their_newest_lines(self):
        stdout, stderr = self.own / 'stdout.log', self.own / 'stderr.log'
        line = b'[12:00:00.000] WARN (#101): Scheduled task run failed %08d\n'
        lines = [line % index for index in range(400000)]  # About 21 MB.
        stdout.write_bytes(b''.join(lines))
        stderr.write_bytes(b'small\n')
        older = self.own / 'stdout.log.1'
        outside = self.home / 'outside.log'
        outside.write_bytes(b'not the app\'s')
        older.symlink_to(outside)
        launchd = os.open(str(stdout), os.O_WRONLY | os.O_APPEND)  # How launchd holds it.
        self.addCleanup(os.close, launchd)
        self.config()
        self.run_agent()
        self.assertEqual(stdout.stat().st_size, 0, self.log)
        kept = older.read_bytes()
        self.assertFalse(older.is_symlink())
        self.assertEqual(outside.read_bytes(), b'not the app\'s')
        self.assertEqual(older.stat().st_mode & 0o777, 0o600)
        self.assertLessEqual(len(kept), update_agent.SERVICE_LOG_KEPT)
        self.assertGreater(len(kept), update_agent.SERVICE_LOG_KEPT - len(lines[0]) * 2)
        self.assertTrue(kept.startswith(b'[12:00:00.000] WARN'), kept[:60])
        self.assertTrue(kept.endswith(lines[-1]))
        self.assertEqual(stderr.read_bytes(), b'small\n')
        os.write(launchd, b'after rotation\n')
        self.assertEqual(stdout.read_bytes(), b'after rotation\n')
        self.assertEqual(sorted(path.name for path in self.own.glob('stdout.log*')), ['stdout.log', 'stdout.log.1'])

    def test_a_log_under_the_limit_or_behind_a_link_is_left_alone(self):
        outside = self.home / 'outside.log'
        outside.write_bytes(b'x' * 64)
        link = self.own / 'stdout.log'
        link.symlink_to(outside)
        self.assertFalse(update_agent.rotate_service_log(link, limit=16, kept=8))
        self.assertEqual(outside.read_bytes(), b'x' * 64)
        self.assertFalse((self.own / 'stdout.log.1').exists())
        small = self.own / 'stderr.log'
        small.write_bytes(b'line\n' * 3)
        self.assertFalse(update_agent.rotate_service_log(small, limit=16, kept=8))
        self.assertEqual(small.read_bytes(), b'line\n' * 3)
        self.assertFalse(update_agent.rotate_service_log(self.own / 'missing.log'))
        small.write_bytes(b'one\ntwo\nthree\n')
        (self.own / 'stderr.log.1').write_bytes(b'previous rotation')
        self.assertTrue(update_agent.rotate_service_log(small, limit=8, kept=8))
        self.assertEqual((self.own / 'stderr.log.1').read_bytes(), b'three\n')
        self.assertEqual(small.read_bytes(), b'')

    def test_a_full_disk_still_truncates_the_live_log(self):
        log = self.own / 'stdout.log'
        log.write_bytes(b'line\n' * 10)
        (self.own / 'stdout.log.1').write_bytes(b'previous rotation')
        real_fdopen = os.fdopen

        def full(fd, *args, **kwargs):
            handle = real_fdopen(fd, *args, **kwargs)
            handle.write = mock.Mock(side_effect=OSError(update_agent.errno.ENOSPC, 'No space left on device'))
            return handle

        with mock.patch.object(update_agent.os, 'fdopen', side_effect=full):
            self.assertTrue(update_agent.rotate_service_log(log, limit=16, kept=8))
        self.assertEqual(log.read_bytes(), b'')
        self.assertEqual((self.own / 'stdout.log.1').read_bytes(), b'previous rotation')
        self.assertEqual(sorted(path.name for path in self.own.glob('stdout.log*')), ['stdout.log', 'stdout.log.1'])
        log.write_bytes(b'line\n' * 10)
        with mock.patch.object(update_agent.os, 'fdopen', side_effect=OSError(update_agent.errno.EACCES, 'denied')):
            self.assertFalse(update_agent.rotate_service_log(log, limit=16, kept=8))
        self.assertEqual(log.read_bytes(), b'line\n' * 10)  # Any other failure leaves the log whole.


class LaunchAgent(AgentCase):
    def test_install_is_idempotent_and_uninstall_removes_plist(self):
        calls = []
        loaded = {'value': False}

        def fake_launchctl(args, output=None):
            calls.append(list(args))
            if args[0] == 'print':
                return 0 if loaded['value'] else 113
            if args[0] == 'bootstrap':
                loaded['value'] = True
            if args[0] == 'bootout':
                loaded['value'] = False
            return 0

        with mock.patch.object(update_agent, 'launchctl', fake_launchctl), \
                mock.patch.object(update_agent, 'current_uid', return_value=501):
            self.assertEqual(self.run_agent('--install-launch-agent'), 0)
            label = 'com.specweave.studio.m4.updater'
            self.assertIn('"result": "installed"', self.log)
            plist_path = self.home / 'Library' / 'LaunchAgents' / (label + '.plist')
            content = plistlib.loads(plist_path.read_bytes())
            script = self.home / '.specwithcode/install/updater/update_agent.py'
            self.assertEqual(content['ProgramArguments'], ['/usr/bin/python3', str(script), '--identity', 'm4'])
            self.assertEqual(content['StartInterval'], 600)
            self.assertTrue(content['RunAtLoad'] and content['LowPriorityIO'])
            self.assertEqual(content['ProcessType'], 'Standard')
            self.assertEqual(content['StandardOutPath'], str(self.updates / 'agent.log'))
            self.assertEqual(content['WorkingDirectory'], str(self.updates))
            self.assertEqual(script.read_bytes(), (HERE / 'update_agent.py').read_bytes())
            self.assertEqual(script.with_name('update_request.py').read_bytes(), (HERE / 'update_request.py').read_bytes())
            self.assertEqual(oct(script.parent.stat().st_mode & 0o777), '0o700')
            self.assertIn(['bootstrap', 'gui/501', str(plist_path)], calls)
            self.log = ''
            self.assertEqual(self.run_agent('--install-launch-agent'), 0)
            self.assertIn('"result": "unchanged"', self.log)
            self.assertEqual(len([c for c in calls if c[0] == 'bootstrap']), 1)
            self.assertEqual(self.run_agent('--uninstall-launch-agent'), 0)
            self.assertFalse(plist_path.exists())
            self.assertIn(['bootout', 'gui/501/' + label], calls)

    def launchd(self, calls, disabled=False, loaded=False, fail=None):
        """A launchd stub: `fail` maps a verb to (exit status, stderr)."""
        job = {'loaded': loaded, 'disabled': disabled}
        label = 'com.specweave.studio.m4.updater'

        def launchctl(args, output=None):
            calls.append(list(args))
            stdout, stderr, code = '', '', 0
            if args[0] in (fail or {}):
                code, stderr = fail[args[0]]
            elif args[0] == 'print':
                code = 0 if job['loaded'] else 113
            elif args[0] == 'print-disabled':
                stdout = '{\n\t"%s" => %s\n}\n' % (label, 'disabled' if job['disabled'] else 'enabled')
            elif args[0] == 'enable':
                job['disabled'] = False
            elif args[0] == 'bootstrap':
                code, stderr = (5, 'Bootstrap failed: 5: Input/output error') if job['disabled'] else (0, '')
                job['loaded'] = code == 0
            elif args[0] == 'bootout':
                job['loaded'] = False
            if output is not None:
                output.extend((stdout, stderr))
            return code
        return mock.patch.object(update_agent, 'launchctl', launchctl), job

    def test_a_disabled_label_is_never_booted_out_and_reports_disabled(self):
        # Another tool ran `launchctl disable`: booting the job out would lose it for good.
        calls = []
        patch, job = self.launchd(calls, disabled=True, loaded=False)
        plist = self.home / 'Library/LaunchAgents/com.specweave.studio.m4.updater.plist'
        with patch, mock.patch.object(update_agent, 'current_uid', return_value=501):
            self.assertEqual(self.run_agent('--install-launch-agent'), 3)
        self.assertEqual(json.loads(self.log.strip().splitlines()[-1]),
                         {'result': 'disabled', 'label': 'com.specweave.studio.m4.updater',
                          'message': 'Update agent is turned off in launchd'})
        self.assertEqual([call[0] for call in calls], ['print-disabled'])  # No bootout, no bootstrap.
        self.assertTrue(job['disabled'])  # Never re-enabled on its own.
        self.assertTrue(plist.is_file())  # Current, for a later Repair to load.

    def test_a_failed_bootstrap_reports_launchctl_reason(self):
        calls = []
        patch, _ = self.launchd(calls, fail={'bootstrap': (5, 'Bootstrap failed: 5: Input/output error')})
        with patch, mock.patch.object(update_agent, 'current_uid', return_value=501):
            self.assertEqual(self.run_agent('--install-launch-agent'), 1)
        self.assertIn('launchctl could not load the update agent: Bootstrap failed: 5: Input/output error (exit 5)',
                      self.log)

    def test_repair_turns_the_label_on_loads_the_job_and_starts_a_pass(self):
        calls = []
        patch, job = self.launchd(calls, disabled=True, loaded=False)
        target = 'gui/501/com.specweave.studio.m4.updater'
        with patch, mock.patch.object(update_agent, 'current_uid', return_value=501):
            self.assertEqual(self.run_agent('--repair-launch-agent'), 0)
        self.assertEqual([call[0] for call in calls],
                         ['enable', 'print-disabled', 'bootout', 'bootstrap', 'kickstart'])
        self.assertEqual((calls[0], calls[-1]), (['enable', target], ['kickstart', target]))
        self.assertEqual(job, {'loaded': True, 'disabled': False})
        self.assertEqual(json.loads(self.log.strip().splitlines()[-1]),
                         {'result': 'repaired', 'label': 'com.specweave.studio.m4.updater'})

    def test_repair_fails_with_launchctl_reason(self):
        for verb, words in (('enable', 'could not turn the update agent back on'),
                            ('kickstart', 'could not start the update agent')):
            calls, self.log = [], ''
            patch, _ = self.launchd(calls, fail={verb: (1, 'Operation not permitted')})
            with patch, mock.patch.object(update_agent, 'current_uid', return_value=501):
                self.assertEqual(self.run_agent('--repair-launch-agent'), 1)
            self.assertIn('launchctl %s: Operation not permitted (exit 1)' % words, self.log)
            if verb == 'enable':
                self.assertEqual(calls, [['enable', 'gui/501/com.specweave.studio.m4.updater']])

    def fake_launchctl(self, calls):
        def launchctl(args, output=None):
            calls.append(list(args))
            return 0
        return mock.patch.object(update_agent, 'launchctl', launchctl)

    def test_a_new_script_alone_is_written_without_reloading_the_agent(self):
        calls = []
        script = self.home / '.specwithcode/install/updater/update_agent.py'
        with self.fake_launchctl(calls), mock.patch.object(update_agent, 'current_uid', return_value=501):
            self.run_agent('--install-launch-agent')
            script.write_bytes(b'# an older agent\n')
            del calls[:]
            self.log = ''
            self.assertEqual(self.run_agent('--install-launch-agent'), 0)
        self.assertIn('"result": "installed"', self.log)
        self.assertEqual(script.read_bytes(), (HERE / 'update_agent.py').read_bytes())
        self.assertEqual([call[0] for call in calls], ['print'])

    def run_installed(self, script):
        runner = '''import os,pathlib,pwd,runpy,sys,types
account = pwd.getpwuid(os.getuid())
pwd.getpwuid = lambda uid: types.SimpleNamespace(pw_name=account.pw_name, pw_dir=str(pathlib.Path.cwd()))
script = sys.argv.pop(1)
sys.path.insert(0, str(pathlib.Path(script).parent))
sys.argv[0] = script
runpy.run_path(script, run_name='__main__')
'''
        return subprocess.run([sys.executable, '-B', '-c', runner, str(script), '--identity', 'm4', '--home', str(self.home),
                               '--status'], cwd=str(self.home), capture_output=True, text=True, timeout=60)

    def test_the_installed_agent_imports_its_modules_from_where_it_was_installed(self):
        script = self.home / '.specwithcode/install/updater/update_agent.py'
        with self.fake_launchctl([]), mock.patch.object(update_agent, 'current_uid', return_value=501):
            self.assertEqual(self.run_agent('--install-launch-agent'), 0)
        result = self.run_installed(script)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['installedVersion'], '0.1.4')
        # A copy without its module cannot start: this is what the install guards against.
        alone = self.home / 'alone' / 'update_agent.py'
        alone.parent.mkdir()
        alone.write_bytes(script.read_bytes())
        result = self.run_installed(alone)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("No module named 'update_", result.stderr)

    def test_a_changed_module_alone_is_written(self):
        module = self.home / '.specwithcode/install/updater/update_request.py'
        with self.fake_launchctl([]), mock.patch.object(update_agent, 'current_uid', return_value=501):
            self.run_agent('--install-launch-agent')
            module.write_bytes(b'# an older module\n')
            self.log = ''
            self.assertEqual(self.run_agent('--install-launch-agent'), 0)
        self.assertIn('"result": "installed"', self.log)
        self.assertEqual(module.read_bytes(), (HERE / 'update_request.py').read_bytes())

    def test_the_desktop_build_ships_every_module_the_agent_imports(self):
        local = sorted(path.stem for path in HERE.glob('*.py'))
        source = (HERE / 'update_agent.py').read_text()
        imported = sorted(set(re.findall(r'^import ([a-z_]+)', source, re.M)) & set(local))
        build = (HERE.parent / 'lib/studio-service-updater.ts').read_text()
        shipped = re.search(r'MAC_SERVICE_UPDATER_FILES = \[([^\]]*)\]', build).group(1)
        # migrate_home is its own entry point, shipped and installed beside the agent; service_hold,
        # service_handles and its live_database are update_agent_pause's own imports.
        self.assertEqual(sorted(re.findall(r'"([a-z_]+)\.py"', shipped)),
                         sorted(['update_agent', 'managed_updates', 'migrate_home', 'service_hold', 'service_handles',
                                 'live_database', 'relay_ownership'] + imported))
        self.assertEqual(imported, ['installation_descriptor', 'studio_paths', 'update_agent_cache', 'update_agent_pause',
                                    'update_agent_reap', 'update_agent_recovery', 'update_agent_run', 'update_request'])

    def hold_lock_and_install(self):
        holder = os.open(str(self.updates / 'agent.lock'), os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return self.run_agent('--install-launch-agent')
        finally:
            os.close(holder)

    def test_a_running_pass_gets_the_new_files_but_its_job_is_not_reloaded(self):
        # "Update now" kicks the agent, which takes the lock: the new agent and its modules must
        # still land, or the old agent handles the request and every later one.
        calls = []
        script = self.home / '.specwithcode/install/updater/update_agent.py'
        plist = self.home / 'Library/LaunchAgents/com.specweave.studio.m4.updater.plist'
        with self.fake_launchctl(calls), mock.patch.object(update_agent, 'current_uid', return_value=501):
            self.run_agent('--install-launch-agent')
            script.write_bytes(b'# an older agent\n')
            for name in ('update_request.py', 'update_agent_reap.py'):
                script.with_name(name).write_bytes(b'# an older module\n')
            plist.write_bytes(b'stale')
            del calls[:]
            self.log = ''
            self.assertEqual(self.hold_lock_and_install(), 0)
        self.assertEqual(json.loads(self.log.strip().splitlines()[-1]),
                         {'result': 'busy', 'written': True, 'label': 'com.specweave.studio.m4.updater'})
        self.assertEqual(calls, [])  # No bootout: it would stop the pass mid-snapshot or mid-install.
        self.assertEqual(plist.read_bytes(), b'stale')
        for name in ('update_agent.py', 'update_request.py', 'update_agent_reap.py'):
            self.assertEqual(script.with_name(name).read_bytes(), (HERE / name).read_bytes(), name)

    def test_a_running_pass_with_current_files_reports_nothing_written(self):
        calls = []
        with self.fake_launchctl(calls), mock.patch.object(update_agent, 'current_uid', return_value=501):
            self.run_agent('--install-launch-agent')
            del calls[:]
            self.log = ''
            self.assertEqual(self.hold_lock_and_install(), 0)
        self.assertIn('"result": "busy", "written": false', self.log)
        self.assertEqual(calls, [])


def later(minutes=0, seconds=0):
    moment = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=minutes, seconds=seconds)
    return moment.isoformat()


class PlanGenerator(unittest.TestCase):
    def test_cli_writes_a_valid_plan_and_rejects_bad_input(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            sums = root / 'SHA256SUMS'
            sums.write_text('%s  specweave-studio-0.2.0-darwin-arm64.tgz\n%s  %s.tar.gz\n' % ('1' * 64, '2' * 64, ROOT))
            output = root / 'studio-update.json'
            base = [sys.executable, '-B', str(HERE / 'make_update_plan.py'), '--version', '0.2.0',
                    '--source-commit', NEW_COMMIT, '--sha256sums', str(sums),
                    '--runtime', 'specweave-studio-0.2.0-darwin-arm64.tgz', '--helpers', ROOT + '.tar.gz',
                    '--from-source', OLD_COMMIT, '--from-source', OTHER_COMMIT, '--output', str(output)]
            result = subprocess.run(base + ['--arg', '--allow-project-migrations',
                                            '--arg', '--allow-existing-browser-heartbeat'],
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads(output.read_text())
            update_agent.validate_plan(plan, '0.2.0')
            self.assertEqual(plan['service']['runtime']['sha256'], '1' * 64)
            self.assertEqual(plan['service']['helpers'], {'asset': ROOT + '.tar.gz', 'sha256': '2' * 64, 'root': ROOT})
            self.assertEqual(plan['service']['upgrades'][0]['fromSourceCommits'], [OLD_COMMIT, OTHER_COMMIT])
            self.assertEqual(plan['service']['upgrades'][0]['args'],
                             ['--allow-project-migrations', '--allow-existing-browser-heartbeat'])
            self.assertEqual(update_agent.select_upgrade(plan, OTHER_COMMIT)[0], '--allow-project-migrations')
            output.unlink()
            for extra in (['--arg', '--force'], ['--runtime', 'missing.tgz'], ['--version', '0.2.x']):
                with self.subTest(extra=extra):
                    result = subprocess.run(base + extra, capture_output=True, text=True, timeout=30)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(output.exists())
            result = subprocess.run(base + ['--upload', 'v0.3.0'], capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 2)  # Tag mismatch is refused before any gh call.
            self.assertIn('Upload tag must be v0.2.0', result.stderr)



@unittest.skipUnless(sys.platform == 'darwin', 'darwin background is a macOS policy')
class BackgroundPriorityTests(unittest.TestCase):
    """launchd starts the agent as a Background process; its helpers must not inherit that."""

    def test_helpers_and_gh_run_outside_darwin_background(self):
        probe = 'import os,sys;sys.stdout.write(str(os.getpriority(4, 0)))'
        script = ('import os,subprocess,sys;sys.path.insert(0,%r);os.setpriority(4,0,0x1000);import update_agent;'
                  'assert os.getpriority(4,0)==1;'
                  'r=subprocess.run([sys.executable,"-c",%r],capture_output=True,text=True,preexec_fn=update_agent.leave_background);'
                  'sys.stdout.write(r.stdout)') % (str(pathlib.Path(update_agent.__file__).parent), probe)
        # Background priority throttles the probe's import; 60s timed out on a loaded host.
        result = subprocess.run([sys.executable, '-c', script], capture_output=True, text=True, timeout=300)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '0')

    def test_every_child_the_agent_starts_leaves_background(self):
        calls = []
        def record(*args, **kwargs):
            calls.append(kwargs.get('preexec_fn'))
            raise OSError('stop')
        with mock.patch.object(update_agent.subprocess, 'run', side_effect=record), \
                mock.patch.object(update_agent.subprocess, 'Popen', side_effect=record), \
                mock.patch.object(update_agent.os.path, 'isfile', return_value=True), \
                mock.patch.object(update_agent.os, 'access', return_value=True):
            update_agent.find_gh_token(pathlib.Path('/nonexistent'))
            update_agent.run_helper_process(['/usr/bin/true'], '/', {}, 5)
            update_agent.run_helper_process(['/usr/bin/true'], '/', {}, 5, wait_detached=True)
        self.assertTrue(calls)
        self.assertTrue(all(fn is update_agent.leave_background for fn in calls))

if __name__ == '__main__':
    unittest.main()
