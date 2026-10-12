#!/usr/bin/env python3
"""Read retained T17 evidence; never calls providers, services or auth APIs."""
import argparse
import hashlib
import json
import pathlib
import re

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

bundle = read('specweave-studio-darwin-arm64-t17.tar.gz.receipt.json')
archive = root / 'specweave-studio-darwin-arm64-t17.tar.gz'
assert bundle['sha256'] == digest(archive) and re.fullmatch('[a-f0-9]{40}', bundle['sourceCommit'])
assert bundle['files'] == 6605 and bundle['packages'] == 35
standalone = json.loads((root / 'bundle-verification.log').read_text().splitlines()[-1])
assert standalone['sourceCommit'] == bundle['sourceCommit'] and standalone['node'] == 'v22.20.0'
assert standalone['filesVerified'] == 6605 and standalone['legalNoticesVerified'] is True
assert standalone['inferenceExecuted'] is False
assert (root / 'web-typecheck-final.log').read_text() == ''
assert '180 passed (180)' in (root / 'focused-final.log').read_text()
assert '70 passed (70)' in (root / 'coverage-scoped.log').read_text()
assert '7 passed (7)' in (root / 'source-fixture-final.log').read_text()
assert 'built in' in (root / 'web-build.log').read_text()
assert 'Build complete' in (root / 'server-build.log').read_text()
coverage = read('coverage/coverage-summary.json')['total']
assert coverage['lines']['covered'] == 419 and coverage['lines']['total'] == 459
assert coverage['branches']['covered'] == 733 and coverage['branches']['total'] == 862
fixture = read('source-fixture-receipt.json')
assert fixture['node'] == 'v22.20.0' and fixture['installedServicesTouched'] is False
assert fixture['nativeInference'] is False and fixture['browserAutomation'] is False
cases = {case['case']: case for case in fixture['cases']}
assert cases['explicit-host-fixed-before-navigation']['host'] == 'host-a'
assert cases['explicit-host-fixed-before-navigation']['automatic'] is False
assert cases['saved-balancing-policy-draft']['actualHost'] == 'host-b'  # Caller omitting intent stays automatic.
assert cases['saved-balancing-policy-draft']['explicitModelPreserved'] is True

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
    assert live['nodeVersion'] == '22.20.0' and live['filesVerified'] == 6605
    assert live['service']['state'] == 'running' and live['http'] == {'root': 200, 'capacityUnauth': 401}
    assert live['nativeAuthRead'] is False and live['nativeAuthCopied'] is False
    cookies.add(final['cookieName'])
assert len(cookies) == 3
transition = read('network-artifact-transition.json')
assert transition['result'] == 'transitioned' and transition['mappingWrites'] is False
assert transition['privateGateStillDisabled'] is True
assert transition['newArchiveSha256'] == bundle['sha256'] and transition['sourceCommit'] == bundle['sourceCommit']
assert transition['allHostProofSha256'] == digest(proof_path)
assert set(transition['unchangedTransports']) == {'com.specweave.studio.tunnel-m1', 'com.specweave.studio.tunnel-m3'}
backup = pathlib.Path(transition['backup'])
assert backup.parent == pathlib.Path.home() / '.specweave-studio/m4/network'
assert digest(backup) == transition['previousProgressSha256']
print(json.dumps({'result': 'passed', 'hosts': 3, 'sourceCommit': bundle['sourceCommit'],
                  'archiveSha256': bundle['sha256'], 'focusedTests': 180, 'coverageTests': 70,
                  'coverageLines': coverage['lines'], 'coverageBranches': coverage['branches'],
                  'proofScope': 'source-host-intent-and-exact-installed-artifact-preservation',
                  'nativeInferenceOrAuthActions': False, 'serviceActions': False}))
