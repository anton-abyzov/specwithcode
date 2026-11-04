#!/usr/bin/env python3
"""Writes fixture-runs.json: two release runs recorded by scripts/release/run_record.py itself, with
fixed times. A finished 1.0.189 run, and a 1.0.190 run held in fleet: M4 verified on canary, M1
verified, M3 not updated (busy), an optional machine without a route. Synthetic data only."""
import importlib.util
import json
import pathlib
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('run_record', HERE / '../../../../scripts/release/run_record.py')
rr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rr)
STEPS = ('preflight trees prev bump candidate stage1 build bundle sign verify helpers plan drafts server-wait '
         'quit-desktop publish-private publish-public fleet-m4 desktop fleet-workers merge fleet-linux server').split()


def at(minutes):
    return '2026-11-04T%02d:%02d:%02dZ' % (13 + minutes // 60, minutes % 60, 7)


def run(directory, version, run_id, upto):
    path = rr.init(directory, version, run_id=run_id, steps=STEPS, previous=('1.0.%d' % (int(version[-3:]) - 1)),
                   sha=('a1b2c3d4e5f6' * 4)[:40], channel='candidate',
                   at=at(0))
    clock = 0
    for name, minutes in upto:
        rr.step(path, name, 'running', log='release-staging/%s/logs/%s.log' % (version, name), at=at(clock))
        if minutes is None:
            return path
        clock += minutes
        rr.step(path, name, 'passed', at=at(clock))
    return path


with tempfile.TemporaryDirectory() as temp:
    done = run(temp, '1.0.189', 'f00dfeed0189', [(name, 3) for name in STEPS])
    rr.host(done, 'm4', 'verified', role='canary', required=True, source='1.0.188', at=at(60))
    for name in ('m1', 'm3'):
        rr.host(done, name, 'verified', role='fleet', required=True, source='1.0.188', at=at(66))
    rr.finish(done, 'done', at=at(72))
    order = [('preflight', 2), ('trees', 1), ('prev', 1), ('bump', 1), ('candidate', 1), ('stage1', 9),
             ('build', 6), ('bundle', 2), ('sign', 4), ('verify', 3), ('helpers', 2), ('plan', 1), ('drafts', 1),
             ('server-wait', 2), ('quit-desktop', 1), ('publish-private', 2), ('publish-public', 2), ('fleet-m4', 8),
             ('desktop', 2), ('fleet-workers', None)]
    live = run(temp, '1.0.190', 'c0ffee000190', order)
    for shard in range(1, 9):
        rr.step(live, 'server', 'passed', shard=shard, at=at(12))
    rr.step(live, 'server', 'passed', log='release-staging/1.0.190/logs/server.log', at=at(14))
    rr.step(live, 'preflight', 'passed', facts={'disk': {'m4': {'freeGiB': 123, 'needGiB': 41}}}, at=at(2))
    rr.host(live, 'm4', 'asked', role='canary', required=True, source='1.0.189', at=at(46))
    rr.host(live, 'm4', 'acked', at=at(46))
    rr.host(live, 'm4', 'installed', at=at(51))
    rr.host(live, 'm4', 'verified', receipt='updates/receipts/update-1.0.190.json', desktop='swapped', at=at(53))
    rr.host(live, 'm1', 'asked', role='fleet', required=True, source='1.0.189', at=at(56))
    rr.host(live, 'm1', 'acked', at=at(56))
    rr.host(live, 'm1', 'installed', at=at(60))
    rr.host(live, 'm1', 'verified', desktop='swapped', at=at(62))
    rr.host(live, 'm3', 'asked', role='fleet', required=True, source='1.0.189', at=at(56))
    rr.host(live, 'm3', 'acked', at=at(57))
    rr.host(live, 'm3', 'not-updated', reason='busy: 3 windows elapsed (claude, node)', at=at(76))
    rr.host(live, 'annas-macbook-air', 'not-updated', role='fleet', required=False, source='1.0.187',
            reason='no SSH and no Connect address', at=at(56))
    rr.finish(live, 'held', at=at(77))
    runs = [rr.read(live), rr.read(done)]
    for record in runs:  # Writes stamp the real clock; the fixture keeps its own.
        record['updatedAt'] = record['endedAt']
(HERE / 'fixture-runs.json').write_text(json.dumps(runs, indent=2) + '\n')
print('wrote', HERE / 'fixture-runs.json')
