#!/usr/bin/env python3
"""CAS migration of an owned network record after a verified all-host release update.

This helper only reads transports. It never restarts tunnels or writes Serve mappings.
The existing private-access --resume artifact equality remains strict.
"""
import argparse
import copy
import datetime
import json
import os
import pathlib
import plistlib
import pwd
import re
import subprocess
import sqlite3
import uuid
from update import assert_prestate, atomic, digest, listeners, safe_path, snapshot
from auth_heartbeat import read_auth_sessions, restore_timestamp, verify_restart_witness
import database_continuity as continuity
from fleet_hosts import worker_plans

TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
PLANS = [plan[:4] for plan in worker_plans()]
MAPPINGS = {443: 'http://127.0.0.1:8319', 8443: 'http://127.0.0.1:18319', 8444: 'http://127.0.0.1:28319'}

def assert_completed_private_serve(state, hostname):
    """A completed record owns exactly three HTTPS proxies, never Funnel."""
    assert isinstance(state, dict) and not set(state) - {'TCP', 'Web', 'AllowFunnel'}
    hosts = {hostname + ':' + str(port) for port in MAPPINGS}
    assert state.get('TCP') == {str(port): {'HTTPS': True} for port in MAPPINGS}
    assert state.get('Web') == {hostname + ':' + str(port): {'Handlers': {'/': {'Proxy': target}}}
        for port, target in MAPPINGS.items()}, 'Completed private Serve mappings changed'
    funnel = state.get('AllowFunnel', {})
    assert isinstance(funnel, dict) and not set(funnel) - hosts and all(value is False for value in funnel.values()), 'Public Funnel or foreign mapping present'

def assert_private_metadata(value, progress):
    hostname = progress['selfDNSName']
    assert value['configuredPrivateOnly'] is True and value['selfDNSName'] == hostname
    assert value['origins'] == {'m4': 'https://' + hostname, 'm1': 'https://' + hostname + ':8443', 'm3': 'https://' + hostname + ':8444'}
    assert value['serveReadback'] == progress['serveReadback']
    assert value['tunnels'] == [{'identity': identity, 'localPort': port, 'remoteHost': ip,
        'remotePort': 8319, 'label': 'com.specweave.studio.tunnel-' + identity}
        for identity, _remote_user, ip, port in PLANS]

def read_command(command):
    result = subprocess.run(command, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, 'Owned transport readback unavailable; private output withheld'
    return result.stdout

def tunnel_bytes(home, identity, remote_user, ip, port, user):
    network = home / '.specweave-studio/m4/network'
    fleet = home / '.local/share/specweave/fleet'
    label = 'com.specweave.studio.tunnel-' + identity
    command = ['/usr/bin/env', '-i', 'HOME=' + str(home), 'USER=' + user, 'PATH=/usr/bin:/bin',
        '/usr/bin/ssh', '-F', '/dev/null', '-i', str(fleet / 'id_ed25519'), '-o', 'IdentitiesOnly=yes',
        '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(fleet / 'known_hosts'),
        '-o', 'ConnectTimeout=5', '-o', 'ControlMaster=no', '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-N', '-L',
        '127.0.0.1:' + str(port) + ':127.0.0.1:8319', remote_user + '@' + ip]
    return plistlib.dumps({'Label': label, 'ProgramArguments': command, 'RunAtLoad': True,
        'KeepAlive': True, 'ThrottleInterval': 10, 'StandardOutPath': str(network / (identity + '.stdout.log')),
        'StandardErrorPath': str(network / (identity + '.stderr.log'))})

def fresh(value):
    observed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    assert observed.tzinfo is not None
    age = (datetime.datetime.now(datetime.timezone.utc) - observed).total_seconds()
    assert -30 <= age <= 900, 'All-host installation proof is stale'

def assert_update_continuity(expected, actual, home, witness=None):
    """Allow only a cryptographically reconstructed existing-browser heartbeat."""
    if witness is None:
        assert_prestate(expected, actual)
        return None
    assert expected['identity'] == actual['identity'] == 'm4'
    assert set(witness) == {'beforeLastConnectedAt', 'afterLastConnectedAt'}
    before, after = witness['beforeLastConnectedAt'], witness['afterLastConnectedAt']
    for value in [before, after]:
        assert re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', value)
    assert before < after
    db_path = safe_path(home / '.specweave-studio/m4/userdata/statev2.sqlite', home)
    db = sqlite3.connect('file:' + str(db_path) + '?mode=ro', uri=True)
    try:
        db.execute('BEGIN')
        columns = [row[1] for row in db.execute('PRAGMA table_info(auth_sessions)')]
        timestamp = columns.index('last_connected_at'); revoked = columns.index('revoked_at')
        rows = [list(row) for row in db.execute('SELECT * FROM auth_sessions')]
        def rows_hash():
            values = sorted(json.dumps(row, default=lambda value: value.hex(), separators=(',', ':')) for row in rows)
            return digest(('\n'.join(values)).encode())
        observed = rows_hash()
        assert observed == actual['rows']['hashes']['auth_sessions'], 'Live auth rows changed during witness validation'
        if 'databaseCapture' in actual:
            assert actual['databaseCapture']['summary']['tables']['auth_sessions'] == {
                'count': len(rows), 'sha256': continuity.typed_rows_hash(rows)}, 'Live auth cells differ from the complete database proof'
        candidates = [row for row in rows if row[timestamp] == after and row[revoked] is None]
        assert len(candidates) == 1, 'Heartbeat witness must identify one existing active browser session'
        candidates[0][timestamp] = before
        assert rows_hash() == expected['rows']['hashes']['auth_sessions'], 'Heartbeat witness cannot reconstruct original complete auth rows'
    finally:
        db.close()
    normalized = copy.deepcopy(actual)
    normalized['rows']['hashes']['auth_sessions'] = expected['rows']['hashes']['auth_sessions']
    if 'databaseCapture' in actual:
        # Reverse the witnessed cell in the complete capture too; every other table and
        # the schema must still equal the updater's after-snapshot exactly.
        normalized['databaseCapture'] = continuity.reverse_later_capture(actual['databaseCapture'], {'rows': rows})
    assert_prestate(expected, normalized)
    return {'beforeAuthSessionsSha256': expected['rows']['hashes']['auth_sessions'],
            'afterAuthSessionsSha256': observed, 'changedColumn': 'last_connected_at', 'changedRows': 1,
            'originalCompleteRowsReconstructed': True}

def remote_database_proof(home, identity, update, final, *, allow_existing_browser_heartbeat):
    """Recompute complete-database preservation on the owning worker over pinned SSH.

    Trusted local verifier code is streamed to the worker's python3 on stdin; private auth
    cells stay on that host, and only the recomputed public result comes back."""
    remote_user, ip = next((user, address) for name, user, address, _port in PLANS if name == identity)
    request = {'update': update, 'final': final, 'identity': identity,
               'allow_existing_browser_heartbeat': allow_existing_browser_heartbeat}
    request_json = json.dumps(request, sort_keys=True, separators=(',', ':'))
    sources = {name: pathlib.Path(__file__).with_name(name + '.py').read_text()
               for name in ['auth_heartbeat', 'database_continuity']}
    hashes = {name: digest(source.encode()) for name, source in sources.items()}
    # The fleet convention executes read-only Python from stdin over pinned SSH. No helper
    # installation, credential export, runtime call or remote file write occurs.
    program = 'request_json = ' + repr(request_json) + '\nsources = ' + repr(sources) + '\nhashes = ' + repr(hashes) + '\n' + """
import hashlib,json,os,pathlib,sys,types
assert os.getuid() == 501
request = json.loads(request_json)
for name, source in sources.items():
    assert hashlib.sha256(source.encode()).hexdigest() == hashes[name]
    module = types.ModuleType(name)
    sys.modules[name] = module
    exec(compile(source, name + '.py', 'exec'), module.__dict__)
identity = request['identity']
assert identity in {'m1', 'm3'} and request['final']['identity'] == identity
home = pathlib.Path.home().resolve()
state = home / '.specweave-studio' / identity / 'userdata'
ancestor = home
for part in state.relative_to(home).parts:
    ancestor = ancestor / part
    assert not ancestor.is_symlink()
assert not (state / 'statev2.sqlite').is_symlink()
installation = state.parent / 'installation.json'
assert not installation.is_symlink()
receipt = json.loads(installation.read_text())
assert receipt['identity'] == identity and receipt['stateDir'] == str(state)
assert receipt['sourceCommit'] == request['final']['artifactSourceCommit']
assert receipt['archiveSha256'] == request['final']['archiveSha256']
verified = sys.modules['database_continuity'].verify_update_database(
    request['update'], request['final'], state,
    allow_existing_browser_heartbeat=request['allow_existing_browser_heartbeat'])
print(json.dumps({'requestSha256': hashlib.sha256(request_json.encode()).hexdigest(), 'verified': verified}))
"""
    fleet = home / '.local/share/specweave/fleet'
    command = ['/usr/bin/ssh', '-F', '/dev/null', '-i', str(fleet / 'id_ed25519'),
               '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
               '-o', 'UserKnownHostsFile=' + str(fleet / 'known_hosts'), '-o', 'ConnectTimeout=5',
               '-o', 'ControlMaster=no', remote_user + '@' + ip, '/usr/bin/python3 -B -']
    response = subprocess.run(command, input=program, capture_output=True, text=True, timeout=45)
    assert response.returncode == 0, 'Read-only owning-host preservation verifier failed; private output withheld'
    value = json.loads(response.stdout)
    assert set(value) == {'requestSha256', 'verified'} and value['requestSha256'] == digest(request_json.encode()), \
        'Remote proof request binding changed'
    expected = {'authHeartbeatWitness': update.get('authHeartbeatWitness'),
                'finalDatabaseSha256': continuity.digest(continuity.encoded(final['databaseCapture']['summary']))}
    assert value['verified'] == expected, 'Remote recomputed preservation proof differs'
    return value['verified']

def assert_update_rows(update, final, home, later_witness=None, *, allow_existing_browser_heartbeat=False):
    """Recompute the update's preservation proof against live state on the owning host.

    With complete database captures, M4 recomputes locally and M1/M3 recompute on their own
    host (remote_database_proof); the result carries `finalDatabaseSha256`. Capture-less
    legacy receipts keep the protected-row comparison."""
    captured = ['databaseCapture' in value for value in (update['before'], update['after'], final)]
    if any(captured):
        assert all(captured), 'Complete database capture missing'
        identity = final['identity']
        if identity == 'm4':
            state = safe_path(home / '.specweave-studio/m4/userdata', home)
            return continuity.verify_update_database(update, final, state, later_witness=later_witness,
                                                     allow_existing_browser_heartbeat=allow_existing_browser_heartbeat)
        assert identity in {'m1', 'm3'} and later_witness is None
        return remote_database_proof(home, identity, update, final,
                                     allow_existing_browser_heartbeat=allow_existing_browser_heartbeat)
    witness = update.get('authHeartbeatWitness')
    if witness is None:
        assert update['before']['rows'] == update['after']['rows']
        assert update.get('rowsByteIdentical', True) is True
        assert update.get('rowPreservation', 'byte-identical') == 'byte-identical'
        return None
    assert allow_existing_browser_heartbeat, 'Restart heartbeat acceptance requires explicit opt-in'
    assert update['before']['identity'] == update['after']['identity'] == final['identity'] == 'm4'
    assert update['rowsByteIdentical'] is False and update['rowPreservation'] == 'verified-existing-browser-heartbeat'
    assert update['restartStartedAt'] == witness['restartStartedAt']
    assert update['after']['observedAt'] == witness['observedAfterAt']
    state = safe_path(home / '.specweave-studio/m4/userdata', home)
    current = read_auth_sessions(state, final['rows'])
    if later_witness is not None:
        # The separate later heartbeat was also checked by assert_update_continuity.
        # Reverse it only in memory to reconstruct the updater's real after hash.
        current = restore_timestamp(current, later_witness['beforeLastConnectedAt'],
                                    later_witness['afterLastConnectedAt'], update['after']['rows'])
    return verify_restart_witness(update['before']['rows'], update['after']['rows'], witness, current)


def transition(home, proof_path, expected_progress_sha, old_sha, new_sha, output, *, allow_existing_browser_heartbeat=False):
    assert os.getuid() == 501 and home == pathlib.Path.home().resolve()
    assert re.fullmatch('[a-f0-9]{64}', old_sha) and re.fullmatch('[a-f0-9]{64}', new_sha) and old_sha != new_sha
    network = safe_path(home / '.specweave-studio/m4/network', home)
    path = safe_path(network / 'progress.json', home)
    original = path.read_bytes()
    assert digest(original) == expected_progress_sha, 'Network progress changed before transition'
    progress = json.loads(original)
    assert progress['schemaVersion'] == 1 and progress['archiveSha256'] == old_sha
    assert progress['safeToResume'] is True and progress['initialServe'] == {}
    assert isinstance(progress['complete'], bool)
    completed = progress['complete']
    metadata_path = None
    metadata_bytes = None
    if completed:
        assert_completed_private_serve(progress['serveReadback'], progress['selfDNSName'])
        metadata_path = safe_path(network / 'private-access.json', home)
        metadata_bytes = metadata_path.read_bytes()
        assert_private_metadata(json.loads(metadata_bytes), progress)
    else:
        assert progress['serveReadback'] == {}, 'Incomplete transition preserves the disabled private gate'
    proof_bytes = proof_path.read_bytes()
    proof = json.loads(proof_bytes)
    assert proof['schemaVersion'] == 1 and set(proof['hosts']) == {'m4', 'm1', 'm3'}
    source = None
    witnesses = proof.get('authHeartbeatWitnesses', {})
    assert isinstance(witnesses, dict) and not set(witnesses) - {'m4'}
    heartbeats = {}
    restart_heartbeats = {}
    database_proofs = {}
    for identity, host in proof['hosts'].items():
        update = host['update']; final = host['finalSnapshot']
        assert update['phase'] == 'verified' and update['preservedRowsAuthAndIdentity'] is True
        assert update['originalServicesPreserved'] is True and update['onlyKnownOwnedServiceRestarted'] is True
        assert update['before']['archiveSha256'] == old_sha and update['after']['archiveSha256'] == new_sha
        heartbeat = assert_update_continuity(update['after'], final, home, witnesses.get(identity))
        if heartbeat is not None: heartbeats[identity] = heartbeat
        restart_heartbeat = assert_update_rows(update, final, home, witnesses.get(identity),
                                              allow_existing_browser_heartbeat=allow_existing_browser_heartbeat)
        if restart_heartbeat is not None and 'finalDatabaseSha256' in restart_heartbeat:
            database_proofs[identity] = restart_heartbeat
            restart_heartbeat = restart_heartbeat['authHeartbeatWitness']
        if restart_heartbeat is not None: restart_heartbeats[identity] = restart_heartbeat
        assert final['identity'] == identity and final['uid'] == 501 and final['serviceLabel'] == 'com.specweave.studio.' + identity
        fresh(final['observedAt'])
        source = source or final['artifactSourceCommit']
        assert re.fullmatch('[a-f0-9]{40}', source) and source == final['artifactSourceCommit']
    # Reverify the current primary installation rather than trusting its saved report.
    assert_prestate(proof['hosts']['m4']['finalSnapshot'], snapshot('m4'))
    status = json.loads(read_command([TAILSCALE, 'status', '--json']))
    serve = json.loads(read_command([TAILSCALE, 'serve', 'status', '--json']))
    hostname = (status.get('Self') or {}).get('DNSName', '').rstrip('.')
    assert status.get('BackendState') == 'Running' and hostname.endswith('.ts.net')
    assert hostname == progress['selfDNSName'] and serve == progress['serveReadback'], 'Private DNS or Serve ownership changed'
    assert set(progress['tunnels']) == {'com.specweave.studio.tunnel-' + item[0] for item in PLANS}
    user = pwd.getpwuid(os.getuid()).pw_name
    transports = {}
    for identity, remote_user, ip, port in PLANS:
        label = 'com.specweave.studio.tunnel-' + identity
        record = progress['tunnels'][label]
        plist = safe_path(home / 'Library/LaunchAgents' / (label + '.plist'), home)
        expected = tunnel_bytes(home, identity, remote_user, ip, port, user)
        assert record['phase'] == 'ready' and record['plistPath'] == str(plist)
        assert record['expectedPlistSha256'] == digest(expected) and plist.read_bytes() == expected
        live = read_command(['/bin/launchctl', 'print', 'gui/501/' + label])
        pid = re.search(r'^\s*pid = (\d+)\s*$', live, re.M)
        assert pid and int(pid.group(1)) == record['pid'] and 'path = ' + str(plist) in live
        assert re.search(r'^\s*state = running\s*$', live, re.M) and listeners(port) == [record['pid']]
        command = read_command(['/bin/ps', '-p', str(record['pid']), '-o', 'command='])
        assert '/usr/bin/ssh' in command and '127.0.0.1:' + str(port) + ':127.0.0.1:8319' in command and remote_user + '@' + ip in command
        transports[label] = {'pid': record['pid'], 'plistSha256': digest(expected), 'port': port}
    final_status = json.loads(read_command([TAILSCALE, 'status', '--json']))
    final_serve = json.loads(read_command([TAILSCALE, 'serve', 'status', '--json']))
    assert final_status.get('BackendState') == 'Running' and (final_status.get('Self') or {}).get('DNSName', '').rstrip('.') == hostname
    assert final_serve == serve, 'Private Serve changed during readback'
    if metadata_path is not None:
        assert metadata_path.read_bytes() == metadata_bytes, 'Private transport metadata changed during readback'
    assert path.read_bytes() == original, 'Network progress changed during readback'
    backup = network / ('progress-before-artifact-transition-' + str(uuid.uuid4()) + '.json')
    with backup.open('xb') as file: file.write(original)
    backup.chmod(0o600)
    audit = {'oldArchiveSha256': old_sha, 'newArchiveSha256': new_sha, 'previousProgressSha256': digest(original),
        'allHostProofSha256': digest(proof_bytes), 'sourceCommit': source, 'backup': str(backup),
        'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'unchangedTransports': transports,
        'unchangedServeSha256': digest(json.dumps(serve, sort_keys=True).encode()), 'mappingWrites': False,
        'privateAccessComplete': completed, 'verifiedAuthHeartbeats': heartbeats,
        'verifiedRestartAuthHeartbeats': restart_heartbeats, 'verifiedDatabasePreservation': database_proofs,
        'transportMetadataSha256': digest(metadata_bytes) if metadata_bytes is not None else None}
    progress['archiveSha256'] = new_sha
    progress['artifactTransitions'] = [*progress.get('artifactTransitions', []), audit]
    assert path.read_bytes() == original, 'Network progress changed before commit'
    if metadata_path is not None:
        assert metadata_path.read_bytes() == metadata_bytes, 'Private transport metadata changed before commit'
    atomic(path, (json.dumps(progress, indent=2) + '\n').encode(), 0o600)
    result = {'result': 'transitioned', **audit, 'progressSha256': digest(path.read_bytes()), 'privateGateStillDisabled': not completed}
    output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'result': result['result'], 'report': str(output), 'mappingWrites': False}))

def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    for flag in ['fleet-proof', 'expected-progress-sha256', 'old-sha256', 'new-sha256', 'output']:
        parser.add_argument('--' + flag, required=True)
    parser.add_argument('--allow-existing-browser-heartbeat', action='store_true',
                        help='Recompute an explicitly witnessed M4 restart heartbeat from complete live auth rows')
    args = parser.parse_args()
    output = pathlib.Path(args.output)
    assert not output.exists()
    transition(pathlib.Path.home().resolve(), pathlib.Path(args.fleet_proof), args.expected_progress_sha256,
        args.old_sha256, args.new_sha256, output, allow_existing_browser_heartbeat=args.allow_existing_browser_heartbeat)

if __name__ == '__main__': main()
