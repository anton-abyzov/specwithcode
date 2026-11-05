"""The release run record's machine rows, as fleet_rollout.py asks each machine (increment 1239).

release.sh exports STUDIO_RELEASE_RUN_RECORD, the run's record (scripts/release/run_record.py), to
its canary and fleet steps; a rollout run any other way has none and records nothing. Each request
a machine is sent is recorded as asked, and as acked once the machine answered with it. The verdict
per machine (verified, or not updated with the reason) comes from the rollout's summary, which
release.sh records when the step ends. A record that cannot be written is a warning on stderr,
never a failed rollout.
"""
import importlib.util
import os
import pathlib
import sys

ENV = 'STUDIO_RELEASE_RUN_RECORD'
CANARY = 'm4'  # fleet_rollout.LOCAL: M4 installs first and is the canary.
REQUIRED = ('m4', 'm1', 'm3')  # fleet_rollout.REQUIRED_HOSTS
TOOL = pathlib.Path(__file__).resolve().parent.parent / 'release' / 'run_record.py'

_module = []


def _run_record():
    if not _module:
        spec = importlib.util.spec_from_file_location('run_record', str(TOOL))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _module.append(module)
    return _module[0]


def path(environ=None):
    return (environ if environ is not None else os.environ).get(ENV) or None


def asked(identity, current, acked, required=REQUIRED, environ=None, stderr=None, version=None):
    """One request sent to `identity` (on `current`, the version it runs before the request) for
    `version`: asked, then acked when it answered. A request for another version than the record's
    release is not this run's (a test's fake fleet, a stray rollout) and is not recorded."""
    record = path(environ)
    if not record:
        return False
    try:
        run_record = _run_record()
        if version is not None and run_record.read(record).get('version') != version:
            return False
        role = 'canary' if identity == CANARY else 'fleet'
        run_record.host(record, identity, 'asked', role=role, required=identity in required,
                        source=current or None)
        if acked:
            run_record.host(record, identity, 'acked')
        return True
    except Exception as error:  # noqa: BLE001 - never fail a rollout over its record.
        print('fleet_rollout: run record not written for %s: %s' % (identity, error), file=stderr or sys.stderr)
        return False
