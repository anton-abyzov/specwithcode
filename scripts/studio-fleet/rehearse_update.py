#!/usr/bin/env python3
"""Rehearses this release's update on a temporary APFS clone of the previous release's real state,
before anything is published (release.sh stage test.migration; increment 1239 AC-12).

    python3 -B scripts/studio-fleet/rehearse_update.py --json [--keep] [--idle 120]
        [--source-db PATH] [--source-config PATH] [--scratch DIR] [--home DIR] [--identity m4]

What it does, on this machine only:
  1. Picks the newest pre-update copy of the state database (<home>/.specwithcode/backups/pre-*/
     statev2.sqlite, written by update.py before every update) and the update agent's settings
     (<home>/.specwithcode/<identity>/updates/config.json), unless --source-db/--source-config name
     others. Refuses to start unless the scratch volume has at least twice the database's bytes free
     (disk_room's measure).
  2. Clones both with `cp -c` into a new private folder under --scratch (default: a folder beside
     this checkout's scratch root, ~/.specwithcode/<identity>/scratch). The copy never leaves the
     machine, and the folder is deleted when the rehearsal ends, also on failure, unless --keep.
  3. Runs update.py's own apply (held page mode, project migrations allowed) with this checkout's
     helper over the clone: a writer holds the clone open as the old service; the restart starts
     this checkout's server (apps/server/src/bin.ts, or --server-entrypoint) on it, under the
     install gate apply writes, so its migrations run on the copy, and it stays up --idle seconds
     (default 120) before apply's post-restart proof reads the database. The service seams apply
     cannot have here (launchd, the listener and process-tree checks, the installation owner) are
     the fleet tests' sandbox transport (test-update.py ApplyRecovery, the page-mode branch of
     test-update-page-mode.py); every database read, proof, migration check and receipt is apply's.
  4. Asserts the receipt reached phase verified with databaseProofMode stopped-clone-pages-v1 (or a
     declared full read when the release carries an additive_migrations.FULL_READ migration the
     clone has not run), that it finished within the time budget (page proof 300 s, full read
     1800 s, the idle excluded), that every protected table (update_read.is_projection_table false;
     the migrations table and tables a declared migration adds or rebuilds left out) keeps its row
     count and content hash, and that the candidate update agent reads the cloned config.json with
     every key kept (update_agent.load_config).

Prints one JSON report. Exit 0 when the rehearsal passed, 1 when it failed, 2 when it could not
start (no source, too little disk). Never sends state anywhere and never touches the source files.
"""
import argparse
import contextlib
import datetime
import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import traceback

import additive_migrations
import disk_room
import studio_paths
from update_read import is_projection_table

HERE = pathlib.Path(__file__).resolve().parent
REPOSITORY = HERE.parents[1]
DEFAULT_ENTRYPOINT = REPOSITORY / 'apps/server/src/bin.ts'
PAGE_BUDGET_SECONDS = 300
FULL_READ_BUDGET_SECONDS = 1800
PAGE_PROOF_MODE = 'stopped-clone-pages-v1'
DISK_FACTOR = 2
PROVIDERS = ('codex', 'claudeAgent', 'cursor', 'grok', 'pi', 'opencode', 'antigravity')
# apply's sandbox replaces time.sleep and time.monotonic process-wide (fake clock): the rehearsal's
# own waits and budget use these.
REAL_SLEEP, REAL_MONOTONIC = time.sleep, time.monotonic


class CannotStart(Exception):
    """No source state, or too little disk: nothing was copied."""


class Failed(AssertionError):
    """The rehearsal ran and the update did not pass."""


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def newest_backup(home):
    """The newest pre-update copy of the state database under `home`'s backups root, or None."""
    root = studio_paths.backups_root(home)
    found = [path for path in root.glob('pre-*/statev2.sqlite') if path.is_file() and not path.is_symlink()] if root.is_dir() else []
    return max(found, key=lambda path: path.stat().st_mtime, default=None)


def database_bytes(database):
    return sum(path.stat().st_size for path in (database, pathlib.Path(str(database) + '-wal')) if path.exists())


def room(database, scratch):
    """(need, free): the scratch volume must hold DISK_FACTOR times the database."""
    return DISK_FACTOR * database_bytes(database), disk_room.kept_lines.available_disk(scratch)


def clone(source, target):
    """An APFS clone (cp -c) of `source` at `target`; a copy where the volume cannot clone fails."""
    subprocess.run(['/bin/cp', '-c', str(source), str(target)], check=True, capture_output=True, timeout=600)
    os.chmod(target, 0o600)


def protected(database, leave_out=()):
    """{table: [count, sha256]} of each protected table, read only."""
    db = sqlite3.connect('file:%s?mode=ro' % database, uri=True)
    try:
        db.execute('BEGIN')
        found = {}
        for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall():
            if is_projection_table(table) or table == additive_migrations.MIGRATIONS_TABLE or table in leave_out:
                continue
            width = len(db.execute('PRAGMA table_info("%s")' % table).fetchall())
            digest, count = hashlib.sha256(), 0
            for row in db.execute('SELECT * FROM "%s" ORDER BY %s' % (table, ', '.join(str(i) for i in range(1, width + 1)))):
                digest.update(json.dumps(row, default=lambda value: value.hex()).encode() + b'\n')
                count += 1
            found[table] = [count, digest.hexdigest()]
        return found
    finally:
        db.close()


def migration_objects():
    """Tables a declared additive migration adds or rebuilds: their rows are new or proven by apply."""
    tables = {name for _, objects in additive_migrations.DECLARED.values() for kind, name, _, _ in objects if kind == 'table'}
    return tables | {table for _, rebuilt in additive_migrations.REBUILT.values() for table in rebuilt}


def config_check(source_config, home):
    """The candidate update agent's reading of the cloned config.json: every key kept, values equal."""
    agent = load('rehearsal_update_agent', 'update_agent.py')
    original = json.loads(source_config.read_text())
    upgraded = agent.load_config(source_config.parent, home)
    lost = sorted(key for key in original if key not in upgraded)
    changed = sorted(key for key in original if key in upgraded and upgraded[key] != original[key])
    added = sorted(key for key in upgraded if key not in original)
    return {'lost': lost, 'changed': changed, 'added': added}


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


class RealClock:
    """The sandbox's clock (ApplyRecovery.clock, read as clock[0] by its time.monotonic and
    advanced by its time.sleep) on real time: apply's waits really wait, on real processes, and its
    receipt's timings are real."""

    def __getitem__(self, index):
        return REAL_MONOTONIC()

    def __setitem__(self, index, value):
        REAL_SLEEP(max(0.0, value - REAL_MONOTONIC()))


class Interrupted(BaseException):
    """SIGTERM/SIGHUP/SIGINT during a rehearsal: unwinds through every finally, never swallowed."""

    def __init__(self, signum):
        super().__init__(signum)
        self.signum = signum


# How main's handler treats a signal: raise Interrupted once; inside a cleanup (`shielded`) or once
# stopping, only record it, so no signal ever aborts the removal of the copy. Children inherit
# neither a blocked mask nor an ignored disposition from this.
_SIGNALS = {'cleaning': 0, 'pending': None, 'stopping': None, 'left': None}


def on_signal(signum, frame=None):
    if _SIGNALS['stopping'] is not None:
        return
    if _SIGNALS['cleaning']:
        _SIGNALS['pending'] = _SIGNALS['pending'] or signum
        return
    _SIGNALS['stopping'] = signum
    raise Interrupted(signum)


def stop_if_signalled():
    """An Interrupted another exception replaced (a rollback that raised) is raised again."""
    if _SIGNALS['stopping'] not in (None, -1):
        raise Interrupted(_SIGNALS['stopping'])


@contextlib.contextmanager
def shielded(entered=False):
    """A cleanup no signal interrupts; a signal held during it is raised once it ends. A finally
    raises the count itself as its first statement (entered=True), so no signal lands between
    the finally starting and the shield going up."""
    if not entered:
        _SIGNALS['cleaning'] += 1
    try:
        yield
    finally:
        _SIGNALS['cleaning'] -= 1
        pending = _SIGNALS['pending']
        if pending and not _SIGNALS['cleaning'] and _SIGNALS['stopping'] is None:
            _SIGNALS['pending'], _SIGNALS['stopping'] = None, pending
            raise Interrupted(pending)


class Candidate:
    """This checkout's server on the clone, started by the sandbox's restart."""

    def __init__(self, entrypoint, own, home, idle):
        self.entrypoint, self.own, self.home, self.idle, self.process = entrypoint, own, home, idle, None

    def start(self):
        settings = self.own / 'userdata/settings.json'
        settings.write_text(json.dumps({'providers': {driver: {'enabled': False} for driver in PROVIDERS}}))
        port = free_port()
        env = {'HOME': str(self.home), 'USER': os.environ.get('USER', 'rehearsal'), 'LANG': 'en_US.UTF-8', 'PATH': '/usr/bin:/bin',
               'STUDIO_HOME': str(self.own), 'STUDIO_LOG_LEVEL': 'Warn', 'STUDIO_ENABLE_HOSTED_SERVICES': 'false',
               'STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD': 'false', 'PWDEBUG': '0', 'PLAYWRIGHT_HTML_OPEN': 'never'}
        node = os.environ.get('STUDIO_TEST_NODE') or shutil.which('node')
        assert node, 'Node 22 not found; set STUDIO_TEST_NODE'
        with shielded():  # A signal inside Popen must not lose the handle stop() kills by.
            self.log = open(self.own / 'candidate-server.log', 'w')
            self.process = subprocess.Popen([node, str(self.entrypoint), 'start', '--host', '127.0.0.1', '--port', str(port), '--base-dir', str(self.own),
                                             '--mode', 'web', '--no-browser'], cwd=str(self.own), env=env, stdin=subprocess.DEVNULL,
                                            stdout=self.log, stderr=subprocess.STDOUT, start_new_session=True)
        credential = self.own / 'userdata/secrets/local-cli-credential.bin'
        began = REAL_MONOTONIC()
        while not credential.exists():
            assert self.process.poll() is None, 'The candidate server exited during startup (see candidate-server.log)'
            assert REAL_MONOTONIC() - began < 300, 'The candidate server did not start within 300 s'
            REAL_SLEEP(0.2)
        self.started = REAL_MONOTONIC() - began
        REAL_SLEEP(self.idle)  # Idle under the install gate, as after an update's restart.

    def stop(self):
        with shielded():
            self._stop()

    def _stop(self):
        if self.process is None:
            return
        # Its own session (start_new_session): signal the whole group so no child keeps the clone open.
        if self.process.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(self.process.pid, signal.SIGTERM)
            with contextlib.suppress(subprocess.TimeoutExpired):
                self.process.wait(timeout=30)
        # Whatever is left in the group (a child that ignored SIGTERM, or one of a leader that
        # already exited) goes too.
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(self.process.pid, signal.SIGKILL)
        self.process.wait()
        self.log.close()


def apply_on_clone(database, scratch, entrypoint, idle, identity='m4'):
    """update.apply over a clone at `database` (moved into the sandbox's home). Returns (receipt,
    protected before, protected after, seconds, candidate startup seconds, apply's exception)."""
    previous = tempfile.tempdir
    tempfile.tempdir = str(scratch)  # The sandbox's temporary home lives in the scratch folder.
    try:
        base = load('rehearsal_update_base', 'test-update.py')
        fixture = load('rehearsal_page_fixture', 'test-after-proof.py')
        h = base.ApplyRecovery('runTest')
        h.setUp()
    finally:
        tempfile.tempdir = previous
    update = base.update
    candidate = Candidate(entrypoint, h.own, h.home, idle)
    try:
        state = h.own / 'userdata'
        shutil.move(str(database), str(state / 'statev2.sqlite'))
        for name in ('statev2.sqlite-wal',):
            if (database.parent / name).exists():
                shutil.move(str(database.parent / name), str(state / name))
        old = fixture.Writer(state / 'statev2.sqlite')
        # A running service always has a log: right before apply marks it, one write that leaves
        # every row as it was gives the page proof its baseline frame, as a heartbeat does on a
        # real host (apply's reads before the mark fold an idle log away).
        # SQLite skips an UPDATE that changes nothing, so the newest migration row's name is
        # changed and put back in one transaction: its page is logged with the same content.
        newest = '(SELECT max(migration_id) FROM effect_sql_migrations)'
        unchanged = [("UPDATE effect_sql_migrations SET name = name || '~' WHERE migration_id = " + newest, []),
                     ('UPDATE effect_sql_migrations SET name = substr(name, 1, length(name) - 1) WHERE migration_id = ' + newest, [])]
        old.commit(*unchanged)
        real_mark = update.after_proof.mark

        def mark(database, *args, **kwargs):
            if old.process.poll() is None:
                old.commit(*unchanged)
            return real_mark(database, *args, **kwargs)
        h.real_db = h.capture_database = True
        h.clock = RealClock()
        now = datetime.datetime.now(datetime.timezone.utc)
        request = now.isoformat()
        runtime = {'pid': 100, 'startedAt': (now - datetime.timedelta(minutes=5)).isoformat(), 'host': '127.0.0.1', 'port': 8319}
        (state / 'server-runtime.json').write_text(json.dumps(runtime))
        updates = h.own / 'updates'
        updates.mkdir(exist_ok=True)
        (updates / 'hold.json').write_text(json.dumps({'schemaVersion': 1, 'pid': 100, 'startedAt': (now - datetime.timedelta(seconds=1)).isoformat(),
                                                       'expiresAt': (now + datetime.timedelta(hours=1)).isoformat()}))
        (updates / 'config.json').write_text(json.dumps({'installMode': 'force', 'installRequestedAt': request}))
        h.before.update(snapshotMode='held-service', installRequestedAt=request, rows={'nativeWorkIdle': True, 'counts': {}})
        service = {'own': h.own, 'home': h.home, 'runtime': runtime}

        def stopped(pid, *, port=8319):
            h.stops.append(pid)
            if pid == 100:
                old.close()
        h.wait_for_stopped = stopped

        def backup(own, commit):
            target = h.home / 'backups/pre-rehearsal'
            target.mkdir(parents=True)
            with contextlib.ExitStack() as stack:
                stack.enter_context(_patched(base.state_backup, 'backup_folder', lambda commit: target))
                path, _ = base.state_backup.clone_state(own, commit, update._clonefile())
            h.backups.append(commit)
            return path
        h.backup_state = backup
        h.on_restart = candidate.start

        def metadata(identity, include_auth, since=None, widen_from=None, reads=None, passing=None):
            value = h.snapshot(identity)
            if reads is None:  # The full read: apply's own read of the live database.
                value['rows'], auth, carried, value['databaseCapture'] = update._read_state(state, include_auth, since, True, widen_from)
            else:
                value['rows'], auth, carried, value['databaseCapture'] = reads
            value.setdefault('observedAt', datetime.datetime.now(datetime.timezone.utc).isoformat())
            return value, auth, carried
        leave_out = migration_objects()
        before = protected(state / 'statev2.sqlite', leave_out)
        began = REAL_MONOTONIC()
        error = None
        try:
            with _patched(update, '_service', lambda identity: service), _patched(update, '_snapshot', metadata), \
                    _patched(update.after_proof, 'mark', mark):
                h.execute(allow_project_migrations=True)
        except (Interrupted, KeyboardInterrupt):
            raise  # Stop now; the finally blocks stop the candidate and remove the copy.
        except BaseException as caught:  # The receipt says why; the report carries it.
            stop_if_signalled()
            error = caught
        seconds = REAL_MONOTONIC() - began - (idle if candidate.process is not None else 0)
        receipt = json.loads(h.output.read_text()) if h.output.exists() else {}
        after = protected(state / 'statev2.sqlite', leave_out)
        return receipt, before, after, seconds, getattr(candidate, 'started', None), error
    finally:
        _SIGNALS['cleaning'] += 1
        with shielded(entered=True):
            candidate.stop()
            h.tearDown()


@contextlib.contextmanager
def _patched(target, name, value):
    original = getattr(target, name)
    setattr(target, name, value)
    try:
        yield
    finally:
        setattr(target, name, original)


def proof_mode(receipt):
    """How apply proved the database: the page proof's receipt key, else the full read's baseline."""
    return receipt.get('databaseProofMode') or (receipt.get('before') or {}).get('databaseProofMode')


def judge(receipt, before, after, seconds, error):
    """Why the rehearsal failed, or []."""
    problems = []
    if receipt.get('phase') != 'verified':
        problems.append('phase %s, not verified: %s' % (receipt.get('phase'), receipt.get('error') or (error and type(error).__name__)))
    full_read = bool(receipt.get('fullReadMigrations'))
    if not full_read and proof_mode(receipt) != PAGE_PROOF_MODE:
        problems.append('databaseProofMode %r without a declared full read (pageFallback %s)' % (proof_mode(receipt), receipt.get('pageFallback')))
    budget = FULL_READ_BUDGET_SECONDS if full_read else PAGE_BUDGET_SECONDS
    if seconds > budget:
        problems.append('took %.0f s, over the %d s budget' % (seconds, budget))
    changed = sorted(table for table in set(before) | set(after) if before.get(table) != after.get(table))
    if changed:
        problems.append('protected tables changed: ' + ', '.join(changed))
    return problems


def rehearse(args):
    home = (args.home or pathlib.Path.home()).resolve()
    source_db = args.source_db or newest_backup(home)
    if source_db is None or not pathlib.Path(source_db).is_file():
        raise CannotStart('No previous state copy found under %s' % studio_paths.backups_root(home))
    source_db = pathlib.Path(source_db).resolve()
    source_config = (args.source_config or studio_paths.identity_home(home, args.identity) / 'updates/config.json').resolve()
    if not source_config.is_file():
        raise CannotStart('No update settings at %s' % source_config)
    scratch_root = (args.scratch or studio_paths.identity_home(home, args.identity) / 'scratch').resolve()
    scratch_root.mkdir(parents=True, exist_ok=True)
    need, free = room(source_db, scratch_root)
    if free is None or free < need:
        raise CannotStart('Scratch volume %s has %s bytes free; the rehearsal needs %d (%dx the database)' % (scratch_root, free, need, DISK_FACTOR))
    report = {'source': str(source_db), 'sourceBytes': database_bytes(source_db), 'kept': bool(args.keep)}
    folder = None
    try:
        with shielded():  # Created and named together: a held signal is raised inside the try.
            folder = pathlib.Path(tempfile.mkdtemp(prefix='rehearse-update-', dir=str(scratch_root)))
            report['folder'] = str(folder)
        os.chmod(folder, 0o700)
        copy = folder / 'clone'
        copy.mkdir(mode=0o700)
        clone(source_db, copy / 'statev2.sqlite')
        if pathlib.Path(str(source_db) + '-wal').exists():
            clone(pathlib.Path(str(source_db) + '-wal'), copy / 'statev2.sqlite-wal')
        config = folder / 'config' / 'config.json'
        config.parent.mkdir(mode=0o700)
        clone(source_config, config)
        report['config'] = config_check(config, folder)
        receipt, before, after, seconds, started, error = apply_on_clone(copy / 'statev2.sqlite', folder, args.server_entrypoint, args.idle, args.identity)
        problems = judge(receipt, before, after, seconds, error)
        if report['config']['lost'] or report['config']['changed']:
            problems.append('config.json lost or changed keys: %s' % ', '.join(report['config']['lost'] + report['config']['changed']))
        report.update(phase=receipt.get('phase'), databaseProofMode=proof_mode(receipt), rowPreservation=receipt.get('rowPreservation'),
                      pageFallback=receipt.get('pageFallback'), timings=receipt.get('timings'),
                      migrations=((receipt.get('databasePageProof') or {}).get('schemaDelta') or {}).get('migrations', []),
                      fullReadMigrations=receipt.get('fullReadMigrations', []), seconds=round(seconds, 1),
                      candidateStartSeconds=started and round(started, 1), idleSeconds=args.idle,
                      protectedTables=len(before), problems=problems, result='passed' if not problems else 'failed')
        return report
    finally:
        _SIGNALS['cleaning'] += 1
        with shielded(entered=True):
            remove(folder, report, args)


def remove(folder, report, args):
    if args.keep or folder is None:
        return
    for _ in range(2):
        shutil.rmtree(folder, ignore_errors=True)
        if not folder.exists():
            break
    report['removed'] = not folder.exists()
    if not report['removed']:  # A copy of real state left on disk fails the rehearsal loudly.
        _SIGNALS['left'] = str(folder)
        report['result'] = 'failed'
        report.setdefault('problems', []).append('Could not remove the rehearsal copy at %s' % folder)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--identity', default='m4')
    parser.add_argument('--home', type=pathlib.Path, help='Whose state to rehearse (default: this user)')
    parser.add_argument('--source-db', type=pathlib.Path)
    parser.add_argument('--source-config', type=pathlib.Path)
    parser.add_argument('--scratch', type=pathlib.Path)
    parser.add_argument('--server-entrypoint', type=pathlib.Path, default=DEFAULT_ENTRYPOINT)
    parser.add_argument('--idle', type=int, default=120)
    parser.add_argument('--keep', action='store_true', help='Keep the rehearsal folder for inspection')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    # SIGTERM/SIGHUP/SIGINT (a stopped release, a logout) raise Interrupted once, so every finally
    # runs: the candidate server stops and the copy of real state is removed (on_signal, shielded).
    _SIGNALS.update(cleaning=0, pending=None, stopping=None, left=None)
    previous = {sig: signal.signal(sig, on_signal) for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)}
    try:
        return finish(args)
    except Interrupted as stop:
        left = _SIGNALS['left']
        print('rehearsal stopped by signal %d%s' % (stop.signum, '; COPY OF REAL STATE LEFT AT %s' % left if left else ''), file=sys.stderr)
        return 128 + stop.signum
    finally:
        _SIGNALS['stopping'] = _SIGNALS['stopping'] or -1  # Nothing raises once main is returning.
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def finish(args):
    try:
        report = rehearse(args)
    except CannotStart as error:
        report = {'result': 'cannot-start', 'error': str(error)}
    except Exception as error:  # A crash in the rehearsal itself fails it; the clone is already removed.
        stop_if_signalled()
        report = {'result': 'failed', 'error': '%s: %s' % (type(error).__name__, error), 'trace': traceback.format_exc(limit=5)}
    print(json.dumps(report, indent=2) if args.json else '%s: %s' % (report['result'], '; '.join(report.get('problems') or [report.get('error', 'ok')])))
    return {'passed': 0, 'cannot-start': 2}.get(report['result'], 1)


if __name__ == '__main__':
    sys.exit(main())
