#!/usr/bin/env python3
"""One-time move of a machine's SpecWithCode data to ~/.specwithcode.

    ~/.specweave-studio               -> ~/.specwithcode            (identities, backups, profile)
    ~/.local/share/specweave-studio   -> ~/.specwithcode/install    (releases, update agent)

Both moves are same-volume renames, so nothing is copied and nothing is deleted. Each old
path is left as a compatibility link to its new place: paths recorded before the move
(thread history, worktrees, transcripts) keep resolving. Every step is idempotent and
recorded in ~/.specwithcode-migration.json, so a run that stops anywhere is finished by
running it again, and --rollback undoes a move that has not been verified.

The databases are never opened while a service could run, and never copied. They are read
only after their services stop and lsof shows no process holding statev2.sqlite, -wal or
-shm; the move refuses (and names the holders) otherwise. The directory rename carries
each database with its -wal and -shm. After the restart, only the process, its port and the
files it holds are checked.

Running services are stopped for the move: launchd agents labelled com.specweave.studio.<id>
(and .updater) are booted out, moved, rewritten and bootstrapped again. Labels, the bundle
ID and Keychain items do not change, so updates and sign-ins carry over. Run it from a job
that does not belong to the service being moved (see --detach).
"""
if not __debug__:
    raise RuntimeError('Optimized Python is unsupported for owned-service safety checks')

import argparse
import datetime
import json
import os
import pathlib
import plistlib
import re
import shutil
import sqlite3
import subprocess
import sys
import time

import fcntl

import studio_paths

JOURNAL = '.specwithcode-migration.json'
LABEL_PREFIX = 'com.specweave.studio.'
DETACHED_LABEL = LABEL_PREFIX + 'home-migration'
READY_SECONDS = 180
# Services and update agents older than this hardcode the legacy paths and refuse the link.
MINIMUM_VERSION = (1, 0, 35)
COUNTED_TABLES = ('projection_projects', 'orchestration_v2_projection_threads')


class MigrationError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise MigrationError(message)


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')


class Migration:
    def __init__(self, home, *, services=True, out=print, minimum_version=None):
        self.home = pathlib.Path(home)
        require(self.home.is_absolute() and self.home == self.home.resolve(), 'Home must be a real absolute path')
        self.legacy = studio_paths.legacy_root(self.home)
        self.branded = studio_paths.branded_root(self.home)
        self.legacy_install = studio_paths.legacy_install(self.home)
        self.branded_install = self.branded / studio_paths.INSTALL_DIRECTORY
        self.agents = self.home / 'Library' / 'LaunchAgents'
        self.journal_path = self.home / JOURNAL
        self.services = services
        self.minimum_version = minimum_version
        self.out = out
        self.domain = 'gui/%d' % os.getuid()
        self.journal = self._load_journal()

    # ------------------------------------------------------------------ journal
    def _load_journal(self):
        try:
            value = json.loads(self.journal_path.read_text())
        except FileNotFoundError:
            return {'schemaVersion': 1, 'phase': 'new', 'history': []}
        require(isinstance(value, dict) and value.get('schemaVersion') == 1, 'Migration journal is malformed')
        return value

    def record(self, phase, **fields):
        self.journal.update(fields)
        self.journal['phase'] = phase
        self.journal['history'].append({'phase': phase, 'at': now()})
        temporary = self.journal_path.with_name(self.journal_path.name + '.tmp')
        temporary.write_text(json.dumps(self.journal, indent=2) + '\n')
        os.chmod(str(temporary), 0o600)
        os.replace(str(temporary), str(self.journal_path))
        self.out('home-migration: ' + phase)

    # ------------------------------------------------------------------ state
    def moved(self):
        return self.legacy.is_symlink() and os.readlink(str(self.legacy)) in {studio_paths.HOME_DIRECTORY, str(self.branded)}

    def pairs(self):
        """Old -> new path prefixes, the install store first (it is not under the legacy root)."""
        return [(str(self.legacy_install), str(self.branded_install)), (str(self.legacy), str(self.branded))]

    def rewrite(self, text, reverse=False):
        for old, new in self.pairs():
            if reverse:
                old, new = new, old
            text = re.sub(re.escape(old) + r'(?![A-Za-z0-9_.-])', lambda _: new, text)
        return text

    def identities(self):
        root = self.legacy if self.legacy.is_dir() and not self.legacy.is_symlink() else self.branded
        found = []
        if root.is_dir():
            for entry in sorted(root.iterdir()):
                if entry.is_dir() and not entry.is_symlink() and (entry / 'installation.json').is_file():
                    found.append(entry.name)
        return found

    def studio_plists(self):
        if not self.agents.is_dir():
            return []
        return sorted(path for path in self.agents.glob(LABEL_PREFIX + '*.plist')
                      if not path.is_symlink() and path.stem != DETACHED_LABEL)

    # ------------------------------------------------------------------ launchd
    def launchctl(self, *args, check=False):
        if not self.services:
            return 0
        result = subprocess.run(['/bin/launchctl', *args], stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
        require(not check or result.returncode == 0, 'launchctl %s failed' % args[0])
        return result.returncode

    def loaded(self, label):
        return self.launchctl('print', self.domain + '/' + label) == 0

    def stop(self, labels):
        for label in labels:
            if self.loaded(label):
                self.launchctl('bootout', self.domain + '/' + label)
        deadline = time.monotonic() + 60
        while self.services and any(self.loaded(label) for label in labels):
            require(time.monotonic() < deadline, 'A service did not stop')
            time.sleep(0.5)

    def start(self, plists):
        for plist in plists:
            label = plist.stem
            if not self.loaded(label):
                self.launchctl('bootstrap', self.domain, str(plist), check=True)

    # ------------------------------------------------------------------ database
    # A database is opened only after its service is stopped and no process holds any of
    # statev2.sqlite, -wal or -shm (lsof). It is never copied: the directory rename moves the
    # three files together, and every change here is undone by --rollback.
    def database_files(self, root):
        root = pathlib.Path(os.path.realpath(str(root)))
        if not root.is_dir():
            return []
        return sorted(str(path) for pattern in ('userdata/statev2.sqlite*', '*/userdata/statev2.sqlite*')
                      for path in root.glob(pattern) if path.is_file())

    def database_holders(self, root):
        files = self.database_files(root)
        if not files:
            return {}
        try:
            result = subprocess.run(['/usr/sbin/lsof', '-t', '--', *files], stdin=subprocess.DEVNULL,
                                    capture_output=True, text=True, timeout=60)
        except FileNotFoundError:
            raise MigrationError('lsof is required to prove no process holds the database') from None
        holders = {}
        for pid in sorted({int(line) for line in result.stdout.split() if line.isdigit()}):
            name = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'comm='], capture_output=True, text=True).stdout.strip()
            holders[pid] = os.path.basename(name) or '?'
        return holders

    def require_unheld(self, root, wait=120):
        deadline = time.monotonic() + wait
        while True:
            holders = self.database_holders(root)
            if not holders:
                return
            if time.monotonic() >= deadline:
                raise MigrationError('These processes still hold a SpecWithCode database; quit them and run again: %s'
                                     % ', '.join('%s (%d)' % (name, pid) for pid, name in holders.items()))
            time.sleep(2)

    def database_facts(self, identity_home):
        path = identity_home / 'userdata' / 'statev2.sqlite'
        if not path.is_file():
            return None
        db = sqlite3.connect(str(path), timeout=30)
        try:
            check = db.execute('PRAGMA quick_check').fetchone()[0]
            require(check == 'ok', 'Database check failed before the move: %s' % check)
            tables = {row[0] for row in db.execute("select name from sqlite_master where type='table'")}
            return {table: db.execute('select count(*) from "%s"' % table).fetchone()[0]
                    for table in COUNTED_TABLES if table in tables}
        finally:
            db.close()

    def rewrite_project_roots(self, identity_home, reverse=False):
        """Project roots are looked up by exact path (Scratch, managed projects): point them at
        the new root so the app finds them instead of creating duplicates."""
        path = identity_home / 'userdata' / 'statev2.sqlite'
        if not path.is_file():
            return 0
        db = sqlite3.connect(str(path), timeout=30)
        try:
            tables = {row[0] for row in db.execute("select name from sqlite_master where type='table'")}
            if 'projection_projects' not in tables:
                return 0
            changed = 0
            with db:
                for old, new in self.pairs():
                    if reverse:
                        old, new = new, old
                    cursor = db.execute(
                        'update projection_projects set workspace_root = ? || substr(workspace_root, ?) '
                        'where workspace_root = ? or substr(workspace_root, 1, ?) = ?',
                        (new, len(old) + 1, old, len(old) + 1, old + '/'))
                    changed += cursor.rowcount
            return changed
        finally:
            db.close()

    # ------------------------------------------------------------------ files
    def backup_dir(self):
        name = self.journal.get('backupName')
        if name is None:
            name = 'home-migration-' + now()
            self.journal['backupName'] = name
        root = (self.legacy if self.legacy.is_dir() and not self.legacy.is_symlink() else self.branded) / 'backups'
        path = root / name
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        return path

    def pointer_files(self, root):
        files = []
        for identity in self.identities():
            own = root / identity
            files += [own / 'installation.json', own / 'launch.sh']
        bin_dir = self.home / '.local' / 'bin'
        if bin_dir.is_dir():
            files += [path for path in sorted(bin_dir.iterdir())
                      if path.name.startswith(('specweave-studio', 'specwithcode')) and path.is_file() and not path.is_symlink()]
        files += self.studio_plists()
        return [path for path in files if path.is_file() and not path.is_symlink()]

    def save_pointers(self, backup):
        saved = backup / 'pointers'
        if saved.exists():
            return  # A rerun keeps the copies the first run took.
        staging = backup / 'pointers.partial'
        shutil.rmtree(str(staging), ignore_errors=True)
        staging.mkdir(mode=0o700)
        manifest = {}
        for index, path in enumerate(self.pointer_files(self.legacy)):
            copy = staging / ('%03d-%s' % (index, path.name))
            shutil.copy2(str(path), str(copy))
            manifest[copy.name] = str(path)
        (staging / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        os.replace(str(staging), str(saved))

    def rewrite_pointers(self):
        changed = []
        for path in self.pointer_files(self.branded):
            data = path.read_bytes()
            if path.suffix == '.plist':
                value = plistlib.loads(data)
                updated = plistlib.dumps(self._rewrite_value(value))
                if plistlib.loads(updated) == value:
                    continue
            else:
                text = data.decode()
                new_text = self.rewrite(text)
                if path.name == 'installation.json':
                    new_text = json.dumps(self._rewrite_value(json.loads(text)), indent=2) + '\n'
                updated = new_text.encode()
                if updated == data:
                    continue
            temporary = path.with_name(path.name + '.home-migration')
            temporary.write_bytes(updated)
            os.chmod(str(temporary), path.stat().st_mode & 0o777)
            os.replace(str(temporary), str(path))
            changed.append(str(path))
        return changed

    def _rewrite_value(self, value):
        if isinstance(value, str):
            for old, new in self.pairs():
                if value == old or value.startswith(old + '/'):
                    return new + value[len(old):]
            return self.rewrite(value)
        if isinstance(value, list):
            return [self._rewrite_value(item) for item in value]
        if isinstance(value, dict):
            return {key: self._rewrite_value(item) for key, item in value.items()}
        return value

    def repair_worktrees(self):
        """Point each managed worktree's repository back-link at the new path (best effort;
        the compatibility link keeps the old one working)."""
        repaired = 0
        for identity in self.identities():
            for container in ('worktrees', 'scratch', 'projects'):
                root = self.branded / identity / container
                if not root.is_dir():
                    continue
                for git_file in root.glob('**/.git'):
                    if git_file.is_file() and len(git_file.relative_to(root).parts) <= 4:
                        try:
                            subprocess.run(['git', '-C', str(git_file.parent), 'worktree', 'repair'],
                                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                           stderr=subprocess.DEVNULL, timeout=30)
                            repaired += 1
                        except (OSError, subprocess.SubprocessError):
                            pass
        return repaired

    def require_current(self, identities):
        for identity in identities:
            receipt = json.loads((self.legacy / identity / 'installation.json').read_text())
            try:
                version = tuple(int(part) for part in str(receipt.get('version')).split('-')[0].split('.'))
            except ValueError:
                version = ()
            require(version >= self.minimum_version, '%s runs %s; update it to %s or later before moving its data'
                    % (identity, receipt.get('version'), '.'.join(map(str, self.minimum_version))))
        updater = self.legacy_install / 'updater'
        require(not (updater / 'update_agent.py').exists() or (updater / 'studio_paths.py').exists(),
                'The update agent predates the new home; update the desktop app, then run the migration again')

    # ------------------------------------------------------------------ move
    def move(self):
        require(not (self.branded.exists() and not self.branded.is_symlink() and any(self.branded.iterdir())),
                'Both %s and %s hold data; merge them by hand' % (self.legacy, self.branded))
        require(os.stat(str(self.legacy)).st_dev == os.stat(str(self.home)).st_dev, 'Legacy root is on another volume')
        if self.branded.is_dir() and not self.branded.is_symlink():
            self.branded.rmdir()  # Empty; checked above.
        os.rename(str(self.legacy), str(self.branded))

    def link(self):
        if not os.path.lexists(str(self.legacy)):
            os.symlink(studio_paths.HOME_DIRECTORY, str(self.legacy))
        require(self.moved(), '%s is not the compatibility link' % self.legacy)

    def move_install(self):
        if self.legacy_install.is_dir() and not self.legacy_install.is_symlink():
            require(not self.branded_install.exists(), '%s already exists' % self.branded_install)
            require(os.stat(str(self.legacy_install)).st_dev == os.stat(str(self.branded)).st_dev,
                    'Install store is on another volume')
            os.rename(str(self.legacy_install), str(self.branded_install))
        if self.branded_install.is_dir() and not os.path.lexists(str(self.legacy_install)):
            self.legacy_install.parent.mkdir(parents=True, exist_ok=True)
            os.symlink(os.path.relpath(str(self.branded_install), str(self.legacy_install.parent)), str(self.legacy_install))

    # ------------------------------------------------------------------ verify
    def wait_ready(self, identity):
        own = self.branded / identity
        receipt = json.loads((own / 'installation.json').read_text())
        require(receipt.get('studioHome') == str(own), 'Receipt still names the old home')
        if not self.services:
            return
        deadline = time.monotonic() + READY_SECONDS
        while time.monotonic() < deadline:
            try:
                runtime = json.loads((own / 'userdata' / 'server-runtime.json').read_text())
                pid = runtime.get('pid')
                if type(pid) is int and subprocess.run(['/bin/kill', '-0', str(pid)], capture_output=True).returncode == 0:
                    lsof = subprocess.run(['/usr/sbin/lsof', '-nP', '-a', '-p', str(pid), '-iTCP', '-sTCP:LISTEN'],
                                          capture_output=True, text=True, timeout=10)
                    if ':%s ' % receipt.get('port') in lsof.stdout + ' ' and \
                            str(own / 'userdata' / 'statev2.sqlite') in subprocess.run(
                                ['/usr/sbin/lsof', '-p', str(pid)], capture_output=True, text=True, timeout=10).stdout:
                        return
            except (OSError, ValueError, subprocess.SubprocessError):
                pass
            time.sleep(1)
        raise MigrationError('Service %s did not become ready from the new home' % identity)

    def verify(self):
        facts = {}
        running = set(self.journal.get('loaded', []))
        for identity in self.identities():
            if LABEL_PREFIX + identity not in running:
                continue
            # Readiness only: the running service's database is never opened from here.
            self.wait_ready(identity)
            facts[identity] = 'listening-from-new-home'
        return facts

    def compare_counts(self):
        """Row counts after the rewrite, still with every service stopped."""
        after = {}
        for identity, before in (self.journal.get('counts') or {}).items():
            facts = self.database_facts(self.branded / identity) or {}
            for table, count in (before or {}).items():
                require(facts.get(table) == count, '%s changed row counts in %s' % (identity, table))
            after[identity] = facts
        return after

    # ------------------------------------------------------------------ run
    def run(self):
        if self.journal['phase'] == 'verified' and self.moved():
            self.out('home-migration: already complete')
            return self.journal
        legacy_real = self.legacy.is_dir() and not self.legacy.is_symlink()
        interrupted = self.journal['phase'] in {'stopped', 'moved', 'linked', 'rewritten', 'failed-after-move'}
        install_left = self.legacy_install.is_dir() and not self.legacy_install.is_symlink()
        if not self.moved() and not legacy_real and not ((interrupted or install_left) and self.branded.is_dir()):
            self.out('home-migration: nothing to move')
            return self.journal
        identities = self.identities()
        for identity in identities:
            for root in (self.legacy, self.branded):
                require(not any((root / identity / 'updates' / name).exists()
                                for name in ('install-in-progress.json', 'install-gate.json')),
                        'An update of %s is being installed; run the migration again when it finishes' % identity)
        if self.minimum_version and not self.moved():
            self.require_current(identities)
        plists = self.studio_plists()
        if 'loaded' not in self.journal:
            self.journal['loaded'] = [plist.stem for plist in plists if self.loaded(plist.stem)]
        labels = list(self.journal['loaded'])
        try:
            if not self.moved() and self.legacy.is_dir() and not self.legacy.is_symlink():
                backup = self.backup_dir()
                self.record('stopping', identities=identities, labels=labels, backup=str(backup))
                self.stop(labels)
                self.require_unheld(self.legacy)
                counts = {identity: self.database_facts(self.legacy / identity) for identity in identities}
                self.save_pointers(backup)
                self.record('stopped', counts=counts)
                self.move()
                self.record('moved')
            else:
                self.stop(labels)
                self.require_unheld(self.branded)
            self.link()
            self.move_install()
            self.record('linked')
            changed = self.rewrite_pointers()
            self.require_unheld(self.branded, wait=0)
            roots = {identity: self.rewrite_project_roots(self.branded / identity) for identity in self.identities()}
            counts_after = self.compare_counts()
            self.record('rewritten', rewrittenFiles=changed, rewrittenProjectRoots=roots, countsBeforeStart=counts_after)
            repaired = self.repair_worktrees()
            self.start([plist for plist in self.studio_plists() if plist.stem in labels])
            facts = self.verify()
            self.record('verified', worktreesRepaired=repaired, services=facts,
                        home=str(self.branded), install=str(self.branded_install))
            return self.journal
        except BaseException as error:
            self.journal['error'] = '%s: %s' % (type(error).__name__, error)
            if self.journal['phase'] in {'stopping', 'stopped'} and not self.moved():
                # Nothing moved yet: put the services back as they were.
                self.start([plist for plist in plists if plist.stem in labels])
                self.record('failed-before-move')
            else:
                self.record('failed-after-move')
            raise

    def rollback(self):
        """Undo an unverified (or explicitly unwanted) move: back to the legacy layout."""
        labels = self.journal.get('loaded') or [plist.stem for plist in self.studio_plists() if self.loaded(plist.stem)]
        self.stop(labels)
        self.require_unheld(self.branded if self.legacy.is_symlink() else self.legacy)
        if self.legacy_install.is_symlink():
            self.legacy_install.unlink()
            if self.branded_install.is_dir():
                os.rename(str(self.branded_install), str(self.legacy_install))
        if self.legacy.is_symlink():
            require(self.branded.is_dir(), 'Nothing to roll back to')
            self.legacy.unlink()
            os.rename(str(self.branded), str(self.legacy))
        backup = self.legacy / 'backups' / self.journal.get('backupName', '')
        saved = backup / 'pointers'
        if self.journal.get('backupName') and saved.is_dir():
            manifest = json.loads((saved / 'manifest.json').read_text())
            for name, original in manifest.items():
                shutil.copy2(str(saved / name), original)
        for identity in self.journal.get('identities', []):
            # Keep everything written since the move; only point the project roots back.
            self.rewrite_project_roots(self.legacy / identity, reverse=True)
        self.start([plist for plist in self.studio_plists() if plist.stem in labels])
        self.record('rolled-back')
        return self.journal


class UpdateLock:
    """The release store's installation lock (update.py and install.py take it too), held for
    the whole move: an update never runs mid-move, and a move never starts mid-update. The
    lock file moves with the store; the open descriptor keeps the lock across the rename."""

    def __init__(self, home):
        self.path = studio_paths.install_root(home) / 'installation.lock'
        self.fd = None

    def __enter__(self):
        if not self.path.parent.is_dir():
            return self
        self.fd = os.open(str(self.path), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(self.fd)
            self.fd = None
            raise MigrationError('An update is in progress; run the migration again when it finishes') from None
        return self

    def __exit__(self, *exc):
        if self.fd is not None:
            os.close(self.fd)
        return False


def update_lock(home):
    return UpdateLock(pathlib.Path(home))


def detach(script, home):
    """Run this migration as its own launchd job, so stopping the service that hosts the
    caller (an agent in a SpecWithCode thread) does not stop the migration."""
    log = pathlib.Path(home) / 'Library' / 'Logs' / 'specwithcode-home-migration.log'
    log.parent.mkdir(parents=True, exist_ok=True)
    plist = pathlib.Path(home) / 'Library' / 'LaunchAgents' / (DETACHED_LABEL + '.plist')
    plist.write_bytes(plistlib.dumps({
        'Label': DETACHED_LABEL, 'RunAtLoad': True, 'KeepAlive': False, 'LaunchOnlyOnce': True,
        'ProgramArguments': ['/usr/bin/python3', '-B', str(script), '--remove-job'],
        'WorkingDirectory': str(home), 'StandardOutPath': str(log), 'StandardErrorPath': str(log)}))
    domain = 'gui/%d' % os.getuid()
    subprocess.run(['/bin/launchctl', 'bootout', domain + '/' + DETACHED_LABEL], capture_output=True)
    subprocess.run(['/bin/launchctl', 'bootstrap', domain, str(plist)], check=True, capture_output=True)
    print(json.dumps({'result': 'started', 'label': DETACHED_LABEL, 'log': str(log),
                      'journal': str(pathlib.Path(home) / JOURNAL)}))


def main(argv=None):
    parser = argparse.ArgumentParser(description='Move SpecWithCode data to ~/.specwithcode')
    parser.add_argument('--home', help=argparse.SUPPRESS)  # Tests only.
    parser.add_argument('--no-services', action='store_true', help=argparse.SUPPRESS)  # Tests only.
    parser.add_argument('--rollback', action='store_true')
    parser.add_argument('--detach', action='store_true', help='Run as a separate launchd job')
    parser.add_argument('--remove-job', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    os.umask(0o077)
    home = pathlib.Path(args.home) if args.home else pathlib.Path.home()
    if args.detach:
        detach(pathlib.Path(os.path.abspath(__file__)), home)
        return 0
    migration = Migration(home, services=not args.no_services,
                          minimum_version=None if args.no_services else MINIMUM_VERSION)
    try:
        with update_lock(home):
            result = migration.rollback() if args.rollback else migration.run()
        print(json.dumps({'result': result['phase'], 'journal': str(migration.journal_path)}))
        return 0
    except (MigrationError, OSError, sqlite3.Error, subprocess.SubprocessError) as error:
        print('home-migration: error: %s' % error, file=sys.stderr)
        return 1
    finally:
        if args.remove_job:
            plist = home / 'Library' / 'LaunchAgents' / (DETACHED_LABEL + '.plist')
            if plist.is_file():
                plist.unlink()


if __name__ == '__main__':
    sys.exit(main())
