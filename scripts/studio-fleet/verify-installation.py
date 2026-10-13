#!/usr/bin/env python3
"""Read-only live fleet proof. Pairing secrets and native auth stores are never read."""
import argparse
import concurrent.futures
import datetime
import hashlib
import json
import os
import pathlib
import re
import subprocess
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo
from fleet_hosts import worker_plans

parser = argparse.ArgumentParser()
parser.add_argument('--research-dir', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
os.umask(0o077)
home = pathlib.Path.home().resolve()
research = pathlib.Path(args.research_dir).resolve(strict=True)
archive_sha = 'b98275939be5c6abed6cf00b8feea0fbf16000ecefad09e208944956e599d05d'
artifact_source = '58215f1692de220b767043bb901289de65c2f356'
assert hashlib.sha256((research / 'specweave-studio-final.tar.gz').read_bytes()).hexdigest() == archive_sha
key = home / '.local/share/specweave/fleet/id_ed25519'
known = key.with_name('known_hosts')
ssh = ['/usr/bin/ssh', '-F', '/dev/null', '-i', str(key), '-o', 'IdentitiesOnly=yes',
       '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
       '-o', 'UserKnownHostsFile=' + str(known), '-o', 'ConnectTimeout=5', '-o', 'ControlMaster=no']
remote = {identity: user + '@' + host for identity, user, host, _tunnel, _https in worker_plans()}
helper = pathlib.Path(__file__).with_name('readback.py')
remote_helper = home / '.local/share/specweave-studio/incoming/t04-b9827593/readback.py'

def run_json(command, stdin=None):
    result = subprocess.run(command, input=stdin, capture_output=True, text=True, timeout=45)
    assert result.returncode == 0, 'Read-only live fleet probe failed'
    return json.loads(result.stdout)

def readback(identity):
    command = ['/usr/bin/python3', str(helper), '--identity', identity] if identity == 'm4' else \
        ssh + [remote[identity], '/usr/bin/python3 ' + str(remote_helper) + ' --identity ' + identity]
    data = run_json(command)
    assert data['archiveSha256'] == archive_sha and data['sourceCommit'] == artifact_source
    assert data['nodeVersion'] == '22.20.0' and data['filesVerified'] == 6605
    assert data['uid'] == 501 and data['service']['domain'] == 'gui/501'
    assert data['service']['state'] == 'running' and data['http'] == {'root': 200, 'capacityUnauth': 401}
    assert data['settings'] == {'defaultThreadEnvMode': 'worktree', 'defaultRuntimeMode': 'approval-required'}
    assert [p['version'] for p in data['providerVersions']] == ['codex-cli 0.160.1', '2.1.292 (Claude Code)']
    assert data['nativeAuthRead'] is False and data['nativeAuthCopied'] is False
    return identity, data

with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
    hosts = dict(executor.map(readback, ['m4', 'm1', 'm3']))
assert len({host['cookieName'] for host in hosts.values()}) == 3
assert len({host['stateDir'] for host in hosts.values()}) == 3
assert len({host['environmentIdFingerprint'] for host in hosts.values()}) == 3

probe = '''import json,subprocess,urllib.request,urllib.error
r={'listeners':{},'authNegative':{}}
for port in [8317,8318,8319]:
 p=subprocess.run(['/usr/sbin/lsof','-nP','-t','-iTCP:'+str(port),'-sTCP:LISTEN'],capture_output=True,text=True)
 r['listeners'][str(port)]=sorted(set(p.stdout.split()))
for label,headers in [('unauth',{}),('foreignOrigin',{'Origin':'https://foreign.invalid'}),('foreignHost',{'Host':'foreign.invalid'})]:
 try:r['authNegative'][label]=urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8319/api/studio/capacity',headers=headers),timeout=5).status
 except urllib.error.HTTPError as e:r['authNegative'][label]=e.code
p=subprocess.run(['/usr/sbin/lsof','-nP','-iTCP:8319','-sTCP:LISTEN'],capture_output=True,text=True)
r['loopbackOnly']=bool(p.stdout.splitlines()[1:]) and all('127.0.0.1:8319' in line for line in p.stdout.splitlines()[1:])
print(json.dumps(r))
'''
prestate = json.loads((research / 'fleet-prestate.json').read_text())
for identity in hosts:
    command = ['/usr/bin/python3', '-'] if identity == 'm4' else ssh + [remote[identity], '/usr/bin/python3 -']
    live = run_json(command, probe)
    assert live['loopbackOnly'] and set(live['authNegative'].values()) == {401}
    for port, pids in prestate['hosts'][identity].get('listeners', {}).items():
        if pids and port in live['listeners']:
            assert all(pid in live['listeners'][port] for pid in pids), 'Original visible listener changed'
    hosts[identity]['liveBindAndUnauthProof'] = live

network = home / '.specweave-studio/m4/network'
progress = json.loads((network / 'progress.json').read_text())
for identity, port in [('m1', 18319), ('m3', 28319)]:
    label = 'com.specweave.studio.tunnel-' + identity
    record = progress['tunnels'][label]
    plist = pathlib.Path(record['plistPath'])
    assert record['phase'] == 'ready' and hashlib.sha256(plist.read_bytes()).hexdigest() == record['expectedPlistSha256']
    live = subprocess.run(['/bin/launchctl', 'print', 'gui/501/' + label], capture_output=True, text=True, timeout=5)
    pid = re.search(r'^\s*pid = (\d+)\s*$', live.stdout, re.M)
    assert live.returncode == 0 and pid and 'path = ' + str(plist) in live.stdout
    listeners = subprocess.run(['/usr/sbin/lsof', '-nP', '-t', '-iTCP:' + str(port), '-sTCP:LISTEN'], capture_output=True, text=True)
    assert listeners.stdout.split() == [pid.group(1)]
    assert urllib.request.urlopen('http://127.0.0.1:' + str(port) + '/', timeout=5).status == 200
    try:
        code = urllib.request.urlopen('http://127.0.0.1:' + str(port) + '/api/studio/capacity', timeout=5).status
    except urllib.error.HTTPError as error:
        code = error.code
    assert code == 401

tailscale = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
serve = run_json([tailscale, 'serve', 'status', '--json'])
assert serve == progress['serveReadback'], 'Serve state changed; resume/review before claiming a mapping'
assert not any(serve.get('AllowFunnel', {}).values()), 'Unexpected public Funnel'
headless_gate = json.loads((research / 'serve-enable-headless.json').read_text())
assert headless_gate['browserHeadless'] and headless_gate['freshContext'] and not headless_gate['personalCookiesCopied']
assert headless_gate['result'] == 'interactive-account-sign-in-required'
assert serve == {} and progress['safeToResume'] and not progress['complete']
now = datetime.datetime.now(datetime.timezone.utc)
receipt = {'schemaVersion': 1, 'product': 'SpecWeave Studio', 'observedAtUTC': now.isoformat(),
           'observedAtNewYork': now.astimezone(ZoneInfo('America/New_York')).isoformat(),
           'artifactSourceCommit': artifact_source, 'archiveSha256': archive_sha,
           'helperSourceCommit': 'f50e85fd0eeb8e7df81999b92fc4e6754b940abd',
           'hosts': hosts, 'independentCookieStateAndEnvironmentIdentities': True,
           'nativeCredentialStoresCopied': False, 'originalVisibleWorkerListenersPreserved': True,
           'privateAccess': {'lanForwardsVerified': {'m1': 18319, 'm3': 28319}, 'serveReadback': serve,
               'https': 'blocked: private Serve enable requires interactive account sign-in',
               'safeToResume': True, 'headlessEnableGate': headless_gate,
               'funnelEnabled': False, 'phoneMembership': 'unproved', 'workerTailnetEnrollment': 'unknown',
               'workerRelayRequiresPrimaryOnLAN': True},
           'nativeAcceptance': 'T05 owns distinct authenticated/native/checkpoint/restart/resume/restore receipts',
           'telemetry': 'unknown: resource-monitor sidecar absent',
           'originalHistoryImport': 'not attempted; live original stores preserved',
           'evidenceDirectory': str(research), 'limits': ['M1 admin proxy invisible to anton SSH identity',
               'Unauthenticated foreign Host/Origin rejection is not authenticated CSRF proof',
               'AC caffeinate does not prove closed-lid or battery availability',
               'The administrator must enable private Serve before guarded resume and HTTPS verification']}
output = pathlib.Path(args.output)
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps({'result': 'passed', 'hosts': 3, 'filesVerifiedPerHost': 6605,
                  'archiveSha256': archive_sha, 'report': str(output), 'https': 'blocked: interactive Serve enable'}))
