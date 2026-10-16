#!/usr/bin/env python3
"""Verify retained preload-only rollout evidence offline; no service/provider/auth calls."""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import studio_paths

parser = argparse.ArgumentParser()
parser.add_argument('--evidence-dir', type=pathlib.Path, required=True)
args = parser.parse_args()
root = args.evidence_dir.resolve(strict=True)

def read(name):
    return json.loads((root / name).read_text())

def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as file:
        for block in iter(lambda: file.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()

source = read('source-proof.json')
assert source['nodeVersion'] == '22.20.0' and source['nativeInferenceOrAuthActions'] is False
assert source['productionFiles'] == ['apps/web/vite.config.ts', 'apps/web/tsconfig.json',
    'apps/web/scripts/studio-module-preload.ts']
assert re.fullmatch('[a-f0-9]{40}', source['fixCommit'])
repo = pathlib.Path(__file__).resolve().parents[2]
assert set(source['sourceFileHashes']) == set(source['productionFiles'])
def source_hash(commit, path):
    # Both arguments are fixed whitelisted paths / validated commit IDs. Never
    # emit source bytes or read working-tree config, credentials or process env.
    result = subprocess.run(['/usr/bin/git', '-C', str(repo), 'show', commit + ':' + path],
        capture_output=True, timeout=15)
    assert result.returncode == 0, 'Recorded source revision is unavailable'
    return hashlib.sha256(result.stdout).hexdigest()
for path in source['productionFiles']:
    assert source_hash(source['fixCommit'], path) == source['sourceFileHashes'][path]
for record in source['tests']:
    log = pathlib.Path(record['log'])
    assert record['exitCode'] == 0 and record['sha256'] == digest(log)
    assert record['successMarker'] in log.read_text()
assert sum(record['count'] for record in source['tests']) == source['focusedTests']
for record in source['checks']:
    log = pathlib.Path(record['log'])
    assert record['exitCode'] == 0 and record['sha256'] == digest(log)
    assert record['successMarker'] in log.read_text()
    if record['type'] == 'typecheck': assert log.read_text() == ''

bundle = read('specweave-studio-darwin-arm64-t20.tar.gz.receipt.json')
assert bundle['sha256'] == digest(root / 'specweave-studio-darwin-arm64-t20.tar.gz')
assert re.fullmatch('[a-f0-9]{40}', bundle['sourceCommit'])
for path in source['productionFiles']:
    assert source_hash(bundle['sourceCommit'], path) == source['sourceFileHashes'][path], 'Bundled declared source differs from the tested fix'
manifest = read('studio-manifest.json')
assert bundle['sourceCommit'] == manifest['sourceCommit']
assert bundle['files'] == len(manifest['files']) and bundle['packages'] == len(manifest['packages'])
standalone = json.loads((root / 'bundle-verification.log').read_text().splitlines()[-1])
assert standalone['sourceCommit'] == bundle['sourceCommit'] and standalone['node'] == 'v22.20.0'
assert standalone['filesVerified'] == len(manifest['files']) and standalone['legalNoticesVerified'] is True
assert standalone['inferenceExecuted'] is False
proof_path = root / 'all-host-proof.json'
proof = read('all-host-proof.json')
assert proof['schemaVersion'] == 1 and set(proof['hosts']) == {'m4', 'm1', 'm3'}
cookies = set()
for identity, host in proof['hosts'].items():
    update, final, live = host['update'], host['finalSnapshot'], host['liveReadback']
    assert update['phase'] == 'verified' and update['preservedRowsAuthAndIdentity'] is True
    assert update['originalServicesPreserved'] is True and update['onlyKnownOwnedServiceRestarted'] is True
    before, after = update['before'], update['after']
    assert before['rows'] == after['rows'] == final['rows']
    for field in ['identity', 'uid', 'serviceLabel', 'servicePid', 'archiveSha256',
                  'artifactSourceCommit', 'fileHashes', 'otherListeners', 'cookieName']:
        assert final[field] == after[field]
    for field in ['settings', 'environment', 'plist']:
        assert before['fileHashes'][field] == after['fileHashes'][field]
    assert before['cookieName'] == after['cookieName']
    assert before['otherListeners'] == after['otherListeners']
    assert final['identity'] == identity and final['uid'] == 501 and final['rows']['nativeWorkIdle'] is True
    assert final['archiveSha256'] == live['archiveSha256'] == bundle['sha256']
    assert final['artifactSourceCommit'] == live['sourceCommit'] == bundle['sourceCommit']
    assert live['nodeVersion'] == '22.20.0' and live['filesVerified'] == len(manifest['files'])
    assert live['service']['state'] == 'running' and live['http'] == {'root': 200, 'capacityUnauth': 401}
    assert live['nativeAuthRead'] is False and live['nativeAuthCopied'] is False
    cookies.add(final['cookieName'])
assert len(cookies) == 3
transition = read('network-artifact-transition.json')
assert transition['result'] == 'transitioned' and transition['mappingWrites'] is False
assert transition['privateAccessComplete'] is True and transition['privateGateStillDisabled'] is False
assert transition['newArchiveSha256'] == bundle['sha256'] and transition['sourceCommit'] == bundle['sourceCommit']
assert transition['allHostProofSha256'] == digest(proof_path)
assert set(transition['unchangedTransports']) == {'com.specweave.studio.tunnel-m1', 'com.specweave.studio.tunnel-m3'}
backup = pathlib.Path(transition['backup'])
network = studio_paths.identity_home(pathlib.Path.home(), 'm4') / 'network'
assert backup.parent == network and digest(backup) == transition['previousProgressSha256']
old = json.loads(backup.read_text())
current_path = root / 'network-progress-after.json'
assert digest(current_path) == transition['progressSha256']
current = json.loads(current_path.read_text())
assert old['complete'] is True and current['complete'] is True
assert old['archiveSha256'] == transition['oldArchiveSha256']
assert current['archiveSha256'] == transition['newArchiveSha256']
for key, value in old.items():
    if key not in ['archiveSha256', 'artifactTransitions']:
        assert current[key] == value
assert current['artifactTransitions'][:-1] == old.get('artifactTransitions', [])
assert current['artifactTransitions'][-1]['previousProgressSha256'] == digest(backup)
assert transition['transportMetadataSha256'] == digest(root / 'private-access-metadata.json')
generated = read('generated-artifact-check.json')
assert generated['result'] == 'passed' and generated['speculativeJavaScriptHints'] == 0
assert generated['actualBootstrapImportPreserved'] and generated['lazyEntryGraphPreserved']
assert generated['requiredCssPreserved'] > 0 and generated['relativeImportsVerified'] > 0
indexed = {entry['path']: entry for entry in manifest['files']}
assert generated['manifestSha256'] == indexed['client/.vite/manifest.json']['sha256']
binding_path = root / 'native-source-preservation.json'
binding = read('native-source-preservation.json')
review = read('independent-archive-native-binding-review.json')
assert review['accepted'] is True
accepted = review['nativeSourceBinding']
assert accepted['reportSHA256'] == digest(binding_path)
assert accepted['from'] == binding['from'] and accepted['to'] == binding['to']
assert accepted['protectedSourcePreserved'] is True
assert binding['schemaVersion'] == 1 and binding['kind'] == 'studio-preload-only-successor'
assert binding['to'] == {'archiveSHA256': bundle['sha256'], 'sourceCommit': bundle['sourceCommit']}
assert len(binding['protectedGitObjects']) == 17
assert {entry['path'] for entry in binding['protectedGitObjects']} == {
    'apps/server/src', 'packages/contracts/src', 'packages/client-runtime/src',
    'packages/shared/src', 'apps/web/src', 'pnpm-lock.yaml', 'package.json',
    'apps/server/package.json', 'packages/contracts/package.json',
    'packages/client-runtime/package.json', 'packages/shared/package.json',
    'packages/effect-codex-app-server/src', 'packages/effect-codex-app-server/package.json',
    'packages/effect-acp/src', 'packages/effect-acp/package.json',
    'apps/web/package.json', 'pnpm-workspace.yaml'}
for entry in binding['protectedGitObjects']:
    assert entry['before'] == entry['after']
    assert re.fullmatch('[a-f0-9]{40}', entry['before'])
    for side, revision in [('before', binding['from']['sourceCommit']), ('after', binding['to']['sourceCommit'])]:
        value = subprocess.check_output(['/usr/bin/git', '-C', str(repo), 'rev-parse', revision + ':' + entry['path']], text=True).strip()
        assert value == entry[side]
assert binding['runtimeByteBinding']['allOutsideClientManifestRecordsIdentical'] is True
assert binding['runtimeByteBinding']['allOutsideClientActualBytesVerified'] is True
http = read('installed-normal-http2-bootstrap.json')
assert http['result'] == 'passed' and http['nodeVersion'] == 'v22.20.0'
assert http['headless'] is True and http['strictTLS'] is True
assert http['http2Disabled'] is False and http['responseInterception'] is False
assert http['nativeInferenceOrAuthActions'] is False
assert http['archiveSha256'] == bundle['sha256'] and http['sourceCommit'] == bundle['sourceCommit']
assert {case['identity'] for case in http['cases']} == {'m4', 'm1', 'm3'}
for case in http['cases']:
    assert case['rootStatus'] == 200 and case['capacityUnauth'] == 401
    assert case['safePath'] == '/pair' and case['pairingSurfaceVisible'] is True
    assert case['assetRequests'] > 0 and case['badAssetResponses'] == [] and case['failedAssetRequests'] == []
    assert case['assetProtocols'] == ['h2'] and case['loadFailureVisible'] is False
    assert case['webSockets'] > 0
print(json.dumps({'result': 'passed', 'hosts': 3, 'sourceCommit': bundle['sourceCommit'],
    'archiveSha256': bundle['sha256'], 'focusedTests': source['focusedTests'],
    'proofScope': 'actual production config/generated CSS/imports plus exact installed-artifact/transport and anonymous HTTP2 bootstrap',
    'nativeInferenceOrAuthActions': False, 'serviceActions': False, 'mappingWrites': False}))
