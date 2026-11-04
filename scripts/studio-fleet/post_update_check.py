"""`update.py verify --local`: the post-update check on a SpecWithCode home no installation serves.

A release's verify stage (scripts/release/verify-built-app.mjs) seeds a throwaway home from the
previous release's state, captures it before the new build first starts on it, and checks it
again once the new server has run its migrations and answered:

    python3 -B update.py verify --local --state <base dir> --capture <before.json>
    python3 -B update.py verify --local --state <base dir> --against <before.json> --output <receipt.json>

It applies the comparison update.py's apply makes after a release's restart (update_apply.compare
with project migrations and an existing browser heartbeat allowed), without a service, an
installation or a held request: the protected rows and the complete database capture
(update_read._read_state) may change only as a new release's migrations may change them (every
project and thread survives; history, provider, schedule and pairing rows and every typed cell
stay identical; projections may grow; log and receipt rows the new server appended carry forward
after the earlier rows; an auth session may only record its heartbeat), every user setting
survives (update_compare.settings_preserved) and the environment id is unchanged. The capture
holds the home's private auth cells to prove that heartbeat, so it is written owner-only and
never copied into the receipt. Reads only; nothing here starts, stops or signals a process.
Exit 0 with result verified, or 1 with a REFUSAL line on stderr and result failed in the receipt.
"""
if not __debug__:
    raise RuntimeError('Optimized Python is unsupported for owned-service safety checks')

import argparse
import datetime
import hashlib
import json
import os
import pathlib
import sys

import types

import database_continuity
import settings_continuity
import update_apply
import update_migration
from update_compare import settings_preserved
from update_read import _read_state

SCHEMA_VERSION = 2
IDENTITY = 'local'  # Stands in for a service identity: a desktop home's browser-cookie sessions.
POLICY = 'browser-cookie'
# The names update_apply.compare reads for a release's migration proof (update.py passes its globals).
NAMES = types.SimpleNamespace(continuity=database_continuity, **{name: getattr(update_migration, name) for name in (
    'accepted_widenings', 'narrowed_rows', 'principal_auth', 'prove_migration_preserved',
    'assert_migration_typed_cells', 'assert_migration_protected_schema')})


def _digest(data):
    return hashlib.sha256(data).hexdigest()


def _encode_cells(value):
    """Private auth cells as JSON; a blob keeps its type ({'$bytes': hex})."""
    if isinstance(value, (bytes, bytearray)):
        return {'$bytes': bytes(value).hex()}
    if isinstance(value, (list, tuple)):
        return [_encode_cells(item) for item in value]
    if isinstance(value, dict):
        return {key: _encode_cells(item) for key, item in value.items()}
    return value


def _decode_cells(value):
    if isinstance(value, dict):
        if set(value) == {'$bytes'}:
            return bytes.fromhex(value['$bytes'])
        return {key: _decode_cells(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_decode_cells(item) for item in value]
    return value


def capture(base, since=None):
    """Protected rows, private auth, the complete database capture, the settings proof and the
    file hashes of the home at `base`; with `since` (an earlier capture), also the rows appended
    after it, with tables that gained columns since then measured too."""
    userdata = pathlib.Path(base) / 'userdata'
    database = userdata / 'statev2.sqlite'
    assert database.is_file() and not database.is_symlink(), 'The home has no statev2.sqlite'
    files = {'settings': userdata / 'settings.json', 'environment': userdata / 'environment-id'}
    for path in files.values():
        assert path.is_file() and not path.is_symlink(), 'A protected SpecWithCode file is missing or is a link'
    contents = {name: path.read_bytes() for name, path in files.items()}
    widen = {'widen_from': since['databaseCapture']['schema']['columns']} if since is not None else {}
    rows, auth, carried, database = _read_state(userdata, True, since['rows'] if since is not None else None, True, **widen)
    return {'schemaVersion': SCHEMA_VERSION, 'rows': rows, 'databaseCapture': database,
            'privateAuth': _encode_cells(auth), 'carried': carried,
            'fileHashes': {name: _digest(data) for name, data in contents.items()},
            'settingsProof': settings_continuity.settings_proof(contents['settings']),
            'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}


def check(before, after):
    """update.py's post-restart comparison of `after` (captured with since=`before`) against
    `before`; raises AssertionError on a refusal. The capture time stands in for the restart."""
    assert before.get('schemaVersion') == SCHEMA_VERSION, 'The capture before the update is not a post-update check capture'
    original_auth, current_auth = _decode_cells(before['privateAuth']), _decode_cells(after['privateAuth'])
    heartbeat, _, migration_cells, widenings, continuity = update_apply.compare(
        NAMES, before, after, original_auth, current_auth, after['carried'], before['observedAt'],
        IDENTITY, POLICY, True, True)
    assert after['fileHashes']['environment'] == before['fileHashes']['environment'], 'The environment id changed after the update'
    return {'settings': settings_preserved(before, after), 'migrationCells': migration_cells,
            'databaseContinuity': continuity, 'widenedTables': sorted(widenings),
            'heartbeat': heartbeat is not None, 'rowsByteIdentical': before['rows'] == after['rows']}


def _write(path, value, private=False):
    data = json.dumps(value, indent=2) + '\n'
    if private:  # Owner-only from creation: the capture holds the home's auth cells.
        with open(os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as handle:
            handle.write(data)
    else:
        path.write_text(data)


def main(argv):
    parser = argparse.ArgumentParser(prog='update.py verify')
    parser.add_argument('--local', action='store_true', required=True,
                        help='Check a home no installation serves (the only mode)')
    parser.add_argument('--state', type=pathlib.Path, required=True, help='The SpecWithCode base dir (holds userdata/)')
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--capture', type=pathlib.Path, help='Write the capture before the update here')
    action.add_argument('--against', type=pathlib.Path, help='The capture before the update to check against')
    parser.add_argument('--output', type=pathlib.Path, help='With --against: the receipt')
    args = parser.parse_args(argv)
    if args.against and not args.output:
        parser.error('--against needs --output')
    if args.capture:
        assert not args.capture.exists(), 'The capture file exists already'
        _write(args.capture, capture(args.state), private=True)
        print(json.dumps({'result': 'captured', 'capture': str(args.capture)}))
        return 0
    receipt = {'schemaVersion': SCHEMA_VERSION, 'mode': 'local', 'state': str(args.state)}
    try:
        before = json.loads(args.against.read_text())
        assert before.get('schemaVersion') == SCHEMA_VERSION, 'The capture before the update is not a post-update check capture'
        # Through JSON like the capture before it, so both sides compare in the same types.
        after = json.loads(json.dumps(capture(args.state, since=before)))
        receipt.update(check(before, after), result='verified',
                       projects=len(after['rows']['projectIds']), threads=len(after['rows']['threadIds']))
    except AssertionError as error:
        receipt.update(result='failed', error=str(error) or type(error).__name__)
        _write(args.output, receipt)
        print('REFUSAL post-update-check ' + receipt['error'], file=sys.stderr)
        return 1
    _write(args.output, receipt)
    print(json.dumps({'result': 'verified', 'receipt': str(args.output)}))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
