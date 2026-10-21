#!/usr/bin/env python3
"""Generic ownership and update regressions. Temporary files, synthetic OS/process evidence only."""
import ast
import contextlib
import copy
import datetime
import importlib.util
import json
import os
import pathlib
import plistlib
import shlex
import shutil
import sqlite3
import tempfile
import types
import unittest
from unittest import mock

import installation_descriptor as descriptor
import auth_heartbeat as heartbeat
import database_continuity as continuity
import quiescence
import update
import update_agent
from launcher import runtime_path, render_cli

HERE = pathlib.Path(__file__).parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@contextlib.contextmanager
def simulated_owner(home, uid=502, foreign=None):
    """Model the OS account and stat UID together; never chown a file or use real launchd."""
    original_stat = pathlib.Path.stat
    original_fstat = os.fstat
    def stat(path, *args, **kwargs):
        value = original_stat(path, *args, **kwargs)
        fields = list(value)
        fields[4] = uid + 1 if path == foreign else uid
        return os.stat_result(fields)
    def fstat(fd):
        value = list(original_fstat(fd)); value[4] = uid
        return os.stat_result(value)
    with mock.patch.object(descriptor.os, 'fstat', side_effect=fstat), mock.patch.object(descriptor.os, 'getuid', return_value=uid), \
         mock.patch.object(descriptor.os, 'geteuid', return_value=uid), \
         mock.patch.object(descriptor.pwd, 'getpwuid', return_value=types.SimpleNamespace(pw_name='fixture-user', pw_dir=str(home))), \
         mock.patch.object(pathlib.Path, 'home', return_value=home), \
         mock.patch.object(pathlib.Path, 'stat', stat):
        yield


class InstallationIdentity(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='studio generic owner ')
        self.addCleanup(temporary.cleanup)
        self.home = pathlib.Path(temporary.name).resolve()
        self.identity = 'studio-lab-7'
        self.own = self.home / '.specwithcode' / self.identity
        self.state = self.own / 'userdata'
        self.state.mkdir(parents=True)
        self.receipt = self.make_receipt(self.identity)

    def make_receipt(self, identity, policy='worker-relay'):
        own = self.home / '.specwithcode' / identity
        value = {'identity': identity, 'uid': 502, 'user': 'fixture-user', 'studioHome': str(own),
                 'stateDir': str(own / 'userdata'), 'host': '127.0.0.1', 'port': 24319,
                 'cliWrapper': str(descriptor.cli_paths(self.home, identity)[0]),
                 'archiveSha256': 'a' * 64,
                 'release': str(self.home / '.specwithcode/install/releases' / ('a' * 20)),
                 'service': {'installed': True, 'label': 'com.specweave.studio.' + identity, 'domain': 'gui/502'}}
        if identity not in descriptor.LEGACY_POLICIES:
            value['webSessionPolicy'] = policy
        return value

    def test_safe_generic_id_actual_uid_502_spaced_home_and_receipt_port(self):
        with simulated_owner(self.home):
            value = descriptor.InstallationDescriptor.from_receipt(self.identity, self.receipt)
        self.assertEqual((value.uid, value.home, value.port, value.domain), (502, self.home, 24319, 'gui/502'))
        self.assertEqual(value.policy, 'worker-relay')

    def test_unsafe_and_reserved_ids_cannot_form_a_service_path(self):
        for identity in ('', '.', '..', '../m4', '/m4', 'a/b', 'a\\b', 'a\n', 'M4', 'á', '-host', 'host-', 'a' * 65, 'stage', 'backups'):
            with self.subTest(identity=identity), self.assertRaises(AssertionError):
                descriptor.validate_identity(identity)
        self.assertEqual(descriptor.validate_identity('a' * 64), 'a' * 64)

    def test_root_effective_uid_and_environment_home_do_not_choose_owner(self):
        with simulated_owner(self.home):
            for value in (0, 501):
                with mock.patch.object(descriptor.os, 'geteuid', return_value=value), self.assertRaises(AssertionError):
                    descriptor.current_owner()
            with mock.patch.object(descriptor.os, 'getuid', return_value=0), self.assertRaises(AssertionError):
                descriptor.current_owner()
            elsewhere = self.home / 'other'; elsewhere.mkdir()
            with self.assertRaises(AssertionError): descriptor.current_owner(elsewhere)
            self.assertEqual(descriptor.current_owner(elsewhere, staging=True)['home'], elsewhere)

    def test_private_stage_never_becomes_a_service_or_receipt_update_target(self):
        with simulated_owner(self.home):
            self.assertEqual(descriptor.InstallationDescriptor('stage', staging=True).identity, 'stage')
            for method in (lambda: descriptor.InstallationDescriptor('stage'),
                           lambda: descriptor.InstallationDescriptor.from_receipt('stage', self.make_receipt('stage')),
                           lambda: descriptor.InstallationDescriptor('generic', staging=True)):
                with self.assertRaises(AssertionError): method()

    def test_foreign_owner_or_aliased_components_fail_before_receipt_use(self):
        target = self.own / 'installation.json'; target.write_text('{}')
        with simulated_owner(self.home, foreign=target), self.assertRaisesRegex(AssertionError, 'another OS user'):
            descriptor.InstallationDescriptor(self.identity, policy='worker-relay')
        alias = self.home / 'alias'; alias.symlink_to(self.own, target_is_directory=True)
        with simulated_owner(self.home):
            for path in (alias / 'userdata', self.home / '..' / 'other', self.home.parent / 'outside'):
                with self.assertRaises(AssertionError): descriptor.owned_path(path, self.home, 502)
            with self.assertRaises(AssertionError): descriptor.current_owner(alias)

    def test_owner_service_paths_host_and_port_are_bound_not_receipt_authority(self):
        mutations = [('uid', 501), ('uid', True), ('user', 'foreign'), ('identity', 'other'),
                     ('studioHome', str(self.home)), ('stateDir', str(self.home)), ('cliWrapper', None),
                     ('release', str(self.home / 'elsewhere')), ('host', '0.0.0.0'), ('port', True), ('port', 1023), ('port', 65536),
                     ('service', {'installed': True, 'label': 'com.specweave.studio.other', 'domain': 'gui/502'}),
                     ('service', {'installed': True, 'label': 'com.specweave.studio.' + self.identity, 'domain': 'gui/501'}),
                     ('service', {'installed': False, 'label': 'com.specweave.studio.' + self.identity, 'domain': 'gui/502'})]
        with simulated_owner(self.home):
            for key, value in mutations:
                with self.subTest(key=key, value=value), self.assertRaises(AssertionError):
                    descriptor.InstallationDescriptor.from_receipt(self.identity, {**self.receipt, key: value})

    def test_legacy_receipts_need_no_policy_field_and_are_never_rewritten(self):
        with simulated_owner(self.home):
            for identity, policy in descriptor.LEGACY_POLICIES.items():
                receipt = self.make_receipt(identity); original = copy.deepcopy(receipt)
                self.assertEqual(descriptor.InstallationDescriptor.from_receipt(identity, receipt).policy, policy)
                self.assertEqual(receipt, original)
                opposite = 'worker-relay' if policy == 'browser-cookie' else 'browser-cookie'
                with self.assertRaises(AssertionError):
                    descriptor.InstallationDescriptor.from_receipt(identity, {**receipt, 'webSessionPolicy': opposite})

    def test_generic_service_requires_explicit_supported_policy(self):
        with simulated_owner(self.home):
            for policy in (None, '', 'both', 'cookie', True):
                with self.subTest(policy=policy), self.assertRaises(AssertionError):
                    descriptor.InstallationDescriptor.from_receipt(self.identity, {**self.receipt, 'webSessionPolicy': policy})
            for policy in descriptor.WEB_SESSION_POLICIES:
                self.assertEqual(descriptor.InstallationDescriptor.from_receipt(self.identity, {**self.receipt, 'webSessionPolicy': policy}).policy, policy)

    def service_fixture(self):
        self.node = self.home / 'node22'; self.node.write_text('fixture')
        release = pathlib.Path(self.receipt['release']); release.mkdir(parents=True)
        self.receipt.update(node=str(self.node), sourceCommit='b' * 40, version='1.0.18')
        self.launcher = self.own / 'launch.sh'
        prefix = ['/usr/bin/env', '-i', 'HOME=' + str(self.home), 'PATH=' + runtime_path(self.home, self.node), 'USER=fixture-user', 'LOGNAME=fixture-user',
                  'STUDIO_HOME=' + str(self.own), 'STUDIO_PORT=24319', 'STUDIO_HOST=127.0.0.1',
                  'STUDIO_MODE=web', 'STUDIO_NO_BROWSER=true', 'STUDIO_ENABLE_HOSTED_SERVICES=false',
                  str(self.node), str(release / 'bin.mjs')]
        argv = prefix + ['start', '--no-browser', '--host', '127.0.0.1', '--port', '24319', '--base-dir', str(self.own), '--mode', 'web']
        self.launcher.write_text('#!/bin/sh\nset -eu\numask 077\ncd ' + shlex.quote(str(self.own)) + '\nexec ' + shlex.join(argv) + '\n')
        wrapper = pathlib.Path(self.receipt['cliWrapper']); wrapper.parent.mkdir(parents=True); wrapper.write_text(render_cli(prefix))
        self.plist = self.home / 'Library/LaunchAgents' / ('com.specweave.studio.' + self.identity + '.plist')
        self.plist.parent.mkdir(parents=True)
        self.plist.write_bytes(plistlib.dumps({'Label': self.receipt['service']['label'],
            'ProgramArguments': ['/usr/bin/caffeinate', '-s', str(self.launcher)], 'WorkingDirectory': str(self.own),
            'StandardOutPath': str(self.own / 'stdout.log'), 'StandardErrorPath': str(self.own / 'stderr.log')}))
        (self.own / 'installation.json').write_text(json.dumps(self.receipt))
        self.runtime = self.state / 'server-runtime.json'
        self.runtime.write_text(json.dumps({'pid': 100, 'host': '127.0.0.1', 'port': 24319}))

    @contextlib.contextmanager
    def service_transport(self, listener=100):
        def run(command, **kwargs):
            if command == [str(self.node), '--version']: return b'v22.20.0'
            if command == ['/bin/launchctl', 'print', 'gui/502/com.specweave.studio.' + self.identity]:
                return 'path = ' + str(self.plist) + '\n state = running\n pid = 100\n'
            if command[0] == '/bin/ps': return str(self.node) + ' ' + self.receipt['release'] + '/bin.mjs'
            self.fail('Unexpected service transport')
        with simulated_owner(self.home), mock.patch.object(update, 'run', side_effect=run), \
             mock.patch.object(update, 'release_verified', return_value={'product': 'SpecWeave Studio', 'sourceCommit': 'b' * 40}), \
             mock.patch.object(update, 'listeners', side_effect=lambda port: [listener] if port == 24319 else []):
            yield

    def test_service_binds_generic_identity_uid_port_launcher_runtime_and_listener(self):
        self.service_fixture()
        with self.service_transport():
            value = update._service(self.identity)
            self.assertEqual((value['owner'].uid, value['owner'].port), (502, 24319))
            self.assertEqual(update_agent.load_installation(self.home, self.identity)['identity'], self.identity)
        with self.service_transport(listener=200), self.assertRaises(AssertionError): update._service(self.identity)
        for path, changed in [(self.runtime, json.dumps({'pid': 100, 'host': '127.0.0.1', 'port': 8319})),
                              (self.launcher, self.launcher.read_text().replace('STUDIO_PORT=24319', 'STUDIO_PORT=8319'))]:
            original = path.read_text(); path.write_text(changed)
            with self.service_transport(), self.assertRaises(AssertionError): update._service(self.identity)
            path.write_text(original)

    def test_optional_foreign_alias_does_not_become_an_owned_service_path(self):
        self.service_fixture()
        alias = descriptor.cli_paths(self.home, self.identity)[1]
        foreign = self.home / 'another-tool'; foreign.write_bytes(b'foreign tool')
        alias.symlink_to(foreign)
        with self.service_transport():
            self.assertEqual(update._service(self.identity)['owner'].alias, alias)
        self.assertTrue(alias.is_symlink()); self.assertEqual(foreign.read_bytes(), b'foreign tool')

    def test_prestate_policy_and_port_cannot_drift(self):
        base = {'identity': self.identity, 'uid': 502, 'serviceLabel': 'label', 'servicePid': 100,
                'archiveSha256': 'a', 'artifactSourceCommit': 'b', 'fileHashes': {}, 'rows': {'nativeWorkIdle': True},
                'otherListenersOwned': False, 'cookieName': 'cookie', 'processQuiescence': {},
                'port': 24319, 'webSessionPolicy': 'worker-relay'}
        with mock.patch.object(update, 'quiescence_core', side_effect=lambda value: value):
            for key, value in [('port', 8319), ('webSessionPolicy', 'browser-cookie')]:
                with self.assertRaisesRegex(AssertionError, key): update.assert_prestate(base, {**base, key: value})


class GenericAgent(unittest.TestCase):
    def test_invalid_home_or_receipt_refuses_before_agent_creates_state(self):
        case = InstallationIdentity('runTest'); case.setUp(); self.addCleanup(case.doCleanups)
        (case.own / 'installation.json').write_text(json.dumps(case.receipt))
        before = {str(p): p.read_bytes() for p in case.home.rglob('*') if p.is_file()}
        with simulated_owner(case.home), mock.patch.object(update_agent, 'launchctl') as transport:
            invalid = dict(case.receipt, uid=501)
            (case.own / 'installation.json').write_text(json.dumps(invalid))
            unchanged = {str(p): p.read_bytes() for p in case.home.rglob('*') if p.is_file()}
            with self.assertRaises(update_agent.AgentError):
                update_agent.run_once(case.home, case.identity, True, lambda line: None)
            self.assertEqual({str(p): p.read_bytes() for p in case.home.rglob('*') if p.is_file()}, unchanged)
            self.assertFalse((case.own / 'updates').exists()); transport.assert_not_called()
            with mock.patch.object(descriptor.pwd, 'getpwuid', return_value=types.SimpleNamespace(pw_name='fixture-user', pw_dir=str(case.home.parent))), self.assertRaises(update_agent.AgentError):
                update_agent.run_once(case.home, case.identity, True, lambda line: None)
            self.assertFalse((case.own / 'updates').exists())

    def test_explicit_removal_works_without_product_receipt_but_rejects_foreign_job(self):
        case = InstallationIdentity('runTest'); case.setUp(); self.addCleanup(case.doCleanups)
        label = 'com.specweave.studio.' + case.identity + '.updater'
        plist = case.home / 'Library/LaunchAgents' / (label + '.plist'); plist.parent.mkdir(parents=True)
        updates = case.own / 'updates'; updates.mkdir()
        content = {'Label': label, 'ProgramArguments': ['/usr/bin/python3', str(case.home / '.specwithcode/install/updater/update_agent.py'), '--identity', case.identity],
                   'WorkingDirectory': str(updates), 'StandardOutPath': str(updates / 'agent.log'), 'StandardErrorPath': str(updates / 'agent.log')}
        plist.write_bytes(plistlib.dumps({**content, 'Label': 'foreign'}))
        with simulated_owner(case.home), mock.patch.object(update_agent, 'launchctl', return_value=0) as transport:
            with self.assertRaises(update_agent.AgentError): update_agent.uninstall_launch_agent(case.home, case.identity, lambda line: None)
            transport.assert_not_called(); self.assertTrue(plist.exists())
            plist.write_bytes(plistlib.dumps(content))
            self.assertEqual(update_agent.uninstall_launch_agent(case.home, case.identity, lambda line: None), 0)
            transport.assert_called_once_with(['bootout', 'gui/502/' + label]); self.assertFalse(plist.exists())


class GenericQuiescence(unittest.TestCase):
    def test_uid502_stays_bound_across_two_samples_and_foreign_owner_refuses(self):
        fixture = load('generic_quiescence_fixture', 'test-quiescence.py')
        values = fixture.fixture()
        for pid in (100, 101): values[pid]['uid'] = 502
        def capture(first, second):
            samples = iter([first, second])
            return quiescence.capture_quiescence(100, 502, fixture.NODE, fixture.ARGS,
                process_reader=lambda: next(samples), argv_reader=lambda pid: fixture.ARGS)
        self.assertEqual(capture(values, copy.deepcopy(values))['root']['uid'], 502)
        for pid in (100, 101):
            other = copy.deepcopy(values); other[pid]['uid'] = 501
            with self.assertRaises(AssertionError): capture(other, other)
            with self.assertRaises(AssertionError): capture(values, other)


class GenericHeartbeat(unittest.TestCase):
    def fixture(self, policy, web=1, desktop=0):
        columns = ['session_id', 'method', 'client_surface', 'issued_at', 'expires_at', 'last_connected_at', 'revoked_at', 'credential']
        method = heartbeat.session_policy('lab', policy)[0]
        old = {'schema': ['unchanged-schema'], 'columns': columns, 'rows': []}
        for index in range(web + desktop):
            old['rows'].append(['session-' + str(index), method if index < web else 'dpop-access-token',
                'web' if index < web else 'desktop', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z',
                '2026-10-08T09:00:00Z', None, b'private-credential'])
        current = copy.deepcopy(old)
        for row in current['rows']: row[5] = '2026-10-08T10:00:01Z'
        proof = lambda rows: {'nativeWorkIdle': True, 'counts': {'auth_sessions': len(rows)}, 'hashes': {'auth_sessions': heartbeat.rows_hash(rows)}}
        return proof(old['rows']), proof(current['rows']), old, current

    def prove(self, policy, web=1, desktop=0, identity='lab'):
        before, after, old, current = self.fixture(policy, web, desktop)
        witness = heartbeat.prove_restart_heartbeat(before, after, old, current,
            '2026-10-08T10:00:00Z', '2026-10-08T10:00:02Z', identity=identity, web_session_policy=policy)
        self.assertEqual(heartbeat.verify_restart_witness(before, after, witness, current, identity=identity, web_session_policy=policy), witness)
        return before, after, current, witness

    def test_policy_counts_and_desktop_limit_are_preserved(self):
        for policy, limit in [('browser-cookie', 2), ('worker-relay', 1)]:
            for web in range(1, limit + 1):
                _, _, _, witness = self.prove(policy, web, 4)
                self.assertEqual((witness['schemaVersion'], witness['serviceIdentity'], witness['webSessionPolicy']), (4, 'lab', policy))
            for web, desktop in ((limit + 1, 0), (1, 5)):
                with self.assertRaises(AssertionError): self.prove(policy, web, desktop)

    def test_identity_policy_substitution_and_missing_policy_fail_even_for_unchanged_rows(self):
        before, after, current, witness = self.prove('browser-cookie')
        for identity, policy in [('other', 'browser-cookie'), ('lab', 'worker-relay'), ('lab', None)]:
            with self.assertRaises(AssertionError):
                heartbeat.verify_restart_witness(before, after, witness, current, identity=identity, web_session_policy=policy)
        for policy in (None, 'both'):
            with self.assertRaises(AssertionError):
                heartbeat.prove_restart_heartbeat(after, after, current, current, '', '', identity='lab', web_session_policy=policy)
        _, _, old, current = self.fixture('worker-relay')
        with self.assertRaises(AssertionError):
            heartbeat.prove_restart_heartbeat(before, after, old, current, '2026-10-08T10:00:00Z', '2026-10-08T10:00:02Z', identity='lab', web_session_policy='browser-cookie')

    def test_explicit_legacy_policies_preserve_exact_witness_shapes(self):
        for identity, policy in descriptor.LEGACY_POLICIES.items():
            for web, desktop in [(1, 0), (1, 1)] + ([(2, 0)] if identity == 'm4' else []):
                before, after, old, current = self.fixture(policy, web, desktop)
                args = (before, after, old, current, '2026-10-08T10:00:00Z', '2026-10-08T10:00:02Z')
                implicit = heartbeat.prove_restart_heartbeat(*args, identity=identity)
                explicit = heartbeat.prove_restart_heartbeat(*args, identity=identity, web_session_policy=policy)
                self.assertEqual(implicit, explicit)
                self.assertNotIn('webSessionPolicy', implicit)


class GenericUpdate(unittest.TestCase):
    def harness(self, policy='browser-cookie'):
        # Reuse the established rollback harness with only installation constants changed.
        # The actual updater, guards and proof functions execute without rewrites.
        module = load('generic_update_fixture', 'test-update.py')
        tree = ast.parse((HERE / 'test-update.py').read_text())
        fixture = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'ApplyRecovery')
        class Constants(ast.NodeTransformer):
            def visit_Constant(self, node):
                if isinstance(node.value, str):
                    node.value = node.value.replace('m4', 'studio-lab-7')
                elif type(node.value) is int and node.value in (501, 8319):
                    node.value = {501: 502, 8319: 24319}[node.value]
                return node
        namespace = dict(vars(module))
        exec(compile(ast.fix_missing_locations(ast.Module(body=[Constants().visit(fixture)], type_ignores=[])), '<generic-fixture>', 'exec'), namespace)
        case = namespace['ApplyRecovery']('runTest'); case.setUp()
        self.addCleanup(case.tearDown)
        old_wrapper = case.wrapper
        case.wrapper = descriptor.cli_paths(case.home, 'studio-lab-7')[0]
        old_wrapper.rename(case.wrapper); case.original[case.wrapper] = case.original.pop(old_wrapper)
        receipt_path = case.own / 'installation.json'
        receipt = json.loads(receipt_path.read_text()); receipt.update(port=24319, webSessionPolicy=policy)
        receipt_path.write_text(json.dumps(receipt)); case.original[receipt_path] = receipt_path.read_bytes()
        case.before.update(port=24319, webSessionPolicy=policy)
        self.commands, self.stop_ports = [], []
        original_run, original_stop = case.transport, case.wait_for_stopped
        def run(command, **kwargs):
            self.commands.append(list(command))
            return original_run(command, **kwargs)
        def stop(pid, *, port):
            self.stop_ports.append(port); return original_stop(pid, port=port)
        case.transport, case.wait_for_stopped = run, stop
        return case

    def test_generic_success_retains_uid_policy_and_exact_restart_domain(self):
        case = self.harness(); case.execute()
        result = json.loads(case.output.read_text())
        self.assertEqual(result['phase'], 'verified')
        self.assertEqual((result['after']['uid'], result['after']['port'], result['after']['webSessionPolicy']), (502, 24319, 'browser-cookie'))
        # The restart unloads this job (its copy is taken then) and loads it again, in its own domain.
        self.assertEqual(case.restart_calls, [['/bin/launchctl', 'bootstrap', 'gui/502', str(case.plist)]])
        self.assertIn(['/bin/launchctl', 'bootout', 'gui/502/com.specweave.studio.studio-lab-7'], self.commands)
        self.assertEqual(self.stop_ports, [24319])
        self.assertEqual(case.quiescence_checks, [case.before['processQuiescence']])

    def test_generic_rollback_preserves_owner_domain_port_and_previous_bytes(self):
        case = self.harness(); case.after_mutation = lambda after: after.update(archiveSha256='foreign-artifact')
        with self.assertRaises(AssertionError): case.execute()
        result = json.loads(case.output.read_text())
        self.assertEqual(result['rollback'], 'restored-runtime-pointers-and-state')
        self.assertEqual(self.stop_ports, [24319, 24319])  # The restart's stop, then the rollback's.
        self.assertIn(['/bin/launchctl', 'bootout', 'gui/502/com.specweave.studio.studio-lab-7'], self.commands)
        self.assertIn(['/bin/launchctl', 'bootstrap', 'gui/502', str(case.plist)], self.commands)
        self.assertTrue(all(path.read_bytes() == value for path, value in case.original.items()))

    def test_generic_active_work_still_refuses_rollback_stop(self):
        case = self.harness(); case.scenario = 'rollback-child'
        case.after_mutation = lambda after: after.update(archiveSha256='foreign-artifact')
        with self.assertRaises(AssertionError): case.execute()
        self.assertEqual(json.loads(case.output.read_text())['rollback'], 'held-new-release-rollback-checks-failed')
        # Only the restart's own stop and start: the rollback never stops the busy new release.
        self.assertEqual(case.launchd, ['bootout', 'bootstrap']); self.assertEqual(case.stops, [100])

    def test_generic_migration_and_normal_heartbeat_receive_authorized_policy(self):
        for migrations in (False, True):
            with self.subTest(migrations=migrations):
                case = self.harness(); case.prepare_heartbeat(); case.execute(True, migrations)
                result = json.loads(case.output.read_text())
                self.assertEqual(result['authHeartbeatWitness']['schemaVersion'], 4)
                self.assertEqual(result['authHeartbeatWitness']['webSessionPolicy'], 'browser-cookie')
                self.assertEqual(len(case.restart_calls), 1)


class GenericDatabase(unittest.TestCase):
    def test_saved_proof_roundtrip_requires_bound_policy_and_explicit_heartbeat_opt_in(self):
        module = load('generic_database_fixture', 'test-database-continuity.py')
        case = module.SavedProofRecompute('runTest'); case.setUp(); self.addCleanup(case.doCleanups)
        before, original = case.snapshot(auth=True)
        case.fixture.advance(); after, current = case.snapshot(auth=True)
        for value in (before, after): value.update(identity='lab', webSessionPolicy='worker-relay')
        witness = heartbeat.prove_restart_heartbeat(before['rows'], after['rows'], original, current,
            module.START, module.END, identity='lab', web_session_policy='worker-relay')
        report = case.report(before, after, 'verified-existing-browser-heartbeat', witness)
        result = continuity.verify_update_database(report, after, case.state,
            allow_existing_browser_heartbeat=True, web_session_policy='worker-relay')
        self.assertEqual(result['authHeartbeatWitness'], witness)
        for kwargs in ({}, {'web_session_policy': 'worker-relay'},
                       {'web_session_policy': 'browser-cookie', 'allow_existing_browser_heartbeat': True}):
            with self.assertRaises(AssertionError): continuity.verify_update_database(report, after, case.state, **kwargs)
        for key, value in [('identity', 'other'), ('webSessionPolicy', 'browser-cookie')]:
            forged = copy.deepcopy(after); forged[key] = value
            with self.assertRaises(AssertionError):
                continuity.verify_update_database(report, forged, case.state,
                    allow_existing_browser_heartbeat=True, web_session_policy='worker-relay')

    def test_generic_migration_witness_replay_uses_policy(self):
        fixture = GenericHeartbeat('runTest')
        before, after, old, current = fixture.fixture('browser-cookie')
        for value in (before, after): value.update(projectIds=['project'], threadIds=['thread'])
        witness = update.prove_migration_preserved(before, after, old, current,
            '2026-10-08T10:00:00Z', '2026-10-08T10:00:02Z', identity='lab',
            allow_existing_browser_heartbeat=True, web_session_policy='browser-cookie')
        self.assertEqual(update.verify_migration_heartbeat_witness(before, after, witness, current,
            identity='lab', web_session_policy='browser-cookie'), witness)
        with self.assertRaises(AssertionError):
            update.verify_migration_heartbeat_witness(before, after, witness, current,
                identity='lab', web_session_policy='worker-relay')


class GenericInstaller(unittest.TestCase):
    def harness(self):
        module = load('generic_install_fixture', 'test-install.py')
        case = module.InstallerIntegrityTests('runTest'); case.setUp(); self.addCleanup(case.tearDown)
        return case

    def test_new_service_requires_policy_before_any_write_and_records_selected_policy(self):
        case = self.harness(); digest = case.bundle(); inventory = case.inventory(case.home)
        missing = case.install(digest, ('--identity', 'lab', '--service', '--install-cli'), mock_service=True)
        self.assertNotEqual(missing.returncode, 0); self.assertEqual(case.inventory(case.home), inventory)
        self.assertNotIn('MOCK_LAUNCHCTL:', missing.stderr)
        result = case.install(digest, ('--identity', 'lab', '--service', '--install-cli', '--web-session-policy', 'worker-relay'), mock_service=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertEqual((receipt['identity'], receipt['webSessionPolicy']), ('lab', 'worker-relay'))
        self.assertEqual(receipt['service']['domain'], 'gui/' + str(os.getuid()))

    def test_two_generic_services_keep_distinct_ports_wrappers_and_aliases(self):
        case = self.harness(); digest = case.bundle()
        first = case.install(digest, ('--identity', 'lab-one', '--service', '--install-cli', '--web-session-policy', 'worker-relay'), mock_service=True)
        self.assertEqual(first.returncode, 0, first.stderr)
        first_receipt = json.loads(first.stdout)
        first_bytes = {p: p.read_bytes() for p in descriptor.cli_paths(case.home, 'lab-one')}
        second = case.install(digest, ('--identity', 'lab-two', '--port', '19321', '--service', '--install-cli', '--web-session-policy', 'browser-cookie'), mock_service=True)
        self.assertEqual(second.returncode, 0, second.stderr)
        second_receipt = json.loads(second.stdout)
        self.assertNotEqual(first_receipt['cliWrapper'], second_receipt['cliWrapper'])
        self.assertNotEqual(first_receipt['port'], second_receipt['port'])
        self.assertTrue(all(path.read_bytes() == data for path, data in first_bytes.items()))
        self.assertFalse((case.home / '.local/bin/specweave-studio').exists())
        self.assertFalse((case.home / '.local/bin/specwithcode').exists())

    def test_stage_with_service_is_rejected_before_any_write_or_transport(self):
        case = self.harness(); digest = case.bundle(); inventory = case.inventory(case.home)
        result = case.install(digest, ('--identity', 'stage', '--service'), mock_service=True)
        self.assertNotEqual(result.returncode, 0); self.assertEqual(case.inventory(case.home), inventory)
        self.assertNotIn('MOCK_LAUNCHCTL:', result.stderr)


class SharedInstallationStore(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='studio-shared-store-')
        self.addCleanup(temporary.cleanup)
        self.home = pathlib.Path(temporary.name).resolve()
        (self.home / '.specwithcode/install').mkdir(parents=True)

    def test_another_installation_apply_refuses_before_snapshot_or_prune(self):
        with descriptor.installation_lock(self.home), mock.patch.object(update, 'current_owner', return_value={'home': self.home}), mock.patch.object(update, '_apply') as guarded:
            with self.assertRaisesRegex(AssertionError, 'Another installation operation'):
                update.apply('lab-two', {'webSessionPolicy': 'worker-relay'}, self.home / 'archive', 'a' * 64, self.home / 'result')
            guarded.assert_not_called()
        # The held operation exited; a later invocation can proceed and re-read prestate.
        with descriptor.installation_lock(self.home): pass

    def test_lock_spans_the_whole_apply_and_releases_after_failure(self):
        def guarded(*args, **kwargs):
            with self.assertRaisesRegex(AssertionError, 'Another installation operation'):
                with descriptor.installation_lock(self.home): self.fail('Overlapping guarded update')
            raise AssertionError('synthetic rollback finished')
        with mock.patch.object(update, 'current_owner', return_value={'home': self.home}), mock.patch.object(update, '_apply', side_effect=guarded):
            with self.assertRaisesRegex(AssertionError, 'synthetic rollback finished'):
                update.apply('lab', {'webSessionPolicy': 'worker-relay'}, self.home / 'archive', 'a' * 64, self.home / 'result')
        with descriptor.installation_lock(self.home): pass

    def test_fresh_installer_cannot_publish_or_bootstrap_during_an_update(self):
        module = load('shared_store_installer', 'test-install.py')
        case = module.InstallerIntegrityTests('runTest'); case.setUp(); self.addCleanup(case.tearDown)
        digest = case.bundle()
        with descriptor.installation_lock(case.home, create=True):
            result = case.install(digest, ('--identity', 'lab', '--service', '--install-cli', '--web-session-policy', 'worker-relay'), mock_service=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Another installation operation', result.stderr)
        self.assertNotIn('MOCK_LAUNCHCTL:bootstrap', result.stderr)
        self.assertFalse((case.home / '.specwithcode/lab').exists())
        self.assertFalse((case.home / '.specwithcode/install/releases').exists())

    def release(self, path):
        path.mkdir(parents=True)
        binary = b'verified synthetic runtime'
        (path / 'bin.mjs').write_bytes(binary)
        (path / 'studio-manifest.json').write_text(json.dumps({'product': 'SpecWeave Studio', 'version': '0.1.0',
            'sourceCommit': 'fixture', 'files': [{'path': 'bin.mjs', 'type': 'file', 'sha256': update.digest(binary)}]}))

    def test_atomic_publication_reverifies_a_racing_winner_without_nesting(self):
        staged, destination = self.home / 'staged', self.home / 'published'
        self.release(staged)
        original_rename = pathlib.Path.rename
        def racing_rename(path, target):
            shutil.copytree(path, target)
            return original_rename(path, target)
        with mock.patch.object(pathlib.Path, 'rename', racing_rename):
            update.publish_release(staged, destination)
        self.assertEqual(update.release_verified(staged), update.release_verified(destination))
        self.assertEqual(sorted(path.name for path in destination.iterdir()), ['bin.mjs', 'studio-manifest.json'])

    def test_backups_are_unique_for_two_services_on_same_commit_and_second(self):
        class Clock(datetime.datetime):
            @classmethod
            def now(cls, tz=None): return cls(2026, 10, 14, 12, 0, 0, tzinfo=tz)
        backups = []
        for identity in ('lab-one', 'lab-two'):
            own = self.home / '.specwithcode' / identity; (own / 'userdata').mkdir(parents=True)
            with sqlite3.connect(own / 'userdata/statev2.sqlite') as db:
                db.execute('CREATE TABLE protected(value TEXT)'); db.execute('INSERT INTO protected VALUES (?)', (identity,))
            with mock.patch.object(pathlib.Path, 'home', return_value=self.home), mock.patch.object(update.datetime, 'datetime', Clock):
                backup = update.backup_state(own, 'a' * 40)
            with sqlite3.connect(backup) as db:
                self.assertEqual(db.execute('SELECT value FROM protected').fetchone()[0], identity)
            backups.append(backup)
        self.assertNotEqual(backups[0], backups[1])


if __name__ == '__main__':
    unittest.main()
