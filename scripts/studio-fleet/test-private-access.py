#!/usr/bin/env python3
"""Execute the real helper with fake transports; no services, ports or Tailnet writes."""
import contextlib
import io
import json
import os
import pathlib
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).with_name('private-access.py')
DNS = 'fixture.tail-test.ts.net'

class PrivateAccessRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='studio-network-test-')
        self.home = pathlib.Path(self.temp.name).resolve() / 'home'
        self.owner = self.home / '.specwithcode/m4'
        self.owner.mkdir(parents=True)
        (self.owner / 'installation.json').write_text(json.dumps({'archiveSha256': 'fixture-digest'}))
        fleet = self.home / '.local/share/specweave/fleet'
        fleet.mkdir(parents=True)
        (fleet / 'id_ed25519').write_text('fixture-only')
        (fleet / 'known_hosts').write_text('fixture-only')
        (self.home / 'Library/LaunchAgents').mkdir(parents=True)
        # Fixture inventory (documentation addresses only); never the operator's real fleet file.
        self.fleet_hosts = pathlib.Path(self.temp.name).resolve() / 'hosts.json'
        self.fleet_hosts.write_text(json.dumps({'m1': {'host': '192.0.2.11', 'user': 'worker-one', 'home': '/Users/worker-one'},
            'm3': {'host': '192.0.2.13', 'user': 'worker-three', 'home': '/Users/worker-three'}}))
        self.serve = {}
        self.loaded = {}
        self.mutations = []
        self.fail_port = None
        self.fail_bootstrap_once = False
        self.fail_readiness = False

    def tearDown(self):
        self.temp.cleanup()

    def transport(self, command, **kwargs):
        def result(code=0, text=''):
            return subprocess.CompletedProcess(command, code, text, '')
        if command[0].endswith('/Tailscale'):
            arguments = command[1:]
            if arguments == ['status', '--json']:
                return result(text=json.dumps({'BackendState': 'Running', 'Self': {'DNSName': DNS}, 'Peer': None}))
            if arguments == ['serve', 'status', '--json']:
                return result(text=json.dumps(self.serve))
            self.mutations.append(arguments)
            self.assertEqual(arguments[:3], ['serve', '--bg', '--yes'])
            port = arguments[3].split('=')[1]
            if port == self.fail_port:
                return result(1)
            self.serve.setdefault('TCP', {})[port] = {'HTTPS': True}
            self.serve.setdefault('Web', {})[DNS + ':' + port] = {'Handlers': {'/': {'Proxy': arguments[4]}}}
            return result()
        if command[:2] == ['/bin/launchctl', 'print']:
            label = command[2].rsplit('/', 1)[1]
            pid = 1001 if label.endswith('m1') else 1002
            return result(text='path = ' + self.loaded[label] + '\npid = ' + str(pid)) if label in self.loaded else result(113)
        if command[:2] == ['/bin/launchctl', 'bootstrap']:
            if self.fail_bootstrap_once:
                self.fail_bootstrap_once = False
                raise subprocess.CalledProcessError(5, command)
            path = pathlib.Path(command[3])
            self.loaded[path.stem] = str(path)
            return result()
        if command[0] == '/usr/sbin/lsof':
            return result(text='1001\n' if '-iTCP:18319' in command else '1002\n')
        self.fail('Unexpected command: ' + str(command))

    def execute(self, operation):
        fake_response = type('Response', (), {'status': 200})()
        def response(*args, **kwargs):
            if self.fail_readiness:
                raise OSError('fixture worker unavailable')
            return fake_response
        with patch.dict(os.environ, {'HOME': str(self.home), 'STUDIO_FLEET_HOSTS': str(self.fleet_hosts)}), patch.object(sys, 'argv', [str(SCRIPT), operation]), \
             patch('subprocess.run', side_effect=self.transport), patch('socket.socket'), \
             patch('urllib.request.urlopen', side_effect=response), patch('time.sleep'), contextlib.redirect_stdout(io.StringIO()):
            runpy.run_path(str(SCRIPT), run_name='__main__')

    def test_missing_fleet_inventory_fails_before_mutation(self):
        self.fleet_hosts.unlink()
        with self.assertRaisesRegex(SystemExit, 'Fleet inventory not found .*STUDIO_FLEET_HOSTS'):
            self.execute('--apply')
        self.assertEqual(self.mutations, [])
        self.assertFalse((self.owner / 'network').exists())

    def test_foreign_mapping_blocks_initial_mutation(self):
        self.serve = {'TCP': {'443': {'TCPForward': 'foreign:443'}}}
        with self.assertRaisesRegex(AssertionError, 'Existing Serve'):
            self.execute('--apply')
        self.assertEqual(self.mutations, [])
        self.assertFalse((self.owner / 'network').exists())
        self.assertEqual(self.loaded, {})

    def test_partial_serve_failure_retains_owned_state_and_resumes_without_reset(self):
        self.fail_port = '8443'
        with self.assertRaisesRegex(AssertionError, 'external configuration'):
            self.execute('--apply')
        path = self.owner / 'network/progress.json'
        partial = json.loads(path.read_text())
        self.assertEqual(partial['serveReadback'], self.serve)
        self.assertTrue(partial['safeToResume'])
        self.assertFalse(partial['complete'])
        first_443_count = sum('--https=443' in call for call in self.mutations)
        self.fail_port = None
        self.execute('--resume')
        final = json.loads(path.read_text())
        self.assertTrue(final['complete'])
        self.assertEqual(len(self.serve['Web']), 3)
        self.assertEqual(sum('--https=443' in call for call in self.mutations), first_443_count)
        self.assertFalse(any('reset' in call or 'funnel' in call for call in self.mutations))

    def test_foreign_state_after_partial_failure_blocks_resume(self):
        self.fail_port = '8443'
        with self.assertRaises(AssertionError):
            self.execute('--apply')
        count = len(self.mutations)
        self.serve['TCP']['9999'] = {'TCPForward': 'foreign:9999'}
        with self.assertRaises(AssertionError):
            self.execute('--resume')
        self.assertEqual(len(self.mutations), count)

    def test_first_bootstrap_failure_is_recorded_and_resumable(self):
        self.fail_bootstrap_once = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.execute('--apply')
        path = self.owner / 'network/progress.json'
        partial = json.loads(path.read_text())
        self.assertEqual(partial['tunnels']['com.specweave.studio.tunnel-m1']['phase'], 'created')
        self.assertEqual(partial['tunnels']['com.specweave.studio.tunnel-m3']['phase'], 'planned')
        self.assertEqual(self.mutations, [])
        self.execute('--resume')
        self.assertTrue(json.loads(path.read_text())['complete'])

    def test_tunnel_readiness_failure_is_recorded_and_resumable(self):
        self.fail_readiness = True
        with self.assertRaisesRegex(RuntimeError, 'did not reach'):
            self.execute('--apply')
        path = self.owner / 'network/progress.json'
        partial = json.loads(path.read_text())
        self.assertEqual(partial['tunnels']['com.specweave.studio.tunnel-m1']['phase'], 'loaded')
        self.assertEqual(self.mutations, [])
        self.fail_readiness = False
        self.execute('--resume')
        self.assertTrue(json.loads(path.read_text())['complete'])

if __name__ == '__main__':
    unittest.main()
