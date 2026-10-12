#!/usr/bin/env python3
"""Check retained T15 installed evidence without auth, model or service actions."""
import argparse
import hashlib
import json
import pathlib


def load(path):
    return json.loads(path.read_text())


def verify(directory):
    plan = load(directory / 'plan.json')
    archive = pathlib.Path(plan['archive'])
    digest = hashlib.sha256()
    with archive.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    assert digest.hexdigest() == plan['archiveSha256'], 'Archive bytes do not match installed proof'
    fleet = load(directory / 'all-host-proof.json')
    assert fleet['schemaVersion'] == 1 and set(fleet['hosts']) == {'m4', 'm1', 'm3'}
    protected = ['identity', 'uid', 'serviceLabel', 'servicePid', 'archiveSha256',
                 'artifactSourceCommit', 'fileHashes', 'rows', 'otherListeners', 'cookieName']
    for identity, host in fleet['hosts'].items():
        update, final = host['update'], host['finalSnapshot']
        assert update['phase'] == 'verified'
        assert update['preservedRowsAuthAndIdentity'] is True
        assert update['originalServicesPreserved'] is True
        assert update['onlyKnownOwnedServiceRestarted'] is True
        before, after = update['before'], update['after']
        assert all(after[key] == final[key] for key in protected)
        assert before['rows'] == after['rows'] and before['otherListeners'] == after['otherListeners']
        assert before['cookieName'] == after['cookieName']
        for name in ['settings', 'environment', 'plist']:
            assert before['fileHashes'][name] == after['fileHashes'][name]
        assert final['archiveSha256'] == plan['archiveSha256']
        assert final['artifactSourceCommit'] == plan['artifactSourceCommit']
        assert final['uid'] == 501 and final['serviceLabel'] == 'com.specweave.studio.' + identity
        readback = load(directory / (identity + '-final-readback.json'))
        assert readback['archiveSha256'] == plan['archiveSha256']
        assert readback['sourceCommit'] == plan['artifactSourceCommit']
        assert readback['filesVerified'] == 6605 and readback['nodeVersion'] == '22.20.0'
        assert readback['service']['pid'] == final['servicePid']
        assert readback['http'] == {'root': 200, 'capacityUnauth': 401}
    startup = load(directory / 'installed-startup3/receipt.json')
    assert startup['result'] == 'passed' and startup['browserHeadless'] is True
    assert startup['version'] == 'v22.20.0' and startup['inferenceExecuted'] is False
    assert {host['identity'] for host in startup['hosts']} == {'m4', 'm1', 'm3'}
    for host in startup['hosts']:
        assert host['rootAndReloadOverview'] and host['shellIdsPreserved']
        assert host['ownedGrantsAndSessionsRevoked'] and host['oneTimePairingUi']
        assert host['tokenClearedBeforeCapture'] and host['authenticatedShell'] == 200
        assert host['welcome'] == {'bootstrapProjectPresent': False, 'bootstrapThreadPresent': False}
    wrapper = load(directory / 'installed-cli-fresh2/receipt.json')
    assert wrapper['result'] == 'passed' and wrapper['version'] == 'v22.20.0'
    assert wrapper['browserHeadless'] and wrapper['allNativeProvidersDisabled']
    assert wrapper['inferenceExecuted'] is False and wrapper['cliWrapper'] is not None
    cases = {case['name']: case for case in wrapper['cases']}
    assert set(cases) == {'ordinary-start', 'service-bootstrap-false',
                         'intentional-explicit-project', 'intentional-headless-serve'}
    for name, case in cases.items():
        explicit = name == 'intentional-explicit-project'
        assert case['projectCount'] == case['threadCount'] == (1 if explicit else 0)
        assert case['runCount'] == case['providerSessionCount'] == 0
        assert case['startupPairingCount'] == (1 if name == 'intentional-headless-serve' else 0)
        assert case['startupSessionCount'] == 0
        assert case['oneTimePairingUi'] and case['tokenClearedBeforeCapture']
        assert case['ownedGrantsAndSessionsRevoked']
        if not explicit:
            assert case['overviewStable']
    transition = load(directory / 'network-artifact-transition.json')
    assert transition['result'] == 'transitioned' and transition['mappingWrites'] is False
    assert transition['privateGateStillDisabled'] is True
    assert transition['newArchiveSha256'] == plan['archiveSha256']
    assert transition['sourceCommit'] == plan['artifactSourceCommit']
    assert transition['allHostProofSha256'] == hashlib.sha256((directory / 'all-host-proof.json').read_bytes()).hexdigest()
    for identity in ['m1', 'm3']:
        diagnosis = load(directory / (identity + '-configuration-diagnosis.json'))
        assert diagnosis['onlyExpectedSparseDefaultAndEmptyProjectFold']
        assert diagnosis['providerCredentialsOrExtraKeysPresent'] is False
        cleanup = load(directory / (identity + '-rollback-startup-grant-revoked.json'))
        assert cleanup['exactOwnedRollbackStartupGrantsRevoked'] == 1
        assert cleanup['originalPairingRowsHashPreserved'] and cleanup['auditRowsRetained']
    print(json.dumps({'result': 'passed', 'hosts': 3, 'installedCliCases': 4,
                      'proofScope': 'startup-navigation-and-state-preservation',
                      'nativeInferenceOrAuthActions': False, 'serviceActions': False}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence-dir', type=pathlib.Path, required=True)
    verify(parser.parse_args().evidence_dir.resolve(strict=True))
