#!/usr/bin/env python3
"""Owned private Serve + exact pinned LAN forwards. Never enables Funnel or resets Serve."""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import plistlib
import pwd
import re
import socket
import subprocess
import time
import urllib.request
from fleet_hosts import worker_plans

parser = argparse.ArgumentParser()
operation = parser.add_mutually_exclusive_group()
operation.add_argument('--apply', action='store_true')
operation.add_argument('--resume', action='store_true')
args = parser.parse_args()
os.umask(0o077)
home = pathlib.Path.home().resolve()
tailscale = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
owner = home / '.specweave-studio/m4'
key = home / '.local/share/specweave/fleet/id_ed25519'
known = home / '.local/share/specweave/fleet/known_hosts'
def command_json(arguments):
    result = subprocess.run([tailscale] + arguments, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, 'Tailscale status unavailable'
    return json.loads(result.stdout)

status = command_json(['status', '--json'])
before = command_json(['serve', 'status', '--json'])
self_status = status.get('Self') or {}
hostname = self_status.get('DNSName', '').rstrip('.')
assert hostname.endswith('.ts.net'), 'No enrolled Tailnet DNS identity'
observation = {'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'backendState': status.get('BackendState'), 'selfDNSName': hostname,
               'selfIPs': self_status.get('TailscaleIPs', []),
               'peerCount': len(status.get('Peer') or {}), 'serveWasEmpty': before == {},
               'workerTailnetEnrollment': 'unknown', 'physicalPhoneProof': 'not-observed',
               'workerRouteRequiresPrimaryOnLAN': True}
if not args.apply and not args.resume:
    print(json.dumps(observation))
    raise SystemExit(0)
assert status.get('BackendState') == 'Running', 'Offline Tailnet'
assert (owner / 'installation.json').is_file(), 'Install verified primary Studio first'
assert key.is_file() and known.is_file(), 'Pinned fleet SSH material missing'
network = owner / 'network'
assert owner.resolve() == owner and not network.is_symlink(), 'Network destination escapes Studio home'
if args.apply:
    assert before == {} and not network.exists(), 'Existing Serve mapping or network destination'
else:
    assert network.is_dir(), 'No owned network installation to resume'
user = pwd.getpwuid(os.getuid()).pw_name
plans = worker_plans()
plists = []
progress_path = network / 'progress.json'
progress = json.loads(progress_path.read_text()) if args.resume else None
installation = json.loads((owner / 'installation.json').read_text())
def expected_tunnel(identity, remote_user, ip, local_port, label):
    logs = [network / (identity + '.stdout.log'), network / (identity + '.stderr.log')]
    ssh = ['/usr/bin/env', '-i', 'HOME=' + str(home), 'USER=' + user, 'PATH=/usr/bin:/bin',
           '/usr/bin/ssh', '-F', '/dev/null', '-i', str(key), '-o', 'IdentitiesOnly=yes',
           '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
           '-o', 'UserKnownHostsFile=' + str(known), '-o', 'ConnectTimeout=5',
           '-o', 'ControlMaster=no', '-o', 'ExitOnForwardFailure=yes',
           '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
           '-N', '-L', '127.0.0.1:' + str(local_port) + ':127.0.0.1:8319', remote_user + '@' + ip]
    return plistlib.dumps({'Label': label, 'ProgramArguments': ssh,
                          'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 10,
                          'StandardOutPath': str(logs[0]), 'StandardErrorPath': str(logs[1])})
def free_port(port):
    probe = socket.socket()
    try:
        probe.bind(('127.0.0.1', port))
    finally:
        probe.close()
if args.resume:
    assert progress['initialServe'] == {} and progress['archiveSha256'] == installation['archiveSha256']
    assert progress['selfDNSName'] == hostname and progress['serveReadback'] == before
    assert progress['safeToResume'], 'Foreign state prevents owned resume'
for identity, remote_user, ip, local_port, https_port in plans:
    label = 'com.specweave.studio.tunnel-' + identity
    plist = home / 'Library/LaunchAgents' / (label + '.plist')
    assert not plist.is_symlink(), 'Tunnel launch agent is a symlink'
    loaded = subprocess.run(['/bin/launchctl', 'print', 'gui/' + str(os.getuid()) + '/' + label],
                            capture_output=True, text=True)
    if args.apply:
        assert not plist.exists() and loaded.returncode != 0, 'Existing tunnel launch agent or label'
        free_port(local_port)
    else:
        record = progress['tunnels'][label]
        assert record['expectedPlistSha256'] == hashlib.sha256(expected_tunnel(identity, remote_user, ip, local_port, label)).hexdigest()
        if record['phase'] == 'planned':
            assert not plist.exists() and loaded.returncode != 0, 'Unrecorded tunnel appeared'
            free_port(local_port)
        else:
            assert plist.is_file() and hashlib.sha256(plist.read_bytes()).hexdigest() == record['expectedPlistSha256']
            if loaded.returncode == 0:
                assert ('path = ' + str(plist)) in loaded.stdout, 'Loaded tunnel belongs to another owner'
            else:
                free_port(local_port)
    plists.append((identity, remote_user, ip, local_port, https_port, label, plist))
if args.apply:
    network.mkdir(mode=0o700)
mappings = {443: 'http://127.0.0.1:8319', 8443: 'http://127.0.0.1:18319', 8444: 'http://127.0.0.1:28319'}
def is_owned_serve(state):
    if set(state) - {'TCP', 'Web', 'AllowFunnel'} or any(state.get('AllowFunnel', {}).values()):
        return False
    web, tcp = state.get('Web', {}), state.get('TCP', {})
    if set(tcp) != {host.rsplit(':', 1)[1] for host in web}:
        return False
    for host, config in web.items():
        port = int(host.rsplit(':', 1)[1])
        if host != hostname + ':' + str(port) or port not in mappings:
            return False
        if config != {'Handlers': {'/': {'Proxy': mappings[port]}}} or tcp[str(port)] != {'HTTPS': True}:
            return False
    return True
if args.apply:
    progress = {'schemaVersion': 1, 'initialServe': {}, 'selfDNSName': hostname,
                'archiveSha256': installation['archiveSha256'], 'serveReadback': before,
                'safeToResume': True, 'complete': False, 'phase': 'tunnels',
                'tunnels': {p[5]: {'phase': 'planned', 'plistPath': str(p[6]),
                    'expectedPlistSha256': hashlib.sha256(expected_tunnel(p[0], p[1], p[2], p[3], p[5])).hexdigest()} for p in plists}}
def retain_progress(state, failure=None):
    progress.update({'serveReadback': state, 'safeToResume': is_owned_serve(state),
                     'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()})
    if failure:
        progress['failureType'] = type(failure).__name__
    progress_path.write_text(json.dumps(progress, indent=2) + '\n')
retain_progress(before)
owned_state = before
try:
  for identity, remote_user, ip, local_port, https_port, label, plist in plists:
    record = progress['tunnels'][label]
    expected_plist = expected_tunnel(identity, remote_user, ip, local_port, label)
    if record['phase'] == 'planned':
        for suffix in ['stdout', 'stderr']:
            (network / (identity + '.' + suffix + '.log')).touch(mode=0o600)
        with plist.open('xb') as file:
            file.write(expected_plist)
        record['phase'] = 'created'
        retain_progress(owned_state)
    assert plist.read_bytes() == expected_plist, 'Recorded tunnel arguments changed'
    loaded = subprocess.run(['/bin/launchctl', 'print', 'gui/' + str(os.getuid()) + '/' + label],
                            capture_output=True, text=True)
    if loaded.returncode != 0:
        free_port(local_port)
        subprocess.run(['/bin/launchctl', 'bootstrap', 'gui/' + str(os.getuid()), str(plist)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        assert ('path = ' + str(plist)) in loaded.stdout, 'Loaded tunnel belongs to another owner'
    record['phase'] = 'loaded'
    retain_progress(owned_state)
    for attempt in range(30):
        try:
            live = subprocess.run(['/bin/launchctl', 'print', 'gui/' + str(os.getuid()) + '/' + label],
                                  capture_output=True, text=True)
            pid = re.search(r'^\s*pid = (\d+)\s*$', live.stdout, re.M)
            assert live.returncode == 0 and pid and ('path = ' + str(plist)) in live.stdout
            listener = subprocess.run(['/usr/sbin/lsof', '-nP', '-t', '-iTCP:' + str(local_port), '-sTCP:LISTEN'],
                                      capture_output=True, text=True)
            assert listener.stdout.split() == [pid.group(1)], 'Listener is not the owned SSH process'
            response = urllib.request.urlopen('http://127.0.0.1:' + str(local_port) + '/', timeout=2)
            assert response.status == 200
            record.update({'phase': 'ready', 'pid': int(pid.group(1))})
            retain_progress(owned_state)
            break
        except Exception:
            time.sleep(.3)
    else:
        raise RuntimeError('Owned tunnel did not reach installed worker HTTP')
  progress['phase'] = 'serve'
  retain_progress(owned_state)
  with (network / 'tailscale-private.log').open('ab') as log:
    for port, target in mappings.items():
        # Recheck no unrelated mapping appeared; never reset or overwrite another owner.
        current = command_json(['serve', 'status', '--json'])
        assert current == owned_state, 'Serve state changed outside this installation'
        assert is_owned_serve(current), 'Unrecognized Serve state'
        if hostname + ':' + str(port) in current.get('Web', {}):
            continue
        result = subprocess.run([tailscale, 'serve', '--bg', '--yes', '--https=' + str(port), target],
                                stdout=log, stderr=log, timeout=30)
        assert result.returncode == 0, 'Tailscale private HTTPS requires external configuration; inspect private log'
        owned_state = command_json(['serve', 'status', '--json'])
        retain_progress(owned_state)
        assert is_owned_serve(owned_state), 'Unexpected private Serve state'
except Exception as error:
    retain_progress(command_json(['serve', 'status', '--json']), error)
    raise
after = command_json(['serve', 'status', '--json'])
assert not any(after.get('AllowFunnel', {}).values()), 'Unexpected public Funnel configuration'
for port, target in mappings.items():
    assert after['Web'][hostname + ':' + str(port)]['Handlers']['/']['Proxy'] == target
assert set(after['Web']) == {hostname + ':' + str(port) for port in mappings}, 'Unexpected Serve endpoint'
progress['complete'] = True
retain_progress(after)
observation.update({'configuredPrivateOnly': True, 'origins': {
    'm4': 'https://' + hostname, 'm1': 'https://' + hostname + ':8443',
    'm3': 'https://' + hostname + ':8444'}, 'serveReadback': after,
    'tunnels': [{'identity': p[0], 'localPort': p[3], 'remoteHost': p[2],
                 'remotePort': 8319, 'label': p[5]} for p in plists]})
(network / 'private-access.json').write_text(json.dumps(observation, indent=2) + '\n')
print(json.dumps(observation))
