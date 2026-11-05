#!/usr/bin/env python3
"""Release run record checks (increment 1239, AC-21): schema, stage ids and states, per-host rows,
resume keeping prior rows, atomic writes and concurrent writers, and fleet_rollout.py recording each
machine it asks (against its fake fleet). Temporary folders only; no host is contacted."""
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
SCRIPT = HERE / 'run_record.py'
spec = importlib.util.spec_from_file_location('run_record', SCRIPT)
rr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rr)
FLEET = HERE.parent / 'studio-fleet'
# release.sh's step names today (STAGE_NAMES) plus the background server suite.
STEPS = ('preflight trees prev bump candidate stage1 build bundle sign verify helpers plan drafts server-wait '
         'quit-desktop publish-private publish-public fleet-m4 desktop fleet-workers merge fleet-linux server').split()


def cli(*args, stdin=None):
    return subprocess.run([sys.executable, '-B', str(SCRIPT)] + list(args), input=stdin, capture_output=True,
                          text=True, timeout=60)


class RunRecord(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='release-run-record-')
        self.addCleanup(temp.cleanup)
        self.root = pathlib.Path(temp.name).resolve()
        self.runs = self.root / 'updates' / 'runs'
        self.id_file = self.root / 'staging' / 'run-id'
        self.id_file.parent.mkdir()

    def init(self, **fields):
        return rr.init(self.runs, '1.0.190', id_file=self.id_file, steps=STEPS, previous='1.0.189', **fields)

    def stage(self, record, stage_id):
        return next(stage for stage in record['stages'] if stage['id'] == stage_id)

    def test_new_record_has_the_release_schema_and_every_graph_stage(self):
        path = self.init(sha='a' * 40, channel='candidate')
        run_id = self.id_file.read_text().strip()
        self.assertEqual(path, self.runs / ('release-1.0.190-%s.json' % run_id))
        self.assertEqual(oct(path.stat().st_mode & 0o777), '0o600')
        record = json.loads(path.read_text())
        for key in ('schemaVersion', 'kind', 'runId', 'rev', 'version', 'previous', 'channel', 'sha', 'createdAt',
                    'createdBy', 'startedAt', 'updatedAt', 'endedAt', 'state', 'stages', 'hosts'):
            self.assertIn(key, record)
        self.assertEqual((record['schemaVersion'], record['kind'], record['state'], record['channel']),
                         (1, 'release', 'running', 'candidate'))
        self.assertEqual([stage['id'] for stage in record['stages']], list(rr.STAGE_IDS))
        self.assertEqual(self.stage(record, 'publish.candidate')['needs'][-1], 'verify.linux')
        self.assertEqual([step['name'] for step in self.stage(record, 'build.mac')['steps']],
                         ['build', 'bundle', 'sign'])
        self.assertEqual([step['name'] for step in self.stage(record, 'test.server')['steps']], ['server-wait', 'server'])
        for stage in record['stages']:
            self.assertEqual(stage['state'], 'pending')
            for step in stage['steps']:
                self.assertIn(step['name'], STEPS)
        self.assertTrue(record['createdAt'].endswith('Z'))

    def test_step_states_times_and_logs_fold_into_their_stage(self):
        path = self.init()
        rr.step(path, 'build', 'running', log='logs/build.log', attempt=1, at='2026-11-04T10:00:00Z')
        record = rr.read(path)
        build = self.stage(record, 'build.mac')
        self.assertEqual((build['state'], build['startedAt'], build['log']), ('running', '2026-11-04T10:00:00Z',
                                                                              'logs/build.log'))
        for name, end in (('build', '10:05'), ('bundle', '10:06')):
            rr.step(path, name, 'passed', log='logs/%s.log' % name, at='2026-11-04T%s:00Z' % end)
        self.assertEqual(self.stage(rr.read(path), 'build.mac')['state'], 'running')  # sign still to run.
        rr.step(path, 'sign', 'passed', log='logs/sign.log', at='2026-11-04T10:09:00Z')
        build = self.stage(rr.read(path), 'build.mac')
        self.assertEqual((build['state'], build['endedAt']), ('passed', '2026-11-04T10:09:00Z'))
        rr.step(path, 'verify', 'running', log='logs/verify.log')
        rr.step(path, 'verify', 'failed', log='logs/verify.log', facts={'mode': 'upgraded'})
        verify = self.stage(rr.read(path), 'verify.mac')
        self.assertEqual((verify['state'], verify['log'], verify['facts']), ('failed', 'logs/verify.log',
                                                                             {'mode': 'upgraded'}))
        rr.step(path, 'verify', 'running')
        self.assertEqual(self.stage(rr.read(path), 'verify.mac')['steps'][0]['attempt'], 2)
        with self.assertRaises(rr.RecordError):
            rr.step(path, 'verify', 'done')

    def test_a_ci_job_step_is_its_graph_stage_and_shards_are_kept(self):
        path = rr.init(self.runs, '1.0.190', run_id='gh-12345', created_by='release.yml')
        for shard in (3, 1, 2):
            rr.step(path, 'test.server', 'running', shard=shard)
        rr.step(path, 'test.server', 'passed', shard=1)
        stage = self.stage(rr.read(path), 'test.server')
        self.assertEqual(stage['shards'], [{'n': 1, 'state': 'passed'}, {'n': 2, 'state': 'running'},
                                           {'n': 3, 'state': 'running'}])
        self.assertEqual((stage['steps'][0]['state'], stage['steps'][0]['attempt'], stage['state']),
                         ('running', 1, 'running'))
        for shard in (2, 3):  # Every shard passed: still running until the merge says so.
            rr.step(path, 'test.server', 'passed', shard=shard)
        self.assertEqual(self.stage(rr.read(path), 'test.server')['state'], 'running')
        rr.step(path, 'test.server', 'failed', shard=2)
        self.assertEqual(self.stage(rr.read(path), 'test.server')['state'], 'failed')
        rr.step(path, 'test.server', 'running', shard=4)  # A later shard does not hide the failed one.
        rr.step(path, 'test.server', 'passed', shard=4)
        self.assertEqual(self.stage(rr.read(path), 'test.server')['state'], 'failed')
        rr.step(path, 'test.server', 'passed', shard=2)  # Its rerun passed.
        self.assertEqual(self.stage(rr.read(path), 'test.server')['state'], 'running')
        rr.step(path, 'test.server', 'passed')  # The merge.
        stage = self.stage(rr.read(path), 'test.server')
        self.assertEqual((stage['state'], stage['steps'][0]['state']), ('passed', 'passed'))
        rr.step(path, 'windows-extra', 'passed')  # Unknown steps become a stage of their own, never lost.
        self.assertEqual(self.stage(rr.read(path), 'windows-extra')['state'], 'passed')

    def test_the_candidate_channel_publishes_in_finalize_and_new_steps_have_stages(self):
        steps = STEPS + ['publish-candidate', 'canary-soak', 'promote-stable']
        stable = rr.fresh('1.0.190', 'a', steps)
        candidate = rr.fresh('1.0.190', 'b', steps, channel='candidate')
        names = lambda record, stage: [entry['name'] for entry in self.stage(record, stage)['steps']]
        self.assertEqual(names(stable, 'publish.candidate'),
                         ['helpers', 'plan', 'drafts', 'publish-private', 'publish-public', 'publish-candidate'])
        self.assertEqual(names(candidate, 'publish.candidate'), ['helpers', 'plan', 'drafts', 'publish-candidate'])
        self.assertEqual(names(candidate, 'finalize'), ['publish-private', 'publish-public', 'merge',
                                                        'fleet-linux', 'promote-stable'])
        self.assertEqual(names(candidate, 'fleet'), ['fleet-workers'])
        self.assertEqual(names(stable, 'fleet'), ['fleet-workers', 'fleet-linux'])
        self.assertIn('canary-soak', names(candidate, 'canary'))
        self.assertEqual([stage['id'] for stage in candidate['stages']], list(rr.STAGE_IDS))
        self.assertEqual(cli('steps', '--stage', 'finalize', '--channel', 'candidate', '--names',
                             'publish-public merge fleet-linux').stdout.strip(), 'publish-public merge fleet-linux')
        self.assertEqual(cli('steps', '--stage', 'fleet', '--channel', 'candidate', '--names',
                             'fleet-workers merge fleet-linux').stdout.strip(), 'fleet-workers')

    def test_fleet_rollout_records_each_machine_it_asks_and_release_sh_its_verdict(self):
        sys.path.insert(0, str(FLEET))
        self.addCleanup(sys.path.remove, str(FLEET))
        lock = pathlib.Path(tempfile.mkdtemp(prefix='fleet-rollout-lock-')) / 'fleet-rollout.lock'
        with mock.patch.dict(os.environ, {'STUDIO_FLEET_ROLLOUT_LOCK': str(lock)}):
            import fleet_rollout
            import rollout_record
            from rollout_test_fakes import NEW, OLD, Clock, Fleet, quiet
        path = rr.init(self.runs, NEW, run_id='fleet')
        clock = Clock()
        fleet = Fleet(clock, polls={'m4': 2})
        with mock.patch.dict(os.environ, {rollout_record.ENV: str(path)}):
            results = fleet_rollout.rollout(NEW, fleet.hosts(), clock=clock, sleep=clock.sleep, say=quiet, poll=15)
        hosts = {row['identity']: row for row in rr.read(path)['hosts']}
        self.assertEqual(sorted(hosts), ['m1', 'm3', 'm4'])
        self.assertEqual((hosts['m4']['role'], hosts['m1']['role']), ('canary', 'fleet'))
        for row in hosts.values():  # Asked and acknowledged as the rollout went; the verdict is the summary's.
            self.assertEqual((row['state'], row['from'], row['required']), ('acked', OLD, True))
            self.assertTrue(row['askedAt'] and row['ackedAt'])
        for role, names in (('canary', ('m4',)), ('fleet', ('m1', 'm3'))):  # fleet-m4, then fleet-workers
            summary = {'version': NEW, 'result': 'installed', 'hosts': {name: results[name] for name in names}}
            result = cli('rollout', '--file', str(path), '--summary', '-', '--role', role,
                         stdin='fleet_rollout: done\n' + json.dumps(summary) + '\n')
            self.assertEqual(result.returncode, 0, result.stderr)
        hosts = {row['identity']: row for row in rr.read(path)['hosts']}
        self.assertEqual({name: (row['role'], row['state']) for name, row in hosts.items()},
                         {'m4': ('canary', 'verified'), 'm1': ('fleet', 'verified'), 'm3': ('fleet', 'verified')})
        # Outside release.sh there is no record, and a record that cannot be written never fails a rollout.
        self.assertFalse(rollout_record.asked('m1', OLD, True, environ={}))
        errors = []
        stream = type('Stream', (), {'write': lambda _self, text: errors.append(text), 'flush': lambda _self: None})()
        self.assertFalse(rollout_record.asked('m1', OLD, True, environ={rollout_record.ENV: str(self.runs / 'gone.json')},
                                              stderr=stream))
        self.assertIn('run record not written for m1', ''.join(errors))

    def test_a_rollout_of_another_version_writes_no_machine_rows(self):
        # 1.0.192: stage1's fleet suites ran their fake fleet (1.0.40 to 1.0.41) with the record in
        # their environment, and m4, m1 and m3 read "1.0.40 -> 1.0.192", asked at the run's start.
        sys.path.insert(0, str(FLEET))
        self.addCleanup(sys.path.remove, str(FLEET))
        lock = pathlib.Path(tempfile.mkdtemp(prefix='fleet-rollout-lock-')) / 'fleet-rollout.lock'
        with mock.patch.dict(os.environ, {'STUDIO_FLEET_ROLLOUT_LOCK': str(lock)}):
            import fleet_rollout
            import rollout_record
            from rollout_test_fakes import NEW, Clock, Fleet, quiet
        path = rr.init(self.runs, '1.0.192', run_id='real', previous='1.0.191')
        clock = Clock()
        with mock.patch.dict(os.environ, {rollout_record.ENV: str(path)}):
            fleet_rollout.rollout(NEW, Fleet(clock).hosts(), clock=clock, sleep=clock.sleep, say=quiet, poll=15)
        self.assertEqual(rr.read(path)['hosts'], [])
        self.assertFalse(rollout_record.asked('m1', '1.0.40', True, version='1.0.41',
                                              environ={rollout_record.ENV: str(path)}))
        self.assertTrue(rollout_record.asked('m1', '1.0.191', True, version='1.0.192',
                                             environ={rollout_record.ENV: str(path)}))
        row = rr.read(path)['hosts'][0]
        self.assertEqual((row['identity'], row['from'], row['state']), ('m1', '1.0.191', 'acked'))

    def test_release_sh_passes_the_record_to_the_fleet_steps_only(self):
        # Exported to every step, the record reached the test suites stage1 and the server suite run.
        script = HERE / 'release-record.sh'
        probe = ('say() { :; }; MODE=stub STAGING_ROOT="$1" STAGE="$1" VERSION=1.0.192 PREV=1.0.191 '
                 'RECORD_STEPS="preflight stage1 fleet-workers"; . "$2"; record_init; '
                 'printf "%s\\n" "$RUN_RECORD"; env | grep -c "^STUDIO_RELEASE_RUN_RECORD=" || true; '
                 'printf "%s\\n" "$RELEASE_RUN_RECORD_PATH"')
        result = subprocess.run(['bash', '-c', probe, 'probe', str(self.root), str(script)], capture_output=True,
                                text=True, timeout=60, env=dict(os.environ, STUDIO_RELEASE_RUN_RECORD='/inherited'))
        self.assertEqual(result.returncode, 0, result.stderr)
        record, exported, internal = result.stdout.split()
        self.assertTrue(record.endswith('.json') and pathlib.Path(record).is_file(), result.stdout)
        self.assertEqual((exported, internal), ('0', record))
        release = (HERE / 'release.sh').read_text()
        for step in ('fleet-m4', 'fleet-workers'):
            self.assertIn('x %s -C "$BUILD" -- env STUDIO_RELEASE_RUN_RECORD="$RUN_RECORD" python3 -B '
                          'scripts/studio-fleet/fleet_rollout.py' % step, release)

    def test_host_rows_move_forward_and_not_updated_needs_a_reason(self):
        path = self.init()
        rr.host(path, 'm4', 'asked', role='canary', required=True, source='1.0.189', at='2026-11-04T11:00:00Z')
        rr.host(path, 'm4', 'acked', at='2026-11-04T11:00:05Z')
        rr.host(path, 'm4', 'installed', at='2026-11-04T11:04:00Z')
        rr.host(path, 'm4', 'asked', at='2026-11-04T11:05:00Z')  # A late duplicate never moves it back.
        rr.host(path, 'm4', 'verified', receipt='updates/receipts/update-1.0.190.json', at='2026-11-04T11:06:00Z')
        rr.host(path, 'm3', 'asked', role='fleet', required=True)
        with self.assertRaises(rr.RecordError):
            rr.host(path, 'm3', 'not-updated')
        rr.host(path, 'm3', 'not-updated', reason='busy: 3 windows elapsed (claude, node)')
        rr.host(path, 'annas-macbook-air', 'not-updated', role='fleet', required=False,
                reason='no SSH and no Connect address')
        hosts = rr.read(path)['hosts']
        self.assertEqual([row['identity'] for row in hosts], ['m4', 'm3', 'annas-macbook-air'])
        m4, m3, anna = hosts
        self.assertEqual((m4['state'], m4['from'], m4['to'], m4['askedAt'], m4['ackedAt'], m4['verifiedAt']),
                         ('verified', '1.0.189', '1.0.190', '2026-11-04T11:00:00Z', '2026-11-04T11:00:05Z',
                          '2026-11-04T11:06:00Z'))
        self.assertEqual(m4['receipt'], 'updates/receipts/update-1.0.190.json')
        self.assertEqual((m3['state'], m3['reason'], m3['required']), ('not-updated',
                                                                       'busy: 3 windows elapsed (claude, node)', True))
        self.assertFalse(anna['required'])
        rr.host(path, 'm3', 'asked')  # A retry starts again.
        rr.host(path, 'm3', 'verified')
        m3 = rr.read(path)['hosts'][1]
        self.assertEqual((m3['state'], m3['reason']), ('verified', None))
        self.assertIsNotNone(m3['installedAt'])

    def test_rollout_summary_becomes_host_rows(self):
        path = self.init()
        summary = {'version': '1.0.190', 'result': 'partial', 'hosts': {
            'm4': {'identity': 'm4', 'result': 'already-installed', 'requests': 0},
            'm1': {'identity': 'm1', 'result': 'installed', 'requests': 1, 'desktopApp': {'result': 'swapped'}},
            'm3': {'identity': 'm3', 'result': 'not-updated', 'reason': 'unreachable: no route'},
            'ministorm': {'identity': 'ministorm', 'result': 'skipped', 'reason': 'needs SSH'}}}
        output = 'fleet_rollout: not updated: m3\n' + json.dumps(summary) + '\n'
        done = cli('rollout', '--file', str(path), '--summary', '-', '--role', 'fleet', stdin=output)
        self.assertEqual(done.returncode, 0, done.stderr)
        rows = {row['identity']: row for row in rr.read(path)['hosts']}
        self.assertEqual(rows['m1']['state'], 'verified')
        self.assertEqual(rows['m1']['desktop'], 'swapped')
        self.assertEqual(rows['m4']['state'], 'verified')
        self.assertEqual((rows['m3']['state'], rows['m3']['reason'], rows['m3']['required']),
                         ('not-updated', 'unreachable: no route', True))
        self.assertEqual((rows['ministorm']['reason'], rows['ministorm']['required']),
                         ('skipped: needs SSH', False))

    def test_resume_keeps_prior_stage_and_host_rows(self):
        path = self.init()
        rr.step(path, 'preflight', 'passed', log='logs/preflight.log')
        rr.step(path, 'trees', 'passed')
        self.assertEqual(self.stage(rr.read(path), 'resolve')['state'], 'running')  # Between its steps.
        rr.step(path, 'stage1', 'running')
        rr.host(path, 'm4', 'verified', role='canary', required=True)
        rr.finish(path, 'failed')
        stopped = rr.read(path)
        self.assertEqual(self.stage(stopped, 'test.unit')['state'], 'failed')  # Cut off by the stop.
        self.assertEqual(self.stage(stopped, 'resolve')['state'], 'pending')  # Stopped between its steps.
        again = self.init(sha='b' * 40)  # release.sh --resume: the staging folder names the run.
        self.assertEqual(again, path)
        self.assertEqual(len(list(self.runs.glob('release-*.json'))), 1)
        record = rr.read(path)
        self.assertEqual((record['state'], record['endedAt'], record['resumes']), ('running', None, 1))
        self.assertEqual(self.stage(record, 'preflight')['state'], 'passed')
        self.assertEqual(self.stage(record, 'preflight')['log'], 'logs/preflight.log')
        self.assertEqual(self.stage(record, 'resolve')['state'], 'running')
        self.assertEqual(record['hosts'][0]['state'], 'verified')
        self.assertEqual(record['sha'], 'b' * 40)
        self.assertGreater(record['rev'], stopped['rev'])
        rr.step(path, 'stage1', 'passed')
        self.assertEqual(self.stage(rr.read(path), 'test.unit')['state'], 'passed')
        rr.finish(path, 'done')
        self.init()
        self.assertEqual(rr.read(path)['state'], 'done')  # A finished run stays finished.

    def test_writes_are_atomic(self):
        path = self.init()
        before = path.read_bytes()
        with mock.patch.object(rr.os, 'replace', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                rr.step(path, 'preflight', 'passed')
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(sorted(entry.name for entry in self.runs.iterdir()), [path.name, path.name + '.lock'])
        json.loads(path.read_text())

    def test_concurrent_writers_lose_no_rows(self):
        path = self.init()
        rev = rr.read(path)['rev']
        names = ['host-%02d' % index for index in range(12)]
        workers = [subprocess.Popen([sys.executable, '-B', str(SCRIPT), 'host', '--file', str(path), '--identity',
                                     name, '--event', 'asked', '--role', 'fleet'], stderr=subprocess.PIPE)
                   for name in names]
        workers += [subprocess.Popen([sys.executable, '-B', str(SCRIPT), 'step', '--file', str(path), '--name',
                                      'test.server', '--state', 'passed', '--shard', str(n)], stderr=subprocess.PIPE)
                    for n in range(1, 9)]
        for worker in workers:
            self.assertEqual(worker.wait(60), 0, worker.stderr.read())
            worker.stderr.close()
        record = rr.read(path)
        self.assertEqual(sorted(row['identity'] for row in record['hosts']), names)
        self.assertEqual([shard['n'] for shard in self.stage(record, 'test.server')['shards']], list(range(1, 9)))
        self.assertEqual(record['rev'], rev + len(workers))

    def test_cli_init_reuses_the_saved_run_id_and_refuses_bad_input(self):
        first = cli('init', '--dir', str(self.runs), '--version', '1.0.190', '--id-file', str(self.id_file),
                    '--steps', ' '.join(STEPS))
        self.assertEqual(first.returncode, 0, first.stderr)
        second = cli('init', '--dir', str(self.runs), '--version', '1.0.190', '--id-file', str(self.id_file))
        self.assertEqual(second.stdout, first.stdout)
        self.assertNotEqual(cli('init', '--dir', str(self.runs), '--version', '1.0').returncode, 0)
        self.assertNotEqual(cli('init', '--dir', str(self.runs), '--version', '1.0.190', '--run-id', '../x').returncode, 0)
        other = self.runs / 'release-1.0.1-x.json'
        other.write_text('{"kind": "update"}')
        self.assertNotEqual(cli('show', '--file', str(other)).returncode, 0)
        self.assertEqual([record['runId'] for record in rr.runs(self.runs)], [self.id_file.read_text().strip()])


if __name__ == '__main__':
    os.environ.setdefault('PYTHONDONTWRITEBYTECODE', '1')
    unittest.main(verbosity=2)
