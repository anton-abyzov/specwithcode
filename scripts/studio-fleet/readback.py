#!/usr/bin/env python3
"""Bounded install liveness metadata. Never reads native credential stores or pairing logs."""
import argparse
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

parser = argparse.ArgumentParser()
parser.add_argument('--identity', choices=['m4', 'm1', 'm3', 'stage'], required=True)
args = parser.parse_args()
home = pathlib.Path.home().resolve()
own = home / '.specweave-studio' / args.identity
assert own.resolve() == own, 'Studio state escapes its dedicated home'
receipt = json.loads((own / 'installation.json').read_text())
release = pathlib.Path(receipt['release'])
manifest = json.loads((release / 'studio-manifest.json').read_text())
assert manifest['sourceCommit'] == receipt['sourceCommit']
for entry in manifest['files']:
    path = release / entry['path']
    assert release in path.resolve().parents, 'Release member escapes artifact'
    if entry['type'] == 'symlink':
        assert path.is_symlink() and os.readlink(str(path)) == entry['target']
    else:
        assert path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == entry['sha256']
state = pathlib.Path(receipt['stateDir'])
assert state == own / 'userdata'
settings = json.loads((state / 'settings.json').read_text())
runtime = json.loads((state / 'server-runtime.json').read_text())
assert runtime['host'] == '127.0.0.1' and runtime['port'] == receipt['port']
os.kill(runtime['pid'], 0)  # Read-only process existence check, never sends a terminating signal.
service = receipt['service']
if service['installed']:
    result = subprocess.run(['/bin/launchctl', 'print', service['domain'] + '/' + service['label']],
                            capture_output=True, text=True, timeout=5)
    assert result.returncode == 0
    assert re.search(r'^\s*state = running\s*$', result.stdout, re.M)
    match = re.search(r'^\s*pid = (\d+)\s*$', result.stdout, re.M)
    assert match
    service = dict(service, pid=int(match.group(1)), state='running')
def http_code(path):
    try:
        response = urllib.request.urlopen('http://127.0.0.1:' + str(receipt['port']) + path, timeout=5)
        return response.status
    except urllib.error.HTTPError as error:
        return error.code
http = {'root': http_code('/'), 'capacityUnauth': http_code('/api/studio/capacity')}
assert http['root'] == 200 and http['capacityUnauth'] == 401
provider_versions = []
env = {'HOME': str(home), 'PATH': str(pathlib.Path(receipt['node']).parent) + ':/usr/bin:/bin',
       'LANG': 'en_US.UTF-8'}
for driver in ['codex', 'claudeAgent']:
    config = settings['providers'][driver]
    binary = config.get('binaryPath')
    assert binary and pathlib.Path(binary).is_file(), 'Provider binary was not explicitly configured'
    result = subprocess.run([binary, '--version'], capture_output=True, text=True, env=env, timeout=20)
    assert result.returncode == 0
    provider_versions.append({'driver': driver, 'binary': binary, 'version': result.stdout.strip()})
cookie_name = 'studio_session_' + str(receipt['port']) + '_' + hashlib.sha256(str(state).encode()).hexdigest()[:12]
assert cookie_name == receipt['cookieName']
now = datetime.datetime.now(datetime.timezone.utc)
proof = {'observedAtUTC': now.isoformat(), 'observedAtNewYork': now.astimezone(ZoneInfo('America/New_York')).isoformat(),
         'identity': args.identity, 'user': receipt['user'], 'uid': os.getuid(),
         'sourceCommit': manifest['sourceCommit'], 'archiveSha256': receipt['archiveSha256'],
         'release': str(release), 'studioHome': str(own), 'stateDir': str(state),
         'filesVerified': len(manifest['files']), 'node': receipt['node'], 'nodeVersion': receipt['nodeVersion'],
         'settings': {'defaultThreadEnvMode': settings.get('defaultThreadEnvMode'),
                      'defaultRuntimeMode': settings.get('defaultRuntimeMode')},
         'service': service, 'runtime': runtime, 'http': http, 'cookieName': cookie_name,
         'environmentIdFingerprint': hashlib.sha256((state / 'environment-id').read_bytes()).hexdigest(),
         'providerVersions': provider_versions, 'resourceTelemetry': manifest['resourceTelemetry'],
         'nativeAuthRead': False, 'nativeAuthCopied': False, 'inferenceExecuted': False,
         'legalFiles': ['LICENSE', 'UPSTREAM.md', 'third-party-licenses.json', 'client/third-party-licenses.json']}
print(json.dumps(proof))
